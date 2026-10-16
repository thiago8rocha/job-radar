import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const SEARCH = 'https://portal.gupy.io/api/job-search/jobs';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  pagination: z.object({ total: z.number().optional() }).nullish(),
});

const postingSchema = z.object({
  id: z.number(),
  name: z.string(),
  careerPageName: z.string(),
  jobUrl: z.string(),
  type: z.string().nullish(),
  publishedDate: z.string().nullish(),
  applicationDeadline: z.string().nullish(),
  workplaceType: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  description: z.string().nullish(),
});

export type GupyPosting = z.infer<typeof postingSchema>;

/** `vacancy_type_effective` is the CLT hire; talent pools are not jobs. */
const CONTRACTS: Record<string, string> = { vacancy_type_effective: 'CLT' };
const NOT_JOBS = new Set(['vacancy_type_talent_pool']);

/** Gupy prefixes titles with the posting number: "12732048 - Analista de QA". */
function cleanTitle(name: string): string {
  return name.replace(/^\s*\d+\s*[-–—]\s*/, '').trim();
}

function searchTerms(include: string[]): string[] {
  const seen = new Set<string>();
  return include.filter((term) => {
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Gupy's job portal, which most large Brazilian employers use. The portal's own search page calls
 * `portal.gupy.io/api/job-search/jobs`; it is not a documented API, so the adapter is strict about the
 * response shape and the daily live contract test watches it. One search per `search.include` term.
 */
export const gupy: SourceAdapter<GupyPosting> = {
  id: 'gupy',
  mode: 'search',

  async fetch(ctx) {
    const oldest = ctx.now.getTime() - ctx.config.search.max_age_days * DAY_MS;
    const remoteOnly = ctx.config.work_model.length === 1 && ctx.config.work_model[0] === 'remote';
    const byId = new Map<number, GupyPosting>();

    for (const term of searchTerms(ctx.config.search.include)) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({ jobName: term, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
        if (remoteOnly) query.set('workplaceType', 'remote');
        const { data, pagination } = parseEnvelope('gupy', envelopeSchema, await ctx.http.getJson(`${SEARCH}?${query}`));
        if (data.length === 0) break;

        const postings = parseItems('gupy', postingSchema, data, ctx);
        for (const posting of postings) byId.set(posting.id, posting);

        const dates = postings.map((posting) => Date.parse(posting.publishedDate ?? '')).filter((time) => !Number.isNaN(time));
        const reachedEnd = (page + 1) * PAGE_SIZE >= (pagination?.total ?? 0);
        if (reachedEnd || (dates.length > 0 && Math.min(...dates) < oldest)) break;
      }
    }
    return [...byId.values()].filter(
      (posting) =>
        !NOT_JOBS.has(posting.type ?? '') &&
        (!posting.applicationDeadline || Date.parse(posting.applicationDeadline) > ctx.now.getTime()),
    );
  },

  normalize(posting): Job {
    const places = [posting.city, posting.state, 'Brazil']
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const contract = CONTRACTS[posting.type ?? ''];
    return {
      id: jobId('gupy', posting.careerPageName, posting.id),
      source: 'gupy',
      atsApply: true,
      company: posting.careerPageName.trim(),
      title: cleanTitle(posting.name),
      locations: places,
      workModel: workModelFrom(posting.workplaceType),
      seniority: [],
      contracts: contract ? [contract] : [],
      postedAt: posting.publishedDate ?? undefined,
      applyUrl: canonicalUrl(posting.jobUrl) ?? posting.jobUrl,
      description: htmlToText(posting.description),
    };
  },
};
