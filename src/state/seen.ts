import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_STATE_PATH = 'state/seen.json';

const RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const seenSchema = z.object({
  version: z.literal(1),
  /** Jobs that became an issue, by id. */
  jobs: z.record(z.string(), z.object({ issue: z.number().optional(), seenAt: z.string() })).default({}),
  /** Health per source: consecutive runs that returned zero jobs without an error. */
  sources: z.record(z.string(), z.object({ zeroRuns: z.number().int().nonnegative() })).default({}),
});

export type SeenState = z.infer<typeof seenSchema>;

export function emptyState(): SeenState {
  return { version: 1, jobs: {}, sources: {} };
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
  const output: SeenState = { version: 1, jobs: Object.fromEntries(jobs), sources: Object.fromEntries(sources) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
}
