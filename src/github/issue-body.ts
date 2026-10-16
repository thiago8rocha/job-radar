export interface IssueBodyInput {
  /** Missing only for historical jobs imported without a link; the collector always has one. */
  applyUrl?: string;
  location?: string;
  postedOn?: string;
  compensation?: string;
  source: string;
  excerpt?: string;
  /** Extra `**Label:** value` lines after the source, such as the AI's fit score. */
  extraLines?: string[];
  /** Full posting text, kept in a collapsed block so `/evaluate` and the reader have it without the link. */
  fullDescription?: string;
  /** Stable id of the job, written in the hidden marker: `<source>:<company>:<hash>`. */
  markerId: string;
}

/** Start of the collapsed block that holds the full description. */
export const DESCRIPTION_SUMMARY = '<summary>Full description</summary>';

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
    ...(input.extraLines ?? []),
  ];
  if (input.excerpt) {
    lines.push('', ...input.excerpt.trim().split('\n').map((line) => `> ${line}`));
  }
  if (input.fullDescription) {
    lines.push('', '<details>', DESCRIPTION_SUMMARY, '', input.fullDescription.trim(), '', '</details>');
  }
  lines.push('', marker(input.markerId));
  return lines.join('\n');
}

/** The full description stored by `renderIssueBody`, if the issue has one. */
export function extractFullDescription(body: string | null | undefined): string | undefined {
  const match = /<details>\s*<summary>Full description<\/summary>\s*([\s\S]*?)\s*<\/details>/.exec(body ?? '');
  return match?.[1]?.trim() || undefined;
}
