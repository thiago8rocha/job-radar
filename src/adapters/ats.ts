export interface AtsUrlPattern {
  /** Captures the company slug in group 1. */
  pattern: RegExp;
  /** Captured values that are not companies (`embed`, `www`). */
  ignore?: string[];
  region?: 'eu';
}

export interface AtsDefinition {
  id: string;
  urls: AtsUrlPattern[];
  /** The slug's case matters on the ATS, so it is kept as written instead of lower-cased. */
  caseSensitive?: boolean;
}

/** Every per-company ATS: a new one is an entry here plus its adapter. */
export const ATS = [
  { id: 'inhire', urls: [{ pattern: /^https?:\/\/([a-z0-9-]+)\.inhire\.app(?:\/|$)/i, ignore: ['www', 'app', 'api', 'files'] }] },
  {
    id: 'greenhouse',
    urls: [
      { pattern: /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/i, ignore: ['embed', 'jobs'] },
      { pattern: /^https?:\/\/(?:boards|job-boards)\.eu\.greenhouse\.io\/([a-z0-9_-]+)/i, ignore: ['embed', 'jobs'], region: 'eu' },
    ],
  },
  {
    id: 'lever',
    urls: [
      { pattern: /^https?:\/\/jobs\.lever\.co\/([a-z0-9_.-]+)/i },
      { pattern: /^https?:\/\/jobs\.eu\.lever\.co\/([a-z0-9_.-]+)/i, region: 'eu' },
    ],
  },
  { id: 'ashby', urls: [{ pattern: /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i }] },
] as const satisfies readonly AtsDefinition[];

export type AtsId = (typeof ATS)[number]['id'];

export type AtsTable = readonly AtsDefinition[];

export function slugKey(def: AtsDefinition, slug: string): string {
  return def.caseSensitive ? slug : slug.toLowerCase();
}

/** `{ <ats>: [] }` for every ATS in the table. */
export function emptyByAts<T = never>(table: AtsTable = ATS): Record<AtsId, T[]> {
  return Object.fromEntries(table.map((def) => [def.id, []])) as unknown as Record<AtsId, T[]>;
}
