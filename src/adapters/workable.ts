import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, jobId } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const envelopeSchema = z.object({ name: z.string().nullish(), jobs: z.array(z.unknown()) });

const postingSchema = z.object({
  shortcode: z.string(),
  title: z.string(),
  url: z.string(),
  telecommuting: z.boolean().nullish(),
  employment_type: z.string().nullish(),
  published_on: z.string().nullish(),
  created_at: z.string().nullish(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  locations: z
    .array(z.object({ country: z.string().nullish(), city: z.string().nullish(), region: z.string().nullish(), hidden: z.boolean().nullish() }))
    .nullish(),
  description: z.string().nullish(),
});

export type WorkablePosting = z.infer<typeof postingSchema>;

export interface WorkableRaw {
  company: CompanyRef;
  /** The account's display name, from the envelope. */
  account?: string;
  posting: WorkablePosting;
}

/** Workable widget API: `apply.workable.com/api/v1/widget/accounts/{company}?details=true`, the whole board in one request. */
export const workable: SourceAdapter<WorkableRaw> = {
  id: 'workable',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('workable', ctx, async (company) => {
      const { slug } = resolveBoard('workable', company);
      const data = await ctx.http.getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`);
      const { name, jobs } = parseEnvelope('workable', envelopeSchema, data);
      return parseItems('workable', postingSchema, jobs, ctx).map((posting) => ({ company, account: name ?? undefined, posting }));
    });
  },

  normalize({ company, account, posting }): Job {
    const board = resolveBoard('workable', company).slug;
    const places = (posting.locations ?? [])
      .filter((place) => !place.hidden)
      .map((place) => [place.city, place.region, place.country].filter(Boolean).join(', '))
      .filter(Boolean);
    const fallback = [posting.city, posting.country].filter(Boolean).join(', ');
    return {
      id: jobId('workable', board, posting.shortcode),
      source: 'workable',
      atsApply: true,
      company: companyName({ ...company, slug: board }, account),
      title: posting.title.trim(),
      locations: places.length > 0 ? places : fallback ? [fallback] : [],
      workModel: posting.telecommuting ? 'remote' : undefined,
      seniority: [],
      contracts: posting.employment_type ? [posting.employment_type] : [],
      postedAt: posting.published_on ?? posting.created_at ?? undefined,
      applyUrl: canonicalUrl(posting.url) ?? posting.url,
      description: htmlToText(posting.description),
    };
  },
};
