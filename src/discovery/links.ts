/** ATS the per-company adapters understand, and where each one keeps its company slug in a career page URL. */
const PATTERNS: Array<{ ats: 'inhire' | 'greenhouse' | 'lever' | 'ashby'; pattern: RegExp; ignore?: string[] }> = [
  { ats: 'inhire', pattern: /^https?:\/\/([a-z0-9-]+)\.inhire\.app(?:\/|$)/i, ignore: ['www', 'app', 'api', 'files'] },
  {
    ats: 'greenhouse',
    pattern: /^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i,
    ignore: ['embed', 'jobs'],
  },
  { ats: 'lever', pattern: /^https?:\/\/jobs(?:\.eu)?\.lever\.co\/([a-z0-9_.-]+)/i },
  { ats: 'ashby', pattern: /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i },
];

export type DiscoveredCompanies = Record<'inhire' | 'greenhouse' | 'lever' | 'ashby', string[]>;

/** Company slugs found in a list of search-result links, per ATS, lower case and without repeats. */
export function companiesFromLinks(links: string[]): DiscoveredCompanies {
  const found: DiscoveredCompanies = { inhire: [], greenhouse: [], lever: [], ashby: [] };
  for (const link of links) {
    for (const { ats, pattern, ignore = [] } of PATTERNS) {
      const slug = pattern.exec(link)?.[1]?.toLowerCase();
      if (slug && !ignore.includes(slug) && !found[ats].includes(slug)) found[ats].push(slug);
    }
  }
  return found;
}
