import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ATS, slugKey, type AtsId, type AtsTable } from '../adapters/ats.js';
import { SchemaError } from '../adapters/types.js';
import { companyRefs, type Companies } from '../config/schema.js';
import { HttpError } from '../util/http.js';
import { isoWeek } from './seen.js';

export const DEFAULT_COMPANIES_STATE_PATH = 'state/companies.json';

const DAY_MS = 24 * 60 * 60 * 1000;

const healthSchema = z.object({
  lastOk: z.string().optional(),
  /** Last time a posting of this company passed the title filter. */
  lastRelevant: z.string().optional(),
  /** Consecutive weeks in which the board was gone (404) or changed format. */
  failures: z.number().int().nonnegative().default(0),
  failureWeek: z.string().optional(),
  /** Consecutive runs that answered with no postings. */
  emptyRuns: z.number().int().nonnegative().default(0),
});

const companiesStateSchema = z.object({
  version: z.literal(1),
  companies: z.record(z.string(), healthSchema).default({}),
  /** Where the next `sweep` resumes in the directory. */
  cursor: z.number().int().nonnegative().default(0),
  /** Boards seen in the apply links of collected jobs that are in neither list yet, keyed `<ats>:<slug>`. */
  candidates: z.record(z.string(), z.object({ firstSeen: z.string(), lastSeen: z.string(), count: z.number().int().positive() })).default({}),
});

export type CompanyHealth = z.infer<typeof healthSchema>;
export type CompaniesState = z.infer<typeof companiesStateSchema>;

export function emptyCompaniesState(): CompaniesState {
  return { version: 1, companies: {}, cursor: 0, candidates: {} };
}

/** A missing file is a first run; a corrupt one fails loudly. */
export async function loadCompaniesState(path: string): Promise<CompaniesState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return emptyCompaniesState();
  }
  const parsed = companiesStateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a valid job-radar companies state file: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Sorted keys, so commits only show what changed. */
export async function saveCompaniesState(path: string, state: CompaniesState): Promise<void> {
  const companies = Object.fromEntries(Object.entries(state.companies).sort(([a], [b]) => a.localeCompare(b)));
  const candidates = Object.fromEntries(Object.entries(state.candidates).sort(([a], [b]) => a.localeCompare(b)));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...state, companies, candidates }, null, 2)}\n`);
}

export function healthKey(ats: string, slug: string, table: AtsTable = ATS): string {
  const def = table.find((entry) => entry.id === ats);
  return `${ats}:${def ? slugKey(def, slug) : slug.toLowerCase()}`;
}

/** The board is gone or its format changed; a timeout or a 5xx says nothing about the company. */
function isDeadBoard(error: Error): boolean {
  return error instanceof SchemaError || (error instanceof HttpError && (error.status === 404 || error.status === 410));
}

export interface CompanyOutcome {
  error?: Error;
  postings: number;
  relevant: boolean;
}

/** Updates one company's health after a fetch. A failure counts once per ISO week. */
export function recordOutcome(state: CompaniesState, key: string, outcome: CompanyOutcome, now: Date): void {
  const entry = (state.companies[key] ??= healthSchema.parse({}));
  if (outcome.error) {
    const week = isoWeek(now);
    if (isDeadBoard(outcome.error) && entry.failureWeek !== week) {
      entry.failures++;
      entry.failureWeek = week;
    }
    return;
  }
  entry.lastOk = now.toISOString();
  entry.failures = 0;
  delete entry.failureWeek;
  entry.emptyRuns = outcome.postings === 0 ? entry.emptyRuns + 1 : 0;
  if (outcome.relevant) entry.lastRelevant = now.toISOString();
}

/** Directory companies that had a relevant posting recently enough to join the daily run. */
export function hotDirectory(directory: Companies, state: CompaniesState, hotDays: number, now: Date, table: AtsTable = ATS): Companies {
  const cutoff = now.getTime() - hotDays * DAY_MS;
  const hot: Record<string, Companies[AtsId]> = {};
  for (const def of table) {
    hot[def.id] = (directory[def.id as AtsId] ?? []).filter((entry) => {
      const [ref] = companyRefs([entry]);
      const relevant = state.companies[healthKey(def.id, ref!.slug, table)]?.lastRelevant;
      return relevant !== undefined && Date.parse(relevant) >= cutoff;
    });
  }
  return hot as Companies;
}

const CANDIDATE_RETENTION_DAYS = 60;
/** Boards checked per `discover` run, most often seen first, so a dead one cannot crowd out the rest. */
const MAX_CANDIDATES_PER_RUN = 50;

/**
 * Notes the boards that apply links of collected jobs point to. Boards already listed are skipped (and
 * dropped from the candidates), and candidates not seen for 60 days are forgotten.
 */
export function harvestCandidates(state: CompaniesState, found: Record<string, string[]>, listed: Set<string>, now: Date, table: AtsTable = ATS): void {
  const stamp = now.toISOString();
  for (const def of table) {
    for (const slug of found[def.id] ?? []) {
      const key = healthKey(def.id, slug, table);
      if (listed.has(key)) continue;
      const entry = state.candidates[key];
      state.candidates[key] = { firstSeen: entry?.firstSeen ?? stamp, lastSeen: stamp, count: (entry?.count ?? 0) + 1 };
    }
  }
  const cutoff = now.getTime() - CANDIDATE_RETENTION_DAYS * DAY_MS;
  for (const [key, entry] of Object.entries(state.candidates)) {
    if (listed.has(key) || Date.parse(entry.lastSeen) < cutoff) delete state.candidates[key];
  }
}

/** The candidates `discover` should check, as slugs per ATS. */
export function harvestedCandidates(state: CompaniesState, table: AtsTable = ATS): Record<AtsId, string[]> {
  const result = Object.fromEntries(table.map((def) => [def.id, [] as string[]])) as Record<AtsId, string[]>;
  const ranked = Object.entries(state.candidates)
    .sort(([, a], [, b]) => b.count - a.count || a.firstSeen.localeCompare(b.firstSeen))
    .slice(0, MAX_CANDIDATES_PER_RUN);
  for (const [key] of ranked) {
    const [ats, ...rest] = key.split(':');
    if (ats && ats in result) result[ats as AtsId].push(rest.join(':'));
  }
  return result;
}
