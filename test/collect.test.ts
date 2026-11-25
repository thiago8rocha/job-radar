import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  collect(fake.ctx, { adapters, statePath, companiesStatePath: join(dir, 'state', 'companies.json'), now: NOW, delayMs: 0, ...extra });

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

describe('backlog', () => {
  const SMALL = CONFIG.replace('max_per_run: 25', 'max_per_run: 2');
  const posting = (n: number, extra: Partial<Job> = {}) =>
    job({ id: `alpha:c${n}:1`, source: 'alpha', company: `C${n}`, applyUrl: `https://x.test/${n}`, postedAt: `2026-10-1${n}T00:00:00Z`, ...extra });
  const created = (fake: ReturnType<typeof setup>) => fake.issues.create.mock.calls.map((call) => (call[0] as any).title as string);

  it('keeps what did not fit and writes it first on the next run, without fetching it again', async () => {
    const first = setup(SMALL);
    await run(first, { alpha: adapter('alpha', [posting(1), posting(2), posting(3)]) });
    expect(created(first)).toEqual(['[C3] Senior QA Engineer', '[C2] Senior QA Engineer']);
    expect((await loadState(statePath)).backlog.map((entry) => entry.job.id)).toEqual(['alpha:c1:1']);

    const second = setup(SMALL, { existingIssues: first.issues.create.mock.calls.map((call) => ({ title: (call[0] as any).title, body: (call[0] as any).body })) });
    const result = await run(second, { alpha: adapter('alpha', [posting(4)]) });
    expect(created(second)).toEqual(['[C1] Senior QA Engineer', '[C4] Senior QA Engineer']);
    expect(result.deferred).toBe(0);
    expect((await loadState(statePath)).backlog).toEqual([]);
  });

  it('drops a queued job that got an issue in the meantime', async () => {
    const first = setup(SMALL);
    await run(first, { alpha: adapter('alpha', [posting(1), posting(2), posting(3)]) });

    const later = setup(SMALL, { existingIssues: [{ title: '[Other] Something', body: '**Apply:** https://x.test/1\n' }] });
    await run(later, { alpha: adapter('alpha', [posting(5, { postedAt: '2026-10-14T00:00:00Z' })]) });
    expect(created(later)).toEqual(['[C5] Senior QA Engineer']);
    expect((await loadState(statePath)).backlog).toEqual([]);
  });

  it('drops a queued job once it is older than the age limit', async () => {
    const first = setup(SMALL);
    await run(first, { alpha: adapter('alpha', [posting(1), posting(2), posting(3)]) });

    const later = setup(SMALL);
    await run(later, { alpha: adapter('alpha', []) }, { now: new Date('2026-12-30T12:00:00Z') });
    expect(created(later)).toEqual([]);
    expect((await loadState(statePath)).backlog).toEqual([]);
  });

  it('orders a batch by the company ATS link, then direct sources before aggregators, then newest first', async () => {
    const fake = setup(SMALL.replace('max_per_run: 2', 'max_per_run: 4'));
    await run(
      fake,
      {
        alpha: adapter('alpha', [posting(1, { atsApply: false }), posting(2, { atsApply: false, postedAt: '2026-10-14T00:00:00Z' })]),
        beta: adapter('beta', [posting(3, { id: 'beta:c3:1', source: 'beta', atsApply: false, postedAt: '2026-10-11T00:00:00Z' }), posting(4, { id: 'beta:c4:1', source: 'beta', atsApply: true, postedAt: '2026-10-10T00:00:00Z' })], 'company'),
      },
      { companies: { beta: ['acme'] } },
    );
    expect(created(fake)).toEqual(['[C4] Senior QA Engineer', '[C3] Senior QA Engineer', '[C2] Senior QA Engineer', '[C1] Senior QA Engineer']);
  });

  it('loads a state file written before the backlog existed', async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ version: 1, jobs: {}, sources: {} }));
    expect((await loadState(statePath)).backlog).toEqual([]);
  });
});

