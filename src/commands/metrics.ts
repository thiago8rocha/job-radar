import { desiredFields, analyzeIssue, type IssueFacts, type IssueMetrics } from '../metrics/analyze.js';
import { METRICS_MARKER, renderReport } from '../metrics/report.js';
import { parseStatusLabel, type Status } from '../domain/status.js';
import { extractMarker } from '../github/issue-body.js';
import { listProjectItems, setFieldValue, type Project, type ProjectItem } from '../github/project.js';
import { loadProject, type Context } from './context.js';
import { reconcileStatusField } from './reconcile.js';

export interface MetricsOptions {
  /** Print the report and the field changes instead of writing them. */
  dryRun?: boolean;
  now?: Date;
}

export interface MetricsResult {
  issues: number;
  applications: number;
  fieldsWritten: number;
  report: string;
}

const METRICS_TITLE = 'Metrics';

interface RepoIssue {
  number: number;
  node_id: string;
  title: string;
  html_url?: string;
  state: string;
  body?: string | null;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}

function labelNames(issue: RepoIssue): string[] {
  return issue.labels.map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean);
}

async function statusEvents(ctx: Context, issueNumber: number): Promise<Array<{ status: Status; at: string }>> {
  const events = await ctx.octokit.paginate(ctx.octokit.rest.issues.listEvents, {
    ...ctx.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  return events
    .filter((event) => event.event === 'labeled' && 'label' in event && event.label?.name)
    .map((event) => ({ status: parseStatusLabel((event as { label: { name: string } }).label.name), at: event.created_at }))
    .filter((event): event is { status: Status; at: string } => event.status !== undefined)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Weekly job: computes the calculated Project fields from each issue's timeline, writes the ones
 * that changed, and rewrites the pinned "Metrics" issue. See "Status and calculated fields" and
 * "Metrics" in docs/DESIGN.md.
 */
export async function metrics(ctx: Context, options: MetricsOptions = {}): Promise<MetricsResult> {
  const { dryRun = false } = options;
  const now = options.now ?? new Date();

  const all = (await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, {
    ...ctx.repo,
    state: 'all',
    per_page: 100,
  })) as unknown as RepoIssue[];
  const metricsIssue = all.find((issue) => !issue.pull_request && (issue.body ?? '').includes(METRICS_MARKER));
  const jobs = all.filter((issue) => !issue.pull_request && issue !== metricsIssue);

  const project = await loadProject(ctx);
  const items = await listProjectItems(ctx.octokit, project);

  const results: IssueMetrics[] = [];
  let fieldsWritten = 0;
  for (const issue of jobs) {
    const item = items.get(issue.number);
    const labels = labelNames(issue);
    const imported = extractMarker(issue.body)?.startsWith('import:') ?? false;

    // A job still at "New" with no application date has no history worth reading.
    const status = labels.map(parseStatusLabel).find((value) => value !== undefined);
    const needsTimeline = !imported && (item?.values['Applied on'] !== undefined || (status !== undefined && status !== 'new'));
    const facts: IssueFacts = {
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels,
      statusEvents: needsTimeline ? await statusEvents(ctx, issue.number) : [],
      imported,
      fields: item?.values ?? {},
    };
    const analysis = analyzeIssue(facts);
    results.push(analysis);
    if (item) fieldsWritten += await writeFields(ctx, project, item, analysis, dryRun);
  }

  // The labels are the source of truth for Status; this heals cards changed on the board by hand.
  const statusFixes = await reconcileStatusField(
    ctx,
    project,
    jobs.map((issue) => ({ number: issue.number, node_id: issue.node_id, labels: labelNames(issue) })),
    items,
    dryRun,
  );
  fieldsWritten += statusFixes;

  const report = renderReport(results, now);
  if (dryRun) {
    ctx.log.info(`[dry-run] Would update the Metrics issue with:\n${report}`);
  } else {
    await upsertMetricsIssue(ctx, metricsIssue, report);
  }
  const applications = results.filter((issue) => issue.appliedOn).length;
  ctx.log.info(
    `${dryRun ? '[dry-run] ' : ''}Metrics: ${results.length} jobs, ${applications} applications, ${fieldsWritten} Project field(s) ${dryRun ? 'would change' : 'updated'}`,
  );
  return { issues: results.length, applications, fieldsWritten, report };
}

async function writeFields(
  ctx: Context,
  project: Project,
  item: ProjectItem,
  analysis: IssueMetrics,
  dryRun: boolean,
): Promise<number> {
  let written = 0;
  for (const { field, value } of desiredFields(analysis)) {
    const current = item.values[field];
    const next = value.type === 'option' ? value.name : value.value;
    if (current === next) continue;
    if (dryRun) {
      ctx.log.info(`[dry-run] #${analysis.number}: ${field} ${current ?? '(empty)'} → ${next}`);
    } else {
      await setFieldValue(ctx.octokit, project, item.id, field, value);
    }
    written++;
  }
  return written;
}

async function upsertMetricsIssue(ctx: Context, existing: RepoIssue | undefined, body: string): Promise<void> {
  if (existing) {
    if (existing.body !== body || existing.state === 'closed') {
      await ctx.octokit.rest.issues.update({ ...ctx.repo, issue_number: existing.number, body, state: 'open' });
    }
    return;
  }
  const { data } = await ctx.octokit.rest.issues.create({ ...ctx.repo, title: METRICS_TITLE, body });
  ctx.log.info(`Created the Metrics issue #${data.number}`);
  try {
    await ctx.octokit.graphql(
      `mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { id } } }`,
      { id: data.node_id },
    );
  } catch (error) {
    // Pinning is cosmetic (and limited to 3 pinned issues); the issue is still usable unpinned.
    ctx.log.warn(`Could not pin the Metrics issue (${(error as Error).message}); pin it from the issue page`);
  }
}
