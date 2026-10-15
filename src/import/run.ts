import { setTimeout as sleep } from 'node:timers/promises';
import { loadProject, type Context } from '../commands/context.js';
import { FIELD } from '../domain/fields.js';
import { dynamicLabel, slugify, type LabelDef } from '../domain/labels.js';
import { STATUS_TITLES, isTerminalStatus, statusLabel } from '../domain/status.js';
import { extractMarker, issueTitle, renderIssueBody } from '../github/issue-body.js';
import { ensureLabels } from '../github/labels.js';
import { addIssueToProject, setFieldValue, type Project } from '../github/project.js';
import { shortHash } from '../util/hash.js';
import type { ImportRow } from './xlsx.js';

export interface ImportOptions {
  /** Report what would be created without writing anything. */
  dryRun?: boolean;
  /** Pause between issue creations, to stay under GitHub's secondary rate limit. */
  delayMs?: number;
}

export interface ImportResult {
  created: number;
  skipped: number;
}

export function rowMarkerId(row: ImportRow): string {
  return `import:${slugify(row.company)}:${shortHash(row.company, row.role, row.appliedOn ?? '')}`;
}

function rowLabels(row: ImportRow): LabelDef[] {
  return [
    ...(row.source ? [dynamicLabel('found', row.source)] : []),
    ...row.contracts.map((contract) => dynamicLabel('contract', contract)),
  ].filter((label): label is LabelDef => label !== undefined);
}

async function existingMarkers(ctx: Context): Promise<Set<string>> {
  const issues = await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, {
    ...ctx.repo,
    state: 'all',
    per_page: 100,
  });
  const markers = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => extractMarker(issue.body))
    .filter((id): id is string => id !== undefined);
  return new Set(markers);
}

async function writeFields(ctx: Context, project: Project, itemId: string, row: ImportRow): Promise<void> {
  const set = (name: string, value: Parameters<typeof setFieldValue>[4]) =>
    setFieldValue(ctx.octokit, project, itemId, name, value);

  await set(FIELD.status, { type: 'option', name: STATUS_TITLES[row.status] });
  if (row.appliedOn) await set(FIELD.appliedOn, { type: 'date', value: row.appliedOn });
  if (row.furthestStage) await set(FIELD.furthestStage, { type: 'option', name: STATUS_TITLES[row.furthestStage] });
  if (row.responseDate) await set(FIELD.responseDate, { type: 'date', value: row.responseDate });
  if (row.daysToResponse !== undefined) await set(FIELD.daysToResponse, { type: 'number', value: row.daysToResponse });
  if (row.targetSalary !== undefined) await set(FIELD.targetSalary, { type: 'number', value: row.targetSalary });
  if (row.offeredSalary !== undefined) await set(FIELD.offeredSalary, { type: 'number', value: row.offeredSalary });
  if (row.currency) await set(FIELD.currency, { type: 'option', name: row.currency });
}

/**
 * Creates one issue per spreadsheet row. Re-running is safe: rows whose hidden marker is
 * already on an issue are skipped. Issues with an outcome are created closed. Old dates are
 * not in the timeline, so `Applied on` and the response date are written straight into the fields.
 */
export async function runImport(ctx: Context, rows: ImportRow[], options: ImportOptions = {}): Promise<ImportResult> {
  const { dryRun = false, delayMs = 1000 } = options;
  const result: ImportResult = { created: 0, skipped: 0 };

  const known = await existingMarkers(ctx);
  const pending = rows.filter((row) => {
    const seen = known.has(rowMarkerId(row));
    if (seen) ctx.log.info(`Row ${row.rowNumber} (${row.company}): already imported; skipped`);
    return !seen;
  });
  result.skipped = rows.length - pending.length;

  if (dryRun) {
    for (const row of pending) {
      ctx.log.info(`[dry-run] row ${row.rowNumber}: ${issueTitle(row.company, row.role)} → ${statusLabel(row.status)}`);
    }
    result.created = pending.length;
    return result;
  }
  if (pending.length === 0) return result;

  await ensureLabels(ctx.octokit, ctx.repo, pending.flatMap(rowLabels));
  const project = await loadProject(ctx);

  for (const [index, row] of pending.entries()) {
    const { data: issue } = await ctx.octokit.rest.issues.create({
      ...ctx.repo,
      title: issueTitle(row.company, row.role),
      body: renderIssueBody({
        applyUrl: row.link,
        postedOn: undefined,
        source: row.source ?? 'import',
        markerId: rowMarkerId(row),
      }),
      labels: [statusLabel(row.status), ...rowLabels(row).map((label) => label.name)],
    });

    if (row.notes) {
      await ctx.octokit.rest.issues.createComment({ ...ctx.repo, issue_number: issue.number, body: row.notes });
    }
    const itemId = await addIssueToProject(ctx.octokit, project, issue.node_id);
    await writeFields(ctx, project, itemId, row);

    if (isTerminalStatus(row.status)) {
      await ctx.octokit.rest.issues.update({
        ...ctx.repo,
        issue_number: issue.number,
        state: 'closed',
        state_reason: 'completed', // the process ran its course; "not planned" is for jobs discarded without applying
      });
    }
    result.created++;
    ctx.log.info(`Row ${row.rowNumber}: created #${issue.number} ${issueTitle(row.company, row.role)}`);
    if (delayMs > 0 && index < pending.length - 1) await sleep(delayMs);
  }
  return result;
}
