import { FIELD } from '../domain/fields.js';
import { STATUS_TITLES, closeReason, isTerminalStatus, type Status } from '../domain/status.js';
import { removeLabel } from '../github/labels.js';
import { addIssueToProject, getDateValue, setFieldValue } from '../github/project.js';
import { loadProject, type Context } from './context.js';
import { planStatusSync } from './plan.js';

export interface LabeledEvent {
  action?: string;
  label?: { name: string };
  issue?: { number: number; node_id: string };
}

/**
 * Handles `issues: [labeled]`: keeps a single `status:*` label on the issue and mirrors it
 * into the Project `Status` field (the board column). Applying `status:applied` also fills
 * `Applied on`, unless it is already set.
 */
export async function syncStatus(ctx: Context, event: LabeledEvent, now = new Date()): Promise<void> {
  if (event.action !== 'labeled' || !event.label || !event.issue) {
    ctx.log.info('Not a "labeled" issue event; nothing to do');
    return;
  }
  const { number, node_id: nodeId } = event.issue;

  // The payload labels can be stale if runs overlap, so read the current ones.
  const { data } = await ctx.octokit.rest.issues.listLabelsOnIssue({ ...ctx.repo, issue_number: number, per_page: 100 });
  const plan = planStatusSync(event.label.name, data.map((label) => label.name));
  if (!plan) {
    ctx.log.info(`"${event.label.name}" is not an active status change; nothing to do`);
    return;
  }

  for (const name of plan.remove) await removeLabel(ctx.octokit, ctx.repo, number, name);

  const project = await loadProject(ctx);
  const itemId = await addIssueToProject(ctx.octokit, project, nodeId);
  await setFieldValue(ctx.octokit, project, itemId, FIELD.status, { type: 'option', name: STATUS_TITLES[plan.status] });

  if (plan.fillAppliedOn && !(await getDateValue(ctx.octokit, itemId, FIELD.appliedOn))) {
    await setFieldValue(ctx.octokit, project, itemId, FIELD.appliedOn, { type: 'date', value: now.toISOString().slice(0, 10) });
  }
  if (ctx.config.issues.close_on_final_status) await reconcileState(ctx, number, plan.status);
  ctx.log.info(`Issue #${number}: status is now "${STATUS_TITLES[plan.status]}"`);
}

/**
 * A process that ended (rejected, withdrawn, hired) closes the issue as "completed", a discarded job as
 * "not planned"; an issue that goes back to an active status is reopened.
 */
async function reconcileState(ctx: Context, issueNumber: number, status: Status): Promise<void> {
  const { data } = await ctx.octokit.rest.issues.get({ ...ctx.repo, issue_number: issueNumber });
  const finished = isTerminalStatus(status);
  if (finished && data.state === 'open') {
    await ctx.octokit.rest.issues.update({ ...ctx.repo, issue_number: issueNumber, state: 'closed', state_reason: closeReason(status) });
  } else if (!finished && data.state === 'closed') {
    await ctx.octokit.rest.issues.update({ ...ctx.repo, issue_number: issueNumber, state: 'open', state_reason: 'reopened' });
  }
}
