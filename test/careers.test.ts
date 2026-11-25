import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { careers } from '../src/adapters/careers.js';
import type { FetchContext } from '../src/adapters/types.js';
import { createRobotsReader, parseRobots } from '../src/careers/robots.js';
import { jsonLdJobPostings } from '../src/careers/jsonld.js';
import { parseSitemap, titleFromUrl } from '../src/careers/sitemap.js';
import { parseConfig } from '../src/config/load.js';
import { createHttpClient } from '../src/util/http.js';

const text = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = parseConfig('search:\n  include: ["QA"]\n');

function context(url: string, overrides: Partial<FetchContext> = {}) {
  const warnings: string[] = [];
  const ctx: FetchContext = {
    http: createHttpClient({ backoffMs: 1, retries: 0 }),
    config,
    companies: [{ slug: url, url }],
    now: new Date('2026-11-25T12:00:00Z'),
    worthDetails: () => true,
    warn: (message) => warnings.push(message),
    ...overrides,
  };
  return { ctx, warnings };
}

const html = (body: string) => HttpResponse.text(body, { headers: { 'content-type': 'text/html' } });
const open = (host: string) => http.get(`https://${host}/robots.txt`, () => HttpResponse.text('User-agent: *\nAllow: /\n'));

describe('robots.txt', () => {
  const robots = parseRobots(
    ['User-agent: *', 'Disallow: /app/', 'Disallow: /*.pdf$', 'Allow: /app/public/', '', 'User-agent: aihitdata', 'Disallow: /', '', 'Sitemap: https://x.test/sitemap.xml'].join('\n'),
  );

  it('follows the most specific rule, wildcards and the end anchor', () => {
    expect(robots.allows('https://x.test/jobs/1')).toBe(true);
    expect(robots.allows('https://x.test/app/admin')).toBe(false);
    expect(robots.allows('https://x.test/app/public/page')).toBe(true);
    expect(robots.allows('https://x.test/files/cv.pdf')).toBe(false);
    expect(robots.allows('https://x.test/files/cv.pdf.html')).toBe(true);
    expect(robots.sitemaps).toEqual(['https://x.test/sitemap.xml']);
  });

  it('uses the group that names job-radar over the wildcard group', () => {
    const named = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: job-radar\nDisallow: /careers\n');
    expect(named.allows('https://x.test/careers/qa')).toBe(false);
    expect(named.allows('https://x.test/about')).toBe(true);
  });

  it('allows everything when robots.txt is missing and nothing when it cannot be read', async () => {
    server.use(
      http.get('https://missing.test/robots.txt', () => new HttpResponse(null, { status: 404 })),
      http.get('https://broken.test/robots.txt', () => new HttpResponse(null, { status: 503 })),
    );
    const read = createRobotsReader(createHttpClient({ backoffMs: 1, retries: 0 }));
    expect((await read('https://missing.test/jobs')).allows('https://missing.test/jobs')).toBe(true);
    expect((await read('https://broken.test/jobs')).allows('https://broken.test/jobs')).toBe(false);
  });
});

describe('JobPosting JSON-LD', () => {
  it('reads a plain block, a @graph and an ItemList, and skips blocks that are not JSON', () => {
    const { postings, invalid } = jsonLdJobPostings(text('careers-graph.synthetic.html'));
    expect(postings.map((posting) => posting.title)).toEqual(['Senior QA Engineer', 'QA Analyst', 'Old Role']);
    expect(invalid).toBe(0);
    expect(jsonLdJobPostings(text('careers-jsonld.html')).postings).toHaveLength(1);
    expect(jsonLdJobPostings(text('careers-nodata.synthetic.html')).postings).toEqual([]);
  });

  it('counts a JobPosting without a title as invalid', () => {
    const page = '<script type="application/ld+json">{"@type":"JobPosting","description":"x"}</script>';
    expect(jsonLdJobPostings(page)).toEqual({ postings: [], invalid: 1 });
  });
});

describe('sitemaps', () => {
  it('reads urlset and sitemapindex locations', () => {
    expect(parseSitemap(text('careers-sitemap.xml')).urls).toContain('https://career.teamtailor.com/jobs/8786914-integration-success-specialist');
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://x.test/jobs.xml</loc></sitemap></sitemapindex>')).toEqual({ urls: [], sitemaps: ['https://x.test/jobs.xml'] });
  });

  it('turns a posting URL into words', () => {
    expect(titleFromUrl('https://x.test/jobs/8786914-integration-success-specialist')).toBe('integration success specialist');
    expect(titleFromUrl('https://x.test/vagas/qa-engineer.html?x=1')).toBe('qa engineer');
  });
});

