import { setTimeout as sleep } from 'node:timers/promises';
import { formatRange } from '../adapters/common.js';
import { ADAPTERS } from '../adapters/index.js';
import type { AnySourceAdapter, FetchContext } from '../adapters/types.js';
import { analyzeJob, type JobInsight } from '../ai/insight.js';
import { AiQuotaError, type ChatClient } from '../ai/models.js';
import { companyRefs, type Companies } from '../config/schema.js';
import { FIELD } from '../domain/fields.js';
import type { Job } from '../domain/job.js';
import { dynamicLabel, type LabelDef } from '../domain/labels.js';
import { STATUS_TITLES, statusLabel } from '../domain/status.js';
import { issueTitle, renderIssueBody } from '../github/issue-body.js';
import { ensureLabels } from '../github/labels.js';
import { addIssueToProject, setFieldValue, type Project } from '../github/project.js';
import { dedupe, knownFromIssues } from '../pipeline/dedup.js';
import { regionsOf } from '../pipeline/eligibility.js';
import { buildExcerpt, sanitizeForIssue } from '../pipeline/excerpt.js';
import { createFilter, inferWorkModel } from '../pipeline/filter.js';
import { brasiliaHours } from '../pipeline/timezone.js';
import { DEFAULT_STATE_PATH, loadState, saveState, type SeenState } from '../state/seen.js';
import { createHttpClient, type HttpClient } from '../util/http.js';
import { truncate } from '../util/text.js';
import { loadProject, type Context } from './context.js';

/** A source that returns nothing this many runs in a row, without an error, is probably broken. */
const ZERO_RUN_ALERT = 3;
const SOURCE_TIMEOUT_MS = 5 * 60 * 1000;

export interface CollectOptions {
  /** Run the whole pipeline but write nothing: no issues and no state file. */
  dryRun?: boolean;
  statePath?: string;
  companies?: Companies;
  /** Adapters to run; defaults to every adapter in this version. Tests inject their own. */
  adapters?: Record<string, AnySourceAdapter>;
  http?: HttpClient;
  /** SerpAPI key, for the sources that need one (Google Jobs). */
  serpapiKey?: string;
  /** The optional AI step: when present, each new job gets a fit score and extracted details. */
  ai?: { client: ChatClient; profile: string };
  now?: Date;
  /** Pause between issue creations, to stay under GitHub's secondary rate limit. */
  delayMs?: number;
}

export interface SourceReport {
  source: string;
  fetched: number;
  discarded: Record<string, number>;
  duplicates: number;
  created: number;
  error?: string;
}

export interface CollectResult {
  sources: SourceReport[];
  created: number;
  /** New jobs beyond `issues.max_per_run`, left for the next run. */
  deferred: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stageOf(reason: string): string {
  return reason.split(':')[0]!.trim();
}

/** `Remote · Brazil`, plus the working hours in Brasília time when the posting states them. */
export function describeLocation(job: Job, today: Date): string {
  const places = [...new Set(job.locations)].slice(0, 3).join('; ');
  const model = job.workModel ? job.workModel.charAt(0).toUpperCase() + job.workModel.slice(1) : undefined;
  const where = !model ? places : !places ? model : places.toLowerCase().includes(model.toLowerCase()) ? places : `${model} · ${places}`;
  return [where, brasiliaHours(job.description, today)].filter(Boolean).join(' · ');
}

function labelsFor(job: Job): { names: string[]; dynamic: LabelDef[] } {
  const dynamic = [
    dynamicLabel('found', job.source),
    job.atsApply ? dynamicLabel('ats', job.source) : undefined,
    ...job.contracts.map((contract) => dynamicLabel('contract', contract)),
  ].filter((label): label is LabelDef => label !== undefined);

  const brazilian = [...job.locations, ...(job.restrictions ?? [])].some((place) => regionsOf(place).includes('brazil'));
  const names = [
    statusLabel('new'),
    ...dynamic.map((label) => label.name),
    brazilian ? 'scope:brazil' : 'scope:international',
    ...(job.workModel === 'remote' || job.workModel === 'hybrid' ? [`work:${job.workModel}`] : []),
  ];
  return { names, dynamic };
}

/**
 * Runs the whole collection pipeline: fetch each source in isolation, normalize, filter,
 * deduplicate and write one issue per new job. See "Execution pipeline" in docs/DESIGN.md.
 */
export async function collect(ctx: Context, options: CollectOptions = {}): Promise<CollectResult> {
  const { dryRun = false, statePath = DEFAULT_STATE_PATH, delayMs = 1000 } = options;
  const now = options.now ?? new Date();
  const adapters = options.adapters ?? ADAPTERS;
  const http = options.http ?? createHttpClient({ hostDelayMs: 300 });
  const companies = options.companies ?? companyRefsFromEmpty();
  const filter = createFilter(ctx.config);

  const state = await loadState(statePath);
  const issues = await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, {
    ...ctx.repo,
    state: 'all',
    per_page: 100,
  });
  const known = knownFromIssues(issues.filter((issue) => !issue.pull_request));
  for (const id of Object.keys(state.jobs)) known.ids.add(id);

