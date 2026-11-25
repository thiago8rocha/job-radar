import { setTimeout as sleep } from 'node:timers/promises';
import { formatRange } from '../adapters/common.js';
import { ADAPTERS } from '../adapters/index.js';
import type { AnySourceAdapter, FetchContext } from '../adapters/types.js';
import { analyzeJob, type JobInsight } from '../ai/insight.js';
import { AiQuotaError, type ChatClient } from '../ai/models.js';
import { ATS, emptyByAts } from '../adapters/ats.js';
import { isRelevantPosting } from '../adapters/common.js';
import { companyRefs, type Companies } from '../config/schema.js';
import { FIELD } from '../domain/fields.js';
import type { Job } from '../domain/job.js';
import { dynamicLabel, LABEL, type LabelDef } from '../domain/labels.js';
import { STATUS_TITLES, statusLabel } from '../domain/status.js';
import { issueTitle, renderIssueBody } from '../github/issue-body.js';
import { addLabels, ensureLabels, removeLabel } from '../github/labels.js';
import { addIssueToProject, setFieldValue, type Project } from '../github/project.js';
import { companiesFromLinks } from '../discovery/links.js';
import { dedupe, KNOWN_SOURCE, knownFromIssues, type Duplicate, type KnownJobs } from '../pipeline/dedup.js';
import { priorIssuesByKey, repostAction, repostMarker, type PriorIssue } from '../pipeline/repost.js';
import { regionsOf } from '../pipeline/eligibility.js';
import { canonicalUrl } from '../pipeline/url.js';
import { buildExcerpt, sanitizeForIssue } from '../pipeline/excerpt.js';
import { createFilter, inferWorkModel, type JobFilter } from '../pipeline/filter.js';
import { detectSignals, type Signal } from '../pipeline/signals.js';
import { brasiliaHours } from '../pipeline/timezone.js';
import { DEFAULT_COMPANIES_STATE_PATH, harvestCandidates, healthKey, hotDirectory, loadCompaniesState, recordOutcome, saveCompaniesState } from '../state/companies.js';
import { BACKLOG_LIMIT, DEFAULT_STATE_PATH, loadState, saveState, weekStats, type SeenState } from '../state/seen.js';
import { createHttpClient, type HttpClient } from '../util/http.js';
import { truncate } from '../util/text.js';
import { loadProject, type Context } from './context.js';

