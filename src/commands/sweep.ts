import { ATS } from '../adapters/ats.js';
import { isRelevantPosting } from '../adapters/common.js';
import { ADAPTERS } from '../adapters/index.js';
import type { AnySourceAdapter, FetchContext } from '../adapters/types.js';
import { companyRefs, type CompanyRef, type Companies } from '../config/schema.js';
import { createFilter } from '../pipeline/filter.js';
import { DEFAULT_COMPANIES_STATE_PATH, healthKey, loadCompaniesState, recordOutcome, saveCompaniesState } from '../state/companies.js';
import { createHttpClient, type HttpClient } from '../util/http.js';
import type { Context } from './context.js';

const DEFAULT_CHUNK = 200;
const MINUTE_MS = 60_000;

export interface SweepOptions {
  dryRun?: boolean;
  /** The cold list, `companies.directory.yml`. */
  directory: Companies;
  companiesStatePath?: string;
  adapters?: Record<string, AnySourceAdapter>;
  http?: HttpClient;
  now?: Date;
  chunkSize?: number;
}

export interface SweepResult {
  checked: number;
  total: number;
  /** Where the next sweep resumes. */
  cursor: number;
}

interface Entry {
  ats: string;
  ref: CompanyRef;
  key: string;
}

/**
 * Weekly job: walks the directory in slices, resuming from the cursor, and records each company's
 * health. It creates no issues; a company whose postings pass the title filter becomes part of the
 * daily run through `directory.hot_days`.
 */
export async function sweep(ctx: Context, options: SweepOptions): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const adapters = options.adapters ?? ADAPTERS;
  const http = options.http ?? createHttpClient({ hostDelayMs: 300 });
  const path = options.companiesStatePath ?? DEFAULT_COMPANIES_STATE_PATH;
  const state = await loadCompaniesState(path);
  const filter = createFilter(ctx.config);

  const entries: Entry[] = ATS.flatMap((def) =>
    companyRefs(options.directory[def.id]).map((ref) => ({ ats: def.id as string, ref: { ...ref, light: true }, key: healthKey(def.id, ref.slug) })),
  );
  const total = entries.length;
  if (total === 0) {
    ctx.log.info('Sweep: the directory is empty; nothing to do');
    return { checked: 0, total, cursor: 0 };
  }

  const deadline = Date.now() + ctx.config.run.budget_minutes * MINUTE_MS;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
  let cursor = state.cursor >= total ? 0 : state.cursor;
  let checked = 0;

  while (checked < total && cursor < total && Date.now() < deadline) {
    const chunk = entries.slice(cursor, cursor + chunkSize);
    const done = new Set<string>();

    await Promise.all(
      [...new Set(chunk.map((entry) => entry.ats))].map(async (ats) => {
        const adapter = adapters[ats];
        const group = chunk.filter((entry) => entry.ats === ats);
        if (!adapter) return;
        const fetchContext: FetchContext = {
          http,
          config: ctx.config,
          companies: group.map((entry) => entry.ref),
          now,
          deadline,
          worthDetails: () => false,
          warn: () => undefined,
          onCompany: ({ company, items, error }) => {
            const key = healthKey(ats, company.slug);
            done.add(key);
            recordOutcome(state, key, { error, postings: items.length, relevant: !error && items.some((raw) => isRelevantPosting(adapter, filter, raw)) }, now);
          },
        };
        try {
          await adapter.fetch(fetchContext);
        } catch {
          // Each company's failure is already recorded by onCompany; the source-level error only says that all of them failed.
        }
      }),
    );

    const unfinished = chunk.findIndex((entry) => !done.has(entry.key) && adapters[entry.ats] !== undefined);
    const advanced = unfinished === -1 ? chunk.length : unfinished;
    checked += advanced;
    cursor += advanced;
    if (unfinished !== -1) break;
  }

  state.cursor = cursor >= total ? 0 : cursor;
  ctx.log.info(`${options.dryRun ? '[dry-run] ' : ''}Sweep: ${checked} of ${total} directory companies checked; the next sweep resumes at ${state.cursor}`);
  if (!options.dryRun) await saveCompaniesState(path, state);
  return { checked, total, cursor: state.cursor };
}
