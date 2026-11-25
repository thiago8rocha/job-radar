import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl, isPaywalled } from '../pipeline/url.js';
import { relativeToIso } from '../util/relative-time.js';
import { ATS } from './ats.js';
import { jobId } from './common.js';
import { serpApiSearch } from './serpapi.js';
import { SchemaError, type FetchContext, type SourceAdapter } from './types.js';
import { parseItems } from './validate.js';

const DEFAULT_MAX_SEARCHES = 3;
const DEFAULT_MONTHLY_CAP = 100;
const DEFAULT_MAX_PAGES = 1;
const MAX_DEFAULT_QUERIES = 5;

const postingSchema = z.object({
  title: z.string(),
  company_name: z.string(),
  location: z.string().nullish(),
  description: z.string().nullish(),
  job_id: z.string().nullish(),
  share_link: z.string().nullish(),
  apply_options: z.array(z.object({ link: z.string() })).nullish(),
  extensions: z.array(z.string()).nullish(),
  detected_extensions: z
    .object({ posted_at: z.string().nullish(), work_from_home: z.boolean().nullish() })
    .nullish(),
});

const filterSchema = z.object({
  name: z.string().optional(),
  parameters: z.object({ uds: z.string().optional(), q: z.string().optional() }).optional(),
});
const filtersSchema = z.array(filterSchema.extend({ options: z.array(filterSchema).optional() }));
const REMOTE_FILTER = /^(remote|work from home|trabalho remoto|home office)$/i;
const REMOTE_HINT = /work from home|home.?office|remote|remoto/i;

export type GoogleJobsPosting = z.infer<typeof postingSchema> & { fetchedAt: string };

function isAtsLink(link: string): boolean {
  return ATS.some((def) => def.urls.some(({ pattern }) => pattern.test(link)));
}

/** Google lists apply options in no useful order, often an aggregator first: prefer the ATS, never a paywall. */
export function pickApplyLink(posting: Pick<GoogleJobsPosting, 'apply_options' | 'share_link'>): string | undefined {
  const links = (posting.apply_options ?? []).map((option) => option.link).filter((link) => !isPaywalled(link));
  return links.find(isAtsLink) ?? links[0] ?? (posting.apply_options?.length ? undefined : posting.share_link ?? undefined);
}

/** `QA remote`, `SDET remote`...: one plain query per include term, as a person would type it. */
export function defaultQueries(include: string[]): string[] {
  return include.slice(0, MAX_DEFAULT_QUERIES).map((term) => `${term} remote`);
}

/** Google leaves `detected_extensions` empty on some days, so the plain `extensions` list counts too; a missing field is unknown, never "not remote". */
function isRemote(posting: Pick<GoogleJobsPosting, 'location' | 'extensions' | 'detected_extensions'>): boolean {
  return (
    posting.detected_extensions?.work_from_home === true ||
    /^anywhere$/i.test(posting.location?.trim() ?? '') ||
    (posting.extensions ?? []).some((entry) => REMOTE_HINT.test(entry))
  );
}

/** The `uds` and `q` of Google's own "Remote" filter. They are opaque and change between searches, so they are read from each response. */
function remoteFilter(response: Record<string, unknown>): { uds: string; q: string } | undefined {
  const parsed = filtersSchema.safeParse(response.filters);
  if (!parsed.success) return undefined;
  for (const entry of parsed.data.flatMap((filter) => [filter, ...(filter.options ?? [])])) {
    const { uds, q } = entry.parameters ?? {};
    if (REMOTE_FILTER.test(entry.name ?? '') && uds && q) return { uds, q };
  }
  return undefined;
}

