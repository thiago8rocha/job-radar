import { LABEL } from '../domain/labels.js';
import { parseStatusLabel } from '../domain/status.js';
import { extractMarker } from '../github/issue-body.js';
import { jobKeys } from './dedup.js';

export interface PriorIssue {
  number: number;
  state: 'open' | 'closed';
  labels: string[];
  /** When the issue was opened: a repost is a posting published after it. */
  createdAt?: string;
  /** The source that created the issue, from its marker; manual and imported issues have no source that could repost. */
  source?: string;
}

export type RepostAction = 'comment' | 'reopen';

const TITLE = /^\[([^\]]+)\]\s*(.+)$/;

/** The issue each company + title key points at; when several share a key, the newest one. */
export function priorIssuesByKey(issues: Array<{ number: number; title: string; state: string; created_at?: string; body?: string | null; labels?: Array<string | { name?: string | null }> }>): Map<string, PriorIssue> {
  const byKey = new Map<string, PriorIssue>();
  for (const issue of issues) {
    const title = TITLE.exec(issue.title);
    if (!title) continue;
    const prior: PriorIssue = {
      number: issue.number,
      state: issue.state === 'closed' ? 'closed' : 'open',
      createdAt: issue.created_at,
      source: extractMarker(issue.body)?.split(':')[0],
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

/**
 * A repost is the source listing the job again: the same source as the earlier issue, with a publication date
 * after it was opened. The same posting reached through another source is only a duplicate, and aggregators
 * refresh their dates, so a newer date alone proves nothing. A job with no date is never a repost.
 */
export function isRepost(job: { source: string; postedAt?: string }, issue: PriorIssue): boolean {
  if (!issue.source || job.source !== issue.source) return false;
  const posted = Date.parse(job.postedAt ?? '');
  const opened = Date.parse(issue.createdAt ?? '');
  return !Number.isNaN(posted) && !Number.isNaN(opened) && posted > opened;
}

export function repostMarker(jobId: string): string {
  return `<!-- job-radar:repost=${jobId} -->`;
}