  // 1-3. Collection, validation and normalization, one source at a time.
  const reports: SourceReport[] = [];
  const candidates: Job[] = [];
  for (const [id, toggle] of Object.entries(ctx.config.sources)) {
    if (!toggle.enabled) continue;
    const adapter = adapters[id];
    if (!adapter) {
      ctx.log.info(`${id}: no adapter in this version yet; skipped`);
      continue;
    }
    const entries = companies[id as keyof Companies] as Companies['inhire'] | undefined;
    const refs = companyRefs(entries);
    if (adapter.mode === 'company' && refs.length === 0) {
      ctx.log.info(`${id}: no companies listed in companies.yml; skipped`);
      continue;
    }

    const apiKey = toggle.api_key_secret ? options.serpapiKey : undefined;
    if (adapter.requiresKey && !apiKey) {
      ctx.log.info(`${id}: no API key provided (${toggle.api_key_secret ?? 'api_key_secret'} is not set); skipped`);
      continue;
    }

    const report: SourceReport = { source: id, fetched: 0, discarded: {}, duplicates: 0, created: 0 };
    reports.push(report);
    const fetchContext: FetchContext = {
      http,
      config: ctx.config,
      companies: refs,
      now,
      apiKey,
      worthDetails: (candidate) => filter.worthDetails(candidate),
      warn: (message) => ctx.log.warn(message),
    };
    try {
      const raws = await withTimeout(adapter.fetch(fetchContext), SOURCE_TIMEOUT_MS, id);
      let broken = 0;
      for (const raw of raws) {
        try {
          const job = adapter.normalize(raw);
          candidates.push({
            ...job,
            company: collapseSpaces(job.company),
            title: collapseSpaces(job.title),
            workModel: inferWorkModel(job),
          });
        } catch {
          broken++;
        }
      }
      if (broken > 0) ctx.log.warn(`${id}: ${broken} postings could not be normalized and were skipped`);
      report.fetched = raws.length - broken;
    } catch (error) {
      report.error = (error as Error).message;
      ctx.log.warn(`${id}: failed, other sources carry on (${report.error})`);
    }
    updateHealth(ctx, state, report);
  }

  // 4. Filter.
  const bySource = new Map(reports.map((report) => [report.source, report]));
  const passed: Job[] = [];
  for (const job of candidates) {
    const result = filter.check(job, now);
    if (result.ok) {
      passed.push(job);
    } else {
      const discarded = bySource.get(job.source)!.discarded;
      const stage = stageOf(result.reason ?? 'filter');
      discarded[stage] = (discarded[stage] ?? 0) + 1;
    }
  }

  // 5. Deduplication.
  const { fresh, duplicates } = dedupe(passed, known);
  for (const duplicate of duplicates) bySource.get(duplicate.job.source)!.duplicates++;

  // 6. Writing: newest first, capped per run so a first run cannot flood the board.
  const ordered = fresh.sort((a, b) => Date.parse(b.postedAt ?? '') - Date.parse(a.postedAt ?? '') || 0);
  const batch = ordered.slice(0, ctx.config.issues.max_per_run);
  const deferred = ordered.length - batch.length;

