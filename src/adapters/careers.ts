import { jobFromJsonLd, isExpired, jsonLdJobPostings } from '../careers/jsonld.js';
import { createRobotsReader, type Robots } from '../careers/robots.js';
import { parseSitemap, titleFromUrl } from '../careers/sitemap.js';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { ATS, slugKey, type AtsTable } from './ats.js';
import { forEachCompany } from './common.js';
import type { FetchContext, SourceAdapter } from './types.js';

export type CareersMethod = 'ats' | 'jsonld' | 'sitemap';

export interface CareersRaw {
  method: CareersMethod;
  job: Job;
}

const DEFAULT_MAX_URLS = 100;
const MAX_CHILD_SITEMAPS = 3;
const JOB_SITEMAP = /job|career|vaga|vacanc|position|opening|posting/i;

/** The ATS adapter and board entry a link points at, if it is one of the per-company ATS. */
function atsFor(url: string): { id: string; ref: CompanyRef } | undefined {
  const table: AtsTable = ATS;
  for (const def of table) {
    if (def.id === 'careers') continue;
    for (const { pattern, ignore = [] } of def.urls) {
      const slug = pattern.exec(url)?.[1];
      if (slug && !ignore.includes(slug.toLowerCase())) return { id: def.id, ref: { slug: def.urlOnly ? url : slugKey(def, slug), url } };
    }
  }
  return undefined;
}

/** The first link in the page that is a board of a supported ATS, including the Greenhouse embed `?for=` form. */
function embeddedAts(html: string): ReturnType<typeof atsFor> {
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    const link = match[0].replace(/&amp;/g, '&');
    const embedded = /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/i.exec(link)?.[1];
    const found = atsFor(embedded ? `https://boards.greenhouse.io/${embedded}` : link);
    if (found) return found;
  }
  return undefined;
}

async function viaAts(ctx: FetchContext, found: NonNullable<ReturnType<typeof atsFor>>): Promise<CareersRaw[]> {
  // Loaded on use: the adapter registry imports this module.
  const { ADAPTERS } = await import('./index.js');
  const adapter = ADAPTERS[found.id]!;
  const raws = await adapter.fetch({ ...ctx, companies: [found.ref], onCompany: undefined });
  return raws.map((raw) => ({ method: 'ats' as const, job: { ...adapter.normalize(raw), foundBy: 'ats' } }));
}

function looksLikeJobSitemap(url: string): boolean {
  return JOB_SITEMAP.test(url);
}

async function readPosting(ctx: FetchContext, company: CompanyRef, robots: (url: string) => Promise<Robots>, url: string, method: CareersMethod): Promise<CareersRaw[]> {
  if (!(await robots(url)).allows(url)) {
    ctx.warn(`careers/${company.slug}: robots.txt disallows ${url}, skipped`);
    return [];
  }
  const { postings, invalid } = jsonLdJobPostings(await ctx.http.getText(url));
  if (invalid > 0) ctx.warn(`careers/${company.slug}: ${invalid} JobPosting block(s) on ${url} skipped (missing title)`);
  return postings.filter((posting) => !isExpired(posting, ctx.now)).map((posting) => ({ method, job: jobFromJsonLd(posting, company, url, method) }));
}

async function viaSitemap(ctx: FetchContext, company: CompanyRef, robots: (url: string) => Promise<Robots>, sitemapUrls: string[]): Promise<CareersRaw[] | undefined> {
  const host = new URL(company.url!).host;
  const pages: string[] = [];
  const queue = [...sitemapUrls];
  let children = 0;
  while (queue.length > 0) {
    const sitemapUrl = queue.shift()!;
    if (!(await robots(sitemapUrl)).allows(sitemapUrl)) continue;
    const sitemap = parseSitemap(await ctx.http.getText(sitemapUrl));
    pages.push(...sitemap.urls);
    for (const child of sitemap.sitemaps.filter(looksLikeJobSitemap)) if (children++ < MAX_CHILD_SITEMAPS) queue.push(child);
  }
  const sameHost = [...new Set(pages)].filter((page) => {
    try {
      return new URL(page).host === host;
    } catch {
      return false;
    }
  });
  if (sameHost.length === 0) return undefined;

  const max = ctx.config.sources.careers?.max_urls ?? DEFAULT_MAX_URLS;
  const wanted = sameHost.filter((page) => ctx.worthDetails({ title: titleFromUrl(page), company: company.name }) && !ctx.isKnownUrl?.(page));
  if (wanted.length > max) ctx.warn(`careers/${company.slug}: ${wanted.length} postings look relevant, read the first ${max}`);
  const raws: CareersRaw[] = [];
  for (const page of wanted.slice(0, max)) {
    try {
      raws.push(...(await readPosting(ctx, company, robots, page, 'sitemap')));
    } catch (error) {
      ctx.warn(`careers/${company.slug}: ${page} skipped (${(error as Error).message})`);
    }
  }
  return raws;
}

async function readSite(ctx: FetchContext, company: CompanyRef, robots: (url: string) => Promise<Robots>): Promise<CareersRaw[]> {
  const url = company.url;
  if (!url) throw new Error('careers entries need the page URL, as { url: https://careers.example.com, name: Example }');

  const direct = atsFor(url);
  if (direct) return viaAts(ctx, direct);

  const rules = await robots(url);
  if (!rules.allows(url)) throw new Error(`robots.txt disallows ${url}`);

  if (/\.xml(?:$|\?)/i.test(url)) {
    const raws = await viaSitemap(ctx, company, robots, [url]);
    if (raws) return raws;
    throw new Error(`no page URLs found in the sitemap ${url}`);
  }

  const html = await ctx.http.getText(url);
  const embedded = embeddedAts(html);
  if (embedded) return viaAts(ctx, embedded);

  const { postings, invalid } = jsonLdJobPostings(html);
  if (invalid > 0) ctx.warn(`careers/${company.slug}: ${invalid} JobPosting block(s) skipped (missing title)`);
  const open = postings.filter((posting) => !isExpired(posting, ctx.now));
  if (open.length > 0) return open.map((posting) => ({ method: 'jsonld' as const, job: jobFromJsonLd(posting, company, url, 'jsonld') }));

  const preferred = rules.sitemaps.filter(looksLikeJobSitemap);
  const listed = preferred.length > 0 ? preferred : rules.sitemaps;
  const raws = listed.length > 0 ? await viaSitemap(ctx, company, robots, listed) : undefined;
  if (raws) return raws;
  throw new Error(`no job data found on ${url}: no supported ATS, no JobPosting JSON-LD and no job sitemap in robots.txt`);
}

/**
 * Career pages on a company's own site, for companies on an ATS with no adapter of its own. Cheapest
 * first: a link to a supported ATS is delegated to its adapter; else the page's schema.org JobPosting
 * JSON-LD; else the job sitemap listed in robots.txt, reading only postings whose URL could pass the
 * filters. Nothing found is a failure, never an empty board, so a redesign cannot close open issues.
 */
export const careers: SourceAdapter<CareersRaw> = {
  id: 'careers',
  mode: 'company',

  async fetch(ctx) {
    const robots = createRobotsReader(ctx.http);
    return forEachCompany('careers', ctx, (company) => readSite(ctx, company, robots));
  },

  normalize: (raw) => raw.job,

  /** Only results read from the company's own data prove that a job is gone: a sitemap read is capped and filtered. */
  provesAbsence: (raws) => raws.length > 0 && raws.every((raw) => raw.method !== 'sitemap'),
};
