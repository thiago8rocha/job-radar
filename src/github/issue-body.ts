export interface IssueBodyInput {
  /** Missing only for historical jobs imported without a link; the collector always has one. */
  applyUrl?: string;
  location?: string;
  postedOn?: string;
  compensation?: string;
  source: string;
  excerpt?: string;
  /** Stable id of the job, written in the hidden marker: `<source>:<company>:<hash>`. */
  markerId: string;
}

const MARKER = /<!--\s*job-radar:id=([^\s>]+)\s*-->/;
const EMPTY = '—';

export function issueTitle(company: string, role: string): string {
  return `[${company}] ${role}`;
}

export function marker(id: string): string {
  return `<!-- job-radar:id=${id} -->`;
}

export function extractMarker(body: string | null | undefined): string | undefined {
  return MARKER.exec(body ?? '')?.[1];
}

/** Body in the format described in "Issue model": the application link is always the first line. */
export function renderIssueBody(input: IssueBodyInput): string {
  const lines = [
    `**Apply:** ${input.applyUrl || EMPTY}`,
    `**Location / eligibility:** ${input.location || EMPTY}`,
    `**Posted on:** ${input.postedOn || EMPTY}`,
    `**Stated compensation:** ${input.compensation || EMPTY}`,
    `**Source:** ${input.source}`,
  ];
  if (input.excerpt) {
    lines.push('', ...input.excerpt.trim().split('\n').map((line) => `> ${line}`));
  }
  lines.push('', marker(input.markerId));
  return lines.join('\n');
}
