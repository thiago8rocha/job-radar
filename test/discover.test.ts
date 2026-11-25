import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCompaniesState, saveCompaniesState } from '../src/state/companies.js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { discover } from '../src/commands/discover.js';
import { parseConfig } from '../src/config/load.js';
import { ATS, emptyByAts } from '../src/adapters/ats.js';
import { buildCompaniesSchema, companyRefs } from '../src/config/schema.js';
import { addCompanies, listedSlugs, parseCompaniesText } from '../src/discovery/companies-file.js';
import { companiesFromLinks } from '../src/discovery/links.js';
import { archivedLinks } from '../src/discovery/wayback.js';
import { createHttpClient } from '../src/util/http.js';
import { fakeContext } from './fake-github.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const COMPANIES = `# companies to follow
inhire: [luby, radix]   # Brazilian ATS
greenhouse: [airbnb]
lever: []
ashby: []
`;

describe('company links', () => {
  it('reads the slug of each ATS out of career page links', () => {
    expect(
      companiesFromLinks([
        'https://acme.inhire.app/vagas/123/qa-engineer',
        'https://www.inhire.app/about',
        'https://boards.greenhouse.io/Gitlab/jobs/1',
        'https://job-boards.greenhouse.io/embed/job_board?for=x',
        'https://jobs.lever.co/palantir/abc',
        'https://jobs.ashbyhq.com/ramp',
        'https://apply.workable.com/huggingface/j/81B46579FE',
        'https://huggingface.workable.com/',
        'https://apply.workable.com/j/81B46579FE',
        'https://www.workable.com/pricing',
        'https://acme.inhire.app/vagas/456',
        'https://example.com/careers',
      ]),
    ).toEqual({ inhire: ['acme'], greenhouse: ['gitlab'], lever: ['palantir'], ashby: ['ramp'], workable: ['huggingface'] });
  });
});

describe('companies.yml editing', () => {
  it('adds slugs keeping comments and the list style', () => {
    const text = addCompanies(COMPANIES, { inhire: ['acme'], lever: ['palantir'] });
    expect(text).toContain('# companies to follow');
    expect(text).toContain('# Brazilian ATS');
    expect(text).toMatch(/inhire: \[luby, radix, acme\]/);
    expect(text).toMatch(/lever: \[palantir\]/);
    expect(parseCompaniesText(text).greenhouse).toEqual(['airbnb']);
  });

  it('creates missing lists and files', () => {
    expect(parseCompaniesText(addCompanies('inhire: [a]\n', { ashby: ['ramp'] })).ashby).toEqual(['ramp']);
    expect(parseCompaniesText(addCompanies('', { greenhouse: ['gitlab'] })).greenhouse).toEqual(['gitlab']);
  });

  it('lists the slugs already there, including named entries', () => {
    const listed = listedSlugs(parseCompaniesText('ashby: [{ slug: Ramp, name: Ramp Inc }]\ninhire: [luby]\n'));
    expect(listed.ashby.has('ramp')).toBe(true);
    expect(listed.inhire.has('luby')).toBe(true);
  });
});

describe('discover', () => {
  const CONFIG = `
discovery:
  enabled: true
  queries: ['site:boards.greenhouse.io "QA" remote', 'site:inhire.app/vagas QA']
  max_archive_queries: 0
