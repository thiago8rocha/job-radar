import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { companyName, forEachCompany, jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const envelopeSchema = z.object({ jobs: z.array(z.unknown()) });

const postingSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  company_name: z.string().nullish(),
  content: z.string().nullish(),
  metadata: z
    .array(z.object({ name: z.string(), value: z.unknown() }))
    .nullish(),
});

export type GreenhousePosting = z.infer<typeof postingSchema>;

export interface GreenhouseRaw {
  company: CompanyRef;
  posting: GreenhousePosting;
}

/** Greenhouse board API: `boards-api.greenhouse.io/v1/boards/{company}/jobs`, one request per company. */
export const greenhouse: SourceAdapter<GreenhouseRaw> = {
  id: 'greenhouse',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('greenhouse', ctx, async (company) => {
      const data = await ctx.http.getJson(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.slug)}/jobs?content=true`,
      );
      const { jobs } = parseEnvelope('greenhouse', envelopeSchema, data);
      return parseItems('greenhouse', postingSchema, jobs, ctx).map((posting) => ({ company, posting }));
    });
  },

  normalize({ company, posting }): Job {
    const name = companyName(company, posting.company_name);
    const workplace = posting.metadata?.find((item) => /workplace type/i.test(item.name));
    const location = posting.location?.name?.trim();
    return {
      id: jobId('greenhouse', company.slug, posting.id),
      source: 'greenhouse',
      atsApply: true,
      company: name,
      title: posting.title.trim(),
      locations: location ? [location] : [],
      workModel: workModelFrom(typeof workplace?.value === 'string' ? workplace.value : location),
      seniority: [],
      contracts: [],
      postedAt: posting.first_published ?? posting.updated_at ?? undefined,
      applyUrl: canonicalUrl(posting.absolute_url) ?? posting.absolute_url,
      description: htmlToText(posting.content, { escaped: true }),
    };
  },
};
