import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { relativeToIso } from '../util/relative-time.js';
import { jobId } from './common.js';
import { serpApiSearch } from './serpapi.js';
import { SchemaError, type FetchContext, type SourceAdapter } from './types.js';
import { parseItems } from './validate.js';

const DEFAULT_MAX_SEARCHES = 3;

const postingSchema = z.object({
  title: z.string(),
  company_name: z.string(),
  location: z.string().nullish(),
  description: z.string().nullish(),
  job_id: z.string().nullish(),
  share_link: z.string().nullish(),
  apply_options: z.array(z.object({ link: z.string() })).nullish(),
  detected_extensions: z
    .object({ posted_at: z.string().nullish(), work_from_home: z.boolean().nullish() })
    .nullish(),
});

export type GoogleJobsPosting = z.infer<typeof postingSchema> & { fetchedAt: string };

/** `QA OR "Quality Assurance" OR SDET remote`: one search that covers several include terms. */
export function defaultQueries(include: string[]): string[] {
  const terms = include.slice(0, 4).map((term) => (/\s/.test(term) ? `"${term}"` : term));
  return terms.length === 0 ? [] : [`${terms.join(' OR ')} remote`];
}

/**
 * Google Jobs through SerpAPI, which covers postings that only exist on LinkedIn, Indeed or Glassdoor
 * without scraping them. Optional: it needs `SERPAPI_KEY`, and each search spends the free quota
 * (100 a month), so `max_searches` caps what one run may use.
 */
export const googleJobs: SourceAdapter<GoogleJobsPosting> = {
  id: 'google_jobs',
  mode: 'search',
  requiresKey: true,

  async fetch(ctx: FetchContext) {
    if (!ctx.apiKey) return [];
    const toggle = ctx.config.sources.google_jobs;
    const queries = (toggle?.queries ?? defaultQueries(ctx.config.search.include)).slice(0, toggle?.max_searches ?? DEFAULT_MAX_SEARCHES);
    const location = toggle?.location ?? (ctx.config.eligibility.accept_regions.includes('brazil') ? 'Brazil' : undefined);

    const byKey = new Map<string, GoogleJobsPosting>();
    for (const query of queries) {
      const response = await serpApiSearch(ctx.http, ctx.apiKey, {
        engine: 'google_jobs',
        q: query,
        hl: 'en',
        ...(location ? { location } : {}),
      });
      const results = response.jobs_results;
      if (results === undefined) continue; // no results for this query
      if (!Array.isArray(results)) throw new SchemaError('google_jobs', 'jobs_results is not a list');
      for (const posting of parseItems('google_jobs', postingSchema, results, ctx)) {
        byKey.set(posting.job_id ?? `${posting.company_name}|${posting.title}`, { ...posting, fetchedAt: ctx.now.toISOString() });
      }
    }
    return [...byKey.values()];
  },

  normalize(posting): Job {
    const link = posting.apply_options?.[0]?.link ?? posting.share_link;
    if (!link) throw new Error('posting has no application link');
    const location = posting.location?.trim();
    return {
      id: jobId('google_jobs', posting.company_name, posting.job_id ?? `${posting.company_name}|${posting.title}`),
      source: 'google_jobs',
      atsApply: false,
      company: posting.company_name.trim(),
      title: posting.title.trim(),
      locations: location ? [location] : [],
      workModel: posting.detected_extensions?.work_from_home ? 'remote' : undefined,
      seniority: [],
      contracts: [],
      postedAt: relativeToIso(posting.detected_extensions?.posted_at ?? undefined, new Date(posting.fetchedAt)),
      applyUrl: canonicalUrl(link) ?? link,
      description: posting.description?.trim() ?? '',
    };
  },
};