/** A source that returns nothing this many runs in a row, without an error, is probably broken. */
const ZERO_RUN_ALERT = 3;
const DEFAULT_SOURCE_TIMEOUT_MINUTES = 5;
/** A source that ignores its deadline is cut off this long after it. */
const DEADLINE_GRACE_MS = 30_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface CollectOptions {
  /** Run the whole pipeline but write nothing: no issues and no state file. */
  dryRun?: boolean;
  statePath?: string;
  companies?: Companies;
  /** The cold list (`companies.directory.yml`): its companies join the run once a `sweep` finds them relevant. */
  directory?: Companies;
  companiesStatePath?: string;
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
  passedFilters: number;
  duplicates: number;
  /** Duplicates by the source they matched, or `known` for an existing issue. */
  duplicateOf: Record<string, number>;
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

function labelsFor(job: Job, signals: Signal[]): { names: string[]; dynamic: LabelDef[] } {
  const dynamic = [
    dynamicLabel('found', job.source),
    job.atsApply ? dynamicLabel('ats', job.source) : undefined,
    ...job.contracts.map((contract) => dynamicLabel('contract', contract)),
    ...signals.map(({ kind }) => dynamicLabel('signal', kind)),
  ].filter((label): label is LabelDef => label !== undefined);

  const brazilian = [...job.locations, ...(job.restrictions ?? [])].some((place) => regionsOf(place).includes('brazil'));
  const names = [
    statusLabel('new'),
    ...dynamic.map((label) => label.name),
    brazilian ? 'scope:brazil' : 'scope:international',
    ...(job.workModel ? [`work:${job.workModel}`] : []),
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
  const companiesStatePath = options.companiesStatePath ?? DEFAULT_COMPANIES_STATE_PATH;
  const companiesState = await loadCompaniesState(companiesStatePath);
  const hotDirectoryCompanies = options.directory ? hotDirectory(options.directory, companiesState, ctx.config.directory.hot_days, now) : emptyByAts<never>();
  const issues = await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, {
    ...ctx.repo,
    state: 'all',
    per_page: 100,
  });
  const known = knownFromIssues(issues.filter((issue) => !issue.pull_request));
  for (const id of Object.keys(state.jobs)) known.ids.add(id);

  // 1-3. Collection (sources run side by side: they hit different hosts), validation and normalization.
  const reports: SourceReport[] = [];
  const candidates: Job[] = [];
  const startedAt = Date.now();
  const budgetEnd = startedAt + ctx.config.run.budget_minutes * MINUTE_MS;
  const running: Array<{ id: string; adapter: AnySourceAdapter; report: SourceReport; outcome: Promise<{ raws?: unknown[]; error?: Error }> }> = [];
  for (const [id, toggle] of Object.entries(ctx.config.sources)) {
    if (!toggle.enabled) continue;
    const adapter = adapters[id];
    if (!adapter) {
      ctx.log.info(`${id}: no adapter in this version yet; skipped`);
      continue;
    }
    const entries = (companies as Partial<Record<string, Companies['inhire']>>)[id];
    const listed = new Set(companyRefs(entries).map((ref) => healthKey(id, ref.slug)));
    const refs = [
      ...companyRefs(entries),
      ...companyRefs((hotDirectoryCompanies as Partial<Record<string, Companies['inhire']>>)[id])
        .filter((ref) => !listed.has(healthKey(id, ref.slug)))
        .map((ref) => ({ ...ref, light: true })),
    ];
    if (adapter.mode === 'company' && refs.length === 0) {
      ctx.log.info(`${id}: no companies listed in companies.yml; skipped`);
      continue;
    }

    const apiKey = toggle.api_key_secret ? options.serpapiKey : undefined;
    if (adapter.requiresKey && !apiKey) {
      ctx.log.info(`${id}: no API key provided (${toggle.api_key_secret ?? 'api_key_secret'} is not set); skipped`);
      continue;
    }

    const report: SourceReport = { source: id, fetched: 0, discarded: {}, passedFilters: 0, duplicates: 0, duplicateOf: {}, created: 0 };
    reports.push(report);
    const fetchContext: FetchContext = {
      http,
      config: ctx.config,
      companies: refs,
      now,
      apiKey,
      worthDetails: (candidate) => filter.worthDetails(candidate),
      isKnownUrl: (url) => known.urls.has(canonicalUrl(url) ?? url),
      resolved: companiesState.resolved,
      github: ctx.octokit,
      warn: (message) => ctx.log.warn(message),
      onCompany: ({ company, items, error }) =>
        recordOutcome(
          companiesState,
          healthKey(id, company.slug),
          { error, postings: items.length, relevant: items.some((raw) => isRelevantPosting(adapter, filter, raw)) },
          now,
        ),
      deadline: Math.min(budgetEnd, startedAt + (toggle.timeout_minutes ?? DEFAULT_SOURCE_TIMEOUT_MINUTES) * MINUTE_MS),
    };
    const hardLimit = Math.max(fetchContext.deadline! + DEADLINE_GRACE_MS - Date.now(), DEADLINE_GRACE_MS);
    running.push({
      id,
      adapter,
      report,
      outcome: withTimeout(adapter.fetch(fetchContext), hardLimit, id).then(
        (raws) => ({ raws }),
        (error: Error) => ({ error }),
      ),
    });
  }

  for (const { id, adapter, report, outcome } of running) {
    const { raws, error } = await outcome;
    try {
      if (error) throw error;
      let broken = 0;
      for (const raw of raws!) {
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
      report.fetched = raws!.length - broken;
    } catch (failure) {
      report.error = (failure as Error).message;
      ctx.log.warn(`${id}: failed, other sources carry on (${report.error})`);
    }
    updateHealth(ctx, state, report);
  }

  if (!dryRun) {
    const listed = new Set([companies, options.directory ?? emptyByAts<never>()].flatMap(listedKeys));
    for (const job of candidates) harvestCandidates(companiesState, companiesFromLinks([job.applyUrl]), listed, now);
  }

  // 4. Filter.
  const bySource = new Map(reports.map((report) => [report.source, report]));
  const passed: Job[] = [];
  for (const job of candidates) {
    const result = filter.check(job, now);
    if (result.ok) {
      passed.push(job);
      bySource.get(job.source)!.passedFilters++;
    } else {
      const discarded = bySource.get(job.source)!.discarded;
      const stage = stageOf(result.reason ?? 'filter');
      discarded[stage] = (discarded[stage] ?? 0) + 1;
    }
  }

  if (!dryRun) recordNearMisses(state, candidates, passed, filter, known, now);

  // 5. Deduplication.
  const { fresh, duplicates } = dedupe(passed, known);
  const reposts = repostsOf(duplicates, priorIssuesByKey(issues.filter((issue) => !issue.pull_request)));
  for (const duplicate of duplicates) {
    const report = bySource.get(duplicate.job.source)!;
    report.duplicates++;
    report.duplicateOf[duplicate.of] = (report.duplicateOf[duplicate.of] ?? 0) + 1;
  }
  if (!dryRun) {
    recordStats(state, reports, now);
    await saveCompaniesState(companiesStatePath, companiesState);
  }

  if (reposts.length > 0) await signalReposts(ctx, state, reposts, now, dryRun);

  // 6. Writing, capped per run so a first run cannot flood the board. What did not fit waits in the backlog and goes first next time.
  const ai = { calls: 0, stopped: false };
  const insights = new Map<string, JobInsight>();
  const pool = poolOf(fresh, state, known, ctx.config.search.max_age_days, now, adapters);
  if (options.ai && !dryRun) {
    for (const job of pool) {
      const insight = await insightFor(ctx, options.ai, ai, job);
      if (insight) insights.set(job.id, insight);
      if (ai.stopped) break;
    }
  }
  const ordered = insights.size > 0 ? [...pool].sort((a, b) => (insights.get(b.id)?.fit ?? 0) - (insights.get(a.id)?.fit ?? 0)) : pool;
  const batch = ordered.slice(0, ctx.config.issues.max_per_run);
  const deferred = ordered.length - batch.length;
  if (!dryRun) {
    const since = new Map(state.backlog.map((entry) => [entry.job.id, entry.queuedAt]));
    state.backlog = ordered.slice(0, BACKLOG_LIMIT).map((job) => ({ job: { ...job, description: truncate(job.description, 8000) }, queuedAt: since.get(job.id) ?? now.toISOString() }));
  }

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
    try {
      for (const [index, job] of batch.entries()) {
        const issue = await writeIssue(ctx, project, labelNames, job, now, insights.get(job.id));
        state.jobs[job.id] = { issue, seenAt: now.toISOString() };
        state.backlog = state.backlog.filter((entry) => entry.job.id !== job.id);
        weekStats(state, job.source, now).unique++;
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

interface Repost {
  job: Job;
  prior: PriorIssue;
}

/** Duplicates that are the same job posted again (new id, new link) under an issue that is closed or has no answer. */
function repostsOf(duplicates: Duplicate[], prior: Map<string, PriorIssue>): Repost[] {
  return duplicates.flatMap((duplicate) => {
    const issue = duplicate.key && duplicate.of === KNOWN_SOURCE ? prior.get(duplicate.key) : undefined;
    return issue && repostAction(issue) ? [{ job: duplicate.job, prior: issue }] : [];
  });
}

/**
 * Tells the earlier issue about a repost instead of creating a second one: a comment and `signal:reposted`,
 * and an issue closed by `revalidate` is reopened at `status:new`. Once per issue per run; each new id is
 * recorded as seen, so the next run does not comment again.
 */
async function signalReposts(ctx: Context, state: SeenState, reposts: Repost[], now: Date, dryRun: boolean): Promise<void> {
  const label = dynamicLabel('signal', 'reposted');
  const handled = new Set<number>();
  let labelReady = false;
  for (const { job, prior } of reposts) {
    const action = repostAction(prior)!;
    if (!dryRun) state.jobs[job.id] = { issue: prior.number, seenAt: now.toISOString() };
    if (handled.has(prior.number)) continue;
    handled.add(prior.number);

    ctx.log.info(`${dryRun ? '[dry-run] ' : ''}Reposted: #${prior.number} ${issueTitle(job.company, job.title)} (${action === 'reopen' ? 'reopened' : 'commented'})`);
    if (dryRun) continue;
    if (label && !labelReady) {
      await ensureLabels(ctx.octokit, ctx.repo, [label]);
      labelReady = true;
    }
    const target = { ...ctx.repo, issue_number: prior.number };
    const body = `Reposted on ${now.toISOString().slice(0, 10)}: ${job.applyUrl}${action === 'reopen' ? '\n\nThe posting had disappeared from its source and is listed again, so this issue is back at `status:new`.' : ''}\n\n${repostMarker(job.id)}`;
    await addLabels(ctx.octokit, ctx.repo, prior.number, [label!.name, ...(action === 'reopen' ? [statusLabel('new')] : [])]);
    if (action === 'reopen') {
      await removeLabel(ctx.octokit, ctx.repo, prior.number, LABEL.closedAtSource);
      await removeLabel(ctx.octokit, ctx.repo, prior.number, statusLabel('discarded'));
      await ctx.octokit.rest.issues.update({ ...target, state: 'open' });
    }
    await ctx.octokit.rest.issues.createComment({ ...target, body });
  }
}

/**
 * The jobs this run may write: the backlog from earlier runs still inside the age limit and not known by now,
 * then the new ones. Each group is ordered with the company's own ATS link first, then jobs read from a
 * company's board before aggregators, then newest first.
 */
function poolOf(fresh: Job[], state: SeenState, known: KnownJobs, maxAgeDays: number, now: Date, adapters: Record<string, AnySourceAdapter>): Job[] {
  const oldest = now.getTime() - maxAgeDays * DAY_MS;
  const direct = (job: Job) => Number(adapters[job.source]?.mode === 'company');
  const byPriority = (a: Job, b: Job) =>
    Number(b.atsApply) - Number(a.atsApply) || direct(b) - direct(a) || Date.parse(b.postedAt ?? '') - Date.parse(a.postedAt ?? '') || 0;
  const waiting = state.backlog.filter((entry) => Date.parse(entry.job.postedAt ?? entry.queuedAt) >= oldest).map((entry) => entry.job);
  const freshIds = new Set(fresh.map((job) => job.id));
  const queued = dedupe(waiting.filter((job) => !freshIds.has(job.id)), known).fresh;
  return [...queued.sort(byPriority), ...[...fresh].sort(byPriority)];
}

function companyRefsFromEmpty(): Companies {
  return emptyByAts();
}

/** Jobs that fail exactly one soft rule and are not already known; they never become issues. */
function recordNearMisses(state: SeenState, candidates: Job[], passed: Job[], filter: JobFilter, known: KnownJobs, now: Date): void {
  const passedIds = new Set(passed.map((job) => job.id));
  const misses = new Map<string, string>();
  for (const job of candidates) {
    if (passedIds.has(job.id) || state.nearMiss.some((entry) => entry.id === job.id)) continue;
    const { failures } = filter.checkAll(job, now);
    if (failures.length === 1 && failures[0]!.soft) misses.set(job.id, failures[0]!.reason);
  }
  const unknown = dedupe(candidates.filter((job) => misses.has(job.id)), known).fresh;
  for (const job of unknown) {
    state.nearMiss.push({ id: job.id, title: job.title, company: job.company, link: job.applyUrl, reason: misses.get(job.id)!, date: now.toISOString() });
  }
}

function listedKeys(companies: Companies): string[] {
  return ATS.flatMap((def) => companyRefs(companies[def.id]).map((ref) => healthKey(def.id, ref.slug)));
}

function recordStats(state: SeenState, reports: SourceReport[], now: Date): void {
  for (const report of reports) {
    if (report.error) continue;
    const week = weekStats(state, report.source, now);
    week.fetched += report.fetched;
    week.passedFilters += report.passedFilters;
    for (const [source, count] of Object.entries(report.duplicateOf)) week.duplicateOf[source] = (week.duplicateOf[source] ?? 0) + count;
  }
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

const SIGNAL_NAMES: Record<Signal['kind'], string> = {
  internal: 'internal selection',
  intermediary: 'intermediary',
  scam: 'possible scam',
};

function signalLine({ kind, quote }: Signal): string {
  return `**Signal (${SIGNAL_NAMES[kind]}):** "${sanitizeForIssue(quote)}"`;
}

async function writeIssue(
  ctx: Context,
  project: Project,
  knownLabels: Set<string>,
  job: Job,
  today: Date,
  insight?: JobInsight,
): Promise<number> {
  const stated = job.contracts.length > 0;
  const read = (insight?.contract ?? []).map((name) => KNOWN_CONTRACTS.get(name.trim().toLowerCase())).filter((name): name is string => Boolean(name));
  const withContracts: Job = stated || read.length === 0 ? job : { ...job, contracts: read };
  const salary = insight?.salary;
  const aiCompensation =
    !job.compensation && salary && (salary.min || salary.max)
      ? `${formatRange(salary.min ?? undefined, salary.max ?? undefined, salary.currency, salary.period)} (read by AI)`
      : undefined;

  const signals = detectSignals(`${job.title}
${job.description}`);
  const { names: baseNames, dynamic } = labelsFor(withContracts, signals);
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
      source: job.foundBy ? `${job.source} (${job.foundBy})` : job.source,
      extraLines: [...(insight ? insightLines(insight, today) : []), ...signals.map(signalLine)],
      excerpt: buildExcerpt(job.description, ctx.config.search.highlight),
      fullDescription: sanitizeForIssue(truncate(job.description, 8000)),
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

function describeOverlap(duplicateOf: Record<string, number>): string {
  const parts = Object.entries(duplicateOf)
    .sort(([, a], [, b]) => b - a)
    .map(([source, count]) => `${source} ${count}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
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
        `${report.duplicates} already known${describeOverlap(report.duplicateOf)}, ${report.created} new`,
    );
  }
  ctx.log.info(
    `${totals.dryRun ? '[dry-run] Would create' : 'Created'} ${totals.created} issue(s)` +
      (totals.deferred > 0 ? `; ${totals.deferred} more wait for the next run (issues.max_per_run)` : ''),
  );
}
