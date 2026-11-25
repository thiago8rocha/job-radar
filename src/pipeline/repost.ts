import { LABEL } from '../domain/labels.js';
import { parseStatusLabel } from '../domain/status.js';
import { jobKeys } from './dedup.js';

export interface PriorIssue {
  number: number;
  state: 'open' | 'closed';
  labels: string[];
}

export type RepostAction = 'comment' | 'reopen';

const TITLE = /^\[([^\]]+)\]\s*(.+)$/;

/** The issue each company + title key points at; when several share a key, the newest one. */
export function priorIssuesByKey(issues: Array<{ number: number; title: string; state: string; labels?: Array<string | { name?: string | null }> }>): Map<string, PriorIssue> {
  const byKey = new Map<string, PriorIssue>();
  for (const issue of issues) {
    const title = TITLE.exec(issue.title);
    if (!title) continue;
    const prior: PriorIssue = {
      number: issue.number,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name ?? '')).filter(Boolean),
    };
    for (const key of jobKeys(title[1]!, title[2]!)) {
      const current = byKey.get(key);
      if (!current || current.number < prior.number) byKey.set(key, prior);
    }
  }
  return byKey;
}

/**
 * What a repost of a job (same company and title, new id) means for the issue it matches. A closed issue,
 * or an application with no answer, gets a comment and the `signal:reposted` label. An issue that
 * `revalidate` closed (so it was never past "New") comes back at `status:new`. An open issue that is
 * still being worked on needs nothing: the job is simply still listed.
 */
export function repostAction(issue: PriorIssue): RepostAction | undefined {
  const statuses = issue.labels.flatMap((name) => parseStatusLabel(name) ?? []);
  if (issue.state === 'closed') {
    const neverWorked = issue.labels.includes(LABEL.closedAtSource) && statuses.every((status) => status === 'discarded' || status === 'new');
    return neverWorked ? 'reopen' : 'comment';
  }
  return statuses.includes('applied') || issue.labels.includes(LABEL.noResponse) ? 'comment' : undefined;
}

export function repostMarker(jobId: string): string {
  return `<!-- job-radar:repost=${jobId} -->`;
}
