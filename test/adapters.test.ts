import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ashby } from '../src/adapters/ashby.js';
import { greenhouse } from '../src/adapters/greenhouse.js';
import { himalayas } from '../src/adapters/himalayas.js';
import { inhire } from '../src/adapters/inhire.js';
import { lever } from '../src/adapters/lever.js';
import { SchemaError, type FetchContext } from '../src/adapters/types.js';
import { parseConfig } from '../src/config/load.js';
import { createFilter } from '../src/pipeline/filter.js';
import { createHttpClient } from '../src/util/http.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = parseConfig(`
search:
  include: ["QA", "Quality"]
  seniority: [senior]
eligibility:
  accept_regions: [worldwide, brazil]
`);

function context(companies: string[] = [], overrides: Partial<FetchContext> = {}) {
  const warnings: string[] = [];
  const filter = createFilter(config);
  const ctx: FetchContext = {
    http: createHttpClient({ backoffMs: 1, retries: 2 }),
    config,
    companies: companies.map((slug) => ({ slug })),
    now: new Date('2026-10-15T12:00:00Z'),
    worthDetails: (candidate) => filter.worthDetails(candidate),
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { ctx, warnings };
}

describe('inhire', () => {
  const list = fixture('inhire-list.json');
  const qa = list.jobsPage.find((job: any) => /QA/.test(job.displayName));

  function mock(detailBody: unknown = fixture('inhire-detail.json')) {
    const detailCalls: string[] = [];
    server.use(
      http.get('https://api.inhire.app/job-posts/public/pages', ({ request }) => {
        expect(request.headers.get('x-tenant')).toBe('luby');
        expect(request.headers.get('x-inhire-client')).toBe('web-inhire');
        return HttpResponse.json(list);
      }),
      http.get('https://api.inhire.app/job-posts/public/pages/:id', ({ params }) => {
        detailCalls.push(params.id as string);
        const item = list.jobsPage.find((job: any) => job.jobId === params.id);
        return HttpResponse.json({ ...(detailBody as any), jobId: params.id, displayName: item?.displayName });
      }),
    );
    return detailCalls;
  }

  it('drops the talent pool and only requests details for jobs that pass the title filter', async () => {
    const detailCalls = mock();
    const { ctx } = context(['luby']);
    const raws = await inhire.fetch(ctx);

    expect(raws.some((raw) => /Banco de Talentos/.test(raw.item.displayName))).toBe(false);
    expect(raws).toHaveLength(list.jobsPage.length - 1);
    expect(detailCalls).toEqual([qa.jobId]);
    expect(raws.find((raw) => raw.item.jobId === qa.jobId)?.detail).toBeDefined();
  });

  it('builds the application link from the job id and a readable slug', async () => {
    mock();
    const { ctx } = context(['luby']);
    const raw = (await inhire.fetch(ctx)).find((item) => item.item.jobId === qa.jobId)!;
    const job = inhire.normalize(raw);

    expect(job.applyUrl).toBe(`https://luby.inhire.app/vagas/${qa.jobId}/profissional-qa-automacao-senior-especialista-remoto`);
    expect(job.company).toBe('Luby');
    expect(job.workModel).toBe('remote');
    expect(job.id).toMatch(/^inhire:luby:[0-9a-f]{8}$/);
    expect(job.locations).toEqual(['BR']);
  });

  it('fails the source when the response format changes', async () => {
    server.use(http.get('https://api.inhire.app/job-posts/public/pages', () => HttpResponse.json({ jobs: [] })));
    await expect(inhire.fetch(context(['luby']).ctx)).rejects.toBeInstanceOf(SchemaError);
  });

  it('keeps going when one company fails, and fails when all of them do', async () => {
    server.use(
      http.get('https://api.inhire.app/job-posts/public/pages', ({ request }) =>
        request.headers.get('x-tenant') === 'ghost' ? new HttpResponse(null, { status: 404 }) : HttpResponse.json(list),
      ),
      http.get('https://api.inhire.app/job-posts/public/pages/:id', () => HttpResponse.json(fixture('inhire-detail.json'))),
    );
    const partial = context(['ghost', 'luby']);
    expect((await inhire.fetch(partial.ctx)).length).toBeGreaterThan(0);
    expect(partial.warnings.join()).toContain('inhire/ghost');

    await expect(inhire.fetch(context(['ghost']).ctx)).rejects.toThrow('HTTP 404');
  });
});

