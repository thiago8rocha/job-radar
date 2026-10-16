import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import type { Job } from '../src/domain/job.js';
import { dedupe, jobKey, knownFromIssues, emptyKnown } from '../src/pipeline/dedup.js';
import { checkEligibility, regionsOf } from '../src/pipeline/eligibility.js';
import { buildExcerpt, sanitizeForIssue } from '../src/pipeline/excerpt.js';
import { createFilter, detectSeniority, inferWorkModel } from '../src/pipeline/filter.js';
import { emptyState, loadState, saveState } from '../src/state/seen.js';
import { job } from './helpers.js';
import { containsTerm, decodeEntities, htmlToText, truncate } from '../src/util/text.js';

const NOW = new Date('2026-10-15T12:00:00Z');

const config = parseConfig(`
search:
  include: ["QA", "Quality Assurance", "SDET", "Analista de Qualidade"]
  ambiguous: ["Analista de Qualidade"]
  ambiguous_requires: ["software", "testes", "QA"]
  exclude: ["Intern", "Júnior", "Pleno"]
  seniority: [senior, specialist, staff, lead]
  max_age_days: 15
eligibility:
  accept_regions: [worldwide, latam, americas, brazil]
  reject: ["US only", "EU only", "must reside in"]
work_model: [remote]
`);
const filter = createFilter(config);

describe('text helpers', () => {
  it('matches whole words only, ignoring case and accents', () => {
    expect(containsTerm('Senior QA Engineer', 'qa')).toBe(true);
    expect(containsTerm('Aquatic Engineer', 'QA')).toBe(false);
    expect(containsTerm('Analista de Automação', 'automacao')).toBe(true);
    expect(containsTerm('Test Automation Lead', 'Test Automation')).toBe(true);
  });

  it('strips HTML, keeping list items and paragraphs readable', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>world</b></p><ul><li>One</li><li>Two</li></ul>')).toBe('Hello world\n\n• One\n• Two');
    expect(htmlToText('&lt;div&gt;Escaped &amp;amp; encoded&lt;/div&gt;', { escaped: true })).toBe('Escaped & encoded');
    expect(decodeEntities('R&#36; 10 &#x41;')).toBe('R$ 10 A');
  });

  it('cuts long text at a boundary', () => {
    expect(truncate('short', 50)).toBe('short');
    const cut = truncate('First sentence here. Second sentence goes on and on and on.', 30);
    expect(cut).toBe('First sentence here.…');
  });
});

describe('eligibility', () => {
  it('reads regions from location text', () => {
    expect(regionsOf('Remote - Brazil')).toEqual(expect.arrayContaining(['brazil', 'latam', 'americas']));
    expect(regionsOf('Remote')).toEqual(['worldwide']);
    expect(regionsOf('Anywhere')).toEqual(['worldwide']);
    expect(regionsOf('Remote, US')).toEqual(['other']);
    expect(regionsOf('LATAM')).toEqual(expect.arrayContaining(['latam', 'americas']));
    expect(regionsOf('BR')).toContain('brazil');
    expect(regionsOf('US')).toEqual(['other']);
    expect(regionsOf('London, United Kingdom')).toEqual(['other']);
  });

  const check = (locations: string[], description = '', restrictions?: string[]) =>
    checkEligibility({ locations, description, restrictions }, ['worldwide', 'latam', 'americas', 'brazil'], ['US only', 'EU only', 'must reside in']);

  it('accepts any location in an accepted region', () => {
    expect(check(['Remote - Brazil']).ok).toBe(true);
    expect(check(['Remote (US)', 'Remote (Brazil)']).ok).toBe(true);
    expect(check([]).ok).toBe(true); // no location on a remote job means worldwide
    expect(check(['Worldwide'], '', []).ok).toBe(true);
  });

  it('rejects regions that are not accepted', () => {
    expect(check(['Remote - United States']).ok).toBe(false);
    expect(check(['Berlin']).ok).toBe(false);
    expect(check(['Worldwide'], '', ['United States']).ok).toBe(false);
  });

  it('rejects "US only" style phrases anywhere, but not "must reside in Brazil"', () => {
    expect(check(['Remote'], 'Candidates must be US only.').reason).toContain('US only');
    expect(check(['Remote'], 'You must reside in the United States.').ok).toBe(false);
    expect(check(['Remote'], 'You must reside in Brazil.').ok).toBe(true);
  });
});

