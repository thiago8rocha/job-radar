import type { LabelDef } from '../domain/labels.js';
import { parseStatusLabel, type Status } from '../domain/status.js';
import type { GitHub, RepoRef } from './client.js';

export interface EnsureLabelsResult {
  created: string[];
  updated: string[];
}

function isStatus(error: unknown, code: number): boolean {
  return (error as { status?: number }).status === code;
}

/** Creates each label, or aligns color and description when it already exists. */
export async function ensureLabels(
  octokit: GitHub,
  repo: RepoRef,
  labels: LabelDef[],
): Promise<EnsureLabelsResult> {
  const result: EnsureLabelsResult = { created: [], updated: [] };
  for (const label of labels) {
    try {
      await octokit.rest.issues.createLabel({ ...repo, ...label });
      result.created.push(label.name);
    } catch (error) {
      if (!isStatus(error, 422)) throw error; // 422 = already exists
      await octokit.rest.issues.updateLabel({ ...repo, ...label });
      result.updated.push(label.name);
    }
  }
  return result;
}

export async function addLabels(
  octokit: GitHub,
  repo: RepoRef,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  if (labels.length === 0) return;
  await octokit.rest.issues.addLabels({ ...repo, issue_number: issueNumber, labels });
}

export async function removeLabel(
  octokit: GitHub,
  repo: RepoRef,
  issueNumber: number,
  name: string,
): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({ ...repo, issue_number: issueNumber, name });
  } catch (error) {
    if (!isStatus(error, 404)) throw error; // already gone
  }
}

export function statusesOf(labelNames: string[]): Status[] {
  return labelNames.flatMap((name) => parseStatusLabel(name) ?? []);
}