  let created = 0;
  if (dryRun) {
    for (const job of batch) {
      ctx.log.info(`[dry-run] ${issueTitle(job.company, job.title)} (${job.source}) ${job.applyUrl}`);
      bySource.get(job.source)!.created++;
    }
    created = batch.length;
  } else if (batch.length > 0) {
    const project = await loadProject(ctx);
    const labelNames = new Set(
      (await ctx.octokit.paginate(ctx.octokit.rest.issues.listLabelsForRepo, { ...ctx.repo, per_page: 100 })).map(
        (label) => label.name,
      ),
    );
    const ai = { calls: 0, stopped: false };
    try {
      for (const [index, job] of batch.entries()) {
        const insight = await insightFor(ctx, options.ai, ai, job);
        const issue = await writeIssue(ctx, project, labelNames, job, now, insight, options.ai !== undefined);
        state.jobs[job.id] = { issue, seenAt: now.toISOString() };
        bySource.get(job.source)!.created++;
        created++;
        ctx.log.info(`Created #${issue} ${issueTitle(job.company, job.title)} (${job.source})`);
        if (delayMs > 0 && index < batch.length - 1) await sleep(delayMs);
      }
    } finally {
      await saveState(statePath, state, now); // keep what was written even if a later issue failed
    }
  }
  if (dryRun === false && batch.length === 0) await saveState(statePath, state, now);

  // 7. Summary.
  summarize(ctx, reports, { created, deferred, dryRun });
  if (reports.length > 0 && reports.every((report) => report.error)) {
    throw new Error('Every enabled source failed; see the warnings above');
  }
  return { sources: reports, created, deferred };
}

function companyRefsFromEmpty(): Companies {
  return { inhire: [], greenhouse: [], lever: [], ashby: [] };
}

function updateHealth(ctx: Context, state: SeenState, report: SourceReport): void {
  if (report.error) return; // an error says more than an empty result does
  const entry = state.sources[report.source] ?? { zeroRuns: 0 };
  entry.zeroRuns = report.fetched === 0 ? entry.zeroRuns + 1 : 0;
  state.sources[report.source] = entry;
  if (entry.zeroRuns >= ZERO_RUN_ALERT) {
    ctx.log.warn(`${report.source}: returned zero jobs for ${entry.zeroRuns} runs in a row; the source may have changed`);
  }
}

/**
 * The AI's read of one job, or undefined when AI is off, the per-run call limit is used up, the free
 * quota ran out, or the call failed: in every one of those cases the issue is created without a score.
 */
async function insightFor(
  ctx: Context,
  ai: CollectOptions['ai'],
  state: { calls: number; stopped: boolean },
  job: Job,
): Promise<JobInsight | undefined> {
  if (!ai || state.stopped) return undefined;
  if (state.calls >= ctx.config.ai.max_calls_per_run) {
    state.stopped = true;
    ctx.log.info(`AI: the limit of ${ctx.config.ai.max_calls_per_run} calls per run was reached; the rest are created without a score`);
    return undefined;
  }
  state.calls++;
  try {
    return await analyzeJob(ai.client, ai.profile, job);
  } catch (error) {
    if (error instanceof AiQuotaError) {
      state.stopped = true;
      ctx.log.warn('AI: the AI quota is used up; the rest are created without a score');
    } else {
      ctx.log.warn(`AI: could not read "${job.title}" (${(error as Error).message}); created without a score`);
    }
    return undefined;
  }
}

const KNOWN_CONTRACTS = new Map([
  ['clt', 'CLT'],
  ['pj', 'PJ'],
  ['cooperado', 'Cooperado'],
  ['contractor', 'Contractor'],
]);

/** What the AI read, as extra body lines: fit, stack, required hours and a remote check. */
function insightLines(insight: JobInsight, today: Date): string[] {
  const lines = [`**Fit:** ${insight.fit}/5${insight.rationale ? ` — ${insight.rationale}` : ''}`];
  if (insight.stack.length > 0) lines.push(`**Stack:** ${insight.stack.join(', ')}`);
  if (insight.required_hours) lines.push(`**Required hours:** ${brasiliaHours(insight.required_hours, today) ?? insight.required_hours}`);
  if (insight.really_remote === false) lines.push('**Remote check:** the posting seems to require office presence');
  if (insight.language_required.length > 0) lines.push(`**Languages required:** ${insight.language_required.join(', ')}`);
  if (insight.hard_blocker) lines.push(`**Possible blocker:** ${insight.hard_blocker}`);
  return lines;
}

