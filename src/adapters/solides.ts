import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, formatRange, jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

// The API rejects a larger page with "take must not be greater than 25".
const PAGE_SIZE = 25;
const MAX_PAGES = 6;

const envelopeSchema = z.object({ totalPages: z.number().nullish(), data: z.array(z.unknown()) });

const named = z.array(z.object({ name: z.string() })).nullish();

const postingSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string(),
  description: z.string().nullish(),
  companyName: z.string().nullish(),
  slug: z.string().nullish(),
  currentState: z.string().nullish(),
  jobType: z.string().nullish(),
  homeOffice: z.boolean().nullish(),
  city: z.object({ name: z.string().nullish() }).nullish(),
  state: z.object({ code: z.string().nullish() }).nullish(),
  recruitmentContractType: named,
  createdAt: z.string().nullish(),
  salary: z
    .object({ showRangeToApplicant: z.boolean().nullish(), initialRange: z.number().nullish(), finalRange: z.number().nullish() })
    .nullish(),
});

export type SolidesPosting = z.infer<typeof postingSchema>;

export interface SolidesRaw {
  company: CompanyRef;
  posting: SolidesPosting;
}

/** Sólides vacancies API used by the company career pages: `apigw.solides.com.br/jobs/v3/companies/{slug}/vacancies`. */
export const solides: SourceAdapter<SolidesRaw> = {
  id: 'solides',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('solides', ctx, async (company) => {
      const { slug } = resolveBoard('solides', company);
      const postings: SolidesPosting[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await ctx.http.getJson(`https://apigw.solides.com.br/jobs/v3/companies/${encodeURIComponent(slug)}/vacancies?take=${PAGE_SIZE}&page=${page}`);
        const { totalPages, data: items } = parseEnvelope('solides', envelopeSchema, data);
        postings.push(...parseItems('solides', postingSchema, items, ctx));
        if (page >= (totalPages ?? 1) || items.length === 0) break;
      }
      return postings.filter((posting) => !posting.currentState || posting.currentState === 'em_andamento').map((posting) => ({ company, posting }));
    });
  },

  normalize({ company, posting }): Job {
    const { slug } = resolveBoard('solides', company);
    const place = [posting.city?.name, posting.state?.code].filter(Boolean).join(', ');
    const range = posting.salary?.showRangeToApplicant ? posting.salary : undefined;
    const url = `https://${slug}.vagas.solides.com.br/vaga/${posting.id}`;
    return {
      id: jobId('solides', slug, posting.id),
      source: 'solides',
      atsApply: true,
      company: companyName({ ...company, slug }, posting.companyName),
      title: posting.title.trim(),
      locations: place ? [place] : [],
      workModel: workModelFrom(posting.jobType) ?? (posting.homeOffice ? 'remote' : undefined),
      seniority: [],
      contracts: (posting.recruitmentContractType ?? []).map((contract) => contract.name),
      compensation: formatRange(range?.initialRange, range?.finalRange, 'BRL'),
      postedAt: posting.createdAt ?? undefined,
      applyUrl: canonicalUrl(url) ?? url,
      description: htmlToText(posting.description),
    };
  },
};
