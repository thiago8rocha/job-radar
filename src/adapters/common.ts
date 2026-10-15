import type { CompanyRef } from '../config/schema.js';
import type { Currency, WorkModel } from '../domain/job.js';
import { shortHash } from '../util/hash.js';
import { slugify } from '../domain/labels.js';
import type { FetchContext } from './types.js';

/** `ramp` → `Ramp`, `acme-corp` → `Acme Corp`; only used when neither config nor source names the company. */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function companyName(ref: CompanyRef, fromSource?: string | null): string {
  return ref.name?.trim() || fromSource?.trim() || prettifySlug(ref.slug);
}

/** Maps the workplace type words sources use ("Remote", "On-site", "Híbrido"...) to a work model. */
export function workModelFrom(value: string | null | undefined): WorkModel | undefined {
  const text = (value ?? '').toLowerCase();
  if (/remote|remoto|anywhere/.test(text)) return 'remote';
  if (/hybrid|h[ií]brid/.test(text)) return 'hybrid';
  if (/on-?\s?site|presencial|in-?\s?office/.test(text)) return 'onsite';
  return undefined;
}

/** Stable job id and hidden issue marker: `<source>:<company>:<hash of the source's job id>`. */
export function jobId(source: string, company: string, sourceJobId: string | number): string {
  return `${source}:${slugify(company)}:${shortHash(source, company, String(sourceJobId))}`;
}

/**
 * Runs `fetchCompany` for each configured company, in sequence. One company failing (wrong slug,
 * temporary outage) is reported as a warning and does not stop the others; the source only fails
 * when every company fails.
 */
export async function forEachCompany<T>(
  source: string,
  ctx: FetchContext,
  fetchCompany: (company: CompanyRef) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  const failures: Error[] = [];
  for (const company of ctx.companies) {
    try {
      results.push(...(await fetchCompany(company)));
    } catch (error) {
      failures.push(error as Error);
      ctx.warn(`${source}/${company.slug}: ${(error as Error).message}`);
    }
  }
  if (ctx.companies.length > 0 && failures.length === ctx.companies.length) throw failures[0];
  return results;
}

export function isoFromEpoch(value: number | undefined, unit: 's' | 'ms'): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(unit === 's' ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function formatRange(min: number | null | undefined, max: number | null | undefined, currency: string | null | undefined, period?: string | null): string | undefined {
  if (min == null && max == null) return undefined;
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const amount = min != null && max != null && min !== max ? `${fmt(min)} – ${fmt(max)}` : fmt((min ?? max) as number);
  return [currency, amount, period ? `/ ${period}` : undefined].filter(Boolean).join(' ');
}

export function asCurrency(code: string | null | undefined): Currency | undefined {
  const upper = code?.toUpperCase();
  return upper === 'BRL' || upper === 'USD' || upper === 'EUR' ? upper : undefined;
}
