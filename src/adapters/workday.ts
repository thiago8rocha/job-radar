import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { companyName, forEachCompany, jobId, searchTerms, workModelFrom } from './common.js';
import type { FetchContext, SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

// Workday rejects a larger page.
const PAGE_SIZE = 20;
const MAX_PAGES_PER_TERM = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const envelopeSchema = z.object({ total: z.number().nullish(), jobPostings: z.array(z.unknown()) });

const postingSchema = z.object({
  title: z.string(),
  externalPath: z.string(),
  locationsText: z.string().nullish(),
  postedOn: z.string().nullish(),
  bulletFields: z.array(z.string()).nullish(),
});

const detailSchema = z.object({
  jobPostingInfo: z.object({
    jobDescription: z.string().nullish(),
    startDate: z.string().nullish(),
    timeType: z.string().nullish(),
    remoteType: z.string().nullish(),
    location: z.string().nullish(),
    externalUrl: z.string().nullish(),
  }),
});

export type WorkdayPosting = z.infer<typeof postingSchema>;
export type WorkdayDetail = z.infer<typeof detailSchema>['jobPostingInfo'];

export interface WorkdayRaw {
  company: CompanyRef;
  /** Public career site, `https://{tenant}.wd{N}.myworkdayjobs.com/{site}`. */
  site: string;
  postedAt?: string;
  posting: WorkdayPosting;
  detail?: WorkdayDetail;
}

interface Site {
  origin: string;
  tenant: string;
  name: string;
}

/** A Workday site needs its host and site name, which a slug cannot carry: entries are `{ url: https://{tenant}.wd{N}.myworkdayjobs.com/{site} }`. */
function parseSite(company: CompanyRef): Site {
  const match = company.url && /^(https:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([^/?#]+)/i.exec(company.url);
  if (!match) throw new Error('workday entries need the career site URL, as { url: https://<tenant>.wd5.myworkdayjobs.com/<site> }');
  return { origin: match[1]!, tenant: match[2]!, name: match[3]! };
}

/** "Posted Yesterday", "Posted 6 Days Ago"; "Posted 30+ Days Ago" has no usable date. */
function postedAtFrom(text: string | null | undefined, now: Date): string | undefined {
  const label = (text ?? '').toLowerCase();
  const days = /today/.test(label) ? 0 : /yesterday/.test(label) ? 1 : /^posted (\d+) days? ago$/.exec(label)?.[1];
  return days === undefined ? undefined : new Date(now.getTime() - Number(days) * DAY_MS).toISOString();
}

async function search(ctx: FetchContext, site: Site, term: string, seen: Map<string, WorkdayPosting>): Promise<void> {
  for (let page = 0; page < MAX_PAGES_PER_TERM; page++) {
    const data = await ctx.http.getJson(`${site.origin}/wday/cxs/${site.tenant}/${site.name}/jobs`, {
      method: 'POST',
      body: { appliedFacets: {}, limit: PAGE_SIZE, offset: page * PAGE_SIZE, searchText: term },
    });
    const { total, jobPostings } = parseEnvelope('workday', envelopeSchema, data);
    for (const posting of parseItems('workday', postingSchema, jobPostings, ctx)) seen.set(posting.externalPath, posting);
    if ((page + 1) * PAGE_SIZE >= (total ?? 0) || jobPostings.length === 0) return;
    if (page === MAX_PAGES_PER_TERM - 1) ctx.warn(`workday/${site.tenant}: "${term}" has ${total} postings, read the first ${MAX_PAGES_PER_TERM * PAGE_SIZE}`);
  }
}

/**
 * Workday career sites: `POST {origin}/wday/cxs/{tenant}/{site}/jobs`. The search runs once per
 * `search.include` term so large employers need few pages; the list has no description, so the detail is
 * read only for postings that could pass the filters.
 */
export const workday: SourceAdapter<WorkdayRaw> = {
  id: 'workday',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('workday', ctx, async (company) => {
      const site = parseSite(company);
      const postings = new Map<string, WorkdayPosting>();
      for (const term of searchTerms(ctx.config.search.include)) await search(ctx, site, term, postings);

      const raws: WorkdayRaw[] = [];
      for (const posting of postings.values()) {
        const raw: WorkdayRaw = { company, site: `${site.origin}/${site.name}`, postedAt: postedAtFrom(posting.postedOn, ctx.now), posting };
        const wanted = ctx.worthDetails({ title: posting.title, company: companyName(company, site.tenant), workModel: workModelFrom(posting.locationsText) });
        if (!wanted || ctx.isKnownUrl?.(`${raw.site}${posting.externalPath}`)) {
          raws.push(raw);
          continue;
        }
        try {
          const detail = await ctx.http.getJson(`${site.origin}/wday/cxs/${site.tenant}/${site.name}${posting.externalPath}`);
          raws.push({ ...raw, detail: parseEnvelope('workday', detailSchema, detail).jobPostingInfo });
        } catch (error) {
          ctx.warn(`workday/${site.tenant}: detail of ${posting.externalPath} skipped (${(error as Error).message})`);
          raws.push(raw);
        }
      }
      return raws;
    });
  },

  normalize({ company, site, postedAt, posting, detail }): Job {
    const { tenant } = parseSite(company);
    const url = `${site}${posting.externalPath}`;
    const place = detail?.location ?? posting.locationsText;
    return {
      id: jobId('workday', tenant, posting.bulletFields?.[0] ?? posting.externalPath),
      source: 'workday',
      atsApply: true,
      company: companyName({ ...company, slug: tenant }),
      title: posting.title.trim(),
      locations: place ? [place] : [],
      workModel: workModelFrom(detail?.remoteType) ?? workModelFrom(posting.locationsText),
      seniority: [],
      contracts: detail?.timeType ? [detail.timeType] : [],
      postedAt: detail?.startDate ?? postedAt,
      applyUrl: canonicalUrl(url) ?? url,
      description: htmlToText(detail?.jobDescription),
    };
  },
};
