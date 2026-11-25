import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { normalizeText } from '../util/text.js';
import { jobId, prettifySlug, workModelFrom } from './common.js';
import { SchemaError, type SourceAdapter } from './types.js';
import { parseItems } from './validate.js';

/** Brazilian job boards that run as a GitHub repository: one open issue per job. */
const DEFAULT_REPOS = ['backend-br/vagas', 'frontendbr/vagas', 'qa-brasil/vagas'];
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const issueSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  title: z.string(),
  body: z.string().nullish(),
  created_at: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().nullish() })])).nullish(),
  pull_request: z.unknown().optional(),
});

export type GithubIssue = z.infer<typeof issueSchema> & { repo: string };

const SENIORITY: Record<string, string> = { senior: 'senior', pleno: 'mid', junior: 'junior' };
const CONTRACTS = new Set(['CLT', 'PJ']);

function labelNames(issue: GithubIssue): string[] {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
}

/** `[Remoto] Role - Company` and `Role na Company` forms; the bracket tags carry the place or work model. */
function parseTitle(title: string): { tags: string[]; role: string; company?: string } {
  const tags = [...title.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]!.trim());
  const rest = title.replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
  const named = /^(.*?)\s+(?:na|no|at|@)\s+(.+)$/i.exec(rest);
  if (named) return { tags, role: named[1]!.trim(), company: named[2]!.trim() };
  const dash = rest.lastIndexOf(' - ');
  if (dash > 0) return { tags, role: rest.slice(0, dash).trim(), company: rest.slice(dash + 3).trim() };
  return { tags, role: rest };
}

/** The host name of the company site the issue's form asks for, as a last resort for the company name. */
function companyFromWebsite(body: string | null | undefined): string | undefined {
  const url = /(?:Company website|Site da empresa)\s*\n+\s*(https?:\/\/\S+)/i.exec(body ?? '')?.[1];
  const host = url ? new URL(url).hostname.replace(/^www\./, '').split('.')[0] : undefined;
  return host ? prettifySlug(host) : undefined;
}

/**
 * Open issues of the repositories in `sources.github_repos.repos` (default: the backend-br, frontendbr and
 * qa-brasil job boards), through the same authenticated GitHub client the rest of job-radar uses. Titles
 * and labels are free-form, so the company comes from the title and the filters do the rest.
 */
export const githubRepos: SourceAdapter<GithubIssue> = {
  id: 'github_repos',
  mode: 'search',

  async fetch(ctx) {
    if (!ctx.github) throw new SchemaError('github_repos', 'no GitHub client available');
    const repos = ctx.config.sources.github_repos?.repos ?? DEFAULT_REPOS;
    const since = new Date(ctx.now.getTime() - ctx.config.search.max_age_days * DAY_MS).toISOString();
    const issues: GithubIssue[] = [];

    for (const repo of repos) {
      const [owner, name] = repo.split('/');
      if (!owner || !name) {
        ctx.warn(`github_repos: "${repo}" is not "owner/name", skipped`);
        continue;
      }
      let page = 0;
      for await (const response of ctx.github.paginate.iterator(ctx.github.rest.issues.listForRepo, { owner, repo: name, state: 'open', since, sort: 'created', direction: 'desc', per_page: PAGE_SIZE })) {
        issues.push(...parseItems('github_repos', issueSchema, response.data, ctx).filter((issue) => !issue.pull_request).map((issue) => ({ ...issue, repo })));
        if (++page >= MAX_PAGES) break;
      }
    }
    return issues.filter((issue) => !/vaga fechada|\bclosed\b/i.test(issue.title));
  },

  normalize(issue): Job {
    const labels = labelNames(issue);
    const { tags, role, company } = parseTitle(issue.title);
    const model = [...tags, ...labels].map(workModelFrom).find(Boolean);
    const place = tags.find((tag) => !workModelFrom(tag));
    const levels = labels.map((label) => SENIORITY[normalizeText(label)]).filter((level): level is string => Boolean(level));
    return {
      id: jobId('github_repos', issue.repo, issue.number),
      source: 'github_repos',
      atsApply: false,
      company: company ?? companyFromWebsite(issue.body) ?? 'Unknown',
      title: role || issue.title.trim(),
      locations: place ? [place] : [],
      workModel: model,
      seniority: [...new Set(levels)],
      contracts: labels.filter((label) => CONTRACTS.has(label.toUpperCase())),
      postedAt: issue.created_at,
      applyUrl: canonicalUrl(issue.html_url) ?? issue.html_url,
      description: (issue.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim(),
    };
  },
};
