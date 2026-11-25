import { ADAPTERS } from '../adapters/index.js';
import { serpApiSearch } from '../adapters/serpapi.js';
import type { AnySourceAdapter, FetchContext } from '../adapters/types.js';
import { emptyByAts } from '../adapters/ats.js';
import type { Companies } from '../config/schema.js';
import { addCompanies, listedSlugs, parseCompaniesText } from '../discovery/companies-file.js';
import { companiesFromLinks, type DiscoveredCompanies } from '../discovery/links.js';
import { archivedLinks } from '../discovery/wayback.js';
import { createHttpClient, type HttpClient } from '../util/http.js';
import { DEFAULT_COMPANIES_STATE_PATH, harvestedCandidates, loadCompaniesState } from '../state/companies.js';
import type { Context } from './context.js';

const BRANCH_PREFIX = 'job-radar/discovery-';

export interface DiscoverOptions {
  dryRun?: boolean;
  /** Path of `companies.yml` in the repository. */
  companiesPath?: string;
  companiesStatePath?: string;
  serpapiKey?: string;
  adapters?: Record<string, AnySourceAdapter>;
  http?: HttpClient;
  now?: Date;
}

export interface DiscoverResult {
  /** Companies that are new, exist on their ATS and have at least one posting. */
  found: DiscoveredCompanies;
  pullRequest?: number;
}

function mergeDiscovered(a: DiscoveredCompanies, b: DiscoveredCompanies): DiscoveredCompanies {
  const merged = emptyByAts<string>();
  for (const ats of Object.keys(merged) as Array<keyof DiscoveredCompanies>) merged[ats] = [...new Set([...a[ats], ...b[ats]])];
  return merged;
}

function count(companies: DiscoveredCompanies): number {
  return Object.values(companies).reduce((sum, list) => sum + list.length, 0);
}

/**
 * Weekly job: runs the `discovery.queries` through SerpAPI, picks the company slugs out of the career
 * page links, keeps the ones that are not in `companies.yml` yet and whose board answers with at least one
 * posting, and opens a pull request that adds them. Nothing enters collection until you merge it.
 */
