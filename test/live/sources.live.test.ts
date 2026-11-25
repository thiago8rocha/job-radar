import { describe, expect, it } from 'vitest';
import { ashby } from '../../src/adapters/ashby.js';
import { careers } from '../../src/adapters/careers.js';
import { quickin } from '../../src/adapters/quickin.js';
import { recruitee } from '../../src/adapters/recruitee.js';
import { smartrecruiters } from '../../src/adapters/smartrecruiters.js';
import { solides } from '../../src/adapters/solides.js';
import { teamtailor } from '../../src/adapters/teamtailor.js';
import { workday } from '../../src/adapters/workday.js';
import { workable } from '../../src/adapters/workable.js';
import { freehire } from '../../src/adapters/freehire.js';
import { greenhouse } from '../../src/adapters/greenhouse.js';
import { gupy } from '../../src/adapters/gupy.js';
import { himalayas } from '../../src/adapters/himalayas.js';
import { inhire } from '../../src/adapters/inhire.js';
import { githubRepos } from '../../src/adapters/github-repos.js';
import { hnHiring } from '../../src/adapters/hn-hiring.js';
import { jobicy } from '../../src/adapters/jobicy.js';
import { lever } from '../../src/adapters/lever.js';
import { parseCards, parseDetail } from '../../src/adapters/linkedin.js';
import { remoteok } from '../../src/adapters/remoteok.js';
import type { FetchContext, SourceAdapter } from '../../src/adapters/types.js';
import { weworkremotely } from '../../src/adapters/weworkremotely.js';
import type { CompanyRef } from '../../src/config/schema.js';
import { Octokit } from 'octokit';
import { parseConfig } from '../../src/config/load.js';
import { createHttpClient, HttpError } from '../../src/util/http.js';

/**
 * One real request per source, checking only that the response still matches the adapter's schema
 * and normalizes into usable jobs. Filters and dates are out of scope: a source with no QA jobs today
 * is fine, a source whose format changed is not. Run by hand from the live-contract workflow; a failure opens an issue.
 */
const config = parseConfig('search: { include: ["QA"], max_age_days: 30 }');
const http = createHttpClient({ hostDelayMs: 500 });

function context(slugs: Array<string | CompanyRef>): FetchContext {
  return {
    http,
    config,
    companies: slugs.map((entry) => (typeof entry === 'string' ? { slug: entry } : entry)),
    now: new Date(),
    worthDetails: () => false, // skip the per-job detail requests; the list endpoint is the contract
    warn: (message) => console.warn(message),
  };
}

async function check<Raw>(adapter: SourceAdapter<Raw>, slugs: Array<string | CompanyRef>, withConfig = config): Promise<void> {
  const raws = await adapter.fetch({ ...context(slugs), config: withConfig });
  expect(raws.length, `${adapter.id} returned no postings`).toBeGreaterThan(0);
  for (const raw of raws.slice(0, 25)) {
    const job = adapter.normalize(raw);
    expect(job.id).toMatch(new RegExp(`^${adapter.id}:`));
    expect(job.title.length).toBeGreaterThan(0);
    expect(() => new URL(job.applyUrl)).not.toThrow();
  }
}

describe('live sources', () => {
  // Public boards that have been stable for years; swap one if a company ever closes its board.
  it('inhire', () => check(inhire, ['luby']));
  it('greenhouse', () => check(greenhouse, ['airbnb']));
  it('lever', () => check(lever, ['palantir']));
  it('ashby', () => check(ashby, ['ramp']));
  // The page links to its Recruitee board, so the jobs come back under that source's ids.
  it('careers', async () => {
    const raws = await careers.fetch(context([{ slug: 'https://careers.bunq.com/', url: 'https://careers.bunq.com/' }]));
    expect(raws.length, 'careers returned no postings').toBeGreaterThan(0);
    const job = careers.normalize(raws[0]!);
    expect(job.title.length).toBeGreaterThan(0);
    expect(() => new URL(job.applyUrl)).not.toThrow();
  });
  // Workday answers 429 to shared CI IPs, so a rate limit skips the check instead of failing it.
  it('workday', async () => {
    try {
      await check(workday, [{ slug: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' }]);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 429)) throw error;
      console.warn('workday: rate limited, check skipped');
    }
  });
  it('solides', () => check(solides, ['solides']));
  it('quickin', () => check(quickin, ['quickin']));
  it('teamtailor', () => check(teamtailor, ['career']));
  it('recruitee', () => check(recruitee, ['bunq']));
  it('smartrecruiters', () => check(smartrecruiters, ['BoschGroup']));
  it('workable', () => check(workable, ['huggingface']));
  it('himalayas', () => check(himalayas, []));
  it('freehire', () => check(freehire, []));
  it('gupy', () => check(gupy, []));
  // Unauthenticated: 60 requests an hour is enough for one check.
  it('github_repos', async () => {
    const ctx = { ...context([]), github: new Octokit(), config: parseConfig('search: { include: ["QA"], max_age_days: 365 }\nsources:\n  github_repos: { enabled: true, repos: ["backend-br/vagas"] }') };
    const raws = await githubRepos.fetch(ctx);
    expect(raws.length, 'github_repos returned no issues').toBeGreaterThan(0);
    expect(githubRepos.normalize(raws[0]!).title.length).toBeGreaterThan(0);
  });
  it('hn_hiring', () => check(hnHiring, []));
  // Broad terms and the busiest region: a narrow query can honestly return nothing on a given day.
  it('jobicy', async () => {
    const wide = parseConfig('search: { include: ["engineer"], max_age_days: 30 }\neligibility: { accept_regions: ["latam"] }');
    await check(jobicy, [], wide);
  });
  it('remoteok', () => check(remoteok, []));
  it('weworkremotely', () => check(weworkremotely, []));
  // LinkedIn answers 429 to shared IPs, so a rate limit skips the check instead of failing it; a changed page still fails.
  it('linkedin', async () => {
    try {
      const search = await http.getText('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=QA&location=Brazil&f_WT=2&start=0');
      const cards = parseCards(search) as Array<{ id: string; title?: string; company?: string }>;
      expect(cards.length, 'linkedin returned no cards').toBeGreaterThan(0);
      expect(cards[0]!.title, 'linkedin card has no title').toBeTruthy();
      expect(cards[0]!.company, 'linkedin card has no company').toBeTruthy();

      const detail = parseDetail(await http.getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${cards[0]!.id}`));
      expect(detail.description.length, 'linkedin detail has no description').toBeGreaterThan(0);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 429)) throw error;
      console.warn('linkedin: rate limited, check skipped');
    }
  });
  // google_jobs and discovery need a SerpAPI key, which CI does not have; they are covered by recorded-shape tests.
});
