import { containsTerm, truncate } from '../util/text.js';

const MAX_EXCERPT = 400;

/**
 * Makes third-party text safe to quote in an issue: no @mentions or #refs that would notify or link
 * someone, no raw HTML, and no way to forge the hidden job marker.
 */
export function sanitizeForIssue(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(?=\w)/g, '@​')
    .replace(/#(?=\d)/g, '#​');
}

/** Terms from `search.highlight` that the description mentions, in the order the config lists them. */
export function matchedTerms(description: string, highlight: string[]): string[] {
  return highlight.filter((term) => containsTerm(description, term));
}

/** Short quote for the issue body: the matched highlight terms, then the start of the description. */
export function buildExcerpt(description: string, highlight: string[]): string | undefined {
  const lead = truncate(description.replace(/\s+/g, ' ').trim(), MAX_EXCERPT);
  const terms = matchedTerms(description, highlight);
  const lines = [terms.length > 0 ? `Matched: ${terms.join(', ')}` : undefined, lead || undefined].filter(
    (line): line is string => Boolean(line),
  );
  return lines.length > 0 ? sanitizeForIssue(lines.join('\n')) : undefined;
}