describe('reposts', () => {
  const issue = (number: number, state: 'open' | 'closed', labels: string[]) => ({
    number,
    state,
    title: '[Acme] Senior QA Engineer',
    body: '**Apply:** https://acme.test/old\n<!-- job-radar:id=alpha:acme:oldoldol -->',
    labels: labels.map((name) => ({ name })),
  });
  const reposted = (id = 'alpha:acme:newnewne') =>
    job({ id, source: 'alpha', company: 'Acme', title: 'Senior QA Engineer', applyUrl: 'https://acme.test/new' });

  async function repost(existing: ReturnType<typeof issue>, jobs = [reposted()]) {
    const fake = setup(CONFIG, { existingIssues: [existing] });
    await run(fake, { alpha: adapter('alpha', jobs) });
    return fake;
  }

  it('comments on an application with no answer and marks it, without opening a second issue', async () => {
    const fake = await repost(issue(7, 'open', ['status:applied']));

    expect(fake.issues.create).not.toHaveBeenCalled();
    expect(fake.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7, labels: ['signal:reposted'] }));
    const comment = (fake.issues.createComment.mock.calls[0]![0] as any).body as string;
    expect(comment).toMatch(/^Reposted on 2026-10-15: https:\/\/acme\.test\/new/);
    expect(comment).toContain('<!-- job-radar:repost=alpha:acme:newnewne -->');
    expect(fake.issues.update).not.toHaveBeenCalled();
    expect(fake.issues.createLabel.mock.calls.map((call) => (call[0] as any).name)).toContain('signal:reposted');
  });

  it('comments on a closed, discarded issue and leaves it closed', async () => {
    const fake = await repost(issue(8, 'closed', ['status:discarded', 'discard:salary']));

    expect(fake.issues.create).not.toHaveBeenCalled();
    expect(fake.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 8, labels: ['signal:reposted'] }));
    expect(fake.issues.createComment).toHaveBeenCalledTimes(1);
    expect(fake.issues.update).not.toHaveBeenCalled();
  });

  it('reopens an issue that was closed because the posting disappeared, back at status:new', async () => {
    const fake = await repost(issue(9, 'closed', ['status:discarded', 'closed-at-source']));

    expect(fake.issues.create).not.toHaveBeenCalled();
    expect(fake.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 9, labels: ['signal:reposted', 'status:new'] }));
    expect(fake.issues.removeLabel.mock.calls.map((call) => (call[0] as any).name)).toEqual(['closed-at-source', 'status:discarded']);
    expect(fake.issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 9, state: 'open' }));
    expect((fake.issues.createComment.mock.calls[0]![0] as any).body).toContain('back at `status:new`');
  });

  it('does nothing for an issue that is still open and not applied to', async () => {
    const fake = await repost(issue(10, 'open', ['status:new']));

    expect(fake.issues.create).not.toHaveBeenCalled();
    expect(fake.issues.createComment).not.toHaveBeenCalled();
    expect(fake.issues.addLabels).not.toHaveBeenCalled();
  });

  it('comments once per issue even when two sources repost it, and not again on the next run', async () => {
    const jobs = [reposted('alpha:acme:newnewne'), { ...reposted('alpha:acme:another1'), applyUrl: 'https://acme.test/another' }];
    const existing = issue(11, 'open', ['no-response']);
    const first = setup(CONFIG, { existingIssues: [existing] });
    await run(first, { alpha: adapter('alpha', jobs) });
    expect(first.issues.createComment).toHaveBeenCalledTimes(1);

    const state = await loadState(statePath);
    expect(Object.keys(state.jobs)).toEqual(expect.arrayContaining(['alpha:acme:newnewne', 'alpha:acme:another1']));

    const second = setup(CONFIG, { existingIssues: [existing] });
    await run(second, { alpha: adapter('alpha', jobs) });
    expect(second.issues.createComment).not.toHaveBeenCalled();
  });

  it('only reports in a dry run', async () => {
    const fake = setup(CONFIG, { existingIssues: [issue(12, 'open', ['status:applied'])] });
    await run(fake, { alpha: adapter('alpha', [reposted()]) }, { dryRun: true });

    expect(fake.issues.createComment).not.toHaveBeenCalled();
    expect(fake.issues.addLabels).not.toHaveBeenCalled();
    expect(fake.log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Reposted: #12'));
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

describe('source contribution', () => {
  const acme = (id: string, source: string, url: string) =>
    job({ id, source, company: 'Acme', title: 'Senior QA Engineer', applyUrl: url });
  const adapters = () => ({
    alpha: adapter('alpha', [acme('alpha:1', 'alpha', 'https://a.test/1')]),
    beta: adapter('beta', [acme('beta:1', 'beta', 'https://b.test/1')]),
  });

  it('records which source a duplicate matched and gives the same counts on a repeated dry run', async () => {
    const first = await run(setup(), adapters(), { dryRun: true });
    const second = await run(setup(), adapters(), { dryRun: true });
    expect(first.sources).toEqual(second.sources);
    expect(first.sources.map((report) => [report.source, report.passedFilters, report.created, report.duplicateOf])).toEqual([
      ['alpha', 1, 1, {}],
      ['beta', 1, 0, { alpha: 1 }],
    ]);
  });

  it('keeps the weekly counters in the state and adds them up across runs', async () => {
    const fake = setup();
    await run(fake, adapters());
    const state = await loadState(statePath);
    expect(state.stats.alpha).toEqual({ '2026-W42': { fetched: 1, passedFilters: 1, unique: 1, duplicateOf: {} } });
    expect(state.stats.beta!['2026-W42']).toMatchObject({ unique: 0, duplicateOf: { alpha: 1 } });

    await run(setup(), adapters());
    expect((await loadState(statePath)).stats.alpha!['2026-W42']).toMatchObject({ fetched: 2, unique: 1, duplicateOf: { known: 1 } });
  });

  it('loads a state file written before the counters existed', async () => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ version: 1, jobs: {}, sources: {} }));
    expect((await loadState(statePath)).stats).toEqual({});
  });
});

