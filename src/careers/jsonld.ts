import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { companyName, formatRange, jobId } from '../adapters/common.js';

const many = <T extends z.ZodType>(schema: T) => z.union([schema, z.array(schema)]).nullish();
const list = <T>(value: T | T[] | null | undefined): T[] => (value == null ? [] : Array.isArray(value) ? value : [value]);

const placeSchema = z.object({
  address: z
    .union([
      z.string(),
      z.object({
        addressLocality: z.string().nullish(),
        addressRegion: z.string().nullish(),
        addressCountry: z.union([z.string(), z.object({ name: z.string().nullish() })]).nullish(),
      }),
    ])
    .nullish(),
});

const jobPostingSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  url: z.string().nullish(),
  identifier: z.union([z.string(), z.number(), z.object({ value: z.union([z.string(), z.number()]).nullish() })]).nullish(),
  datePosted: z.string().nullish(),
  validThrough: z.string().nullish(),
  employmentType: many(z.string()),
  hiringOrganization: z.union([z.string(), z.object({ name: z.string().nullish() })]).nullish(),
  jobLocation: many(placeSchema),
  jobLocationType: z.string().nullish(),
  applicantLocationRequirements: many(z.union([z.string(), z.object({ name: z.string().nullish() })])),
  baseSalary: z
    .object({
      currency: z.string().nullish(),
      value: z
        .union([
          z.number(),
          z.object({ minValue: z.number().nullish(), maxValue: z.number().nullish(), value: z.number().nullish(), unitText: z.string().nullish() }),
        ])
        .nullish(),
    })
    .nullish(),
});

export type JsonLdJobPosting = z.infer<typeof jobPostingSchema>;

const SCRIPT = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

function walk(node: unknown, found: unknown[]): void {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, found));
  if (!node || typeof node !== 'object') return;
  const object = node as Record<string, unknown>;
  const types = list(object['@type'] as string | string[] | undefined);
  if (types.includes('JobPosting')) found.push(object);
  walk(object['@graph'], found);
  if (types.includes('ItemList')) walk(object.itemListElement, found);
  if (object.item) walk(object.item, found);
}

/** Every schema.org `JobPosting` in the page's `application/ld+json` blocks, looking through arrays, `@graph` and `ItemList`. */
export function jsonLdJobPostings(html: string): { postings: JsonLdJobPosting[]; invalid: number } {
  const found: unknown[] = [];
  for (const block of html.matchAll(SCRIPT)) {
    try {
      walk(JSON.parse(block[1]!.trim()), found);
    } catch {
      // A block that is not JSON says nothing about the others.
    }
  }
  const postings: JsonLdJobPosting[] = [];
  let invalid = 0;
  for (const item of found) {
    const parsed = jobPostingSchema.safeParse(item);
    if (parsed.success) postings.push(parsed.data);
    else invalid++;
  }
  return { postings, invalid };
}

function isoOf(value: string | null | undefined): string | undefined {
  const time = Date.parse(value ?? '');
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

const nameOf = (value: string | { name?: string | null | undefined } | null | undefined): string | undefined =>
  (typeof value === 'string' ? value : value?.name)?.trim() || undefined;

/** True when the posting's own `validThrough` has passed, so a stale page does not open an issue. */
export function isExpired(posting: JsonLdJobPosting, now: Date): boolean {
  const end = Date.parse(posting.validThrough ?? '');
  return !Number.isNaN(end) && end < now.getTime();
}

export function jobFromJsonLd(posting: JsonLdJobPosting, company: CompanyRef, pageUrl: string, foundBy: string): Job {
  const host = new URL(pageUrl).host;
  const url = posting.url && /^https?:\/\//i.test(posting.url) ? posting.url : pageUrl;
  const identifier = typeof posting.identifier === 'object' && posting.identifier ? posting.identifier.value : posting.identifier;
  const locations = list(posting.jobLocation)
    .map((place) => {
      const address = place.address;
      if (typeof address === 'string') return address;
      const country = typeof address?.addressCountry === 'string' ? address.addressCountry : address?.addressCountry?.name;
      return [address?.addressLocality, address?.addressRegion, country].filter(Boolean).join(', ');
    })
    .filter(Boolean);
  const restrictions = list(posting.applicantLocationRequirements).map(nameOf).filter((name): name is string => Boolean(name));
  const salary = posting.baseSalary;
  const amount = typeof salary?.value === 'number' ? { min: salary.value, max: salary.value } : { min: salary?.value?.minValue ?? salary?.value?.value, max: salary?.value?.maxValue ?? salary?.value?.value };
  const description = posting.description ?? '';
  return {
    id: jobId('careers', company.slug, identifier ?? url),
    source: 'careers',
    foundBy,
    atsApply: true,
    company: companyName({ ...company, slug: host }, nameOf(posting.hiringOrganization)),
    title: htmlToText(posting.title),
    locations,
    restrictions: restrictions.length > 0 ? restrictions : undefined,
    workModel: posting.jobLocationType === 'TELECOMMUTE' ? 'remote' : undefined,
    seniority: [],
    contracts: list(posting.employmentType),
    compensation: formatRange(amount.min, amount.max, salary?.currency, typeof salary?.value === 'object' ? salary.value?.unitText?.toLowerCase() : undefined),
    postedAt: isoOf(posting.datePosted),
    applyUrl: canonicalUrl(url) ?? url,
    description: htmlToText(description, { escaped: /&lt;\w/.test(description) }),
  };
}
