import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, formatRange, jobId, workModelFrom } from './common.js';
import { SchemaError, type FetchContext, type SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const MAX_PAGES = 5;
const ACCOUNT_ID = /^[0-9a-f]{24}$/;

const envelopeSchema = z.object({ docs: z.array(z.unknown()), pages: z.number().nullish() });

const amount = z.union([z.number(), z.string()]).nullish();

const postingSchema = z.object({
  _id: z.string(),
  publicate: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
  city: z.string().nullish(),
  region: z.string().nullish(),
  country: z.string().nullish(),
  workplace_type: z.string().nullish(),
  career_url: z.string().nullish(),
  created_at: z.string().nullish(),
  remuneration: amount,
  currency: z.string().nullish(),
});

export type QuickinPosting = z.infer<typeof postingSchema>;

export interface QuickinRaw {
  company: CompanyRef;
  posting: QuickinPosting;
}

function numberOf(value: z.infer<typeof amount>): number | undefined {
  const brazilian = (text: string) => text.replace(/\./g, '').replace(',', '.');
  const parsed = typeof value === 'string' ? Number(/,\d{1,2}$|^\d{1,3}(\.\d{3})+$/.test(value.trim()) ? brazilian(value.trim()) : value.replace(/[^\d.]/g, '')) : value;
  return parsed != null && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The API is keyed by account id, not by the slug in the career page URL. The id sits next to the slug
 * in the page's Nuxt payload; it is read once and kept in `ctx.resolved`, which `collect` persists.
 */
async function accountId(ctx: FetchContext, slug: string): Promise<string> {
  if (ACCOUNT_ID.test(slug)) return slug;
  const key = `quickin:${slug.toLowerCase()}`;
  const known = ctx.resolved?.[key];
  if (known) return known;
  const page = await ctx.http.getText(`https://jobs.quickin.io/${encodeURIComponent(slug)}`);
  const id = new RegExp(`"${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}","([0-9a-f]{24})"`, 'i').exec(page)?.[1];
  if (!id) throw new SchemaError('quickin', `no account id found on the career page of "${slug}"`);
  if (ctx.resolved) ctx.resolved[key] = id;
  return id;
}

/** Quickin public jobs API: `api.quickin.io/public/{account id}/jobs`, newest first. */
export const quickin: SourceAdapter<QuickinRaw> = {
  id: 'quickin',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('quickin', ctx, async (company) => {
      const { slug } = resolveBoard('quickin', company);
      const id = await accountId(ctx, slug);
      const postings: QuickinPosting[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await ctx.http.getJson(`https://api.quickin.io/public/${id}/jobs?sort=-created_at&page=${page}`);
        const { docs, pages } = parseEnvelope('quickin', envelopeSchema, data);
        postings.push(...parseItems('quickin', postingSchema, docs, ctx));
        if (page >= (pages ?? 1) || docs.length === 0) break;
      }
      return postings.filter((posting) => !posting.publicate || posting.publicate === 'published').map((posting) => ({ company, posting }));
    });
  },

  normalize({ company, posting }): Job {
    const { slug } = resolveBoard('quickin', company);
    const place = [posting.city, posting.region, posting.country].filter(Boolean).join(', ');
    const url = posting.career_url ?? `https://jobs.quickin.io/${slug}/jobs/${posting._id}`;
    const pay = numberOf(posting.remuneration);
    return {
      id: jobId('quickin', slug, posting._id),
      source: 'quickin',
      atsApply: true,
      company: companyName({ ...company, slug }),
      title: posting.title.trim(),
      locations: place ? [place] : [],
      workModel: workModelFrom(posting.workplace_type),
      seniority: [],
      contracts: [],
      compensation: formatRange(pay, pay, posting.currency ?? 'BRL'),
      postedAt: posting.created_at ?? undefined,
      applyUrl: canonicalUrl(url) ?? url,
      description: [posting.description, posting.requirements].map((part) => htmlToText(part)).filter(Boolean).join('\n\n'),
    };
  },
};
