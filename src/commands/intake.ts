import { FIELD } from '../domain/fields.js';
import { dynamicLabel, LABEL, slugify, type LabelDef } from '../domain/labels.js';
import { STATUS_TITLES, parseStatusLabel, statusLabel } from '../domain/status.js';
import { addLabels, ensureLabels } from '../github/labels.js';
import { issueTitle, renderIssueBody } from '../github/issue-body.js';
import { addIssueToProject, setFieldValue } from '../github/project.js';
import { canonicalUrl } from '../pipeline/url.js';
import { shortHash } from '../util/hash.js';
import { loadProject, type Context } from './context.js';
import { detectCurrency, parseAmount, parseJobForm } from './form.js';

export interface OpenedEvent {
  action?: string;
  issue?: {
    number: number;
    node_id: string;
    body: string | null;
    labels?: Array<{ name: string } | string>;
  };
}

const FOUND_BY_CONTACT: Record<string, string> = { Recruiter: 'recruiter', Referral: 'referral' };

function labelNames(labels: Array<{ name: string } | string> = []): string[] {
  return labels.map((label) => (typeof label === 'string' ? label : label.name));
}

/**
 * Handles `issues: [opened]` for jobs entered by hand through the issue form: normalizes the
 * title and body to the collector's format, adds labels, and fills the Project fields.
 */
export async function intake(ctx: Context, event: OpenedEvent): Promise<void> {
  const issue = event.issue;
  if (event.action !== 'opened' || !issue) {
    ctx.log.info('Not an "opened" issue event; nothing to do');
    return;
  }
  const existing = labelNames(issue.labels);
  if (!existing.includes(LABEL.manual)) {
    ctx.log.info(`Issue #${issue.number} is not a manual entry; nothing to do`);
    return;
  }

  const form = parseJobForm(issue.body ?? '');
  if (!form) {
    ctx.log.warn(`Issue #${issue.number}: company, role or application link is missing; left untouched`);
    return;
  }
  const applyUrl = canonicalUrl(form.link);
  if (!applyUrl) {
    await ctx.octokit.rest.issues.createComment({
      ...ctx.repo,
      issue_number: issue.number,
      body: `The application link \`${form.link}\` is not a valid http(s) URL. Edit the issue and fix it; job-radar needs a link to track the job.`,
    });
    ctx.log.warn(`Issue #${issue.number}: invalid application link`);
    return;
  }

  const found = FOUND_BY_CONTACT[form.contact ?? ''] ?? 'manual';
  const dynamic = [
    dynamicLabel('found', found),
    ...form.contract.map((value) => dynamicLabel('contract', value)),
  ].filter((label): label is LabelDef => label !== undefined);
  await ensureLabels(ctx.octokit, ctx.repo, dynamic);

  const current = existing.map(parseStatusLabel).find((status) => status !== undefined) ?? 'new';
  const labels = dynamic.map((label) => label.name);
  if (!existing.some((name) => parseStatusLabel(name))) labels.push(statusLabel('new'));
  await addLabels(ctx.octokit, ctx.repo, issue.number, labels);

  await ctx.octokit.rest.issues.update({
    ...ctx.repo,
    issue_number: issue.number,
    title: issueTitle(form.company, form.role),
    body: renderIssueBody({
      applyUrl,
      compensation: form.compensation,
      source: 'manual',
      markerId: `manual:${slugify(form.company)}:${shortHash(form.company, form.role, applyUrl)}`,
    }),
  });
  if (form.notes) {
    await ctx.octokit.rest.issues.createComment({ ...ctx.repo, issue_number: issue.number, body: form.notes });
  }

  const project = await loadProject(ctx);
  const itemId = await addIssueToProject(ctx.octokit, project, issue.node_id);
  const set = (name: string, value: Parameters<typeof setFieldValue>[4]) =>
    setFieldValue(ctx.octokit, project, itemId, name, value);

  await set(FIELD.status, { type: 'option', name: STATUS_TITLES[current] });
  const currency = form.currency ?? detectCurrency(form.compensation);
  if (currency) await set(FIELD.currency, { type: 'option', name: currency });
  if (form.contact) await set(FIELD.contact, { type: 'option', name: form.contact });
  const amount = parseAmount(form.compensation);
  if (amount !== undefined) await set(FIELD.offeredSalary, { type: 'number', value: amount });

  ctx.log.info(`Issue #${issue.number}: manual entry for ${form.company} processed`);
}
