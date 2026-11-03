import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ashby } from '../src/adapters/ashby.js';
import { freehire } from '../src/adapters/freehire.js';
import { getonbrd } from '../src/adapters/getonbrd.js';
import { greenhouse } from '../src/adapters/greenhouse.js';
import { himalayas } from '../src/adapters/himalayas.js';
import { inhire } from '../src/adapters/inhire.js';
import { lever } from '../src/adapters/lever.js';
import { linkedin } from '../src/adapters/linkedin.js';
import { SchemaError, type FetchContext } from '../src/adapters/types.js';
import { parseConfig } from '../src/config/load.js';
import { checkEligibility } from '../src/pipeline/eligibility.js';
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

describe('freehire', () => {
  const SEARCH = 'https://freehire.me/api/v1/agent/jobs/search';

  it('searches titles in one OR query, scoped to the accepted regions and the age limit', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(SEARCH, ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(fixture('freehire.json'));
      }),
    );
    const { ctx } = context();
    const raws = await freehire.fetch(ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('q')).toBe('title:"QA" OR title:"Quality"');
    expect(seen[0]!.getAll('regions')).toEqual(['global']);
    expect(seen[0]!.getAll('countries')).toEqual(['br']);
    expect(seen[0]!.get('work_mode')).toBe('remote');
    expect(seen[0]!.get('posted_within_days')).toBe('15');
    expect(raws).toHaveLength(fixture('freehire.json').data.length);
  });

  it('drops postings whose apply link is a Telegram post', async () => {
    const [first, ...rest] = fixture('freehire.json').data;
    const telegram = { ...first, public_slug: 'tg-1', url: 'https://t.me/some_channel/580' };
    server.use(http.get(SEARCH, () => HttpResponse.json({ data: [telegram, first, ...rest] })));
    const raws = await freehire.fetch(context().ctx);

    expect(raws).toHaveLength(fixture('freehire.json').data.length);
    expect(raws.some((raw) => raw.public_slug === 'tg-1')).toBe(false);
  });

  it('splits more than five include terms into several queries and pages until the total', async () => {
    const queries: string[] = [];
    const offsets: string[] = [];
    server.use(
      http.get(SEARCH, ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push(params.get('q')!);
        offsets.push(params.get('offset')!);
        return HttpResponse.json({ data: fixture('freehire.json').data.slice(0, 1), meta: { total: 150 } });
      }),
    );
    const { ctx } = context([], {
      config: parseConfig('search: { include: ["a", "b", "c", "d", "e", "f"] }\neligibility: { accept_regions: [latam] }'),
    });
    await freehire.fetch(ctx);

    expect(queries.map((q) => q.split(' OR ').length)).toEqual([5, 5, 1, 1]);
    expect(offsets).toEqual(['0', '100', '0', '100']);
  });

  it('fails the source when the response format changes', async () => {
    server.use(http.get(SEARCH, () => HttpResponse.json({ jobs: [] })));
    await expect(freehire.fetch(context().ctx)).rejects.toBeInstanceOf(SchemaError);
  });

  it('normalizes a posting open to Brazil, dropping the tracking parameters', () => {
    const job = freehire.normalize(fixture('freehire.json').data[0]);
    expect(job.id).toMatch(/^freehire:media-hero:[0-9a-f]{8}$/);
    expect(job.atsApply).toBe(false);
    expect(job.workModel).toBe('remote');
    expect(job.restrictions).toEqual(['BR']);
    expect(job.applyUrl).not.toContain('utm_');
    expect(checkEligibility(job, ['worldwide', 'latam', 'brazil'], []).ok).toBe(true);
  });

  it('rejects a posting open to a single other country even when the region is LATAM', () => {
    const job = freehire.normalize(fixture('freehire.json').data[2]);
    expect(job.restrictions).toEqual(['CR']);
    expect(checkEligibility(job, ['worldwide', 'latam', 'brazil'], []).ok).toBe(false);
  });

  it('uses the location text, not the region facet, when there are no countries', () => {
    const latam = freehire.normalize(fixture('freehire.json').data[3]);
    expect(latam.restrictions).toEqual([]);
    expect(checkEligibility(latam, ['latam'], []).ok).toBe(true);

    const abroad = freehire.normalize({ ...fixture('freehire.json').data[3], location: 'India', regions: ['global'] });
    expect(checkEligibility(abroad, ['worldwide', 'latam', 'brazil'], []).ok).toBe(false);

    const unlocated = freehire.normalize({ ...fixture('freehire.json').data[3], location: null, regions: ['global'] });
    expect(unlocated.restrictions).toEqual(['Worldwide']);
  });

  it('keeps the stated compensation and level', () => {
    const job = freehire.normalize(fixture('freehire.json').data[5]);
    expect(job.compensation).toBe('USD 5,000 – 6,000 / month');
    expect(job.currency).toBe('USD');
  });
});