describe('greenhouse', () => {
  it('validates the postings and normalizes them', async () => {
    server.use(
      http.get('https://boards-api.greenhouse.io/v1/boards/airbnb/jobs', ({ request }) => {
        expect(new URL(request.url).searchParams.get('content')).toBe('true');
        return HttpResponse.json(fixture('greenhouse.json'));
      }),
    );
    const { ctx } = context(['airbnb']);
    const raws = await greenhouse.fetch(ctx);
    const jobs = raws.map((raw) => greenhouse.normalize(raw));
    const brazil = jobs.find((job) => /Quality Platform/.test(job.title))!;

    expect(brazil.company).toBe('Airbnb');
    expect(brazil.locations).toEqual(['Brazil']);
    expect(brazil.applyUrl).toContain('careers.airbnb.com');
    expect(brazil.postedAt).toMatch(/^2026-/);
    expect(brazil.description).not.toMatch(/&lt;|<div/); // HTML decoded and stripped
    expect(brazil.atsApply).toBe(true);
  });

  it('skips a malformed posting with a warning but fails when none is valid', async () => {
    const data = fixture('greenhouse.json');
    server.use(
      http.get('https://boards-api.greenhouse.io/v1/boards/airbnb/jobs', () =>
        HttpResponse.json({ jobs: [...data.jobs, { id: 'oops' }] }),
      ),
    );
    const { ctx, warnings } = context(['airbnb']);
    expect(await greenhouse.fetch(ctx)).toHaveLength(data.jobs.length);
    expect(warnings.join()).toContain('1 of');

    server.use(http.get('https://boards-api.greenhouse.io/v1/boards/airbnb/jobs', () => HttpResponse.json({ jobs: [{ id: 'x' }] })));
    await expect(greenhouse.fetch(context(['airbnb']).ctx)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe('lever', () => {
  it('normalizes workplace type, locations and the posting date', async () => {
    server.use(http.get('https://api.lever.co/v0/postings/acme', () => HttpResponse.json(fixture('lever.json'))));
    const raws = await lever.fetch(context(['acme']).ctx);
    const job = lever.normalize(raws[0]!);

    expect(job.company).toBe('Acme');
    expect(job.workModel).toBe('hybrid');
    expect(job.locations).toEqual(['Singapore, Singapore']);
    expect(job.postedAt).toBe(new Date(fixture('lever.json')[0].createdAt).toISOString());
    expect(job.applyUrl).toMatch(/^https:\/\/jobs\.lever\.co\//);
  });

  it('fails when the response is not a list', async () => {
    server.use(http.get('https://api.lever.co/v0/postings/acme', () => HttpResponse.json({ error: 'x' })));
    await expect(lever.fetch(context(['acme']).ctx)).rejects.toBeInstanceOf(SchemaError);
  });
});

describe('ashby', () => {
  it('reads compensation and workplace type', async () => {
    server.use(
      http.get('https://api.ashbyhq.com/posting-api/job-board/ramp', ({ request }) => {
        expect(new URL(request.url).searchParams.get('includeCompensation')).toBe('true');
        return HttpResponse.json(fixture('ashby.json'));
      }),
    );
    const jobs = (await ashby.fetch(context(['ramp']).ctx)).map((raw) => ashby.normalize(raw));
    const paid = jobs.find((job) => job.compensation)!;

    expect(paid.compensation).toMatch(/\$/);
    expect(paid.company).toBe('Ramp');
    expect(paid.applyUrl).toMatch(/^https:\/\/jobs\.ashbyhq\.com\/ramp\//);
    expect(jobs.every((job) => job.postedAt)).toBe(true);
  });
});

describe('himalayas', () => {
  it('searches each include term, newest first, with the Brazil scope', async () => {
    const queries: string[] = [];
    server.use(
      http.get('https://himalayas.app/jobs/api/search', ({ request }) => {
        const url = new URL(request.url);
        queries.push(`${url.searchParams.get('q')}|${url.searchParams.get('country')}|${url.searchParams.get('sort')}`);
        return HttpResponse.json(fixture('himalayas.json'));
      }),
    );
    const { ctx } = context([], { now: new Date('2026-10-15T12:00:00Z') });
    const raws = await himalayas.fetch(ctx);

    expect(queries).toContain('QA|BR|recent');
    expect(queries).toContain('Quality|BR|recent');
    // the same postings come back for both terms but are de-duplicated by guid
    expect(raws).toHaveLength(new Set(raws.map((raw) => raw.guid)).size);
  });

  it('stops paging once a page reaches the age limit', async () => {
    const calls = vi.fn();
    server.use(
      http.get('https://himalayas.app/jobs/api/search', () => {
        calls();
        return HttpResponse.json(fixture('himalayas.json'));
      }),
    );
    const { ctx } = context([], { now: new Date('2027-06-01T00:00:00Z') }); // everything recorded is older than 15 days
    await himalayas.fetch(ctx);
    expect(calls).toHaveBeenCalledTimes(2); // one page per term
  });

  it('normalizes eligibility, seniority and the link back', async () => {
    const [first] = fixture('himalayas.json').jobs;
    const job = himalayas.normalize(first);
    expect(job.workModel).toBe('remote');
    expect(job.atsApply).toBe(false);
    expect(job.applyUrl).toContain('himalayas.app');
    expect(job.seniority).toContain('senior');
    expect(job.id).toMatch(/^himalayas:/);
  });
});

describe('http client', () => {
  it('retries on 429 honouring Retry-After and gives up after the retries', async () => {
    let calls = 0;
    server.use(
      http.get('https://example.test/data', () => {
        calls++;
        return calls < 3 ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '0' } }) : HttpResponse.json({ ok: true });
      }),
    );
    expect(await createHttpClient({ backoffMs: 1 }).getJson('https://example.test/data')).toEqual({ ok: true });
    expect(calls).toBe(3);

    server.use(http.get('https://example.test/down', () => new HttpResponse(null, { status: 503 })));
    await expect(createHttpClient({ backoffMs: 1, retries: 1 }).getJson('https://example.test/down')).rejects.toThrow('HTTP 503');
  });

  it('identifies the project in the User-Agent', async () => {
    server.use(
      http.get('https://example.test/ua', ({ request }) => HttpResponse.json({ ua: request.headers.get('user-agent') })),
    );
    const body = (await createHttpClient().getJson('https://example.test/ua')) as { ua: string };
    expect(body.ua).toContain('job-radar');
  });
});
