import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { asCurrency, formatRange, isoFromEpoch, jobId } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const SEARCH = 'https://himalayas.app/jobs/api/search';
const MAX_PAGES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

const postingSchema = z.object({
  guid: z.string(),
  title: z.string(),
  companyName: z.string(),
  companySlug: z.string().nullish(),
  applicationLink: z.string(),
  pubDate: z.number().nullish(),
  seniority: z.array(z.string()).nullish(),
  employmentType: z.string().nullish(),
  locationRestrictions: z.array(z.string()).nullish(),
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  salaryPeriod: z.string().nullish(),
  currency: z.string().nullish(),
  excerpt: z.string().nullish(),
  description: z.string().nullish(),
});

export type HimalayasPosting = z.infer<typeof postingSchema>;

/** Terms to search, de-duplicated ignoring case. */
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
 * Himalayas public API (remote jobs, no key). One search per `search.include` term, newest first,
 * stopping at the age limit. `country=BR` returns the worldwide jobs plus those open to Brazil.
 * The terms of use ask for a link back, which the issue's source line and apply link provide.
 */
export const himalayas: SourceAdapter<HimalayasPosting> = {
  id: 'himalayas',
  mode: 'search',

  async fetch(ctx) {
    const oldest = ctx.now.getTime() - ctx.config.search.max_age_days * DAY_MS;
    const scope = ctx.config.eligibility.accept_regions.includes('brazil') ? 'country=BR' : 'worldwide=true';
    const byGuid = new Map<string, HimalayasPosting>();

    for (const term of searchTerms(ctx.config.search.include)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${SEARCH}?q=${encodeURIComponent(term)}&${scope}&sort=recent&page=${page}`;
        const { jobs } = parseEnvelope('himalayas', envelopeSchema, await ctx.http.getJson(url));
        if (jobs.length === 0) break;

        const postings = parseItems('himalayas', postingSchema, jobs, ctx);
        for (const posting of postings) byGuid.set(posting.guid, posting);

        const dates = postings.map((posting) => (posting.pubDate ?? 0) * 1000).filter((time) => time > 0);
        if (dates.length > 0 && Math.min(...dates) < oldest) break; // the rest is older than the limit
      }
    }
    return [...byGuid.values()];
  },

  normalize(posting): Job {
    const restrictions = posting.locationRestrictions ?? [];
    return {
      id: jobId('himalayas', posting.companySlug ?? posting.companyName, posting.guid),
      source: 'himalayas',
      atsApply: false,
      company: posting.companyName.trim(),
      title: posting.title.trim(),
      locations: restrictions.length > 0 ? restrictions : ['Worldwide'],
      restrictions,
      workModel: 'remote',
      seniority: (posting.seniority ?? []).map((level) => level.toLowerCase()),
      contracts: [],
      compensation: formatRange(posting.minSalary, posting.maxSalary, posting.currency, posting.salaryPeriod),
      currency: asCurrency(posting.currency),
      salaryAmount:
        posting.minSalary != null && posting.minSalary === posting.maxSalary ? posting.minSalary : undefined,
      postedAt: isoFromEpoch(posting.pubDate ?? undefined, 's'),
      applyUrl: canonicalUrl(posting.applicationLink) ?? posting.applicationLink,
      description: htmlToText(posting.description) || posting.excerpt || '',
    };
  },
};
