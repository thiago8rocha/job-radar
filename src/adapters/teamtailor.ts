import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job, WorkModel } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { parseRssItems } from '../util/rss.js';
import { htmlToText } from '../util/text.js';
import { resolveBoard } from './ats.js';
import { companyName, forEachCompany, jobId } from './common.js';
import { SchemaError, type FetchContext, type SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const rssItemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  guid: z.string().min(1),
  pubDate: z.string().optional(),
  remoteStatus: z.string().optional(),
  description: z.string().optional(),
  'tt:locations': z.string().optional(),
  'tt:department': z.string().optional(),
});

const jsonFeedSchema = z.object({ title: z.string().nullish(), items: z.array(z.unknown()) });

const jsonItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  date_published: z.string().nullish(),
  content_html: z.string().nullish(),
  _jobposting: z
    .object({
      employmentType: z.string().nullish(),
      jobLocation: z.array(z.object({ address: z.object({ addressLocality: z.string().nullish(), addressCountry: z.string().nullish() }).nullish() })).nullish(),
    })
    .nullish(),
});

export interface TeamtailorRaw {
  company: CompanyRef;
  /** The career site's name, from the feed title. */
  account?: string;
  id: string;
  title: string;
  url: string;
  postedAt?: string;
  locations: string[];
  workModel?: WorkModel;
  contracts: string[];
  html?: string;
}

/** `{slug}.teamtailor.com`, or the host of a career site on the company's own domain (`{ url: https://careers.acme.com }`). */
function hostOf(company: CompanyRef): string {
  const board = resolveBoard('teamtailor', company);
  return company.url && board.slug === company.slug ? new URL(company.url).host : `${board.slug}.teamtailor.com`;
}

function isoOf(value: string | undefined | null): string | undefined {
  const time = Date.parse(value ?? '');
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function readRss(company: CompanyRef, xml: string, ctx: Pick<FetchContext, 'warn'>): TeamtailorRaw[] {
  const items = parseRssItems(xml);
  if (!items) throw new SchemaError('teamtailor', 'the response is not an RSS feed');
  const account = /<channel>\s*<title>([^<]*)<\/title>/i.exec(xml)?.[1]?.trim();
  return parseItems('teamtailor', rssItemSchema, items, ctx).map((item) => {
    const places = [...(item['tt:locations'] ?? '').matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/g)].map((match) =>
      [/<tt:city>([^<]*)</.exec(match[1]!)?.[1], /<tt:country>([^<]*)</.exec(match[1]!)?.[1]].map((part) => part?.trim()).filter(Boolean).join(', '),
    );
    return {
      company,
      account,
      id: item.guid,
      title: item.title,
      url: item.link,
      postedAt: isoOf(item.pubDate),
      locations: places.filter(Boolean),
      workModel: item.remoteStatus === 'fully' ? 'remote' : item.remoteStatus === 'hybrid' ? 'hybrid' : undefined,
      contracts: [],
      html: item.description,
    };
  });
}

function readJsonFeed(company: CompanyRef, data: unknown, ctx: Pick<FetchContext, 'warn'>): TeamtailorRaw[] {
  const feed = parseEnvelope('teamtailor', jsonFeedSchema, data);
  return parseItems('teamtailor', jsonItemSchema, feed.items, ctx).map((item) => ({
    company,
    account: feed.title ?? undefined,
    id: item.id,
    title: item.title,
    url: item.url,
    postedAt: isoOf(item.date_published),
    locations: (item._jobposting?.jobLocation ?? [])
      .map((place) => [place.address?.addressLocality, place.address?.addressCountry].filter(Boolean).join(', '))
      .filter(Boolean),
    contracts: item._jobposting?.employmentType ? [item._jobposting.employmentType] : [],
    html: item.content_html ?? undefined,
  }));
}

/**
 * Teamtailor career sites, on `{slug}.teamtailor.com` or on the company's own domain. The RSS feed is read
 * first because it states whether the job is remote or hybrid, which the JSON feed does not; the JSON feed
 * is the fallback when the RSS one is missing.
 */
export const teamtailor: SourceAdapter<TeamtailorRaw> = {
  id: 'teamtailor',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('teamtailor', ctx, async (company) => {
      const host = hostOf(company);
      try {
        return readRss(company, await ctx.http.getText(`https://${host}/jobs.rss`), ctx);
      } catch (error) {
        ctx.warn(`teamtailor/${company.slug}: jobs.rss failed (${(error as Error).message}), trying jobs.json`);
        return readJsonFeed(company, await ctx.http.getJson(`https://${host}/jobs.json`), ctx);
      }
    });
  },

  normalize({ company, account, id, title, url, postedAt, locations, workModel, contracts, html }): Job {
    const key = resolveBoard('teamtailor', company).slug;
    return {
      id: jobId('teamtailor', key, id),
      source: 'teamtailor',
      atsApply: true,
      company: companyName({ ...company, slug: key }, account),
      title: title.trim(),
      locations,
      workModel,
      seniority: [],
      contracts,
      postedAt,
      applyUrl: canonicalUrl(url) ?? url,
      description: htmlToText(html),
    };
  },
};
