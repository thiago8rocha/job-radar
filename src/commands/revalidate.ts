import { ADAPTERS } from '../adapters/index.js';
import type { AnySourceAdapter, FetchContext } from '../adapters/types.js';
import { companyRefs, type Companies } from '../config/schema.js';
import { LABEL, slugify } from '../domain/labels.js';
import { parseStatusLabel, statusLabel } from '../domain/status.js';
import { extractMarker } from '../github/issue-body.js';
import { addLabels, removeLabel } from '../github/labels.js';
import { createHttpClient, type HttpClient } from '../util/http.js';
import type { Context } from './context.js';

export interface RevalidateOptions {
  dryRun?: boolean;
  companies?: Companies;
  adapters?: Record<string, AnySourceAdapter>;
  http?: HttpClient;
  now?: Date;
}

export interface RevalidateResult {
  checked: number;
  closed: number;
}

interface Candidate {
  number: number;
  title: string;
  markerId: string;
  source: string;
  company: string;
}

/**
 * Weekly job: jobs still at "New" whose posting has disappeared from its company's board get the
 * `closed-at-source` label and are closed. Only sources that list a whole company's jobs are
 * checked (a search source can't prove a job is gone), a company is skipped when its request fails or
 * comes back empty, and anything you have already moved past "New" is left alone.
 */
export async function revalidate(ctx: Context, options: RevalidateOptions = {}): Promise<RevalidateResult> {
  const { dryRun = false } = options;
  const adapters = options.adapters ?? ADAPTERS;
  const http = options.http ?? createHttpClient({ hostDelayMs: 300 });
  const companies = options.companies ?? { inhire: [], greenhouse: [], lever: [], ashby: [] };

  const issues = await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, {
    ...ctx.repo,
    state: 'open',
    labels: 'status:new',
    per_page: 100,
  });
  const candidates: Candidate[] = [];
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = issue.labels.map((label) => (typeof label === 'string' ? label : label.name ?? ''));
    if (labels.some((name) => parseStatusLabel(name) && name !== 'status:new')) continue;
    if (labels.includes(LABEL.closedAtSource)) continue;
    const markerId = extractMarker(issue.body);
    const [source, company] = markerId?.split(':') ?? [];
    if (!markerId || !source || !company) continue;
    const adapter = adapters[source];
    if (!adapter || adapter.mode !== 'company' || !ctx.config.sources[source]?.enabled) continue;
    candidates.push({ number: issue.number, title: issue.title, markerId, source, company });
  }

  const result: RevalidateResult = { checked: candidates.length, closed: 0 };
  const bySourceCompany = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.company}`;
    bySourceCompany.set(key, [...(bySourceCompany.get(key) ?? []), candidate]);
  }

  for (const [key, group] of bySourceCompany) {
    const [source, companySlug] = key.split(':') as [string, string];
    const ref = companyRefs(companies[source as keyof Companies]).find((entry) => slugify(entry.slug) === companySlug);
    if (!ref) {
      ctx.log.info(`${key}: company is not in companies.yml any more; left alone`);
      continue;
    }

    let present: Set<string>;
    try {
      const fetchContext: FetchContext = {
        http,
        config: ctx.config,
        companies: [ref],
        now: options.now ?? new Date(),
        worthDetails: () => false, // only the ids matter here
        warn: (message) => ctx.log.warn(message),
      };
      const adapter = adapters[source]!;
      const raws = await adapter.fetch(fetchContext);
      present = new Set(raws.map((raw) => adapter.normalize(raw).id));
    } catch (error) {
      ctx.log.warn(`${key}: could not be checked, so no job was closed (${(error as Error).message})`);
      continue;
    }
    if (present.size === 0) {
      ctx.log.warn(`${key}: the board came back empty; treating it as an outage, no job was closed`);
      continue;
    }

    for (const candidate of group) {
      if (present.has(candidate.markerId)) continue;
      if (dryRun) {
        ctx.log.info(`[dry-run] #${candidate.number} ${candidate.title}: gone from ${source}`);
      } else {
        await addLabels(ctx.octokit, ctx.repo, candidate.number, [LABEL.closedAtSource, statusLabel('discarded')]);
        await removeLabel(ctx.octokit, ctx.repo, candidate.number, statusLabel('new'));
        await ctx.octokit.rest.issues.createComment({
          ...ctx.repo,
          issue_number: candidate.number,
          body: 'This posting is no longer listed on the company\'s board, so job-radar closed the issue. Reopen it if it is still open to applications.',
        });
        await ctx.octokit.rest.issues.update({
          ...ctx.repo,
          issue_number: candidate.number,
          state: 'closed',
          state_reason: 'not_planned',
        });
        ctx.log.info(`Closed #${candidate.number} ${candidate.title}: gone from ${source}`);
      }
      result.closed++;
    }
  }
  ctx.log.info(`${dryRun ? '[dry-run] ' : ''}Revalidation: ${result.checked} open "New" job(s) checked, ${result.closed} ${dryRun ? 'would be ' : ''}closed`);
  return result;
}
