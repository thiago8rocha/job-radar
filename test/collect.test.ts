import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnySourceAdapter } from '../src/adapters/types.js';
import { collect, describeLocation } from '../src/commands/collect.js';
import { parseConfig } from '../src/config/load.js';
import type { Job } from '../src/domain/job.js';
import { loadState } from '../src/state/seen.js';
import { fakeContext } from './fake-github.js';
import { job } from './helpers.js';

const NOW = new Date('2026-10-15T12:00:00Z');

const CONFIG = `
search:
  include: ["QA", "SDET"]
  highlight: ["Playwright"]
  exclude: ["Intern"]
  seniority: [senior]
eligibility:
  accept_regions: [worldwide, brazil]
sources:
  alpha: { enabled: true }
  beta: { enabled: true }
  off: { enabled: false }
  gupy: { enabled: true }
issues:
  max_per_run: 25
`;

/** An adapter whose raw postings are the jobs themselves. */
function adapter(id: string, jobs: Job[] | Error, mode: 'search' | 'company' = 'search'): AnySourceAdapter {
  return {
    id,
    mode,
    fetch: async () => {
      if (jobs instanceof Error) throw jobs;
      return jobs;
    },
    normalize: (raw: Job) => raw,
  };
}

let dir: string;
let statePath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-radar-collect-'));
  statePath = join(dir, 'state', 'seen.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function setup(configText = CONFIG, overrides: Parameters<typeof fakeContext>[0] = {}) {
  const fake = fakeContext(overrides);
  fake.ctx.config = parseConfig(configText);
  return fake;
}

const run = (fake: ReturnType<typeof setup>, adapters: Record<string, AnySourceAdapter>, extra = {}) =>
  collect(fake.ctx, { adapters, statePath, now: NOW, delayMs: 0, ...extra });

