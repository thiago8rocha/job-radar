import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_STATE_PATH = 'state/seen.json';

const RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEK_MS = 7 * DAY_MS;
const STATS_WEEKS = 12;

const weekStatsSchema = z.object({
  fetched: z.number().int().nonnegative().default(0),
  passedFilters: z.number().int().nonnegative().default(0),
  /** Became an issue. */
  unique: z.number().int().nonnegative().default(0),
  /** Jobs this source returned that another source (or an existing issue, as `known`) already had. */
  duplicateOf: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

export type WeekStats = z.infer<typeof weekStatsSchema>;

/** `2026-W42`, so keys sort chronologically. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const week = Math.ceil(((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The counters of one source in the ISO week of `now`, created on first use. */
export function weekStats(state: SeenState, source: string, now: Date): WeekStats {
  const weeks = (state.stats[source] ??= {});
  return (weeks[isoWeek(now)] ??= weekStatsSchema.parse({}));
}

const seenSchema = z.object({
  version: z.literal(1),
  /** Jobs that became an issue, by id. */
  jobs: z.record(z.string(), z.object({ issue: z.number().optional(), seenAt: z.string() })).default({}),
  /** Health per source: consecutive runs that returned zero jobs without an error. */
  sources: z.record(z.string(), z.object({ zeroRuns: z.number().int().nonnegative() })).default({}),
  /** Per source, then per ISO week: what each source contributed. Absent in files written by older versions. */
  stats: z.record(z.string(), z.record(z.string(), weekStatsSchema)).default({}),
});

export type SeenState = z.infer<typeof seenSchema>;

export function emptyState(): SeenState {
  return { version: 1, jobs: {}, sources: {}, stats: {} };
}

/** Reads `state/seen.json`; a missing file is a first run. A corrupt file fails loudly rather than re-creating every issue. */
export async function loadState(path: string): Promise<SeenState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return emptyState();
  }
  const parsed = seenSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`${path} is not a valid job-radar state file: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Writes the state with sorted keys, so commits only show what changed. Entries older than a year are dropped. */
export async function saveState(path: string, state: SeenState, now: Date): Promise<void> {
  const cutoff = now.getTime() - RETENTION_DAYS * DAY_MS;
  const jobs = Object.entries(state.jobs)
    .filter(([, entry]) => Date.parse(entry.seenAt) >= cutoff)
    .sort(([a], [b]) => a.localeCompare(b));
  const sources = Object.entries(state.sources).sort(([a], [b]) => a.localeCompare(b));
  const oldestWeek = isoWeek(new Date(now.getTime() - (STATS_WEEKS - 1) * WEEK_MS));
  const stats = Object.entries(state.stats)
    .map(([source, weeks]) => [source, Object.fromEntries(Object.entries(weeks).filter(([week]) => week >= oldestWeek).sort(([a], [b]) => a.localeCompare(b)))] as const)
    .filter(([, weeks]) => Object.keys(weeks).length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const output: SeenState = { version: 1, jobs: Object.fromEntries(jobs), sources: Object.fromEntries(sources), stats: Object.fromEntries(stats) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
}