describe('careers adapter', () => {
  it('delegates a link to a supported ATS to its adapter', async () => {
    server.use(
      http.get('https://boards-api.greenhouse.io/v1/boards/acme/jobs', () =>
        HttpResponse.json({ jobs: [{ id: 1, title: 'QA Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote' }, content: '' }] }),
      ),
    );
    const { ctx } = context('https://boards.greenhouse.io/acme');
    const [raw] = await careers.fetch(ctx);

    expect(raw!.method).toBe('ats');
    expect(careers.normalize(raw!)).toMatchObject({ source: 'greenhouse', foundBy: 'ats', title: 'QA Engineer' });
  });

  it('delegates a page that embeds an ATS board, including the Greenhouse embed form', async () => {
    server.use(
      open('acme.test'),
      http.get('https://acme.test/careers', () => html(text('careers-iframe.synthetic.html'))),
      http.get('https://boards-api.greenhouse.io/v1/boards/acme/jobs', () =>
        HttpResponse.json({ jobs: [{ id: 7, title: 'QA Lead', absolute_url: 'https://boards.greenhouse.io/acme/jobs/7', content: '' }] }),
      ),
    );
    const [raw] = await careers.fetch(context('https://acme.test/careers').ctx);

    expect(raw!.method).toBe('ats');
    expect(careers.normalize(raw!).applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/7');
  });

  it('reads JobPosting JSON-LD from the page: @graph, ItemList, expired postings dropped', async () => {
    server.use(open('careers.acme.test'), http.get('https://careers.acme.test/', () => html(text('careers-graph.synthetic.html'))));
    const { ctx, warnings } = context('https://careers.acme.test/');
    const raws = await careers.fetch(ctx);
    const jobs = raws.map((raw) => careers.normalize(raw));

    expect(raws.every((raw) => raw.method === 'jsonld')).toBe(true);
    expect(jobs.map((job) => job.title)).toEqual(['Senior QA Engineer', 'QA Analyst']);
    expect(jobs[0]).toMatchObject({
      source: 'careers',
      foundBy: 'jsonld',
      company: 'Acme',
      workModel: 'remote',
      restrictions: ['Brazil'],
      contracts: ['FULL_TIME'],
      compensation: 'USD 4,000 – 5,000 / month',
      applyUrl: 'https://careers.acme.test/jobs/qa-1',
      postedAt: '2026-11-20T00:00:00.000Z',
    });
    expect(jobs[0]!.description).toBe('Own test automation.');
    expect(jobs[1]!.locations).toEqual(['São Paulo, BR']);
    expect(warnings).toEqual([]);
  });

  const acmeSitemap = () => text('careers-sitemap.xml').replaceAll('career.teamtailor.com', 'careers.acme.test');

  it('reads the sitemap listed in robots.txt, only for posting URLs that could pass the filters', async () => {
    const read: string[] = [];
    server.use(
      http.get('https://careers.acme.test/robots.txt', () => HttpResponse.text('User-agent: *\nDisallow: /app/\n\nSitemap: https://careers.acme.test/sitemap.xml\n')),
      http.get('https://careers.acme.test/', () => html(text('careers-nodata.synthetic.html'))),
      http.get('https://careers.acme.test/sitemap.xml', () => HttpResponse.text(acmeSitemap())),
      http.get('https://careers.acme.test/jobs/:slug', ({ params }) => (read.push(String(params.slug)), html(text('careers-jsonld.html')))),
    );
    const { ctx } = context('https://careers.acme.test/', { worthDetails: (candidate) => /integration/.test(candidate.title) });
    const raws = await careers.fetch(ctx);

    expect(read).toEqual(['8786914-integration-success-specialist']);
    expect(raws).toHaveLength(1);
    expect(raws[0]!.method).toBe('sitemap');
    expect(careers.normalize(raws[0]!)).toMatchObject({ foundBy: 'sitemap', title: 'Integration Success Specialist', company: 'Teamtailor' });
  });

  it('accepts a sitemap as the entry URL and skips URLs that already have an issue', async () => {
    server.use(open('careers.acme.test'), http.get('https://careers.acme.test/sitemap.xml', () => HttpResponse.text(acmeSitemap())));
    const { ctx } = context('https://careers.acme.test/sitemap.xml', {
      isKnownUrl: (url) => /8786914/.test(url),
      worthDetails: (candidate) => /integration/.test(candidate.title),
    });
    expect(await careers.fetch(ctx)).toEqual([]);
  });

  it('caps the pages read per company and says so', async () => {
    server.use(
      open('careers.acme.test'),
      http.get('https://careers.acme.test/sitemap.xml', () => HttpResponse.text(acmeSitemap())),
      http.get('https://careers.acme.test/jobs/:slug', () => html(text('careers-jsonld.html'))),
    );
    const { ctx, warnings } = context('https://careers.acme.test/sitemap.xml', {
      config: parseConfig('sources:\n  careers: { enabled: true, max_urls: 1 }\n'),
      worthDetails: (candidate) => /success|executive/.test(candidate.title),
    });
    const raws = await careers.fetch(ctx);

    expect(raws).toHaveLength(1);
    expect(warnings.some((warning) => /read the first 1/.test(warning))).toBe(true);
  });

  it('fails instead of reporting an empty board when the page has no job data', async () => {
    server.use(open('acme.test'), http.get('https://acme.test/careers', () => html(text('careers-nodata.synthetic.html'))));
    await expect(careers.fetch(context('https://acme.test/careers').ctx)).rejects.toThrow(/no job data found/);
  });

  it('fails when robots.txt disallows the page, without requesting it', async () => {
    server.use(http.get('https://acme.test/robots.txt', () => HttpResponse.text('User-agent: *\nDisallow: /careers\n')));
    await expect(careers.fetch(context('https://acme.test/careers').ctx)).rejects.toThrow(/robots\.txt disallows/);
  });

  it('fails for an entry with no URL', async () => {
    const { ctx } = context('https://acme.test/careers', { companies: [{ slug: 'acme' }] });
    await expect(careers.fetch(ctx)).rejects.toThrow(/need the page URL/);
  });

  it('proves a missing job only for results read from the page or an ATS', () => {
    const job = { method: 'jsonld' as const, job: {} as never };
    expect(careers.provesAbsence!([job])).toBe(true);
    expect(careers.provesAbsence!([{ ...job, method: 'ats' }])).toBe(true);
    expect(careers.provesAbsence!([{ ...job, method: 'sitemap' }])).toBe(false);
    expect(careers.provesAbsence!([])).toBe(false);
  });
});
