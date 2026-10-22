import type { Config } from '../config/schema.js';
import type { Job, WorkModel } from '../domain/job.js';
import { containsTerm, normalizeText } from '../util/text.js';
import { checkEligibility } from './eligibility.js';
import { requiredLanguage } from './language.js';
import { detectWorkModel } from './work-model.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keywords per seniority level, EN and PT, compared on normalized text (no accents). */
const SENIORITY_KEYWORDS: Record<string, string[]> = {
  senior: ['senior', 'sr'],
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

export interface JobFilter {
  check(job: Job, now: Date): FilterResult;
  /** Title and work model only, so adapters can skip detail requests for jobs that cannot pass. */
  worthDetails(candidate: { title: string; workModel?: WorkModel }): boolean;
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

  return {
    worthDetails({ title, workModel }) {
      const { matched, excluded } = titleResult(title);
      if (excluded || matched.length === 0) return false;
      return workModel === undefined || allowedModels.has(workModel);
    },

    check(job, now) {
      const blocked = blockedCompany(job.company);
      if (blocked) return { ok: false, reason: `excluded company: "${blocked}"` };

      const { matched, excluded } = titleResult(job.title);
      if (excluded) return { ok: false, reason: `excluded term: "${excluded}"` };
      if (matched.length === 0) return { ok: false, reason: 'title: no search term matched' };

      const onlyAmbiguous = matched.every((term) => ambiguous.has(normalizeText(term)));
      if (onlyAmbiguous && search.ambiguous_requires.length > 0) {
        const text = `${job.title} ${job.description}`;
        if (!search.ambiguous_requires.some((word) => containsTerm(text, word))) {
          return { ok: false, reason: 'title: ambiguous term without a confirming word' };
        }
      }

      if (wantedSeniority.size > 0) {
        const levels = detectSeniority(job);
        if (levels.length === 0) return { ok: false, reason: 'seniority: not stated' };
        if (!levels.some((level) => wantedSeniority.has(level))) {
          return { ok: false, reason: `seniority: ${levels.join('/')}` };
        }
      }

      const model = inferWorkModel(job);
      if (!model) return { ok: false, reason: 'work model: not stated' };
      if (!allowedModels.has(model)) return { ok: false, reason: `work model: ${model}` };

      if (job.postedAt) {
        const posted = Date.parse(job.postedAt);
        if (!Number.isNaN(posted) && now.getTime() - posted > search.max_age_days * DAY_MS) {
          return { ok: false, reason: `age: older than ${search.max_age_days} days` };
        }
      }

      const geo = checkEligibility(job, eligibility.accept_regions, eligibility.reject);
      if (!geo.ok) return { ok: false, reason: geo.reason };

      const language = requiredLanguage(`${job.title}
${job.description}`, eligibility.reject_languages);
      if (language) return { ok: false, reason: `language: requires ${language}` };
      return { ok: true };
    },
  };
}
