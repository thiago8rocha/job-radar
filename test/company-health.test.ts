import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forEachCompany } from '../src/adapters/common.js';
import type { AnySourceAdapter, FetchContext } from '../src/adapters/types.js';
import { collect } from '../src/commands/collect.js';
import { prune } from '../src/commands/prune.js';
import { sweep } from '../src/commands/sweep.js';
import { parseConfig } from '../src/config/load.js';
import { parseCompaniesText, removeCompanies } from '../src/discovery/companies-file.js';
import { emptyCompaniesState, harvestCandidates, hotDirectory, loadCompaniesState, recordOutcome, saveCompaniesState } from '../src/state/companies.js';
import { HttpError } from '../src/util/http.js';
import { fakeContext } from './fake-github.js';
import { job } from './helpers.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const CONFIG = `
search: { include: ["QA"] }
eligibility: { accept_regions: [brazil] }
sources: { greenhouse: { enabled: true } }
`;

let dir: string;
let companiesStatePath: string;
let statePath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-radar-health-'));
  companiesStatePath = join(dir, 'state', 'companies.json');
  statePath = join(dir, 'state', 'seen.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function boards(titles: Record<string, string[] | Error>, seen: string[] = [], delayMs = 0): AnySourceAdapter {
  return {
    id: 'greenhouse',
    mode: 'company',
    fetch: (ctx: FetchContext) =>
      forEachCompany('greenhouse', { ...ctx, concurrency: 1 }, async (company) => {
        seen.push(`${company.slug}${company.light ? '*' : ''}`);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const value = titles[company.slug]!;
        if (value instanceof Error) throw value;
        return value.map((title) => ({ company, title }));
      }),
    normalize: (raw: { company: { slug: string }; title: string }) =>
      job({ id: `greenhouse:${raw.company.slug}:${raw.title}`, source: 'greenhouse', company: raw.company.slug, title: raw.title, applyUrl: `https://x.test/${raw.company.slug}/${raw.title}` }),
  };
}

const directoryOf = (slugs: string[]) => parseCompaniesText(`greenhouse: [${slugs.join(', ')}]`);

describe('company health', () => {
  it('counts a dead board once per week and ignores outages', () => {
    const state = emptyCompaniesState();
    const gone = { error: new HttpError(404, 'u'), postings: 0, relevant: false };
    recordOutcome(state, 'greenhouse:x', gone, new Date('2026-10-12T10:00:00Z'));
    recordOutcome(state, 'greenhouse:x', gone, new Date('2026-10-14T10:00:00Z'));
    expect(state.companies['greenhouse:x']!.failures).toBe(1);
    recordOutcome(state, 'greenhouse:x', gone, new Date('2026-10-19T10:00:00Z'));
    expect(state.companies['greenhouse:x']!.failures).toBe(2);

    recordOutcome(state, 'greenhouse:x', { error: new HttpError(503, 'u'), postings: 0, relevant: false }, new Date('2026-10-26T10:00:00Z'));
    expect(state.companies['greenhouse:x']!.failures).toBe(2);

    recordOutcome(state, 'greenhouse:x', { postings: 3, relevant: true }, new Date('2026-10-26T10:00:00Z'));
    expect(state.companies['greenhouse:x']).toMatchObject({ failures: 0, emptyRuns: 0, lastRelevant: '2026-10-26T10:00:00.000Z' });
  });

  it('keeps only directory companies with a recent relevant posting in the hot list', () => {
    const state = emptyCompaniesState();
    recordOutcome(state, 'greenhouse:fresh', { postings: 1, relevant: true }, new Date('2026-10-01T00:00:00Z'));
    recordOutcome(state, 'greenhouse:stale', { postings: 1, relevant: true }, new Date('2026-07-01T00:00:00Z'));
    recordOutcome(state, 'greenhouse:never', { postings: 1, relevant: false }, new Date('2026-10-01T00:00:00Z'));
    const hot = hotDirectory(directoryOf(['Fresh', 'stale', 'never', 'unknown']), state, 45, NOW);
    expect(hot.greenhouse).toEqual(['Fresh']);
  });

  it('round-trips the state file with sorted keys', async () => {
    const state = emptyCompaniesState();
    recordOutcome(state, 'lever:b', { postings: 0, relevant: false }, NOW);
    recordOutcome(state, 'ashby:a', { postings: 1, relevant: true }, NOW);
    await saveCompaniesState(companiesStatePath, state);
    expect(Object.keys(JSON.parse(await readFile(companiesStatePath, 'utf8')).companies)).toEqual(['ashby:a', 'lever:b']);
    expect(await loadCompaniesState(companiesStatePath)).toEqual(state);
    expect(await loadCompaniesState(join(dir, 'missing.json'))).toEqual(emptyCompaniesState());
  });
});

