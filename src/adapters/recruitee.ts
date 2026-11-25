import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, formatRange, jobId } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const envelopeSchema = z.object({ offers: z.array(z.unknown()) });

const postingSchema = z.object({
  id: z.number(),
  title: z.string(),
  company_name: z.string().nullish(),
  careers_url: z.string(),
  status: z.string().nullish(),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  on_site: z.boolean().nullish(),
  location: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  employment_type_code: z.string().nullish(),
  published_at: z.string().nullish(),
  salary: z
    .object({ min: z.coerce.number().nullish(), max: z.coerce.number().nullish(), currency: z.string().nullish(), period: z.string().nullish() })
    .nullish(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
});

export type RecruiteePosting = z.infer<typeof postingSchema>;

export interface RecruiteeRaw {
  company: CompanyRef;
  posting: RecruiteePosting;
}

/** Recruitee writes `2026-11-10 07:45:05 UTC`. */
function isoFromRecruitee(value: string | null | undefined): string | undefined {
  const date = value ? new Date(value.replace(' UTC', 'Z').replace(' ', 'T')) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

/** Recruitee career site API: `{company}.recruitee.com/api/offers/`, public and keyless, the whole board in one request. */
export const recruitee: SourceAdapter<RecruiteeRaw> = {
  id: 'recruitee',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('recruitee', ctx, async (company) => {
      const { slug } = resolveBoard('recruitee', company);
      const data = await ctx.http.getJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`);
      const { offers } = parseEnvelope('recruitee', envelopeSchema, data);
      return parseItems('recruitee', postingSchema, offers, ctx)
        .filter((posting) => !posting.status || posting.status === 'published')
        .map((posting) => ({ company, posting }));
    });
  },

  normalize({ company, posting }): Job {
    const { slug } = resolveBoard('recruitee', company);
    const place = posting.location && !/remote/i.test(posting.location) ? posting.location : [posting.city, posting.country].filter(Boolean).join(', ');
    const salary = posting.salary;
    return {
      id: jobId('recruitee', slug, posting.id),
      source: 'recruitee',
      atsApply: true,
      company: companyName({ ...company, slug }, posting.company_name),
      title: posting.title.trim(),
      locations: place ? [place] : [],
      workModel: posting.remote ? 'remote' : posting.hybrid ? 'hybrid' : posting.on_site ? 'onsite' : undefined,
      seniority: [],
      contracts: posting.employment_type_code ? [posting.employment_type_code] : [],
      compensation: formatRange(salary?.min, salary?.max, salary?.currency, salary?.period),
      postedAt: isoFromRecruitee(posting.published_at),
      applyUrl: canonicalUrl(posting.careers_url) ?? posting.careers_url,
      description: [posting.description, posting.requirements].map((part) => htmlToText(part)).filter(Boolean).join('\n\n'),
    };
  },
};
