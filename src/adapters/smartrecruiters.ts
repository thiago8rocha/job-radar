import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, jobId, searchTerms } from './common.js';
import type { FetchContext, SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_TERM = 5;

const envelopeSchema = z.object({ totalFound: z.number(), content: z.array(z.unknown()) });

const labelSchema = z.object({ label: z.string().nullish() }).nullish();

const postingSchema = z.object({
  id: z.string(),
  name: z.string(),
  company: z.object({ name: z.string().nullish() }).nullish(),
  releasedDate: z.string().nullish(),
  location: z
    .object({ city: z.string().nullish(), region: z.string().nullish(), country: z.string().nullish(), remote: z.boolean().nullish(), hybrid: z.boolean().nullish(), fullLocation: z.string().nullish() })
    .nullish(),
  typeOfEmployment: labelSchema,
  postingUrl: z.string().nullish(),
  jobAd: z.object({ sections: z.record(z.string(), z.object({ text: z.string().nullish() }).nullish()) }).nullish(),
});

export type SmartRecruitersPosting = z.infer<typeof postingSchema>;

export interface SmartRecruitersRaw {
  company: CompanyRef;
  posting: SmartRecruitersPosting;
  detail?: SmartRecruitersPosting;
}

async function searchTerm(ctx: FetchContext, slug: string, term: string, seen: Map<string, SmartRecruitersPosting>): Promise<void> {
  for (let page = 0; page < MAX_PAGES_PER_TERM; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), q: term });
    const data = await ctx.http.getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?${query}`);
    const { totalFound, content } = parseEnvelope('smartrecruiters', envelopeSchema, data);
    for (const posting of parseItems('smartrecruiters', postingSchema, content, ctx)) seen.set(posting.id, posting);
    if ((page + 1) * PAGE_SIZE >= totalFound || content.length === 0) return;
    if (page === MAX_PAGES_PER_TERM - 1) ctx.warn(`smartrecruiters/${slug}: "${term}" has ${totalFound} postings, read the first ${MAX_PAGES_PER_TERM * PAGE_SIZE}`);
  }
}

/**
 * SmartRecruiters Posting API: `api.smartrecruiters.com/v1/companies/{id}/postings`. The company id is
 * case sensitive, and an unknown one answers 200 with no postings, so a wrong id looks like an empty
 * board. The list has no description or apply link: those come from one detail request per posting
 * that could pass the filters.
 */
export const smartrecruiters: SourceAdapter<SmartRecruitersRaw> = {
  id: 'smartrecruiters',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('smartrecruiters', ctx, async (company) => {
      const { slug } = resolveBoard('smartrecruiters', company);
      const postings = new Map<string, SmartRecruitersPosting>();
      for (const term of searchTerms(ctx.config.search.include)) await searchTerm(ctx, slug, term, postings);

      const raws: SmartRecruitersRaw[] = [];
      for (const posting of postings.values()) {
        const location = posting.location;
        const wanted = ctx.worthDetails({
          title: posting.name,
          company: companyName(company, posting.company?.name),
          workModel: location?.remote ? 'remote' : location?.hybrid ? 'hybrid' : undefined,
        });
        if (!wanted || ctx.isKnownUrl?.(`https://jobs.smartrecruiters.com/${slug}/${posting.id}`)) {
          raws.push({ company, posting });
          continue;
        }
        try {
          const detail = await ctx.http.getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings/${posting.id}`);
          raws.push({ company, posting, detail: parseEnvelope('smartrecruiters', postingSchema, detail) });
        } catch (error) {
          ctx.warn(`smartrecruiters/${slug}: detail of ${posting.id} skipped (${(error as Error).message})`);
          raws.push({ company, posting });
        }
      }
      return raws;
    });
  },

  normalize({ company, posting, detail }): Job {
    const { slug } = resolveBoard('smartrecruiters', company);
    const location = posting.location;
    const place = location?.fullLocation ?? [location?.city, location?.region, location?.country?.toUpperCase()].filter(Boolean).join(', ');
    const url = detail?.postingUrl ?? posting.postingUrl ?? `https://jobs.smartrecruiters.com/${slug}/${posting.id}`;
    const sections = Object.values(detail?.jobAd?.sections ?? {}).map((section) => htmlToText(section?.text));
    return {
      id: jobId('smartrecruiters', slug, posting.id),
      source: 'smartrecruiters',
      atsApply: true,
      company: companyName({ ...company, slug }, posting.company?.name),
      title: posting.name.trim(),
      locations: place ? [place] : [],
      workModel: location?.remote ? 'remote' : location?.hybrid ? 'hybrid' : undefined,
      seniority: [],
      contracts: posting.typeOfEmployment?.label ? [posting.typeOfEmployment.label] : [],
      postedAt: posting.releasedDate ?? undefined,
      applyUrl: canonicalUrl(url) ?? url,
      description: sections.filter(Boolean).join('\n\n'),
    };
  },
};