function field(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Google Jobs through SerpAPI, which covers postings that only exist on LinkedIn, Indeed or Glassdoor
 * without scraping them. Optional: it needs `SERPAPI_KEY`. Every request is one search of the monthly
 * quota (a page, a filter call), so a run reads at most `max_searches` of them, takes its queries in turn
 * from the list (the position and the month's count are kept in `ctx.resolved`) and stops at `monthly_cap`.
 */
export const googleJobs: SourceAdapter<GoogleJobsPosting> = {
  id: 'google_jobs',
  mode: 'search',
  requiresKey: true,

  async fetch(ctx: FetchContext) {
    if (!ctx.apiKey) return [];
    const toggle = ctx.config.sources.google_jobs;
    const brazil = ctx.config.eligibility.accept_regions.includes('brazil');
    const location = toggle?.location ?? (brazil ? 'Brazil' : undefined);
    const gl = toggle?.gl ?? (brazil ? 'br' : undefined);
    const maxPages = toggle?.max_pages ?? DEFAULT_MAX_PAGES;
    const queries = toggle?.queries ?? defaultQueries(ctx.config.search.include);
    if (queries.length === 0) return [];

    const state = ctx.resolved ?? {};
    const monthKey = `google_jobs:searches:${ctx.now.toISOString().slice(0, 7)}`;
    for (const key of Object.keys(state)) if (key.startsWith('google_jobs:searches:') && key !== monthKey) delete state[key];
    let left = Math.min(toggle?.max_searches ?? DEFAULT_MAX_SEARCHES, (toggle?.monthly_cap ?? DEFAULT_MONTHLY_CAP) - Number(state[monthKey] ?? 0));
    if (left <= 0) {
      ctx.warn('google_jobs: the monthly search cap is reached; skipped');
      return [];
    }

    const byKey = new Map<string, GoogleJobsPosting>();
    const search = async (params: Record<string, string>): Promise<Record<string, unknown>> => {
      left--;
      state[monthKey] = String(Number(state[monthKey] ?? 0) + 1);
      const response = await serpApiSearch(ctx.http, ctx.apiKey!, {
        engine: 'google_jobs',
        // With the page in English, Google Jobs answers with no jobs for most searches in Brazil.
        hl: toggle?.hl ?? (brazil ? 'pt-br' : 'en'),
        ...(gl ? { gl } : {}),
        ...(location ? { location } : {}),
        ...params,
      });
      const used = response.search_parameters;
      const meta = response.search_metadata;
      const jobs = Array.isArray(response.jobs_results) ? response.jobs_results.length : 0;
      const more = field(response.serpapi_pagination, 'next_page_token') ? 'more pages' : 'last page';
      ctx.info?.(
        `google_jobs: "${params.q}" in ${field(used, 'location_requested') ?? location ?? 'any place'} (used ${field(used, 'location_used') ?? 'unknown'}): ${jobs} jobs, ${more} (search ${field(meta, 'id') ?? '?'} ${field(meta, 'status') ?? '?'})`,
      );
      return response;
    };

    const first = Number(state['google_jobs:cursor'] ?? 0) % queries.length;
    let started = 0;
    for (let offset = 0; offset < queries.length && left > 0; offset++, started++) {
      let q = queries[(first + offset) % queries.length]!;
      let uds: string | undefined;
      let token: string | undefined;
      let pages = 0;
      let filtered = !toggle?.remote_filter;
      while (left > 0 && pages < maxPages) {
        const response = await search({ q, ...(uds ? { uds } : {}), ...(token ? { next_page_token: token } : {}) });
        const results = response.jobs_results;
        if (results !== undefined && !Array.isArray(results)) throw new SchemaError('google_jobs', 'jobs_results is not a list');
        for (const posting of parseItems('google_jobs', postingSchema, results ?? [], ctx)) {
          if (!pickApplyLink(posting)) continue;
          byKey.set(posting.job_id ?? `${posting.company_name}|${posting.title}`, { ...posting, fetchedAt: ctx.now.toISOString() });
        }
        if (results === undefined) break;
        if (!filtered) {
          filtered = true;
          const filter = remoteFilter(response);
          if (filter) {
            ({ uds, q } = filter);
            token = undefined;
            continue;
          }
        }
        pages++;
        token = field(response.serpapi_pagination, 'next_page_token');
        if (!token) break;
      }
    }
    state['google_jobs:cursor'] = String((first + started) % queries.length);
    return [...byKey.values()];
  },

  normalize(posting): Job {
    const link = pickApplyLink(posting);
    if (!link) throw new Error('posting has no application link');
    const location = posting.location?.trim();
    return {
      id: jobId('google_jobs', posting.company_name, posting.job_id ?? `${posting.company_name}|${posting.title}`),
      source: 'google_jobs',
      atsApply: false,
      company: posting.company_name.trim(),
      title: posting.title.trim(),
      locations: location ? [location] : [],
      workModel: isRemote(posting) ? 'remote' : undefined,
      seniority: [],
      contracts: [],
      postedAt: relativeToIso(posting.detected_extensions?.posted_at ?? undefined, new Date(posting.fetchedAt)),
      applyUrl: canonicalUrl(link) ?? link,
      description: posting.description?.trim() ?? '',
    };
  },
};
