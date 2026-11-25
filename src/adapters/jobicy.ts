import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { asCurrency, formatRange, jobId, searchTerms } from './common.js';
import type { FetchContext, SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const API = 'https://jobicy.com/api/v2/remote-jobs';
const COUNT = 100;

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });
const locationsSchema = z.object({ locations: z.array(z.object({ geoSlug: z.string() })) });

const postingSchema = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string(),
  jobTitle: z.string(),
  companyName: z.string(),
  jobType: z.array(z.string()).nullish(),
  jobGeo: z.string().nullish(),
  jobLevel: z.string().nullish(),
  jobExcerpt: z.string().nullish(),
  jobDescription: z.string().nullish(),
  pubDate: z.string().nullish(),
  salaryMin: z.number().nullish(),
  salaryMax: z.number().nullish(),
  salaryCurrency: z.string().nullish(),
  salaryPeriod: z.string().nullish(),
});

export type JobicyPosting = z.infer<typeof postingSchema>;

/** `accept_regions` of the config as Jobicy `geo` values, in the order they are asked. */
const REGION_GEOS: Record<string, string[]> = { brazil: ['brazil', 'latam'], latam: ['latam'], worldwide: ['anywhere'] };

const LEVELS: Array<[RegExp, string]> = [
  [/senior/i, 'senior'],
  [/midweight/i, 'mid'],
  [/junior|entry/i, 'junior'],
];

/** The geos to ask for: the ones the config accepts that Jobicy lists. A failure to read its list only skips the check. */
async function geosFor(ctx: FetchContext): Promise<string[]> {
  const wanted = [...new Set(ctx.config.eligibility.accept_regions.flatMap((region) => REGION_GEOS[region.toLowerCase()] ?? []))];
  try {
    const { locations } = parseEnvelope('jobicy', locationsSchema, await ctx.http.getJson(`${API}?get=locations`));
    const valid = new Set(locations.map((location) => location.geoSlug));
    return wanted.filter((geo) => valid.has(geo));
  } catch (error) {
    ctx.warn(`jobicy: the list of locations could not be read (${(error as Error).message}); asking for the usual ones`);
    return wanted;
  }
}

/**
 * Jobicy public API (remote jobs, no key): one request per accepted region and `search.include` term.
 * Its terms ask for a credit with a direct link and for application buttons to point at the feed's own
 * job URL, which is the apply link used here; the issue's source line names Jobicy.
 */
export const jobicy: SourceAdapter<JobicyPosting> = {
  id: 'jobicy',
  mode: 'search',

  async fetch(ctx) {
    const byId = new Map<string, JobicyPosting>();
    for (const geo of await geosFor(ctx)) {
      for (const term of searchTerms(ctx.config.search.include)) {
        const query = new URLSearchParams({ count: String(COUNT), geo, tag: term });
        const { jobs } = parseEnvelope('jobicy', envelopeSchema, await ctx.http.getJson(`${API}?${query}`));
        for (const posting of parseItems('jobicy', postingSchema, jobs, ctx)) byId.set(String(posting.id), posting);
      }
    }
    return [...byId.values()];
  },

  normalize(posting): Job {
    const anywhere = /^anywhere$/i.test(posting.jobGeo?.trim() ?? '');
    const places = anywhere ? [] : (posting.jobGeo ?? '').split(',').map((place) => place.trim()).filter(Boolean);
    const levels = (posting.jobLevel ?? '').split(',').flatMap((level) => LEVELS.filter(([pattern]) => pattern.test(level)).map(([, name]) => name));
    return {
      id: jobId('jobicy', posting.companyName, posting.id),
      source: 'jobicy',
      atsApply: false,
      company: posting.companyName.trim(),
      title: htmlToText(posting.jobTitle),
      locations: places.length > 0 ? places : ['Worldwide'],
      restrictions: places,
      workModel: 'remote',
      seniority: [...new Set(levels)],
      contracts: posting.jobType ?? [],
      compensation: formatRange(posting.salaryMin, posting.salaryMax, posting.salaryCurrency, posting.salaryPeriod),
      currency: asCurrency(posting.salaryCurrency),
      postedAt: Number.isNaN(Date.parse(posting.pubDate ?? '')) ? undefined : new Date(posting.pubDate!).toISOString(),
      applyUrl: canonicalUrl(posting.url) ?? posting.url,
      description: htmlToText(posting.jobDescription) || htmlToText(posting.jobExcerpt),
    };
  },
};