describe('near misses', () => {
  const noLevel = (id: string, overrides: Partial<Job> = {}) =>
    job({ id, source: 'alpha', title: 'QA Engineer', applyUrl: `https://a.test/${id}`, ...overrides });

  it('keeps a job that fails one soft rule out of the issues and in the state', async () => {
    const fake = setup();
    const result = await run(fake, {
      alpha: adapter('alpha', [
        noLevel('alpha:1'),
        noLevel('alpha:2', { company: 'Two', postedAt: '2026-01-01T00:00:00Z' }),
        noLevel('alpha:3', { company: 'Three', title: 'QA Intern' }),
      ]),
    });
    expect(result.created).toBe(0);
    const { nearMiss } = await loadState(statePath);
    expect(nearMiss.map((entry) => [entry.id, entry.reason])).toEqual([['alpha:1', 'seniority: not stated']]);
  });

  it('ignores a job that is already an issue and does not repeat one already listed', async () => {
    const known = { title: '[Acme] QA Engineer', body: '**Apply:** https://x.test/1\n' };
    await run(setup(CONFIG, { existingIssues: [known] }), { alpha: adapter('alpha', [noLevel('alpha:1')]) });
    expect((await loadState(statePath)).nearMiss).toEqual([]);

    await run(setup(), { alpha: adapter('alpha', [noLevel('alpha:1')]) });
    await run(setup(), { alpha: adapter('alpha', [noLevel('alpha:1')]) });
    expect((await loadState(statePath)).nearMiss).toHaveLength(1);
  });

  it('does not write near misses on a dry run', async () => {
    await run(setup(), { alpha: adapter('alpha', [noLevel('alpha:1')]) }, { dryRun: true });
    expect((await loadState(statePath)).nearMiss).toEqual([]);
  });
});

describe('run budget', () => {
  it('runs the enabled sources side by side and keeps the report order', async () => {
    const slow = (id: string, ms: number): AnySourceAdapter => ({
      id,
      mode: 'search',
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return [job({ id: `${id}:1`, source: id, company: id, applyUrl: `https://${id}.test/1` })];
      },
      normalize: (raw: Job) => raw,
    });
    const started = Date.now();
    const result = await run(setup(), { alpha: slow('alpha', 150), beta: slow('beta', 150) });
    expect(Date.now() - started).toBeLessThan(290);
    expect(result.sources.map((report) => report.source)).toEqual(['alpha', 'beta']);
  });

  it('passes the earlier of the source timeout and the run budget as the deadline', async () => {
    const deadlines: Record<string, number | undefined> = {};
    const probe = (id: string): AnySourceAdapter => ({
      id,
      mode: 'search',
      fetch: async (ctx) => {
        deadlines[id] = ctx.deadline;
        return [];
      },
      normalize: (raw: Job) => raw,
    });
    const config = CONFIG.replace('alpha: { enabled: true }', 'alpha: { enabled: true, timeout_minutes: 1 }') + 'run:\n  budget_minutes: 3\n';
    const before = Date.now();
    await run(setup(config.replace('beta: { enabled: true }', 'beta: { enabled: true, timeout_minutes: 10 }')), { alpha: probe('alpha'), beta: probe('beta') });
    expect(deadlines.alpha! - before).toBeLessThan(61_000);
    expect(deadlines.beta! - before).toBeGreaterThan(170_000);
    expect(deadlines.beta! - before).toBeLessThan(181_000);
  });
});
