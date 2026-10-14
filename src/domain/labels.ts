import { STATUSES, statusLabel } from './status.js';

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

export const LABEL = {
  manual: 'manual',
  closedAtSource: 'closed-at-source',
} as const;

const STATUS_COLORS: Record<string, string> = {
  new: 'bfd4f2',
  applied: '0e8a16',
  screening: '5319e7',
  'hr-interview': '5319e7',
  'tech-interview': '5319e7',
  'take-home': '5319e7',
  offer: 'fbca04',
  hired: '0e8a16',
  rejected: 'b60205',
  withdrawn: '6a737d',
};

/** Labels with a fixed name, created by `job-radar setup`. */
export const STATIC_LABELS: LabelDef[] = [
  ...STATUSES.map((s) => ({
    name: statusLabel(s),
    color: STATUS_COLORS[s] ?? 'ededed',
    description: `Hiring process status: ${s}`,
  })),
  { name: 'scope:brazil', color: '1d76db', description: 'Brazilian job' },
  { name: 'scope:international', color: '0052cc', description: 'International job' },
  { name: 'work:remote', color: 'c2e0c6', description: 'Fully remote' },
  { name: 'work:hybrid', color: 'fef2c0', description: 'Hybrid work model' },
  { name: LABEL.manual, color: 'd4c5f9', description: 'Entered by hand (recruiter, referral...)' },
  { name: LABEL.closedAtSource, color: 'cccccc', description: 'The posting disappeared from its source' },
];

const PREFIX_COLORS: Record<string, string> = {
  found: 'c5def5',
  ats: 'bfdadc',
  contract: 'e99695',
};

/** Slug used inside dynamic labels (`found:*`, `ats:*`, `contract:*`). */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Definition for a dynamic label such as `found:linkedin`, created on first use. */
export function dynamicLabel(prefix: 'found' | 'ats' | 'contract', value: string): LabelDef | undefined {
  const slug = slugify(value);
  if (!slug) return undefined;
  return {
    name: `${prefix}:${slug}`,
    color: PREFIX_COLORS[prefix] ?? 'ededed',
    description: { found: 'Where the job was seen', ats: 'Where the application was made', contract: 'Contract type' }[prefix],
  };
}