async function writeIssue(
  ctx: Context,
  project: Project,
  knownLabels: Set<string>,
  job: Job,
  today: Date,
  insight?: JobInsight,
  keepDescription = false,
): Promise<number> {
  const stated = job.contracts.length > 0;
  const read = (insight?.contract ?? []).map((name) => KNOWN_CONTRACTS.get(name.trim().toLowerCase())).filter((name): name is string => Boolean(name));
  const withContracts: Job = stated || read.length === 0 ? job : { ...job, contracts: read };
  const salary = insight?.salary;
  const aiCompensation =
    !job.compensation && salary && (salary.min || salary.max)
      ? `${formatRange(salary.min ?? undefined, salary.max ?? undefined, salary.currency, salary.period)} (read by AI)`
      : undefined;

  const { names: baseNames, dynamic } = labelsFor(withContracts);
  const names = insight ? [...baseNames, `fit:${insight.fit}`] : baseNames;
  const missing = dynamic.filter((label) => !knownLabels.has(label.name));
  if (missing.length > 0) {
    await ensureLabels(ctx.octokit, ctx.repo, missing);
    for (const label of missing) knownLabels.add(label.name);
  }

  const { data: issue } = await ctx.octokit.rest.issues.create({
    ...ctx.repo,
    title: issueTitle(job.company, job.title),
    body: renderIssueBody({
      applyUrl: job.applyUrl,
      location: describeLocation(job, today),
      postedOn: job.postedAt?.slice(0, 10),
      compensation: job.compensation ?? aiCompensation,
      source: job.source,
      extraLines: insight ? insightLines(insight, today) : undefined,
      excerpt: buildExcerpt(job.description, ctx.config.search.highlight),
      fullDescription: keepDescription ? sanitizeForIssue(truncate(job.description, 8000)) : undefined,
      markerId: job.id,
    }),
    labels: names,
  });

  try {
    const itemId = await addIssueToProject(ctx.octokit, project, issue.node_id);
    const set = (name: string, value: Parameters<typeof setFieldValue>[4]) =>
      setFieldValue(ctx.octokit, project, itemId, name, value);
    await set(FIELD.status, { type: 'option', name: STATUS_TITLES.new });
    await set(FIELD.contact, { type: 'option', name: 'Application' });
    if (job.currency && job.compensation) await set(FIELD.currency, { type: 'option', name: job.currency });
    if (job.salaryAmount !== undefined) await set(FIELD.offeredSalary, { type: 'number', value: job.salaryAmount });
  } catch (error) {
    // The issue exists and is recorded as seen; only its Project fields are missing.
    ctx.log.warn(`#${issue.number}: could not fill the Project fields (${(error as Error).message})`);
  }
  return issue.number;
}

function summarize(
  ctx: Context,
  reports: SourceReport[],
  totals: { created: number; deferred: number; dryRun: boolean },
): void {
  for (const report of reports) {
    if (report.error) {
      ctx.log.info(`${report.source}: error (${report.error})`);
      continue;
    }
    const discardedTotal = Object.values(report.discarded).reduce((sum, count) => sum + count, 0);
    const reasons = Object.entries(report.discarded)
      .sort(([, a], [, b]) => b - a)
      .map(([stage, count]) => `${stage} ${count}`)
      .join(', ');
    ctx.log.info(
      `${report.source}: ${report.fetched} fetched, ${discardedTotal} discarded${reasons ? ` (${reasons})` : ''}, ` +
        `${report.duplicates} already known, ${report.created} new`,
    );
  }
  ctx.log.info(
    `${totals.dryRun ? '[dry-run] Would create' : 'Created'} ${totals.created} issue(s)` +
      (totals.deferred > 0 ? `; ${totals.deferred} more wait for the next run (issues.max_per_run)` : ''),
  );
}
