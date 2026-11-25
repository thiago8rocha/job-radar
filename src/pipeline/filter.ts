import type { Config } from '../config/schema.js';
import type { Job, WorkModel } from '../domain/job.js';
import { containsTerm, normalizeText } from '../util/text.js';
import { checkEligibility } from './eligibility.js';
import { requiredLanguage } from './language.js';
import { detectWorkModel } from './work-model.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keywords per seniority level, EN and PT, compared on normalized text (no accents). */
const SENIORITY_KEYWORDS: Record<string, string[]> = {
  senior: ['senior', 'sr', 'iii', 'iv', 'nivel 3', 'nivel 4', 'level 3', 'level 4'],
  specialist: ['especialista', 'specialist'],
  staff: ['staff', 'principal'],
  lead: ['lead', 'lider', 'head'],
};

/** Years of experience at which a posting that states no level is read as senior. */
const SENIOR_MIN_YEARS = 5;

const YEARS_RANGE = /\d{1,2}\s*(?:-|–|to|a)\s*\d{1,2}\+?/gi;
const YEARS_THEN_EXPERIENCE = /(\d{1,2})\s*\+?\s*(?:years?|yrs?|anos)\b[^.\n]{0,40}?\bexperi[eê]nc(?:e|ia)/gi;
const EXPERIENCE_THEN_YEARS = /\bexperi[eê]nc(?:e|ia)\b[^.\n]{0,40}?(\d{1,2})\s*\+?\s*(?:years?|yrs?|anos)\b/gi;

/** True when the description asks for `SENIOR_MIN_YEARS` or more years of experience; ranges like "3-5 years" are mid level and ignored. */
function asksForSeniorExperience(description: string): boolean {
  const text = description.replace(YEARS_RANGE, ' ');
  return [YEARS_THEN_EXPERIENCE, EXPERIENCE_THEN_YEARS].some((pattern) =>
    [...text.matchAll(pattern)].some((match) => Number(match[1]) >= SENIOR_MIN_YEARS),
  );
}

export interface FilterResult {
  ok: boolean;
  /** `<stage>: <detail>`; the part before the colon groups the discard counts in the summary. */
  reason?: string;
}

/** Seniority levels a job states, from the source's own field and from words in the title; failing both, senior if the description asks for years of experience. */
export function detectSeniority(job: Pick<Job, 'title' | 'seniority'> & { description?: string }): string[] {
  const found = new Set(job.seniority.map((level) => level.toLowerCase()));
  for (const [level, keywords] of Object.entries(SENIORITY_KEYWORDS)) {
    if (keywords.some((keyword) => containsTerm(job.title, keyword))) found.add(level);
  }
  if (found.size === 0 && job.description && asksForSeniorExperience(job.description)) found.add('senior');
  return [...found];
}

/** Work model of the job, reconciling the source's field with the title, locations and description. */
export function inferWorkModel(job: Pick<Job, 'workModel' | 'title' | 'locations' | 'description'>): WorkModel | undefined {
  return detectWorkModel(job);
}

export interface RuleFailure {
  reason: string;
  /** The posting is silent about something (seniority, work model, location) rather than contradicting the search. */
  soft: boolean;
}

export interface FilterReport {
  ok: boolean;
  failures: RuleFailure[];
}

/** `region not accepted` is soft only for a job that lists no location: then the filter had nothing to judge. */
function isSoft(reason: string, job: Job): boolean {
  if (reason === 'seniority: not stated' || reason === 'work model: not stated') return true;
  return reason === 'eligibility: region not accepted' && job.locations.length === 0 && !job.restrictions?.length;
}

export interface JobFilter {
  check(job: Job, now: Date): FilterResult;
  /** Every failing rule, not just the first; for the near-miss report, not the hot path. */
  checkAll(job: Job, now: Date): FilterReport;
  /** Title and work model only, so adapters can skip detail requests for jobs that cannot pass. */
  worthDetails(candidate: { title: string; company?: string; workModel?: WorkModel }): boolean;
}

const compactText = (value: string): string => normalizeText(value).replace(/ /g, '');

export function createFilter(config: Config): JobFilter {
  const { search, eligibility } = config;
  const ambiguous = new Set(search.ambiguous.map(normalizeText));
  const allowedModels = new Set<WorkModel>(config.work_model);
  const wantedSeniority = new Set(search.seniority.map((level) => level.toLowerCase()));

  const blockedCompany = (company: string): string | undefined =>
    search.exclude_companies.find((name) => containsTerm(company, name) || (compactText(name) !== '' && compactText(company) === compactText(name)));

  const titleResult = (title: string): { matched: string[]; excluded?: string } => ({
    matched: search.include.filter((term) => containsTerm(title, term)),
    excluded: search.exclude.find((term) => containsTerm(title, term)),
  });

  const rules: Array<(job: Job, now: Date) => string | undefined> = [
    (job) => {
      const blocked = blockedCompany(job.company);
      return blocked ? `excluded company: "${blocked}"` : undefined;
    },
    (job) => {
      const { excluded } = titleResult(job.title);
      return excluded ? `excluded term: "${excluded}"` : undefined;
    },
    (job) => (titleResult(job.title).matched.length === 0 ? 'title: no search term matched' : undefined),
    (job) => {
      const { matched } = titleResult(job.title);
      const onlyAmbiguous = matched.length > 0 && matched.every((term) => ambiguous.has(normalizeText(term)));
      if (!onlyAmbiguous || search.ambiguous_requires.length === 0) return undefined;
      const text = `${job.title} ${job.description}`;
      return search.ambiguous_requires.some((word) => containsTerm(text, word)) ? undefined : 'title: ambiguous term without a confirming word';
    },
    (job) => {
      if (wantedSeniority.size === 0) return undefined;
      const levels = detectSeniority(job);
      if (levels.length === 0) return 'seniority: not stated';
      return levels.some((level) => wantedSeniority.has(level)) ? undefined : `seniority: ${levels.join('/')}`;
    },
    (job) => {
      const model = inferWorkModel(job);
      if (!model) return 'work model: not stated';
      return allowedModels.has(model) ? undefined : `work model: ${model}`;
    },
    (job, now) => {
      if (!job.postedAt) return undefined;
      const posted = Date.parse(job.postedAt);
      return !Number.isNaN(posted) && now.getTime() - posted > search.max_age_days * DAY_MS ? `age: older than ${search.max_age_days} days` : undefined;
    },
    (job) => checkEligibility(job, eligibility.accept_regions, eligibility.reject).reason,
    (job) => {
      const language = requiredLanguage(`${job.title}
${job.description}`, eligibility.reject_languages);
      return language ? `language: requires ${language}` : undefined;
    },
  ];

  return {
    worthDetails({ title, company, workModel }) {
      if (company && blockedCompany(company)) return false;
      const { matched, excluded } = titleResult(title);
      if (excluded || matched.length === 0) return false;
      return workModel === undefined || allowedModels.has(workModel);
    },

    check(job, now) {
      for (const rule of rules) {
        const reason = rule(job, now);
        if (reason) return { ok: false, reason };
      }
      return { ok: true };
    },

    checkAll(job, now) {
      const failures = rules.flatMap((rule) => rule(job, now) ?? []).map((reason) => ({ reason, soft: isSoft(reason, job) }));
      return { ok: failures.length === 0, failures };
    },
  };
}
