import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { companyName, forEachCompany, jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

const postingSchema = z.object({
  id: z.string(),
  title: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  publishedAt: z.string().nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  jobUrl: z.string(),
  descriptionPlain: z.string().nullish(),
  compensation: z
    .object({
      compensationTierSummary: z.string().nullish(),
      scrapeableCompensationSalarySummary: z.string().nullish(),
    })
    .nullish(),
});

export type AshbyPosting = z.infer<typeof postingSchema>;

export interface AshbyRaw {
  company: CompanyRef;
  posting: AshbyPosting;
}

/** Ashby public job board API: `api.ashbyhq.com/posting-api/job-board/{company}`, one request per company. */
export const ashby: SourceAdapter<AshbyRaw> = {
  id: 'ashby',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('ashby', ctx, async (company) => {
      const data = await ctx.http.getJson(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.slug)}?includeCompensation=true`,
      );
      const { jobs } = parseEnvelope('ashby', envelopeSchema, data);
      return parseItems('ashby', postingSchema, jobs, ctx)
        .filter((posting) => posting.isListed !== false)
        .map((posting) => ({ company, posting }));
    });
  },

  normalize({ company, posting }): Job {
    const locations = [posting.location, ...(posting.secondaryLocations ?? []).map((item) => item.location)]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const compensation = posting.compensation;
    return {
      id: jobId('ashby', company.slug, posting.id),
      source: 'ashby',
      atsApply: true,
      company: companyName(company),
      title: posting.title.trim(),
      locations,
      workModel: workModelFrom(posting.workplaceType) ?? (posting.isRemote ? 'remote' : undefined),
      seniority: [],
      contracts: [],
      compensation:
        compensation?.scrapeableCompensationSalarySummary ?? compensation?.compensationTierSummary ?? undefined,
      postedAt: posting.publishedAt ?? undefined,
      applyUrl: canonicalUrl(posting.jobUrl) ?? posting.jobUrl,
      description: posting.descriptionPlain ?? '',
    };
  },
};