describe('getonbrd', () => {
  const CATEGORY = 'https://www.getonbrd.com/api/v0/categories/sysadmin-devops-qa/jobs';

  it('reads the category and drops postings that are remote only for residents of an unnamed country', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(CATEGORY, ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(fixture('getonbrd.json'));
      }),
    );
    const raws = await getonbrd.fetch(context().ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('expand[]')).toBe('company');
    expect(raws.map((raw) => raw.attributes.remote_modality)).toEqual(['hybrid', 'fully_remote']);
  });

  it('fails the source when the format changes', async () => {
    server.use(http.get(CATEGORY, () => HttpResponse.json({ jobs: [] })));
    await expect(getonbrd.fetch(context().ctx)).rejects.toBeInstanceOf(SchemaError);
  });

  it('normalizes a fully remote senior posting', () => {
    const job = getonbrd.normalize(fixture('getonbrd.json').data[2]);
    expect(job.id).toMatch(/^getonbrd:[a-z0-9-]+:[0-9a-f]{8}$/);
    expect(job.workModel).toBe('remote');
    expect(job.seniority).toEqual(['senior']);
    expect(job.restrictions).toEqual([]);
    expect(job.applyUrl).toContain('https://www.getonbrd.com/jobs/');
    expect(job.postedAt).toMatch(/^2026-/);
    expect(checkEligibility(job, ['worldwide', 'latam', 'brazil'], []).ok).toBe(true);
  });

  it('keeps the country of a hybrid posting, which only passes when its region is accepted', () => {
    const job = getonbrd.normalize(fixture('getonbrd.json').data[0]);
    expect(job.workModel).toBe('hybrid');
    expect(job.restrictions).toEqual(['Chile']);
    expect(checkEligibility(job, ['worldwide', 'brazil'], []).ok).toBe(false);
  });
});

