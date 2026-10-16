import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { googleJobs, defaultQueries } from '../src/adapters/google-jobs.js';
import { gupy } from '../src/adapters/gupy.js';
import { remoteok } from '../src/adapters/remoteok.js';
import { SchemaError, type FetchContext } from '../src/adapters/types.js';
import { weworkremotely } from '../src/adapters/weworkremotely.js';
import { parseConfig } from '../src/config/load.js';
import { createHttpClient } from '../src/util/http.js';
import { parseRssItems } from '../src/util/rss.js';
import { relativeToIso } from '../src/util/relative-time.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (name: string): any => JSON.parse(fixture(name));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const NOW = new Date('2026-10-16T12:00:00Z');

function context(configText: string, overrides: Partial<FetchContext> = {}) {
  const warnings: string[] = [];
  const ctx: FetchContext = {
    http: createHttpClient({ backoffMs: 1, retries: 1 }),
    config: parseConfig(configText),
    companies: [],
    now: NOW,
    worthDetails: () => true,
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { ctx, warnings };
}

describe('gupy', () => {
  const CONFIG = 'search: { include: ["QA", "Analista de Testes"], max_age_days: 15 }\nwork_model: [remote]';

  it('searches each include term for remote jobs through the portal API', async () => {
    const queries: string[] = [];
    server.use(
      http.get('https://portal.gupy.io/api/job-search/jobs', ({ request }) => {
        const url = new URL(request.url);
        queries.push(`${url.searchParams.get('jobName')}|${url.searchParams.get('workplaceType')}|${url.searchParams.get('limit')}`);
        return HttpResponse.json(json('gupy.json'));
      }),
    );
    const { ctx } = context(CONFIG);
    const raws = await gupy.fetch(ctx);

    expect(queries).toEqual(['QA|remote|100', 'Analista de Testes|remote|100']);
    expect(new Set(raws.map((raw) => raw.id)).size).toBe(raws.length); // the same postings are found once
  });

  it('normalizes the posting number out of the title and keeps the company page link', () => {
    const first = json('gupy.json').data[0];
    const job = gupy.normalize(first);
    expect(job.title).not.toMatch(/^\d+\s*-/);
    expect(job.company).toBe(first.careerPageName.trim());
    expect(job.applyUrl).toContain('.gupy.io/job/');
    expect(job.applyUrl).not.toContain('jobBoardSource');
    expect(job.locations).toContain('Brazil');
    expect(job.workModel).toBe('remote');
    expect(job.id).toMatch(/^gupy:/);
    expect(job.atsApply).toBe(true);
  });

  it('drops talent pools and postings past their deadline, and fails when the format changes', async () => {
    const data = json('gupy.json');
    const [a, b, c] = data.data;
    server.use(
      http.get('https://portal.gupy.io/api/job-search/jobs', () =>
        HttpResponse.json({
          data: [
            { ...a, type: 'vacancy_type_talent_pool' },
            { ...b, applicationDeadline: '2026-01-01T00:00:00.000Z' },
            { ...c, applicationDeadline: '2027-01-01T00:00:00.000Z', type: 'vacancy_type_effective' },
          ],
          pagination: { total: 3, limit: 100, offset: 0 },
        }),
      ),
    );
    const raws = await gupy.fetch(context('search: { include: ["QA"] }').ctx);
    expect(raws.map((raw) => raw.id)).toEqual([c.id]);
    expect(gupy.normalize(raws[0]!).contracts).toEqual(['CLT']);

    server.use(http.get('https://portal.gupy.io/api/job-search/jobs', () => HttpResponse.json({ jobs: [] })));
    await expect(gupy.fetch(context('search: { include: ["QA"] }').ctx)).rejects.toBeInstanceOf(SchemaError);
  });

  it('stops paging at the age limit', async () => {
    let calls = 0;
    server.use(
      http.get('https://portal.gupy.io/api/job-search/jobs', () => {
        calls++;
        return HttpResponse.json({ ...json('gupy.json'), pagination: { total: 1000 } });
      }),
    );
    const { ctx } = context('search: { include: ["QA"], max_age_days: 1 }', { now: new Date('2027-06-01T00:00:00Z') });
    await gupy.fetch(ctx);
    expect(calls).toBe(1);
  });
});

describe('remoteok', () => {
  it('skips the legal notice and keeps the link back to Remote OK', async () => {
    server.use(http.get('https://remoteok.com/api', () => HttpResponse.json(json('remoteok.json'))));
    const raws = await remoteok.fetch(context('').ctx);
    const feed = json('remoteok.json');

    expect(raws).toHaveLength(feed.length - 1);
    const job = remoteok.normalize(raws[0]!);
    expect(job.applyUrl).toMatch(/^https:\/\/remoteok\.com\/remote-jobs\//i);
    expect(job.workModel).toBe('remote');
    expect(job.atsApply).toBe(false);
    expect(job.postedAt).toMatch(/^2026-/);
  });

  it('states salaries in USD per year only when the posting gives one', () => {
    const base = { id: '1', position: 'QA', company: 'Acme', url: 'https://remoteok.com/remote-jobs/1' };
    expect(remoteok.normalize({ ...base, salary_min: 80000, salary_max: 100000 })).toMatchObject({
      compensation: 'USD 80,000 – 100,000 / year',
      currency: 'USD',
    });
    expect(remoteok.normalize({ ...base, salary_min: 0, salary_max: 0 }).compensation).toBeUndefined();
    expect(remoteok.normalize({ ...base, location: 'Remote - US' }).restrictions).toEqual(['Remote - US']);
    expect(remoteok.normalize(base).locations).toEqual(['Worldwide']);
  });

  it('fails when the feed is not a list', async () => {
    server.use(http.get('https://remoteok.com/api', () => HttpResponse.json({ error: 'blocked' })));
    await expect(remoteok.fetch(context('').ctx)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe('weworkremotely', () => {
  it('reads the RSS feed and splits company and role', async () => {
    server.use(http.get('https://weworkremotely.com/remote-jobs.rss', () => new HttpResponse(fixture('wwr.xml'), { headers: { 'Content-Type': 'application/rss+xml' } })));
    const raws = await weworkremotely.fetch(context('', { now: new Date('2026-10-16T12:00:00Z') }).ctx);
    expect(raws.length).toBeGreaterThan(0);

    const job = weworkremotely.normalize(raws.find((raw) => /Quality/.test(raw.title)) ?? raws[0]!);
    expect(job.company).not.toBe('Unknown');
    expect(job.title).not.toContain(job.company);
    expect(job.applyUrl).toMatch(/^https:\/\/weworkremotely\.com\/remote-jobs\//);
    expect(job.description).not.toMatch(/<\/?(p|div|strong)>/);
    expect(job.workModel).toBe('remote');
    expect(job.postedAt).toMatch(/^2026-10/);
  });

  it('drops expired postings and fails when the response is not RSS', async () => {
    server.use(http.get('https://weworkremotely.com/remote-jobs.rss', () => new HttpResponse(fixture('wwr.xml'))));
    const expired = await weworkremotely.fetch(context('', { now: new Date('2028-01-01T00:00:00Z') }).ctx);
    expect(expired).toEqual([]);

    server.use(http.get('https://weworkremotely.com/remote-jobs.rss', () => new HttpResponse('<html>blocked</html>')));
    await expect(weworkremotely.fetch(context('').ctx)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe('rss parsing', () => {
  it('handles CDATA, entities and attributes on item children', () => {
    const items = parseRssItems(
      '<rss><channel><item><title><![CDATA[A & B: QA]]></title><link>https://x.test/1</link><description>&lt;p&gt;Hi&lt;/p&gt;</description><media:content url="u"/></item></channel></rss>',
    )!;
    expect(items).toEqual([{ title: 'A & B: QA', link: 'https://x.test/1', description: '<p>Hi</p>' }]);
    expect(parseRssItems('<html></html>')).toBeUndefined();
  });
});

describe('relative dates', () => {
  it('turns relative texts into timestamps', () => {
    expect(relativeToIso('3 days ago', NOW)).toBe('2026-10-13T12:00:00.000Z');
    expect(relativeToIso('há 2 semanas', NOW)).toBe('2026-10-02T12:00:00.000Z');
    expect(relativeToIso('5 hours ago', NOW)).toBe('2026-10-16T07:00:00.000Z');
    expect(relativeToIso('30+ days ago', NOW)).toBe('2026-09-16T12:00:00.000Z');
    expect(relativeToIso('yesterday', NOW)).toBe('2026-10-15T12:00:00.000Z');
    expect(relativeToIso('soon', NOW)).toBeUndefined();
    expect(relativeToIso(undefined, NOW)).toBeUndefined();
  });
});

describe('google_jobs', () => {
  const CONFIG = 'search: { include: ["QA", "Quality Assurance", "SDET"] }\neligibility: { accept_regions: [brazil, worldwide] }\nsources:\n  google_jobs: { enabled: true, api_key_secret: SERPAPI_KEY }';

  it('does nothing without a key', async () => {
    expect(await googleJobs.fetch(context(CONFIG).ctx)).toEqual([]);
  });

  it('runs one search for the include terms, with the key and location, and normalizes the results', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get('https://serpapi.com/search.json', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(json('google-jobs.synthetic.json'));
      }),
    );
    const raws = await googleJobs.fetch(context(CONFIG, { apiKey: 'secret-key' }).ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('engine')).toBe('google_jobs');
    expect(seen[0]!.get('q')).toBe('QA OR "Quality Assurance" OR SDET remote');
    expect(seen[0]!.get('location')).toBe('Brazil');
    expect(seen[0]!.get('api_key')).toBe('secret-key');

    const [first, second] = raws.map((raw) => googleJobs.normalize(raw));
    expect(first).toMatchObject({ company: 'Acme Brasil', title: 'Senior QA Engineer', workModel: 'remote', atsApply: false });
    expect(first!.applyUrl).toBe('https://www.linkedin.com/jobs/view/123456?trackingId=abc');
    expect(first!.postedAt).toMatch(/^2026-10-/);
    expect(second!.applyUrl).toContain('google.com/search'); // no apply option: falls back to the share link
    expect(second!.workModel).toBeUndefined();
  });

  it('respects max_searches and treats an empty answer as no results', async () => {
    let calls = 0;
    server.use(
      http.get('https://serpapi.com/search.json', () => {
        calls++;
        return HttpResponse.json({ error: "Google hasn't returned any results for this query." });
      }),
    );
    const config = CONFIG.replace('google_jobs: {', 'google_jobs: { queries: ["a", "b", "c", "d"], max_searches: 2,');
    expect(await googleJobs.fetch(context(config, { apiKey: 'k' }).ctx)).toEqual([]);
    expect(calls).toBe(2);
  });

  it('never leaks the key in an error', async () => {
    server.use(http.get('https://serpapi.com/search.json', () => new HttpResponse(null, { status: 401 })));
    const error = await googleJobs.fetch(context(CONFIG, { apiKey: 'secret-key' }).ctx).catch((e: Error) => e);
    expect((error as Error).message).toBe('SerpAPI returned HTTP 401');
    expect((error as Error).message).not.toContain('secret-key');
  });

  it('builds the default query from the first include terms', () => {
    expect(defaultQueries(['QA', 'Test Automation'])).toEqual(['QA OR "Test Automation" remote']);
    expect(defaultQueries([])).toEqual([]);
  });
});
