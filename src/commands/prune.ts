import { ATS, type AtsId } from '../adapters/ats.js';
import { companyRefs } from '../config/schema.js';
import { parseCompaniesText, removeCompanies } from '../discovery/companies-file.js';
import { DEFAULT_COMPANIES_STATE_PATH, healthKey, loadCompaniesState } from '../state/companies.js';
import type { Context } from './context.js';
import { readFileOnBranch } from './discover.js';

const BRANCH_PREFIX = 'job-radar/prune-';
/** Weeks in a row with a missing or unreadable board before a company is proposed for removal. */
const DEFAULT_THRESHOLD = 4;

export interface PruneOptions {
  dryRun?: boolean;
  companiesPath?: string;
  companiesStatePath?: string;
  threshold?: number;
  now?: Date;
}

export interface PruneResult {
  dead: Partial<Record<AtsId, string[]>>;
  pullRequest?: number;
}

/**
 * Weekly job: proposes, in one pull request, removing from `companies.yml` the companies whose board
 * has been missing or unreadable for several weeks in a row. Nothing leaves the file until it is merged.
 */
export async function prune(ctx: Context, options: PruneOptions = {}): Promise<PruneResult> {
  const path = options.companiesPath ?? 'companies.yml';
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const state = await loadCompaniesState(options.companiesStatePath ?? DEFAULT_COMPANIES_STATE_PATH);

  const { data: repository } = await ctx.octokit.rest.repos.get({ ...ctx.repo });
  const base = repository.default_branch;
  const current = await readFileOnBranch(ctx, path, base);
  if (!current) return { dead: {} };
  const companies = parseCompaniesText(current.text);

  const dead: Partial<Record<AtsId, string[]>> = {};
  for (const def of ATS) {
    const slugs = companyRefs(companies[def.id])
      .map((ref) => ref.slug)
      .filter((slug) => (state.companies[healthKey(def.id, slug)]?.failures ?? 0) >= threshold);
    if (slugs.length > 0) dead[def.id] = slugs;
  }
  const total = Object.values(dead).reduce((sum, list) => sum + list.length, 0);
  if (total === 0) {
    ctx.log.info('Prune: no company has a dead board');
    return { dead };
  }
  const summary = Object.entries(dead).map(([ats, slugs]) => `${ats}: ${slugs!.join(', ')}`).join(' · ');
  if (options.dryRun) {
    ctx.log.info(`[dry-run] Would propose removing ${total} company(ies) — ${summary}`);
    return { dead };
  }

  const content = Buffer.from(removeCompanies(current.text, dead)).toString('base64');
  const title = `Review ${total} company board${total === 1 ? '' : 's'} that stopped answering`;
  const body = [
    `These companies have returned a missing board (404) or an unreadable one for ${threshold} weeks in a row.`,
    '',
    ...Object.entries(dead).map(([ats, slugs]) => `- **${ats}**: ${slugs!.map((slug) => `\`${slug}\``).join(', ')}`),
    '',
    'Merge to stop collecting from them, or close the pull request to keep them.',
  ].join('\n');

  const open = await ctx.octokit.rest.pulls.list({ ...ctx.repo, state: 'open', per_page: 100 });
  const pending = open.data.find((pull) => pull.head.ref.startsWith(BRANCH_PREFIX));
  if (pending) {
    const onBranch = await readFileOnBranch(ctx, path, pending.head.ref);
    await ctx.octokit.rest.repos.createOrUpdateFileContents({
      ...ctx.repo,
      path,
      branch: pending.head.ref,
      message: `chore(companies): remove ${total} dead ${total === 1 ? 'board' : 'boards'}`,
      content,
      ...(onBranch ? { sha: onBranch.sha } : {}),
    });
    await ctx.octokit.rest.pulls.update({ ...ctx.repo, pull_number: pending.number, title, body });
    ctx.log.info(`Prune: updated pull request #${pending.number} — ${summary}`);
    return { dead, pullRequest: pending.number };
  }

  const branch = `${BRANCH_PREFIX}${(options.now ?? new Date()).toISOString().slice(0, 10)}`;
  const { data: ref } = await ctx.octokit.rest.git.getRef({ ...ctx.repo, ref: `heads/${base}` });
  await ctx.octokit.rest.git.createRef({ ...ctx.repo, ref: `refs/heads/${branch}`, sha: ref.object.sha });
  await ctx.octokit.rest.repos.createOrUpdateFileContents({
    ...ctx.repo,
    path,
    branch,
    message: `chore(companies): remove ${total} dead ${total === 1 ? 'board' : 'boards'}`,
    content,
    sha: current.sha,
  });
  const { data: pull } = await ctx.octokit.rest.pulls.create({ ...ctx.repo, head: branch, base, title, body });
  ctx.log.info(`Prune: opened pull request #${pull.number} — ${summary}`);
  return { dead, pullRequest: pull.number };
}
