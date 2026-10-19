import type { Job } from '../domain/job.js';
import { extractMarker } from '../github/issue-body.js';
import { normalizeText } from '../util/text.js';
import { canonicalUrl } from './url.js';

/** Legal and descriptive suffixes that differ between sources for the same company ("Stefanini" / "Stefanini Group"). */
const COMPANY_SUFFIX =
  /\b(inc|ltda|ltd|limited|llc|corp|corporation|co|company|sa|s a|gmbh|group|grupo|holding|brasil|brazil|technologies|technology|tecnologia|solutions|solucoes)\b/g;

export function companyKey(company: string): string {
  const stripped = normalizeText(company).replace(COMPANY_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  return stripped || normalizeText(company);
}

/** Company + title, normalized: the same job shows up on its ATS, Himalayas, Gupy and Google Jobs. */
export function jobKey(company: string, title: string): string {
  return `${companyKey(company)}|${normalizeText(title)}`;
}

const ANNOTATION = /[(\[{]\s*([^()[\]{}]*?)\s*[)\]}]/g;
const POSTING_CODE = /^(?:(?:job|req|ref|id|vaga|cod|codigo)\s+)?#?(\d{3,})$/;
const YEAR = /^(?:19|20)\d{2}$/;
const EXCLUSIVE = /\b(?:pcd|pwd|exclusiv[oa]s?|afirmativ[oa]s?)\b/;

/**
 * The same posting is sometimes republished with a requisition code or an audience tag in the
 * title ("... (13865)", "[Job - 32255] ...", "... [Exclusiva PCD]"), which defeats an exact title match.
 * The keys of a job are its exact key, the key without those annotations and, when the title carries
 * one, the key of its posting code. Any of them being known makes the job a duplicate.
 */
export function jobKeys(company: string, title: string): string[] {
  let code: string | undefined;
  const bare = title.replace(ANNOTATION, (whole, inner: string) => {
    const text = normalizeText(inner);
    const match = POSTING_CODE.exec(text)?.[1];
    if (match && !YEAR.test(match)) {
      code ??= match;
      return ' ';
    }
    return EXCLUSIVE.test(text) ? ' ' : whole;
  });

  const keys = [jobKey(company, title)];
  const bareKey = jobKey(company, bare);
  if (normalizeText(bare) && !keys.includes(bareKey)) keys.push(bareKey);
  if (code) keys.push(`${companyKey(company)}|code:${code}`);
  return keys;
}

export interface KnownJobs {
  ids: Set<string>;
  urls: Set<string>;
  keys: Set<string>;
}

export function emptyKnown(): KnownJobs {
  return { ids: new Set(), urls: new Set(), keys: new Set() };
}

const TITLE = /^\[([^\]]+)\]\s*(.+)$/;
const APPLY = /\*\*Apply:\*\*\s*(\S+)/;

/**
 * Everything the repo already knows about, taken from its issues (open or closed): the hidden
 * marker, the application link and the `[Company] Role` title. This also covers jobs entered
 * by hand or imported from the spreadsheet, whose markers differ from the collector's.
 */
export function knownFromIssues(issues: Array<{ title: string; body?: string | null }>, known = emptyKnown()): KnownJobs {
  for (const issue of issues) {
    const id = extractMarker(issue.body);
    if (id) known.ids.add(id);

    const url = canonicalUrl(APPLY.exec(issue.body ?? '')?.[1] ?? '');
    if (url) known.urls.add(url);

    const title = TITLE.exec(issue.title);
    if (title) for (const key of jobKeys(title[1]!, title[2]!)) known.keys.add(key);
  }
  return known;
}

export interface Duplicate {
  job: Job;
  reason: string;
}

export interface DedupResult {
  fresh: Job[];
  duplicates: Duplicate[];
}

/**
 * Splits jobs into new and already known. Known = seen id, then canonical URL, then company + title or posting code.
 * Within one run the first occurrence wins, and jobs applied to on the company's own ATS go first,
 * so an aggregator listing never shadows the direct link.
 */
export function dedupe(jobs: Job[], known: KnownJobs): DedupResult {
  const ids = new Set(known.ids);
  const urls = new Set(known.urls);
  const keys = new Set(known.keys);
  const result: DedupResult = { fresh: [], duplicates: [] };

  const ordered = [...jobs].sort((a, b) => Number(b.atsApply) - Number(a.atsApply));
  for (const job of ordered) {
    const url = canonicalUrl(job.applyUrl) ?? job.applyUrl;
    const candidates = jobKeys(job.company, job.title);
    const knownKey = candidates.find((key) => keys.has(key));
    const keyReason = knownKey?.includes('|code:') ? 'company and posting code' : 'company and title';
    const reason = ids.has(job.id) ? 'id' : urls.has(url) ? 'url' : knownKey ? keyReason : undefined;
    if (reason) {
      result.duplicates.push({ job, reason });
      continue;
    }
    ids.add(job.id);
    urls.add(url);
    for (const key of candidates) keys.add(key);
    result.fresh.push(job);
  }
  return result;
}