`;

  function setup(configText = CONFIG, current: string | null = COMPANIES, openPulls: Array<{ number: number; head: { ref: string } }> = []) {
    const fake = fakeContext();
    fake.ctx.config = parseConfig(configText);
    const rest = fake.ctx.octokit.rest as any;
    rest.repos = {
      get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
      getContent: vi.fn(async () => {
        if (current === null) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { type: 'file', sha: 'FILE_SHA', content: Buffer.from(current).toString('base64') } };
      }),
      createOrUpdateFileContents: vi.fn(async () => ({})),
    };
    rest.pulls = {
      list: vi.fn(async () => ({ data: openPulls })),
      create: vi.fn(async () => ({ data: { number: 7 } })),
    };
    rest.git = {
      getRef: vi.fn(async () => ({ data: { object: { sha: 'BASE_SHA' } } })),
      createRef: vi.fn(async () => ({})),
    };
    return { ...fake, rest };
  }

  const board = (jobs: number) => HttpResponse.json({ jobs: Array.from({ length: jobs }, (_, i) => ({ id: i + 1, title: 'QA', absolute_url: `https://x.test/${i}` })) });

  function mockSearch(links: string[]) {
    server.use(
      http.get('https://serpapi.com/search.json', ({ request }) => {
        expect(new URL(request.url).searchParams.get('engine')).toBe('google');
        return HttpResponse.json({ organic_results: links.map((link) => ({ link })) });
      }),
    );
  }

  const options = (extra = {}) => ({
    serpapiKey: 'k',
    http: createHttpClient({ retries: 0 }),
    now: new Date('2026-10-16T12:00:00Z'),
    ...extra,
  });

  it('opens a pull request with the new companies that answer like a career page', async () => {
    mockSearch(['https://boards.greenhouse.io/gitlab/jobs/1', 'https://boards.greenhouse.io/airbnb/jobs/2', 'https://boards.greenhouse.io/ghost/jobs/3']);
    server.use(
      http.get('https://boards-api.greenhouse.io/v1/boards/gitlab/jobs', () => board(2)),
      http.get('https://boards-api.greenhouse.io/v1/boards/ghost/jobs', () => new HttpResponse(null, { status: 404 })),
    );
    const { ctx, rest } = setup();
    const result = await discover(ctx, options());

    expect(result.found).toEqual({ inhire: [], greenhouse: ['gitlab'], lever: [], ashby: [], workable: [] });
    expect(result.pullRequest).toBe(7);
    expect(rest.git.createRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/job-radar/discovery-2026-10-16', sha: 'BASE_SHA' }));
    const commit = rest.repos.createOrUpdateFileContents.mock.calls[0]![0];
    expect(commit).toMatchObject({ path: 'companies.yml', branch: 'job-radar/discovery-2026-10-16', sha: 'FILE_SHA' });
    expect(commit.message).toBe('chore(companies): add 1 discovered company');
    expect(Buffer.from(commit.content, 'base64').toString()).toMatch(/greenhouse: \[airbnb, gitlab\]/);
    expect(rest.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ base: 'main', head: 'job-radar/discovery-2026-10-16' }));
  });

  it('proposes nothing when every link is already listed', async () => {
    mockSearch(['https://boards.greenhouse.io/airbnb/jobs/2']);
    const { ctx, rest } = setup();
    const result = await discover(ctx, options());
    expect(result.found).toEqual({ inhire: [], greenhouse: [], lever: [], ashby: [], workable: [] });
    expect(rest.pulls.create).not.toHaveBeenCalled();
  });

  it('does not stack a second pull request while one is waiting for review', async () => {
    mockSearch(['https://boards.greenhouse.io/gitlab/jobs/1']);
    server.use(http.get('https://boards-api.greenhouse.io/v1/boards/gitlab/jobs', () => board(1)));
    const { ctx, rest } = setup(CONFIG, COMPANIES, [{ number: 5, head: { ref: 'job-radar/discovery-2026-10-09' } }]);
    const result = await discover(ctx, options());
    expect(result.pullRequest).toBe(5);
    expect(rest.pulls.create).not.toHaveBeenCalled();
    expect(rest.git.createRef).not.toHaveBeenCalled();
  });

  it('only reports in a dry run', async () => {
    mockSearch(['https://boards.greenhouse.io/gitlab/jobs/1']);
    server.use(http.get('https://boards-api.greenhouse.io/v1/boards/gitlab/jobs', () => board(1)));
    const { ctx, rest, log } = setup();
    const result = await discover(ctx, options({ dryRun: true }));
    expect(result.found.greenhouse).toEqual(['gitlab']);
    expect(rest.pulls.create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Would propose 1'));
  });

  it('is skipped when it is off, has no key or has no queries, without calling anything', async () => {
    const off = setup('discovery: { enabled: false }');
    expect((await discover(off.ctx, options())).found.greenhouse).toEqual([]);
    expect(off.rest.repos.get).not.toHaveBeenCalled();

    const noKey = setup();
    await discover(noKey.ctx, options({ serpapiKey: undefined }));
    expect(noKey.rest.repos.get).not.toHaveBeenCalled();
    expect(noKey.log.info).toHaveBeenCalledWith(expect.stringContaining('No SerpAPI key'));

    const noQueries = setup('discovery: { enabled: true, max_archive_queries: 0 }');
    await discover(noQueries.ctx, options());
    expect(noQueries.log.warn).toHaveBeenCalledWith(expect.stringContaining('queries is empty'));
  });

  it('proposes boards harvested from collected jobs even without a SerpAPI key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-radar-harvest-'));
    try {
      const statePath = join(dir, 'companies.json');
      const state = emptyCompaniesState();
      const stamp = '2026-10-14T00:00:00.000Z';
      state.candidates['greenhouse:acme'] = { firstSeen: stamp, lastSeen: stamp, count: 3 };
      state.candidates['greenhouse:airbnb'] = { firstSeen: stamp, lastSeen: stamp, count: 9 };
      state.candidates['greenhouse:ghost'] = { firstSeen: stamp, lastSeen: stamp, count: 1 };
      await saveCompaniesState(statePath, state);
      server.use(
        http.get('https://boards-api.greenhouse.io/v1/boards/acme/jobs', () => board(2)),
        http.get('https://boards-api.greenhouse.io/v1/boards/ghost/jobs', () => new HttpResponse(null, { status: 404 })),
      );
      const { ctx, rest } = setup();
      const result = await discover(ctx, options({ serpapiKey: undefined, companiesStatePath: statePath }));
      expect(result.found.greenhouse).toEqual(['acme']);
      expect(result.pullRequest).toBe(7);
      expect(rest.pulls.create).toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('through the Wayback Machine', () => {
    const WAYBACK = CONFIG.replace('max_archive_queries: 0', 'max_archive_queries: 10');
    const cdx = (hosts: string[]) => [['original'], ...hosts.map((host) => [`https://${host}.inhire.app/vagas/1`]), ['https://inhire.app/']];

    it('proposes only the archived tenants that are new and have postings', async () => {
      server.use(
        http.get('https://web.archive.org/cdx/search/cdx', ({ request }) => {
          const query = new URL(request.url).searchParams;
          expect(query.get('url')).toBe('*.inhire.app');
          expect(query.get('collapse')).toBe('urlkey');
          expect(query.get('from')).toBe('20251016');
          return HttpResponse.json(cdx(['luby', 'newco', 'ghostco']));
        }),
        http.get('https://api.inhire.app/job-posts/public/pages', ({ request }) =>
          request.headers.get('x-tenant') === 'newco' ? HttpResponse.json(fixture('inhire-list.json')) : new HttpResponse(null, { status: 404 }),
        ),
      );
      const { ctx } = setup(WAYBACK);
      const result = await discover(ctx, options({ serpapiKey: undefined, companiesStatePath: 'no-such-state.json' }));
      expect(result.found.inhire).toEqual(['newco']);
      expect(result.pullRequest).toBe(7);
    });

    it('still works when the archive is down', async () => {
      server.use(http.get('https://web.archive.org/cdx/search/cdx', () => new HttpResponse(null, { status: 404 })));
      const { ctx, log } = setup(WAYBACK);
      const result = await discover(ctx, options({ serpapiKey: undefined, companiesStatePath: 'no-such-state.json' }));
      expect(result.found.inhire).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Wayback *.inhire.app'));
    });

    it('reads the CDX rows of a recorded response', async () => {
      server.use(http.get('https://web.archive.org/cdx/search/cdx', () => HttpResponse.json(fixture('wayback-cdx-inhire.json'))));
      const links = await archivedLinks({ http: createHttpClient({ retries: 0 }), maxQueries: 5, now: new Date('2026-11-25T00:00:00Z') });
      expect(companiesFromLinks(links).inhire).toContain('2bizcompany');
      expect(companiesFromLinks(links).inhire).not.toContain('app');
    });

    it('makes no request when the cap is zero', async () => {
      expect(await archivedLinks({ http: createHttpClient({ retries: 0 }), maxQueries: 0, now: new Date() })).toEqual([]);
    });
  });

  it('creates companies.yml when the repository has none', async () => {
    mockSearch(['https://jobs.ashbyhq.com/ramp']);
    server.use(
      http.get('https://api.ashbyhq.com/posting-api/job-board/ramp', () =>
        HttpResponse.json({ jobs: [{ id: 'a', title: 'QA', jobUrl: 'https://jobs.ashbyhq.com/ramp/a' }] }),
      ),
    );
    const { ctx, rest } = setup(CONFIG, null);
    await discover(ctx, options());
    const commit = rest.repos.createOrUpdateFileContents.mock.calls[0]![0];
    expect(commit.sha).toBeUndefined();
    expect(parseCompaniesText(Buffer.from(commit.content, 'base64').toString()).ashby).toEqual(['ramp']);
  });
});

