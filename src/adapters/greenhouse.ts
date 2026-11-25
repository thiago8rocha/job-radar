import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { companyName, forEachCompany, formatRange, jobId, workModelFrom } from './common.js';
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
  pay_input_ranges: z
    .array(
      z.object({
        min_cents: z.number().nullish(),
        max_cents: z.number().nullish(),
        currency_type: z.string().nullish(),
      }),
    )
    .nullish(),
});

export type GreenhousePosting = z.infer<typeof postingSchema>;

export interface GreenhouseRaw {
  company: CompanyRef;
  posting: GreenhousePosting;
}

function workplaceOf(posting: GreenhousePosting) {
  const workplace = posting.metadata?.find((item) => /workplace type/i.test(item.name));
  return workModelFrom(typeof workplace?.value === 'string' ? workplace.value : posting.location?.name?.trim());
}

/**
 * Greenhouse board API: `boards-api.greenhouse.io/v1/boards/{company}/jobs`, one request per company.
 * Companies from the directory are read lightly: titles first, then the detail of the postings that
 * could pass the filters, which also carries the published pay ranges.
 */
export const greenhouse: SourceAdapter<GreenhouseRaw> = {
  id: 'greenhouse',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('greenhouse', ctx, async (company) => {
      const board = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.slug)}/jobs`;
      const data = await ctx.http.getJson(company.light ? board : `${board}?content=true`);
      const { jobs } = parseEnvelope('greenhouse', envelopeSchema, data);
      const postings = parseItems('greenhouse', postingSchema, jobs, ctx);
      if (!company.light) return postings.map((posting) => ({ company, posting }));

      const raws: GreenhouseRaw[] = [];
      for (const posting of postings) {
        const wanted = ctx.worthDetails({ title: posting.title, company: companyName(company, posting.company_name), workModel: workplaceOf(posting) });
        if (!wanted || ctx.isKnownUrl?.(posting.absolute_url)) {
          raws.push({ company, posting });
          continue;
        }
        try {
          const detail = await ctx.http.getJson(`${board}/${posting.id}?pay_transparency=true`);
          raws.push({ company, posting: parseEnvelope('greenhouse', postingSchema, detail) });
        } catch (error) {
          ctx.warn(`greenhouse/${company.slug}: detail of ${posting.id} skipped (${(error as Error).message})`);
        }
      }
      return raws;
    });
  },

  normalize({ company, posting }): Job {
    const name = companyName(company, posting.company_name);
    const location = posting.location?.name?.trim();
    const pay = posting.pay_input_ranges?.[0];
    return {
      id: jobId('greenhouse', company.slug, posting.id),
      source: 'greenhouse',
      atsApply: true,
      company: name,
      title: posting.title.trim(),
      locations: location ? [location] : [],
      workModel: workplaceOf(posting),
      seniority: [],
      contracts: [],
      compensation: pay ? formatRange(pay.min_cents != null ? pay.min_cents / 100 : null, pay.max_cents != null ? pay.max_cents / 100 : null, pay.currency_type) : undefined,
      postedAt: posting.first_published ?? posting.updated_at ?? undefined,
      applyUrl: canonicalUrl(posting.absolute_url) ?? posting.absolute_url,
      description: htmlToText(posting.content, { escaped: true }),
    };
  },
};