export async function discover(ctx: Context, options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const empty: DiscoveredCompanies = emptyByAts<string>();
  const { discovery } = ctx.config;
  if (!discovery.enabled) {
    ctx.log.info('Discovery is off (discovery.enabled: false); nothing to do');
    return { found: empty };
  }

  const harvested = harvestedCandidates(await loadCompaniesState(options.companiesStatePath ?? DEFAULT_COMPANIES_STATE_PATH));
  const searching = Boolean(options.serpapiKey) && discovery.queries.length > 0;
  if (!searching) {
    if (!options.serpapiKey) ctx.log.info('No SerpAPI key (the serpapi-key input); skipping the Google searches');
    else ctx.log.warn('discovery.queries is empty; skipping the Google searches');
  }

  const http = options.http ?? createHttpClient({ hostDelayMs: 1000 });
  const archived = await archivedLinks({
    http,
    maxQueries: discovery.max_archive_queries,
    now: options.now ?? new Date(),
    warn: (message) => ctx.log.warn(message),
  });
  if (!searching && count(harvested) === 0 && archived.length === 0) return { found: empty };

  const adapters = options.adapters ?? ADAPTERS;
  const path = options.companiesPath ?? 'companies.yml';

  // The file on the default branch is the source of truth, not whatever the workflow checked out.
  const { data: repository } = await ctx.octokit.rest.repos.get({ ...ctx.repo });
  const base = repository.default_branch;
  const current = await readFileOnBranch(ctx, path, base);
  const listed = listedSlugs(parseCompaniesText(current?.text ?? ''));

  const links: string[] = [...archived];
  for (const query of searching ? discovery.queries.slice(0, discovery.max_searches) : []) {
    const response = await serpApiSearch(http, options.serpapiKey!, { engine: 'google', q: query, num: '20', hl: 'en' });
    const results = Array.isArray(response.organic_results) ? response.organic_results : [];
    for (const result of results as Array<{ link?: unknown }>) if (typeof result.link === 'string') links.push(result.link);
  }

  const candidates = mergeDiscovered(companiesFromLinks(links), harvested);
  const found: DiscoveredCompanies = emptyByAts<string>();
  for (const ats of Object.keys(found) as Array<keyof DiscoveredCompanies>) {
    for (const slug of candidates[ats].filter((candidate) => !listed[ats].has(candidate))) {
      if (await hasPostings(ctx, adapters[ats], slug, http, options.now ?? new Date())) found[ats].push(slug);
    }
  }

  const total = count(found);
  if (total === 0) {
    ctx.log.info(`Discovery: ${links.length} links searched, no new company to propose`);
    return { found };
  }
  const summary = (Object.keys(found) as Array<keyof DiscoveredCompanies>)
    .filter((ats) => found[ats].length > 0)
    .map((ats) => `${ats}: ${found[ats].join(', ')}`)
    .join(' · ');
  if (options.dryRun) {
    ctx.log.info(`[dry-run] Would propose ${total} company(ies) — ${summary}`);
    return { found };
  }

  const open = await ctx.octokit.rest.pulls.list({ ...ctx.repo, state: 'open', per_page: 100 });
  const pending = open.data.find((pull) => pull.head.ref.startsWith(BRANCH_PREFIX));
  if (pending) {
    ctx.log.info(`Discovery: pull request #${pending.number} is still open; review it before more are proposed`);
    return { found, pullRequest: pending.number };
  }

  const branch = `${BRANCH_PREFIX}${(options.now ?? new Date()).toISOString().slice(0, 10)}`;
  const { data: ref } = await ctx.octokit.rest.git.getRef({ ...ctx.repo, ref: `heads/${base}` });
  await ctx.octokit.rest.git.createRef({ ...ctx.repo, ref: `refs/heads/${branch}`, sha: ref.object.sha });
  await ctx.octokit.rest.repos.createOrUpdateFileContents({
    ...ctx.repo,
    path,
    branch,
    message: `chore(companies): add ${total} discovered ${total === 1 ? 'company' : 'companies'}`,
    content: Buffer.from(addCompanies(current?.text ?? '', found)).toString('base64'),
    ...(current ? { sha: current.sha } : {}),
  });
  const { data: pull } = await ctx.octokit.rest.pulls.create({
    ...ctx.repo,
    head: branch,
    base,
    title: `Review ${total} discovered ${total === 1 ? 'company' : 'companies'}`,
    body: [
      'job-radar found these career pages through the discovery searches. Each one answered with at least one posting.',
      '',
      ...(Object.keys(found) as Array<keyof DiscoveredCompanies>)
        .filter((ats) => found[ats].length > 0)
        .map((ats) => `- **${ats}**: ${found[ats].map((slug) => `\`${slug}\``).join(', ')}`),
      '',
      'Merge to start collecting from them, or delete the lines you do not want first. Closing the pull request discards the proposal.',
    ].join('\n'),
  });
  ctx.log.info(`Discovery: opened pull request #${pull.number} with ${total} company(ies) — ${summary}`);
  return { found, pullRequest: pull.number };
}

export async function readFileOnBranch(ctx: Context, path: string, ref: string): Promise<{ text: string; sha: string } | undefined> {
  try {
    const { data } = await ctx.octokit.rest.repos.getContent({ ...ctx.repo, path, ref });
    if (Array.isArray(data) || data.type !== 'file') return undefined;
    return { text: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

/** A guessed company only counts when its board exists and lists something: it filters out dead links and typos. */
async function hasPostings(
  ctx: Context,
  adapter: AnySourceAdapter | undefined,
  slug: string,
  http: HttpClient,
  now: Date,
): Promise<boolean> {
  if (!adapter) return false;
  const fetchContext: FetchContext = {
    http,
    config: ctx.config,
    companies: [{ slug }],
    now,
    worthDetails: () => false,
    warn: () => undefined,
  };
  try {
    return (await adapter.fetch(fetchContext)).length > 0;
  } catch {
    ctx.log.info(`Discovery: ${adapter.id}/${slug} did not answer like a career page; left out`);
    return false;
  }
}