describe('filter', () => {
  const check = (overrides: Partial<Job>) => filter.check(job(overrides), NOW);

  it('passes a matching job', () => {
    expect(check({}).ok).toBe(true);
  });

  it('requires a search term in the title and drops excluded terms', () => {
    expect(check({ title: 'Senior Backend Engineer' }).reason).toContain('title');
    expect(check({ title: 'QA Intern' }).reason).toContain('excluded term: "Intern"');
    expect(check({ title: 'QA Engineer Júnior' }).reason).toContain('excluded term');
    expect(check({ title: 'QA Pleno Sênior' }).reason).toContain('excluded term'); // exclude wins
  });

  it('needs a confirming word for ambiguous titles', () => {
    const ambiguous = { title: 'Analista de Qualidade Sênior' };
    expect(check({ ...ambiguous, description: 'Vaga para analista da area comercial' }).ok).toBe(false);
    expect(check({ ...ambiguous, description: 'Qualidade de software e testes' }).ok).toBe(true);
    expect(check({ ...ambiguous, title: 'Analista de Qualidade QA Sênior', description: '' }).ok).toBe(true);
  });

  it('keeps only the configured seniority, from the title or the source', () => {
    expect(check({ title: 'QA Engineer' }).reason).toContain('seniority: not stated');
    expect(check({ title: 'QA Engineer', seniority: ['senior'] }).ok).toBe(true);
    expect(check({ title: 'QA Engineer', seniority: ['manager'] }).reason).toContain('seniority: manager');
    expect(check({ title: 'Sr. QA Engineer' }).ok).toBe(true);
    expect(check({ title: 'QA Especialista' }).ok).toBe(true);
    expect(check({ title: 'Staff QA Engineer' }).ok).toBe(true);
    expect(check({ title: 'QA Lead' }).ok).toBe(true);
    expect(detectSeniority({ title: 'Líder de QA Sênior', seniority: [] })).toEqual(expect.arrayContaining(['senior', 'lead']));
  });

  it('keeps only the configured work model', () => {
    expect(check({ workModel: 'hybrid' }).reason).toBe('work model: hybrid');
    expect(check({ workModel: undefined, locations: ['Brazil'], description: 'Fully onsite' }).reason).toBe('work model: onsite');
    expect(check({ workModel: undefined, locations: ['Brazil'], description: 'Based in our office' }).reason).toBe('work model: not stated');
    expect(check({ workModel: 'remote', title: 'Senior QA Engineer (Hybrid)' }).reason).toBe('work model: hybrid');
    expect(inferWorkModel(job({ workModel: undefined, description: 'This role is remote.' }))).toBe('remote');
  });

  it('drops postings older than the limit', () => {
    expect(check({ postedAt: '2026-09-01T00:00:00Z' }).reason).toContain('age');
    expect(check({ postedAt: undefined }).ok).toBe(true);
  });

  it('applies geographic eligibility last', () => {
    expect(check({ locations: ['Remote - United States'] }).reason).toContain('eligibility');
  });

  it('tells adapters which jobs are worth a detail request', () => {
    expect(filter.worthDetails({ title: 'Senior QA Engineer', workModel: 'remote' })).toBe(true);
    expect(filter.worthDetails({ title: 'Senior QA Engineer', workModel: 'hybrid' })).toBe(false);
    expect(filter.worthDetails({ title: 'Backend Engineer' })).toBe(false);
    expect(filter.worthDetails({ title: 'QA Intern' })).toBe(false);
    expect(filter.worthDetails({ title: 'QA Engineer' })).toBe(true); // seniority is checked later
  });
});