describe('linkedin', () => {
  const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
  const DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/:id';
  const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  const linkedinConfig = parseConfig(`
search:
  include: ["QA", "Quality"]
  seniority: [senior]
  exclude_companies: ["BairesDev"]
eligibility:
  accept_regions: [worldwide, brazil]
sources:
  linkedin: { enabled: true, delay_ms: 0, locations: ["Brazil"], queries: ["QA"] }
`);

  function mock(detail: (id: string) => Response | undefined = () => undefined) {
    const searches: URLSearchParams[] = [];
    const details: string[] = [];
    server.use(
      http.get(SEARCH, ({ request }) => {
        searches.push(new URL(request.url).searchParams);
        return new HttpResponse(text('linkedin-search.html'));
      }),
      http.get(DETAIL, ({ params }) => {
        details.push(params.id as string);
        return detail(params.id as string) ?? new HttpResponse(text('linkedin-detail.html'));
      }),
    );
    return { searches, details };
  }

  function linkedinContext(overrides: Partial<FetchContext> = {}) {
    const filter = createFilter(linkedinConfig);
    return context([], { config: linkedinConfig, worthDetails: (candidate) => filter.worthDetails(candidate), ...overrides });
  }

  it('asks for remote Mid-Senior jobs of the last few days and reads the detail only of cards that pass the cheap filters', async () => {
    const { searches, details } = mock();
    const raws = await linkedin.fetch(linkedinContext().ctx);

    expect(searches).toHaveLength(1);
    expect(Object.fromEntries(searches[0]!)).toMatchObject({ keywords: 'QA', location: 'Brazil', f_WT: '2', f_E: '4', f_TPR: 'r172800' });
    // BairesDev is an excluded company and "Product Manager" matches no search term
    expect(details).toEqual(['4400000001', '4400000004']);
    expect(raws[0]).toMatchObject({
      id: '4400000001',
      title: 'QA Engineer & Automation',
      company: 'Acme Software',
      location: 'São Paulo, São Paulo, Brazil',
      date: '2026-10-14',
      level: 'Mid-Senior level',
    });
    expect(raws[0]!.description).toContain('fully remote, open to people living in Brazil');
    expect(raws[0]!.description).toContain('• Build and maintain Playwright suites');
  });

  it('skips the detail of a job whose link already has an issue', async () => {
    const { details } = mock();
    await linkedin.fetch(linkedinContext({ isKnownUrl: (url) => url === 'https://www.linkedin.com/jobs/view/4400000004' }).ctx);
    expect(details).toEqual(['4400000001']);
  });

  it('keeps what it read when LinkedIn answers 429', async () => {
    mock((id) => (id === '4400000004' ? new HttpResponse(null, { status: 429 }) : undefined));
    const { ctx, warnings } = linkedinContext();
    const raws = await linkedin.fetch(ctx);

    expect(raws.map((raw) => raw.id)).toEqual(['4400000001']);
    expect(warnings.some((warning) => warning.includes('rate limited'))).toBe(true);
  });

  it('fails the source when the cards change shape', async () => {
    server.use(http.get(SEARCH, () => new HttpResponse('<li data-entity-urn="urn:li:jobPosting:4400000009"></li>')));
    await expect(linkedin.fetch(linkedinContext().ctx)).rejects.toBeInstanceOf(SchemaError);
  });

  it('normalizes a remote Mid-Senior posting in Brazil', async () => {
    mock();
    const [raw] = await linkedin.fetch(linkedinContext().ctx);
    const job = linkedin.normalize(raw!);

    expect(job.id).toMatch(/^linkedin:acme-software:[0-9a-f]{8}$/);
    expect(job.workModel).toBe('remote');
    expect(job.seniority).toEqual(['senior']);
    expect(job.applyUrl).toBe('https://www.linkedin.com/jobs/view/4400000001');
    expect(job.postedAt).toBe('2026-10-14T00:00:00.000Z');
    expect(createFilter(linkedinConfig).check(job, new Date('2026-10-16T12:00:00Z'))).toEqual({ ok: true });
  });

  it('reads the level of the detail page and counts an unknown level as senior', () => {
    const base = { id: '1', title: 'QA Engineer', company: 'Acme', location: 'Brazil', date: '2026-10-14', description: 'Remote role.' };
    expect(linkedin.normalize({ ...base, level: 'Entry level' }).seniority).toEqual(['junior']);
    expect(linkedin.normalize({ ...base, level: 'Director' }).seniority).toEqual(['lead']);
    expect(linkedin.normalize({ ...base, level: 'Not Applicable' }).seniority).toEqual(['senior']);
    expect(linkedin.normalize(base).seniority).toEqual(['senior']);
  });

  it('opens a posting located abroad only when a sentence about remote work names an accepted region', () => {
    const base = { id: '2', title: 'Senior QA Analyst', company: 'Globex', location: 'Toronto, Ontario, Canada', date: '2026-10-14', level: 'Mid-Senior level' };
    const check = (description: string) =>
      createFilter(linkedinConfig).check(linkedin.normalize({ ...base, description }), new Date('2026-10-16T12:00:00Z')).ok;

    expect(check('This role is fully remote and open to candidates in Latin America.')).toBe(true);
    expect(check('Our customers worldwide rely on us. Join the Toronto office, three days a week.')).toBe(false);
    expect(check('Remote role. You must reside in Canada and be authorized to work in Canada. Brazil is not an option.')).toBe(false);
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
