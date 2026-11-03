import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { HttpError } from '../util/http.js';
import { htmlToText } from '../util/text.js';
import { jobId } from './common.js';
import type { FetchContext, SourceAdapter } from './types.js';
import { parseItems } from './validate.js';

const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const VIEW = 'https://www.linkedin.com/jobs/view/';

const DEFAULT_LOCATIONS = ['Brazil', 'Worldwide'];
const DEFAULT_MAX_SEARCHES = 12;
const DEFAULT_DELAY_MS = 3000;
const DEFAULT_WINDOW_DAYS = 2;
const MAX_TERMS = 6;
const MAX_DETAILS = 40;
const BUDGET_MS = 4 * 60 * 1000; // the collect gives a source 5 minutes
const DAY_SECONDS = 24 * 60 * 60;

const cardSchema = z.object({
  id: z.string().regex(/^\d+$/),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(),
  date: z.string().nullish(),
});

export interface LinkedInPosting extends z.infer<typeof cardSchema> {
  /** "Seniority level" from the detail page, e.g. `Mid-Senior level` or `Not Applicable`. */
  level?: string;
  description: string;
}

function between(source: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(source);
  return match?.[1] === undefined ? undefined : htmlToText(match[1]);
}

/** The search answers with HTML fragments, one `<li>` per card. */
export function parseCards(html: string): unknown[] {
  return html
    .split(/(?=<li>)/)
    .map((card) => ({
      id: /urn:li:jobPosting:(\d+)/.exec(card)?.[1],
      title: between(card, /base-search-card__title[^>]*>([^<]*)</),
      company: between(card, /base-search-card__subtitle[^>]*>\s*(?:<a[^>]*>)?\s*([^<]*)</),
      location: between(card, /job-search-card__location[^>]*>([^<]*)</),
      date: /datetime="([^"]+)"/.exec(card)?.[1],
    }))
    .filter((card) => card.id !== undefined);
}

export function parseDetail(html: string): { level?: string; description: string } {
  const criteria = [...html.matchAll(/description__job-criteria-subheader[^>]*>\s*([^<]*?)\s*<[\s\S]*?description__job-criteria-text[^>]*>\s*([^<]*?)\s*</g)];
  const level = criteria.find(([, name]) => name === 'Seniority level')?.[2];
  return { level, description: between(html, /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/) ?? '' };
}

/** `QA`, `Quality Assurance`...: the first include terms, de-duplicated ignoring case. */
function searchTerms(include: string[]): string[] {
  const seen = new Set<string>();
  return include
    .filter((term) => {
      const key = term.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_TERMS);
}

/** A sentence that talks about remote work or hiring and names a region we accept (boilerplate like "customers worldwide" has no such verb). */
export function opensToRegion(description: string): boolean {
  return description
    .split(/[.\n]/)
    .some(
      (sentence) =>
        /remote|anywhere|work from home|open to|hiring|based in|located/i.test(sentence) &&
        /worldwide|latam|latin america|south america|brazil|brasil/i.test(sentence),
    );
}

function seniorityOf(level: string | undefined): string[] {
  if (level === 'Entry level' || level === 'Internship') return ['junior'];
  if (level === 'Director' || level === 'Executive') return ['lead'];
  // The search already asks for Mid-Senior, and most postings say "Not Applicable", so unknown counts as senior rather than dropping the job.
  return ['senior'];
}

/**
 * LinkedIn's public guest endpoints (no login, no key): a search of HTML cards per term and place,
 * then one detail page for each card that passes the cheap filters. Modeled on JobSpy (MIT,
 * github.com/speedyapply/JobSpy), which documents the endpoints. LinkedIn's terms forbid scraping and
 * datacenter IPs get 429s, so requests are spaced out, the window is a few days (each run only sees
 * the new ones) and a 429 ends the source with what was already read.
 */
export const linkedin: SourceAdapter<LinkedInPosting> = {
  id: 'linkedin',
  mode: 'search',

  async fetch(ctx: FetchContext) {
    const toggle = ctx.config.sources.linkedin;
    const delayMs = toggle?.delay_ms ?? DEFAULT_DELAY_MS;
    const windowSeconds = (toggle?.window_days ?? DEFAULT_WINDOW_DAYS) * DAY_SECONDS;
    const terms = (toggle?.queries ?? searchTerms(ctx.config.search.include)).slice(0, MAX_TERMS);
    const locations = toggle?.locations ?? DEFAULT_LOCATIONS;
    const searches = terms.flatMap((term) => locations.map((location) => ({ term, location }))).slice(0, toggle?.max_searches ?? DEFAULT_MAX_SEARCHES);

    const started = Date.now();
    const pause = () => sleep(delayMs <= 0 ? 0 : delayMs + Math.random() * (delayMs / 2));
    const cards = new Map<string, z.infer<typeof cardSchema>>();
    const found: LinkedInPosting[] = [];

    try {
      for (const { term, location } of searches) {
        const params = new URLSearchParams({ keywords: term, location, f_WT: '2', f_TPR: `r${windowSeconds}`, f_E: '4', start: '0' });
        const html = await ctx.http.getText(`${SEARCH}?${params}`);
        const items = parseCards(html);
        if (items.length > 0) {
          for (const card of parseItems('linkedin', cardSchema, items, ctx)) {
            const url = `${VIEW}${card.id}`;
            if (cards.has(card.id) || ctx.isKnownUrl?.(url)) continue;
            if (ctx.worthDetails({ title: card.title, company: card.company, workModel: 'remote' })) cards.set(card.id, card);
          }
        }
        await pause();
      }

      for (const card of [...cards.values()].slice(0, MAX_DETAILS)) {
        if (Date.now() - started > BUDGET_MS) {
          ctx.warn('linkedin: out of time, the rest waits for the next run');
          break;
        }
        try {
          found.push({ ...card, ...parseDetail(await ctx.http.getText(`${DETAIL}${card.id}`)) });
        } catch (error) {
          if (error instanceof HttpError && error.status === 429) throw error;
          ctx.warn(`linkedin: could not read job ${card.id} (${(error as Error).message})`);
        }
        await pause();
      }
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 429)) throw error;
      ctx.warn(`linkedin: rate limited (HTTP 429), keeping the ${found.length} job(s) read so far`);
    }
    return found;
  },

  normalize(posting): Job {
    return {
      id: jobId('linkedin', posting.company, posting.id),
      source: 'linkedin',
      atsApply: false,
      company: posting.company.trim(),
      title: posting.title.trim(),
      locations: [...(posting.location ? [posting.location] : []), ...(opensToRegion(posting.description) ? ['Worldwide'] : [])],
      workModel: 'remote', // the search asks for remote only; a hybrid or on-site description still overrides it in the filter
      seniority: seniorityOf(posting.level),
      contracts: [],
      postedAt: posting.date && !Number.isNaN(Date.parse(posting.date)) ? new Date(posting.date).toISOString() : undefined,
      applyUrl: `${VIEW}${posting.id}`,
      description: posting.description,
    };
  },
};
