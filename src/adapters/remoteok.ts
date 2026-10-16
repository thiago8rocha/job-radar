import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { formatRange, jobId } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const FEED = 'https://remoteok.com/api';

const envelopeSchema = z.array(z.unknown());

const postingSchema = z.object({
  id: z.union([z.string(), z.number()]),
  position: z.string(),
  company: z.string(),
  url: z.string(),
  date: z.string().nullish(),
  location: z.string().nullish(),
  description: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
});

export type RemoteOkPosting = z.infer<typeof postingSchema>;

/**
 * Remote OK's public JSON feed (the latest ~100 jobs, all remote). Its terms ask for a followed link
 * back and a mention of Remote OK as the source: the issue links to the Remote OK posting and names it.
 */
export const remoteok: SourceAdapter<RemoteOkPosting> = {
  id: 'remoteok',
  mode: 'search',

  async fetch(ctx) {
    const feed = parseEnvelope('remoteok', envelopeSchema, await ctx.http.getJson(FEED));
    // the first element is the legal notice, not a job
    const jobs = feed.filter((entry) => typeof entry === 'object' && entry !== null && 'position' in entry);
    return parseItems('remoteok', postingSchema, jobs, ctx);
  },

  normalize(posting): Job {
    const location = posting.location?.trim();
    const hasSalary = Boolean(posting.salary_min || posting.salary_max);
    return {
      id: jobId('remoteok', posting.company, posting.id),
      source: 'remoteok',
      atsApply: false,
      company: posting.company.trim(),
      title: posting.position.trim(),
      locations: [location || 'Worldwide'],
      restrictions: location ? [location] : [],
      workModel: 'remote',
      seniority: [],
      contracts: [],
      compensation: hasSalary ? formatRange(posting.salary_min || undefined, posting.salary_max || undefined, 'USD', 'year') : undefined,
      currency: hasSalary ? 'USD' : undefined,
      postedAt: posting.date ?? undefined,
      applyUrl: canonicalUrl(posting.url) ?? posting.url,
      description: htmlToText(posting.description),
    };
  },
};