describe('collect', () => {
  it('writes one issue per new job with labels, body, Project fields and state', async () => {
    const fake = setup();
    const result = await run(fake, {
      alpha: adapter('alpha', [
        job({
          id: 'alpha:acme:11111111',
          source: 'alpha',
          company: 'Acme',
          title: 'Senior QA Engineer',
          contracts: ['PJ'],
          compensation: 'USD 100,000 / year',
          currency: 'USD',
          salaryAmount: 100000,
          description: 'Playwright and APIs',
        }),
      ]),
    });

    expect(result.created).toBe(1);
    const call = fake.issues.create.mock.calls[0]![0] as any;
    expect(call.title).toBe('[Acme] Senior QA Engineer');
    expect(call.labels).toEqual(
      expect.arrayContaining(['status:new', 'found:alpha', 'ats:alpha', 'contract:pj', 'scope:brazil', 'work:remote']),
    );
    expect(call.body.split('\n')[0]).toBe('**Apply:** https://boards.greenhouse.io/acme/jobs/1');
    expect(call.body).toContain('**Posted on:** 2026-10-10');
    expect(call.body).toContain('**Stated compensation:** USD 100,000 / year');
    expect(call.body).toContain('> Matched: Playwright');
    expect(call.body).toContain('<!-- job-radar:id=alpha:acme:11111111 -->');

    // dynamic labels are created once, static ones are left to `setup`
    expect(fake.issues.createLabel.mock.calls.map((c) => (c[0] as any).name).sort()).toEqual(['ats:alpha', 'contract:pj', 'found:alpha']);
    const values = fake.fieldWrites().map(([field, value]) => `${field}=${JSON.stringify(value)}`);
    expect(values).toEqual(
      expect.arrayContaining([
        'F_status={"singleSelectOptionId":"O_New"}',
        'F_contact={"singleSelectOptionId":"O_Application"}',
        'F_currency={"singleSelectOptionId":"O_USD"}',
        'F_offered={"number":100000}',
      ]),
    );

    const state = await loadState(statePath);
    expect(state.jobs['alpha:acme:11111111']).toMatchObject({ issue: 101 });
  });

  it('collapses repeated spaces in titles and company names', async () => {
    const fake = setup();
    await run(fake, { alpha: adapter('alpha', [job({ id: 'alpha:a:1', source: 'alpha', company: 'Acme  Corp ', title: 'Senior QA -  Automation' })]) });
    expect((fake.issues.create.mock.calls[0]![0] as any).title).toBe('[Acme Corp] Senior QA - Automation');
  });

  it('does not recreate jobs that are in the state file or already have an issue', async () => {
    const fake = setup(CONFIG, {
      existingIssues: [
        { title: '[Luby] Senior QA', body: '**Apply:** https://luby.test/1\n' },
        { title: '[Other] x', body: '<!-- job-radar:id=alpha:other:22222222 -->' },
      ],
    });
    const jobs = [
      job({ id: 'alpha:luby:1', source: 'alpha', company: 'Luby', title: 'Senior QA', applyUrl: 'https://luby.test/other' }),
      job({ id: 'alpha:other:22222222', source: 'alpha', company: 'Other2', applyUrl: 'https://o.test/2' }),
      job({ id: 'alpha:fresh:3', source: 'alpha', company: 'Fresh', applyUrl: 'https://f.test/3' }),
    ];

    await run(fake, { alpha: adapter('alpha', jobs) });
    expect(fake.issues.create).toHaveBeenCalledTimes(1);

    // a second run without those issues: only the job written before is still known, through seen.json
    const again = setup();
    await run(again, { alpha: adapter('alpha', jobs) });
    expect(again.issues.create.mock.calls.map((c) => (c[0] as any).title)).toEqual(['[Luby] Senior QA', '[Other2] Senior QA Engineer']);
  });

  it('applies the filters and counts the discards per stage', async () => {
    const fake = setup();
    const result = await run(fake, {
      alpha: adapter('alpha', [
        job({ id: 'alpha:a:1', source: 'alpha', company: 'A', title: 'Backend Engineer' }),
        job({ id: 'alpha:b:2', source: 'alpha', company: 'B', title: 'QA Intern' }),
        job({ id: 'alpha:c:3', source: 'alpha', company: 'C', title: 'QA Engineer' }),
        job({ id: 'alpha:d:4', source: 'alpha', company: 'D', locations: ['Remote - US only'] }),
        job({ id: 'alpha:e:5', source: 'alpha', company: 'E' }),
      ]),
    });
    expect(result.sources[0]).toMatchObject({
      fetched: 5,
      created: 1,
      discarded: { title: 1, 'excluded term': 1, seniority: 1, eligibility: 1 },
    });
  });

  it('caps new issues per run, newest first, and leaves the rest for the next run', async () => {
    const fake = setup(CONFIG.replace('max_per_run: 25', 'max_per_run: 2'));
    const jobs = [10, 12, 11].map((day) =>
      job({ id: `alpha:c${day}:1`, source: 'alpha', company: `C${day}`, postedAt: `2026-10-${day}T00:00:00Z`, applyUrl: `https://x.test/${day}` }),
    );
    const result = await run(fake, { alpha: adapter('alpha', jobs) });

    expect(result).toMatchObject({ created: 2, deferred: 1 });
    expect(fake.issues.create.mock.calls.map((c) => (c[0] as any).title)).toEqual(['[C12] Senior QA Engineer', '[C11] Senior QA Engineer']);
    expect(Object.keys((await loadState(statePath)).jobs)).toEqual(['alpha:c11:1', 'alpha:c12:1']);
  });

  it('isolates a failing source and fails only when every source fails', async () => {
    const fake = setup();
    const result = await run(fake, {
      alpha: adapter('alpha', new Error('HTTP 500')),
      beta: adapter('beta', [job({ id: 'beta:x:1', source: 'beta', company: 'X' })]),
    });
    expect(result.created).toBe(1);
    expect(result.sources.find((s) => s.source === 'alpha')?.error).toBe('HTTP 500');
    expect(fake.log.warn).toHaveBeenCalledWith(expect.stringContaining('alpha: failed'));

    await expect(
      run(setup(), { alpha: adapter('alpha', new Error('a')), beta: adapter('beta', new Error('b')) }),
    ).rejects.toThrow('Every enabled source failed');
  });

  it('skips disabled sources, sources without an adapter and company sources without companies', async () => {
    const fake = setup(CONFIG.replace('off: { enabled: false }', 'off: { enabled: true }'));
    const result = await run(fake, {
      alpha: adapter('alpha', [], 'company'),
      off: adapter('off', [job({ id: 'off:x:1', source: 'off' })]),
    });
    expect(result.sources.map((s) => s.source)).toEqual(['off']); // alpha needs companies; beta/gupy have no adapter
    expect(fake.log.info).toHaveBeenCalledWith('gupy: no adapter in this version yet; skipped');
    expect(fake.log.info).toHaveBeenCalledWith('alpha: no companies listed in companies.yml; skipped');
  });

  it('writes nothing in a dry run', async () => {
    const fake = setup();
    const result = await run(fake, { alpha: adapter('alpha', [job({ id: 'alpha:a:1', source: 'alpha' })]) }, { dryRun: true });
    expect(result.created).toBe(1);
    expect(fake.issues.create).not.toHaveBeenCalled();
    expect(fake.issues.createLabel).not.toHaveBeenCalled();
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });

  it('warns when a source returns nothing three runs in a row, and resets on results', async () => {
    const empty = { alpha: adapter('alpha', []) };
    for (let i = 0; i < 2; i++) await run(setup(), empty);
    const third = setup();
    await run(third, empty);
    expect(third.log.warn).toHaveBeenCalledWith(expect.stringContaining('alpha: returned zero jobs for 3 runs in a row'));

    await run(setup(), { alpha: adapter('alpha', [job({ id: 'alpha:z:1', source: 'alpha', company: 'Z' })]) });
    expect((await loadState(statePath)).sources.alpha?.zeroRuns).toBe(0);
  });

  it('keeps the issue and its seen entry when the Project update fails', async () => {
    const fake = setup();
    fake.graphql.mockImplementation(async (query: string) => {
      if (query.includes('repositoryOwner')) {
        return { repositoryOwner: { projectV2: { id: 'P', title: 't', fields: { nodes: [] } } } };
      }
      throw new Error('project is down');
    });
    const result = await run(fake, { alpha: adapter('alpha', [job({ id: 'alpha:a:1', source: 'alpha' })]) });

    expect(result.created).toBe(1);
    expect(fake.log.warn).toHaveBeenCalledWith(expect.stringContaining('could not fill the Project fields'));
    expect((await loadState(statePath)).jobs['alpha:a:1']).toBeDefined();
  });

  it('labels international jobs and skips the work label for on-site ones', async () => {
    const fake = setup(CONFIG.replace('accept_regions: [worldwide, brazil]', 'accept_regions: [worldwide, brazil]\nwork_model: [remote]'));
    await run(fake, {
      alpha: adapter('alpha', [job({ id: 'alpha:w:1', source: 'alpha', company: 'W', locations: ['Worldwide'], atsApply: false })]),
    });
    const labels = (fake.issues.create.mock.calls[0]![0] as any).labels as string[];
    expect(labels).toContain('scope:international');
    expect(labels).not.toContain('ats:alpha');
  });
});

describe('describeLocation', () => {
  it('joins work model, places and the converted hours', () => {
    const base = job({ locations: ['Brazil'], description: 'Overlap needed: 9am-5pm ET' });
    expect(describeLocation(base, NOW)).toBe('Remote · Brazil · 9am-5pm ET → 10am–6pm Brasília time');
    expect(describeLocation(job({ locations: ['Remote - Brazil'], description: '' }), NOW)).toBe('Remote - Brazil');
    expect(describeLocation(job({ locations: [], workModel: 'hybrid', description: '' }), NOW)).toBe('Hybrid');
  });
});
