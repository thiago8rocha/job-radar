import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_STATE_PATH = 'state/seen.json';

const RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const WEEK_MS = 7 * DAY_MS;
const STATS_WEEKS = 12;
const NEAR_MISS_DAYS = 14;
const NEAR_MISS_CAP = 50;

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

const nearMissSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  link: z.string(),
  reason: z.string(),
  date: z.string(),
});

export type NearMiss = z.infer<typeof nearMissSchema>;

const jobSchema = z.object({
  id: z.string(),
  source: z.string(),
  foundBy: z.string().optional(),
  atsApply: z.boolean(),
  company: z.string(),
  title: z.string(),
  locations: z.array(z.string()),
  restrictions: z.array(z.string()).optional(),
  workModel: z.enum(['remote', 'hybrid', 'onsite']).optional(),
  seniority: z.array(z.string()),
  contracts: z.array(z.string()),
  compensation: z.string().optional(),
  currency: z.enum(['BRL', 'USD', 'EUR']).optional(),
  salaryAmount: z.number().optional(),
  postedAt: z.string().optional(),
  applyUrl: z.string(),
  description: z.string(),
});

/** A job that passed every filter but had no room in its run: the whole job, so the issue can be written later without fetching it again. */
const backlogSchema = z.object({ job: jobSchema, queuedAt: z.string() });

export type BacklogEntry = z.infer<typeof backlogSchema>;

/** The most jobs kept for later; the oldest are the ones that would expire first. */
export const BACKLOG_LIMIT = 200;

const seenSchema = z.object({
  version: z.literal(1),
  /** Jobs that became an issue, by id. */
  jobs: z.record(z.string(), z.object({ issue: z.number().optional(), seenAt: z.string() })).default({}),
  /** Health per source: consecutive runs that returned zero jobs without an error. */
  sources: z.record(z.string(), z.object({ zeroRuns: z.number().int().nonnegative() })).default({}),
  /** Per source, then per ISO week: what each source contributed. Absent in files written by older versions. */
  stats: z.record(z.string(), z.record(z.string(), weekStatsSchema)).default({}),
  /** Jobs dropped by exactly one soft rule: never issues, listed in the Metrics issue for a second look. */
  nearMiss: z.array(nearMissSchema).default([]),
  /** Jobs waiting for a free slot under `issues.max_per_run`. Absent in files written by older versions. */
  backlog: z.array(backlogSchema).default([]),
});

export type SeenState = z.infer<typeof seenSchema>;

export function emptyState(): SeenState {
  return { version: 1, jobs: {}, sources: {}, stats: {}, nearMiss: [], backlog: [] };
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
  const nearMissCutoff = now.getTime() - NEAR_MISS_DAYS * DAY_MS;
  const nearMiss = state.nearMiss
    .filter((entry) => Date.parse(entry.date) >= nearMissCutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, NEAR_MISS_CAP);
  const output: SeenState = {
    version: 1,
    jobs: Object.fromEntries(jobs),
    sources: Object.fromEntries(sources),
    stats: Object.fromEntries(stats),
    nearMiss,
    backlog: state.backlog.slice(0, BACKLOG_LIMIT),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
}
