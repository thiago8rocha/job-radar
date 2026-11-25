import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Document, isMap, isSeq, parseDocument } from 'yaml';
import { ATS, slugKey, type AtsId, type AtsTable } from '../adapters/ats.js';
import { listedSlugs, parseCompaniesText } from '../discovery/companies-file.js';
import { companiesFromLinks } from '../discovery/links.js';

export interface CompanyRow {
  ats: string;
  slug: string;
  name?: string;
}

export interface CsvColumns {
  ats: string;
  slug: string;
  name: string;
}

/** The column names of the LastRound AI ATS directory. */
export const LASTROUND_COLUMNS: CsvColumns = { ats: 'ats_vendor', slug: 'board_slug', name: 'company_name' };

/** Rows of an RFC 4180 CSV: quoted fields, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[index + 1] === '\n') index++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

export function rowsFromCsv(text: string, columns: CsvColumns): CompanyRow[] {
  const [header, ...records] = parseCsv(text);
  if (!header) return [];
  const find = (name: string) => {
    const index = header.findIndex((cell) => cell.trim().toLowerCase() === name.toLowerCase());
    if (index === -1) throw new Error(`The CSV has no "${name}" column (found: ${header.join(', ')})`);
    return index;
  };
  const [ats, slug] = [find(columns.ats), find(columns.slug)];
  const name = header.findIndex((cell) => cell.trim().toLowerCase() === columns.name.toLowerCase());
  return records.map((record) => ({
    ats: (record[ats] ?? '').trim().toLowerCase(),
    slug: (record[slug] ?? '').trim(),
    name: name === -1 ? undefined : record[name]?.trim() || undefined,
  }));
}

/** One career-page URL per line; blank lines and `#` comments are skipped. Lines that match no ATS are returned as `unresolved`. */
export function rowsFromUrls(text: string, table: AtsTable = ATS): { rows: CompanyRow[]; unresolved: string[] } {
  const rows: CompanyRow[] = [];
  const unresolved: string[] = [];
  for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith('#'))) {
    const found = companiesFromLinks([line], table);
    const hits = table.flatMap((def) => (found[def.id as AtsId] ?? []).map((slug) => ({ ats: def.id, slug })));
    if (hits.length === 0) unresolved.push(line);
    rows.push(...hits);
  }
  return { rows, unresolved };
}

export interface ImportCompaniesResult {
  text: string;
  added: number;
  /** Already in `companies.yml` or the directory, or repeated in the input. */
  skipped: number;
  /** ATS names no adapter can read from a slug, with how many rows each had. */
  unknownAts: Record<string, number>;
  /** Rows with no slug. */
  empty: number;
}

/**
 * Merges rows into the directory text, skipping slugs already listed in it or in `companies.yml`.
 * The same input twice gives the same file.
 */
export function mergeIntoDirectory(directoryText: string, companiesText: string, rows: CompanyRow[], table: AtsTable = ATS): ImportCompaniesResult {
  const listed = [parseCompaniesText(companiesText), parseCompaniesText(directoryText)].map((companies) => listedSlugs(companies, table));
  const doc = directoryText.trim() ? parseDocument(directoryText) : new Document({});
  const result: ImportCompaniesResult = { text: '', added: 0, skipped: 0, unknownAts: {}, empty: 0 };

  for (const row of rows) {
    const def = table.find((entry) => entry.id === row.ats);
    if (!def || def.urlOnly) {
      result.unknownAts[row.ats || '(blank)'] = (result.unknownAts[row.ats || '(blank)'] ?? 0) + 1;
      continue;
    }
    if (!row.slug) {
      result.empty++;
      continue;
    }
    const key = slugKey(def, row.slug);
    if (listed.some((sets) => sets[def.id as AtsId].has(key))) {
      result.skipped++;
      continue;
    }
    listed[1]![def.id as AtsId].add(key);

    let list = doc.get(def.id, true);
    if (!isSeq(list)) {
      doc.set(def.id, doc.createNode([]));
      list = doc.get(def.id, true);
    }
    if (isSeq(list)) {
      const entry = doc.createNode(row.name ? { slug: key, name: row.name } : key);
      if (isMap(entry)) entry.flow = true;
      list.add(entry);
      result.added++;
    }
  }
  result.text = doc.toString({ lineWidth: 0 });
  return result;
}

export interface ImportCompaniesFiles {
  csv?: string;
  urls?: string;
  columns?: Partial<CsvColumns>;
  directoryPath?: string;
  companiesPath?: string;
  log?: (message: string) => void;
}

/** The local `import-companies` command: reads a CSV or a URL list and merges it into the directory file. */
export async function importCompaniesFiles(options: ImportCompaniesFiles): Promise<ImportCompaniesResult> {
  const log = options.log ?? console.log;
  if (!options.csv && !options.urls) throw new Error('"import-companies" needs --csv <file> or --urls <file>');
  const directoryPath = options.directoryPath ?? 'companies.directory.yml';
  const read = async (path: string) => readFile(path, 'utf8').catch(() => '');

  const rows: CompanyRow[] = [];
  if (options.csv) rows.push(...rowsFromCsv(await readFile(options.csv, 'utf8'), {
        ats: options.columns?.ats ?? LASTROUND_COLUMNS.ats,
        slug: options.columns?.slug ?? LASTROUND_COLUMNS.slug,
        name: options.columns?.name ?? LASTROUND_COLUMNS.name,
      }));
  if (options.urls) {
    const { rows: fromUrls, unresolved } = rowsFromUrls(await readFile(options.urls, 'utf8'));
    rows.push(...fromUrls);
    for (const line of unresolved) log(`Not a supported career page, skipped: ${line}`);
  }

  const result = mergeIntoDirectory(await read(directoryPath), await read(options.companiesPath ?? 'companies.yml'), rows);
  if (result.added > 0) {
    await mkdir(dirname(directoryPath), { recursive: true });
    await writeFile(directoryPath, result.text);
  }
  const unknown = Object.entries(result.unknownAts).sort(([, a], [, b]) => b - a);
  log(`Import: ${result.added} added to ${directoryPath}, ${result.skipped} already listed or repeated, ${result.empty} without a slug`);
  if (unknown.length > 0) log(`Rows with an ATS job-radar has no adapter for (not imported): ${unknown.map(([ats, count]) => `${ats} ${count}`).join(', ')}`);
  return result;
}