describe('sweep and collect', () => {
  const titles = { qaco: ['QA Engineer'], bakery: ['Baker'], ghost: new HttpError(404, 'https://x.test/ghost') };

  it('makes a directory company with a matching posting part of the next collect', async () => {
    const { ctx } = fakeContext();
    ctx.config = parseConfig(CONFIG);
    const directory = directoryOf(['qaco', 'bakery', 'ghost']);

    const swept = await sweep(ctx, { directory, adapters: { greenhouse: boards(titles) }, companiesStatePath, now: NOW });
    expect(swept).toEqual({ checked: 3, total: 3, cursor: 0 });
    const state = await loadCompaniesState(companiesStatePath);
    expect(state.companies['greenhouse:qaco']!.lastRelevant).toBeDefined();
    expect(state.companies['greenhouse:bakery']!.lastRelevant).toBeUndefined();
    expect(state.companies['greenhouse:ghost']!.failures).toBe(1);

    const seen: string[] = [];
    const run = fakeContext();
    run.ctx.config = ctx.config;
    await collect(run.ctx, {
      adapters: { greenhouse: boards(titles, seen) },
      directory,
      companiesStatePath,
      statePath,
      now: NOW,
      delayMs: 0,
      dryRun: true,
    });
    expect(seen).toEqual(['qaco*']);
  });

  it('collects companies.yml entries as usual and does not repeat them from the directory', async () => {
    const { ctx } = fakeContext();
    ctx.config = parseConfig(CONFIG);
    await mkdir(dirname(companiesStatePath), { recursive: true });
    const state = emptyCompaniesState();
    recordOutcome(state, 'greenhouse:qaco', { postings: 1, relevant: true }, NOW);
    await saveCompaniesState(companiesStatePath, state);

    const seen: string[] = [];
    await collect(ctx, {
      adapters: { greenhouse: boards(titles, seen) },
      companies: parseCompaniesText('greenhouse: [qaco, bakery]'),
      directory: directoryOf(['qaco']),
      companiesStatePath,
      statePath,
      now: NOW,
      delayMs: 0,
    });
    expect(seen).toEqual(['qaco', 'bakery']);
    expect((await loadCompaniesState(companiesStatePath)).companies['greenhouse:bakery']!.lastOk).toBeDefined();
  });

  it('resumes from the cursor when the budget runs out', async () => {
    const { ctx } = fakeContext();
    ctx.config = parseConfig(`${CONFIG}run: { budget_minutes: 0.002 }\n`);
    const slugs = ['a', 'b', 'c', 'd', 'e', 'f'];
    const all = Object.fromEntries(slugs.map((slug) => [slug, ['QA']]));
    const first: string[] = [];
    const one = await sweep(ctx, { directory: directoryOf(slugs), adapters: { greenhouse: boards(all, first, 80) }, companiesStatePath, now: NOW, chunkSize: 1 });
    expect(one.checked).toBeLessThan(6);
    expect(one.cursor).toBe(one.checked);

    const second: string[] = [];
    await sweep(ctx, { directory: directoryOf(slugs), adapters: { greenhouse: boards(all, second) }, companiesStatePath, now: NOW });
    expect(second[0]).toBe(`${slugs[one.cursor]}*`);
  });

  it('writes nothing on a dry run', async () => {
    const { ctx } = fakeContext();
    ctx.config = parseConfig(CONFIG);
    await sweep(ctx, { directory: directoryOf(['qaco']), adapters: { greenhouse: boards(titles) }, companiesStatePath, now: NOW, dryRun: true });
    expect(await loadCompaniesState(companiesStatePath)).toEqual(emptyCompaniesState());
  });
});

