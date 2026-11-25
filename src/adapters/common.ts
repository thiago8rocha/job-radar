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

export const DEFAULT_COMPANY_CONCURRENCY = 4;

/**
 * Runs `fetchCompany` for each configured company, a few at a time (the HTTP client still spaces
 * requests to the same host). One company failing (wrong slug, temporary outage) is reported as a
 * warning and does not stop the others; the source only fails when every company it tried fails.
 * Once `ctx.deadline` passes no new company starts, and the skipped ones are reported.
 */
export async function forEachCompany<T>(
  source: string,
  ctx: FetchContext,
  fetchCompany: (company: CompanyRef) => Promise<T[]>,
): Promise<T[]> {
  const results: T[][] = ctx.companies.map(() => []);
  const failures: Error[] = [];
  let next = 0;
  let attempted = 0;

  async function worker(): Promise<void> {
    while (next < ctx.companies.length && !(ctx.deadline !== undefined && Date.now() >= ctx.deadline)) {
      const index = next++;
      const company = ctx.companies[index]!;
      attempted++;
      try {
        results[index] = await fetchCompany(company);
      } catch (error) {
        failures.push(error as Error);
        ctx.warn(`${source}/${company.slug}: ${(error as Error).message}`);
      }
    }
  }

  const workers = Math.min(ctx.concurrency ?? DEFAULT_COMPANY_CONCURRENCY, ctx.companies.length);
  await Promise.all(Array.from({ length: workers }, worker));

  const skipped = ctx.companies.length - attempted;
  if (skipped > 0) ctx.warn(`${source}: out of time, skipped ${skipped} of ${ctx.companies.length} companies`);
  if (attempted > 0 && failures.length === attempted) throw failures[0];
  return results.flat();
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
