import { PROJECT_FIELDS } from '../domain/fields.js';
import { STATIC_LABELS } from '../domain/labels.js';
import { ensureLabels } from '../github/labels.js';
import { ensureProjectFields } from '../github/project.js';
import { loadProject, type Context } from './context.js';

/** Creates the labels and the Project fields the rest of job-radar relies on. Safe to run repeatedly. */
export async function setup(ctx: Context): Promise<void> {
  const labels = await ensureLabels(ctx.octokit, ctx.repo, STATIC_LABELS);
  ctx.log.info(`Labels: ${labels.created.length} created, ${labels.updated.length} aligned`);

  const project = await loadProject(ctx);
  const fields = await ensureProjectFields(ctx.octokit, project, PROJECT_FIELDS);
  ctx.log.info(`Project "${project.title}": ${fields.created.length} fields created`);
  for (const name of fields.optionsUpdated) {
    ctx.log.warn(`Options of "${name}" were replaced; items that had a value in that field lost it`);
  }
}
