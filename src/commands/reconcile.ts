import { FIELD } from '../domain/fields.js';
import { STATUS_TITLES, parseStatusLabel } from '../domain/status.js';
import { addIssueToProject, setFieldValue, type Project, type ProjectItem } from '../github/project.js';
import type { Context } from './context.js';

export interface LabeledIssue {
  number: number;
  node_id: string;
  labels: string[];
}

/**
 * Makes the Project `Status` field match each issue's `status:*` label, which is the source of truth.
 * It heals items that were never added, changed by hand on the board, or emptied when the field's
 * options were replaced (adding "Discarded" to an existing Project does that). Returns how many changed.
 */
export async function reconcileStatusField(
  ctx: Context,
  project: Project,
  issues: LabeledIssue[],
  items: Map<number, ProjectItem>,
  dryRun = false,
): Promise<number> {
  let changed = 0;
  for (const issue of issues) {
    const status = issue.labels.map(parseStatusLabel).find((value) => value !== undefined);
    if (!status) continue;
    const wanted = STATUS_TITLES[status];
    const item = items.get(issue.number);
    if (item?.values[FIELD.status] === wanted) continue;

    changed++;
    if (dryRun) {
      ctx.log.info(`[dry-run] #${issue.number}: Status ${item?.values[FIELD.status] ?? '(empty)'} → ${wanted}`);
      continue;
    }
    const itemId = item?.id ?? (await addIssueToProject(ctx.octokit, project, issue.node_id));
    await setFieldValue(ctx.octokit, project, itemId, FIELD.status, { type: 'option', name: wanted });
  }
  return changed;
}