describe('prune', () => {
  const COMPANIES = '# my list\ngreenhouse: [gone, alive]\nlever:\n  - { slug: old, name: Old Inc }\n  - fine\n';

  async function setup(openPulls: Array<{ number: number; head: { ref: string } }> = []) {
    const state = emptyCompaniesState();
    const gone = { error: new HttpError(404, 'u'), postings: 0, relevant: false };
    for (const [key, weeks] of [['greenhouse:gone', 4], ['lever:old', 4], ['lever:fine', 3]] as const) {
      for (let week = 0; week < weeks; week++) recordOutcome(state, key, gone, new Date(Date.parse('2026-09-21T00:00:00Z') + week * 7 * 86_400_000));
    }
    await saveCompaniesState(companiesStatePath, state);

    const fake = fakeContext();
    fake.ctx.config = parseConfig(CONFIG);
    const rest = fake.ctx.octokit.rest as any;
    rest.repos = {
      get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
      getContent: vi.fn(async () => ({ data: { type: 'file', sha: 'SHA', content: Buffer.from(COMPANIES).toString('base64') } })),
      createOrUpdateFileContents: vi.fn(async () => ({})),
    };
    rest.pulls = { list: vi.fn(async () => ({ data: openPulls })), create: vi.fn(async () => ({ data: { number: 9 } })), update: vi.fn(async () => ({})) };
    rest.git = { getRef: vi.fn(async () => ({ data: { object: { sha: 'BASE' } } })), createRef: vi.fn(async () => ({})) };
    return { ...fake, rest };
  }

  it('proposes removing boards that failed four weeks in a row, and only those', async () => {
    const { ctx, rest } = await setup();
    const result = await prune(ctx, { companiesStatePath, now: NOW });
    expect(result.dead).toEqual({ greenhouse: ['gone'], lever: ['old'] });
    const commit = rest.repos.createOrUpdateFileContents.mock.calls[0]![0];
    const text = Buffer.from(commit.content, 'base64').toString();
    expect(text).toContain('# my list');
    expect(parseCompaniesText(text)).toMatchObject({ greenhouse: ['alive'], lever: ['fine'] });
    expect(rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ head: 'job-radar/prune-2026-10-15', base: 'main' }));
  });

  it('updates the pull request that is already open instead of opening another', async () => {
    const { ctx, rest } = await setup([{ number: 4, head: { ref: 'job-radar/prune-2026-10-08' } }]);
    const result = await prune(ctx, { companiesStatePath, now: NOW });
    expect(result.pullRequest).toBe(4);
    expect(rest.pulls.create).not.toHaveBeenCalled();
    expect(rest.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 4 }));
    expect(rest.repos.createOrUpdateFileContents.mock.calls[0]![0]).toMatchObject({ branch: 'job-radar/prune-2026-10-08' });
  });

  it('only reports in a dry run', async () => {
    const { ctx, rest } = await setup();
    await prune(ctx, { companiesStatePath, dryRun: true });
    expect(rest.pulls.create).not.toHaveBeenCalled();
  });
});

describe('removeCompanies', () => {
  it('drops slugs in any entry form and keeps the rest', () => {
    const text = removeCompanies('greenhouse: [a, B, c]\nlever:\n  - { slug: x, name: X }\n  - y\n', { greenhouse: ['b'], lever: ['x'] });
    expect(parseCompaniesText(text)).toMatchObject({ greenhouse: ['a', 'c'], lever: ['y'] });
  });
});

describe('candidate harvesting', () => {
  const CONFIG_WITH_LISTS = CONFIG;
  const fromLinks = (links: Record<string, string>) =>
    ({
      id: 'freehire',
      mode: 'search',
      fetch: async () => Object.keys(links),
      normalize: (id: string) => job({ id: `freehire:x:${id}`, source: 'freehire', company: id, title: 'Senior QA Engineer', applyUrl: links[id]! }),
    }) as AnySourceAdapter;

  it('keeps the boards that fetched jobs link to, minus the ones already listed', async () => {
    const { ctx } = fakeContext();
    ctx.config = parseConfig(`${CONFIG_WITH_LISTS}`.replace('sources: { greenhouse: { enabled: true } }', 'sources: { freehire: { enabled: true } }'));
    const links = {
      a: 'https://boards.greenhouse.io/newco/jobs/1',
      b: 'https://boards.greenhouse.io/newco/jobs/2',
      c: 'https://boards.greenhouse.io/listed/jobs/3',
      d: 'https://boards.greenhouse.io/indirectory/jobs/4',
      e: 'https://jobs.lever.co/Other/5',
      f: 'https://example.com/careers/6',
    };
    await collect(ctx, {
      adapters: { freehire: fromLinks(links) },
      companies: parseCompaniesText('greenhouse: [listed]'),
      directory: directoryOf(['indirectory']),
      companiesStatePath,
      statePath,
      now: NOW,
      delayMs: 0,
    });
    const { candidates } = await loadCompaniesState(companiesStatePath);
    expect(Object.keys(candidates).sort()).toEqual(['greenhouse:newco', 'lever:other']);
    expect(candidates['greenhouse:newco']).toMatchObject({ count: 2, firstSeen: NOW.toISOString() });
  });

  it('forgets candidates that were not seen for 60 days or got listed', () => {
    const state = emptyCompaniesState();
    state.candidates['greenhouse:old'] = { firstSeen: '2026-06-01T00:00:00Z', lastSeen: '2026-07-01T00:00:00Z', count: 5 };
    state.candidates['greenhouse:nowlisted'] = { firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-10T00:00:00Z', count: 1 };
    state.candidates['greenhouse:keep'] = { firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-10T00:00:00Z', count: 1 };
    harvestCandidates(state, {}, new Set(['greenhouse:nowlisted']), NOW);
    expect(Object.keys(state.candidates)).toEqual(['greenhouse:keep']);
  });
});
