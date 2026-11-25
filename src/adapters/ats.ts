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
  /** Wayback Machine CDX URL patterns that list this ATS's tenants, for ATS with no central search. */
  archive?: string[];
}

/** Every per-company ATS: a new one is an entry here plus its adapter. */
export const ATS = [
  {
    id: 'inhire',
    urls: [{ pattern: /^https?:\/\/([a-z0-9-]+)\.inhire\.app(?:\/|$)/i, ignore: ['www', 'app', 'api', 'files'] }],
    archive: ['*.inhire.app'],
  },
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
  {
    id: 'solides',
    urls: [
      { pattern: /^https?:\/\/([a-z0-9-]+)\.vagas\.solides\.com\.br(?:\/|$)/i, ignore: ['www', 'vagas'] },
      { pattern: /^https?:\/\/(?:www\.)?vagas\.solides\.com\.br\/empresa\/([a-z0-9_-]+)/i },
    ],
    archive: ['*.vagas.solides.com.br'],
  },
  { id: 'quickin', urls: [{ pattern: /^https?:\/\/jobs\.quickin\.io\/([a-z0-9_-]+)/i, ignore: ['jobs', 'api', 'login'] }], archive: ['jobs.quickin.io/*'] },
  {
    id: 'teamtailor',
    urls: [{ pattern: /^https?:\/\/([a-z0-9-]+)\.teamtailor\.com(?:\/|$)/i, ignore: ['www', 'app', 'api', 'support', 'docs', 'blog', 'partner'] }],
    archive: ['*.teamtailor.com'],
  },
  {
    id: 'recruitee',
    urls: [{ pattern: /^https?:\/\/([a-z0-9-]+)\.recruitee\.com(?:\/|$)/i, ignore: ['www', 'app', 'api', 'help', 'docs', 'blog', 'support'] }],
    archive: ['*.recruitee.com'],
  },
  {
    id: 'smartrecruiters',
    urls: [{ pattern: /^https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/(?:oneclick-ui\/company\/)?([A-Za-z0-9_-]+)/i, ignore: ['oneclick-ui', 'external-referrals', 'search', 'jobs', 'company'] }],
    caseSensitive: true,
    archive: ['jobs.smartrecruiters.com/*'],
  },
  {
    id: 'workable',
    urls: [
      { pattern: /^https?:\/\/apply\.workable\.com\/(?:api\/v1\/widget\/accounts\/)?([a-z0-9_-]+)/i, ignore: ['j', 'api', 'o'] },
      { pattern: /^https?:\/\/([a-z0-9-]+)\.workable\.com(?:\/|$)/i, ignore: ['www', 'apply', 'help', 'resources', 'api'] },
    ],
    archive: ['apply.workable.com/*'],
  },
] as const satisfies readonly AtsDefinition[];

export type AtsId = (typeof ATS)[number]['id'];

export type AtsTable = readonly AtsDefinition[];

/** The slug and region of a company entry: read from its board URL when it has one, else the slug as written. */
export function resolveBoard(atsId: string, ref: { slug: string; url?: string }, table: AtsTable = ATS): { slug: string; region?: 'eu' } {
  if (!ref.url) return { slug: ref.slug };
  const def = table.find((entry) => entry.id === atsId);
  for (const { pattern, region } of def?.urls ?? []) {
    const slug = pattern.exec(ref.url)?.[1];
    if (slug) return { slug, region };
  }
  return { slug: ref.slug };
}

export function slugKey(def: AtsDefinition, slug: string): string {
  return def.caseSensitive ? slug : slug.toLowerCase();
}

/** `{ <ats>: [] }` for every ATS in the table. */
export function emptyByAts<T = never>(table: AtsTable = ATS): Record<AtsId, T[]> {
  return Object.fromEntries(table.map((def) => [def.id, []])) as unknown as Record<AtsId, T[]>;
}