describe('dedup', () => {
  it('reads known jobs from existing issues: marker, apply link and title', () => {
    const known = knownFromIssues([
      { title: '[Luby] Senior QA', body: '**Apply:** https://luby.inhire.app/vagas/1?utm_source=x\n\n<!-- job-radar:id=inhire:luby:abcd1234 -->' },
      { title: 'No brackets', body: null },
    ]);
    expect([...known.ids]).toEqual(['inhire:luby:abcd1234']);
    expect([...known.urls]).toEqual(['https://luby.inhire.app/vagas/1']);
    expect([...known.keys]).toEqual([jobKey('Luby', 'Senior QA')]);
  });

  it('drops jobs already known by id, url or company and title', () => {
    const known = knownFromIssues([
      { title: '[Acme] Senior QA Engineer', body: '**Apply:** https://x.test/a\n' },
      { title: '[Other] Role', body: '**Apply:** https://x.test/known\n<!-- job-radar:id=greenhouse:other:11111111 -->' },
    ]);
    const { fresh, duplicates } = dedupe(
      [
        job({ id: 'a:1', company: 'ACME', title: 'senior qa engineer!', applyUrl: 'https://x.test/new1' }),
        job({ id: 'a:2', company: 'New Co', applyUrl: 'https://x.test/known?utm_campaign=z' }),
        job({ id: 'greenhouse:other:11111111', company: 'Third', applyUrl: 'https://x.test/t' }),
        job({ id: 'a:4', company: 'Fresh Inc', applyUrl: 'https://x.test/fresh' }),
      ],
      known,
    );
    expect(fresh.map((item) => item.id)).toEqual(['a:4']);
    expect(duplicates.map((item) => item.reason)).toEqual(['company and title', 'url', 'id']);
  });

  it('treats company names that differ only by a suffix as the same company', () => {
    expect(jobKey('Stefanini Group', 'QA Lead')).toBe(jobKey('Stefanini', 'QA Lead'));
    expect(jobKey('Acme Ltda.', 'QA')).toBe(jobKey('ACME', 'qa'));
    expect(jobKey('Group', 'QA')).toBe('group|qa'); // a name made only of suffixes is kept
    expect(jobKey('Acme', 'QA')).not.toBe(jobKey('Beta', 'QA'));
  });

  it('keeps one copy of a job found on several sources, preferring the company ATS', () => {
    const aggregator = job({ id: 'himalayas:acme:1', source: 'himalayas', atsApply: false, applyUrl: 'https://himalayas.app/acme/qa' });
    const ats = job({ id: 'greenhouse:acme:2', applyUrl: 'https://boards.greenhouse.io/acme/jobs/2' });
    const { fresh, duplicates } = dedupe([aggregator, ats], emptyKnown());
    expect(fresh.map((item) => item.source)).toEqual(['greenhouse']);
    expect(duplicates[0]?.job.source).toBe('himalayas');
  });
});

describe('excerpt', () => {
  it('lists matched highlight terms and the start of the description', () => {
    const excerpt = buildExcerpt('We use Playwright and CI/CD pipelines. Great team.', ['Playwright', 'Cypress', 'CI/CD'])!;
    expect(excerpt).toBe('Matched: Playwright, CI/CD\nWe use Playwright and CI/CD pipelines. Great team.');
    expect(buildExcerpt('', [])).toBeUndefined();
  });

  it('neutralizes mentions, issue references, HTML and forged markers', () => {
    const text = sanitizeForIssue('ping @someone see #123 <script>x</script> <!-- job-radar:id=forged:x:00000000 -->');
    expect(text).not.toMatch(/@someone|#123|<script>|job-radar:id/);
    expect(text).toContain('&lt;script&gt;');
  });
});

describe('state', () => {
  it('round-trips with sorted keys and drops entries older than a year', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-radar-'));
    try {
      const path = join(dir, 'state', 'seen.json');
      expect(await loadState(path)).toEqual(emptyState());

      const state = emptyState();
      state.jobs['b:1'] = { issue: 2, seenAt: '2026-10-01T00:00:00.000Z' };
      state.jobs['a:1'] = { issue: 1, seenAt: '2026-10-02T00:00:00.000Z' };
      state.jobs['old:1'] = { issue: 3, seenAt: '2025-01-01T00:00:00.000Z' };
      state.sources.inhire = { zeroRuns: 1 };
      await saveState(path, state, NOW);

      const saved = JSON.parse(await readFile(path, 'utf8'));
      expect(Object.keys(saved.jobs)).toEqual(['a:1', 'b:1']);
      expect((await loadState(path)).sources.inhire?.zeroRuns).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt state file instead of recreating every issue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-radar-'));
    try {
      const path = join(dir, 'seen.json');
      await import('node:fs/promises').then((fs) => fs.writeFile(path, JSON.stringify({ version: 2 })));
      await expect(loadState(path)).rejects.toThrow('not a valid job-radar state file');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
