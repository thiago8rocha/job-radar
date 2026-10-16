import { FIELD, PROJECT_FIELDS } from '../domain/fields.js';
import { STATIC_LABELS } from '../domain/labels.js';
import { ensureLabels } from '../github/labels.js';
import { ensureProjectFields, listProjectItems } from '../github/project.js';
import { reconcileStatusField } from './reconcile.js';
import { loadProject, type Context } from './context.js';

/** Creates the labels and the Project fields the rest of job-radar relies on. Safe to run repeatedly. */
export async function setup(ctx: Context): Promise<void> {
  const labels = await ensureLabels(ctx.octokit, ctx.repo, STATIC_LABELS);
  ctx.log.info(`Labels: ${labels.created.length} created, ${labels.updated.length} aligned`);

  const project = await loadProject(ctx);
  const fields = await ensureProjectFields(ctx.octokit, project, PROJECT_FIELDS);
  ctx.log.info(`Project "${project.title}": ${fields.created.length} fields created`);
  if (fields.optionsUpdated.length > 0) {
    ctx.log.info(`Options replaced on: ${fields.optionsUpdated.join(', ')}`);
    if (fields.optionsUpdated.includes(FIELD.status)) await restoreStatuses(ctx);
  }
}

/**
 * Replacing the options of `Status` empties it on every item; the labels say what it should be.
 * GitHub can lag behind the writes, so the Project is read again and anything still off is fixed once more.
 */
async function restoreStatuses(ctx: Context): Promise<void> {
  const issues = await ctx.octokit.paginate(ctx.octokit.rest.issues.listForRepo, { ...ctx.repo, state: 'all', per_page: 100 });
  const labeled = issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      node_id: issue.node_id,
      labels: issue.labels.map((label) => (typeof label === 'string' ? label : label.name ?? '')),
    }));

  let restored = 0;
  for (let pass = 0; pass < 2; pass++) {
    const project = await loadProject(ctx);
    const items = await listProjectItems(ctx.octokit, project);
    const changed = await reconcileStatusField(ctx, project, labeled, items);
    restored += changed;
    if (changed === 0) break;
  }
  ctx.log.info(`Status restored from the labels on ${restored} write(s)`);
}