describe('ATS registry', () => {
  const table = [
    ...ATS,
    { id: 'fakeats', urls: [{ pattern: /^https:\/\/jobs\.fake\.test\/([A-Za-z0-9]+)/ }], caseSensitive: true },
  ];

  it('makes a table entry enough for the schema, the listed slugs, link discovery and the defaults', () => {
    const companies = buildCompaniesSchema(table).parse({ fakeats: ['AcmeCo', { slug: 'Beta' }] }) as Record<string, unknown[]>;
    expect(companies.fakeats).toEqual(['AcmeCo', { slug: 'Beta' }]);
    expect((buildCompaniesSchema(table).parse({}) as Record<string, unknown>).fakeats).toEqual([]);
    expect([...(listedSlugs(companies as never, table) as Record<string, Set<string>>).fakeats!]).toEqual(['AcmeCo', 'Beta']);
    expect((companiesFromLinks(['https://jobs.fake.test/AcmeCo/1'], table) as Record<string, string[]>).fakeats).toEqual(['AcmeCo']);
    expect(emptyByAts(table)).toHaveProperty('fakeats', []);
  });

  it('accepts slug, slug with name and url entries', () => {
    const companies = parseCompaniesText('greenhouse:\n  - acme\n  - { slug: beta, name: Beta Inc }\n  - { url: "https://boards.eu.greenhouse.io/gamma", name: Gamma }\n');
    expect(companyRefs(companies.greenhouse)).toEqual([
      { slug: 'acme' },
      { slug: 'beta', name: 'Beta Inc' },
      { slug: 'https://boards.eu.greenhouse.io/gamma', url: 'https://boards.eu.greenhouse.io/gamma', name: 'Gamma' },
    ]);
  });
});
