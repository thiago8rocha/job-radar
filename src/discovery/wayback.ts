import { z } from 'zod';
import { ATS, type AtsTable } from '../adapters/ats.js';
import type { HttpClient } from '../util/http.js';

const CDX_URL = 'https://web.archive.org/cdx/search/cdx';
const PAGE_LIMIT = 5000;
const MONTHS = 12;

const rowsSchema = z.array(z.array(z.string()));

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export interface ArchiveOptions {
  http: HttpClient;
  /** At most this many CDX requests in the whole run. */
  maxQueries: number;
  now: Date;
  table?: AtsTable;
  warn?: (message: string) => void;
}

/**
 * URLs the Wayback Machine saw in the last 12 months under each ATS's tenant host pattern. This is how
 * tenants of an ATS with no central search are found; the caller still checks that each one has postings.
 * The Internet Archive being slow or down only costs this source of candidates.
 */
export async function archivedLinks(options: ArchiveOptions): Promise<string[]> {
  const { http, maxQueries, now, warn = () => undefined } = options;
  const table: AtsTable = options.table ?? ATS;
  const from = yyyymmdd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS, now.getUTCDate())));
  const patterns = table.flatMap((def) => def.archive ?? []).slice(0, Math.max(0, maxQueries));

  const links: string[] = [];
  for (const pattern of patterns) {
    const query = new URLSearchParams({ url: pattern, output: 'json', fl: 'original', collapse: 'urlkey', from, limit: String(PAGE_LIMIT) });
    try {
      const rows = rowsSchema.parse(await http.getJson(`${CDX_URL}?${query}`));
      links.push(...rows.slice(1).flatMap((row) => (row[0] ? [row[0]] : [])));
    } catch (error) {
      warn(`Wayback ${pattern}: ${(error as Error).message}`);
    }
  }
  return links;
}
