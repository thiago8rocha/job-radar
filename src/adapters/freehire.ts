import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { asCurrency, formatRange, jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const SEARCH = 'https://freehire.me/api/v1/agent/jobs/search';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const MAX_ALTERNATIVES = 5; // the API rejects a sixth `OR` alternative

const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ total: z.number().optional() }).nullish(),
});

const postingSchema = z.object({
  public_slug: z.string(),
  title: z.string(),
  company: z.string(),
  company_slug: z.string().nullish(),
  url: z.string(),
  location: z.string().nullish(),
  description: z.string().nullish(),
  countries: z.array(z.string()).nullish(),
  regions: z.array(z.string()).nullish(),
  work_mode: z.string().nullish(),
  posted_at: z.string().nullish(),
  created_at: z.string().nullish(),
  enrichment: z
    .object({
      seniority: z.string().nullish(),
      salary_min: z.number().nullish(),
      salary_max: z.number().nullish(),
      salary_currency: z.string().nullish(),
      salary_period: z.string().nullish(),
    })
    .nullish(),
});

export type FreehirePosting = z.infer<typeof postingSchema>;

/** The `search.accept_regions` values freehire can filter on; `americas` has no equivalent without pulling in the US. */
const REGION_FACETS: Record<string, string> = { worldwide: 'global', latam: 'latam' };

function searchTerms(include: string[]): string[] {
  const seen = new Set<string>();
  return include
    .map((term) => term.replace(/"/g, '').trim())
    .filter((term) => {
      const key = term.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function queries(include: string[]): string[] {
  const alternatives = searchTerms(include).map((term) => `title:"${term}"`);
  const chunks: string[] = [];
  for (let i = 0; i < alternatives.length; i += MAX_ALTERNATIVES) {
    chunks.push(alternatives.slice(i, i + MAX_ALTERNATIVES).join(' OR '));
  }
  return chunks;
}

/**
 * freehire.me, an aggregator of about 50 ATS behind one public JSON API (no key). Titles are searched
 * with `title:` alternatives, so a posting that only mentions "QA" in its text does not come back.
 * Geography is a facet, not text: `regions` and `countries` are ORed together. The service is a
 * personal project with no SLA, so a failure here only costs this source.
 */
export const freehire: SourceAdapter<FreehirePosting> = {
  id: 'freehire',
  mode: 'search',

  async fetch(ctx) {
    const { accept_regions: accepted } = ctx.config.eligibility;
    const regions = accepted.map((region) => REGION_FACETS[region]).filter((facet): facet is string => Boolean(facet));
    const remoteOnly = ctx.config.work_model.length === 1 && ctx.config.work_model[0] === 'remote';
    const bySlug = new Map<string, FreehirePosting>();

    for (const q of queries(ctx.config.search.include)) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          q,
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
          posted_within_days: String(ctx.config.search.max_age_days),
          description_format: 'text',
        });
        for (const region of regions) params.append('regions', region);
        if (accepted.includes('brazil')) params.append('countries', 'br');
        if (remoteOnly) params.set('work_mode', 'remote');

        const { data, meta } = parseEnvelope('freehire', envelopeSchema, await ctx.http.getJson(`${SEARCH}?${params}`));
        for (const posting of parseItems('freehire', postingSchema, data, ctx)) bySlug.set(posting.public_slug, posting);
        if (data.length === 0 || (page + 1) * PAGE_SIZE >= (meta?.total ?? 0)) break;
      }
    }
    return [...bySlug.values()];
  },

  normalize(posting): Job {
    const countries = (posting.countries ?? []).map((code) => code.toUpperCase());
    const regions = posting.regions ?? [];
    // Named countries make the posting open only to them; ISO codes let one that excludes Brazil fail the region check.
    // The region facet is only a fallback, because a "global" posting can still say "India" in its location.
    const fallback = regions.includes('latam') ? ['Latin America'] : regions.includes('global') ? ['Worldwide'] : [];
    const restrictions = countries.length > 0 ? countries : posting.location ? [] : fallback;
    const enrichment = posting.enrichment;
    const seniority = enrichment?.seniority?.toLowerCase();

    return {
      id: jobId('freehire', posting.company_slug ?? posting.company, posting.public_slug),
      source: 'freehire',
      atsApply: false,
      company: posting.company.trim(),
      title: posting.title.trim(),
      locations: posting.location ? [posting.location] : [],
      restrictions,
      workModel: workModelFrom(posting.work_mode),
      seniority: seniority ? [seniority] : [],
      contracts: [],
      compensation: formatRange(enrichment?.salary_min, enrichment?.salary_max, enrichment?.salary_currency, enrichment?.salary_period),
      currency: asCurrency(enrichment?.salary_currency),
      postedAt: posting.posted_at ?? posting.created_at ?? undefined,
      applyUrl: canonicalUrl(posting.url) ?? posting.url,
      description: posting.description?.trim() ?? '',
    };
  },
};
