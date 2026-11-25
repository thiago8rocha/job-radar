import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, formatRange, isoFromEpoch, jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const envelopeSchema = z.array(z.unknown());

const postingSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number().nullish(),
  workplaceType: z.string().nullish(),
  country: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
      commitment: z.string().nullish(),
    })
    .nullish(),
  descriptionPlain: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
});

export type LeverPosting = z.infer<typeof postingSchema>;

export interface LeverRaw {
  company: CompanyRef;
  posting: LeverPosting;
}

/** Lever postings API: `api.lever.co/v0/postings/{company}?mode=json`, or `api.eu.lever.co` for boards on the EU region, one request per company. */
export const lever: SourceAdapter<LeverRaw> = {
  id: 'lever',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('lever', ctx, async (company) => {
      const board = resolveBoard('lever', company);
      const host = board.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
      const data = await ctx.http.getJson(`https://${host}/v0/postings/${encodeURIComponent(board.slug)}?mode=json`);
      const postings = parseEnvelope('lever', envelopeSchema, data);
      return parseItems('lever', postingSchema, postings, ctx).map((posting) => ({ company, posting }));
    });
  },

  normalize({ company, posting }): Job {
    const locations = posting.categories?.allLocations?.length
      ? posting.categories.allLocations
      : posting.categories?.location
        ? [posting.categories.location]
        : [];
    const salary = posting.salaryRange;
    return {
      id: jobId('lever', resolveBoard('lever', company).slug, posting.id),
      source: 'lever',
      atsApply: true,
      company: companyName({ ...company, slug: resolveBoard('lever', company).slug }),
      title: posting.text.trim(),
      locations,
      workModel: workModelFrom(posting.workplaceType),
      seniority: [],
      contracts: [],
      compensation: formatRange(salary?.min, salary?.max, salary?.currency, salary?.interval),
      postedAt: isoFromEpoch(posting.createdAt ?? undefined, 'ms'),
      applyUrl: canonicalUrl(posting.hostedUrl) ?? posting.hostedUrl,
      description: [posting.descriptionPlain, posting.additionalPlain].filter(Boolean).join('\n\n'),
    };
  },
};
