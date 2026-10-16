import { describe, expect, it } from 'vitest';
import type { AnySourceAdapter } from '../src/adapters/types.js';
import { metrics } from '../src/commands/metrics.js';
import { revalidate } from '../src/commands/revalidate.js';
import { parseConfig } from '../src/config/load.js';
import type { Job } from '../src/domain/job.js';
import { analyzeIssue, daysBetween, desiredFields, type IssueFacts } from '../src/metrics/analyze.js';
import { METRICS_MARKER, renderReport } from '../src/metrics/report.js';
import { fakeContext } from './fake-github.js';
import { job } from './helpers.js';

const TODAY = new Date('2026-10-15T12:00:00Z');

function facts(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return { number: 1, title: '[Acme] QA', state: 'open', labels: [], statusEvents: [], imported: false, fields: {}, ...overrides };
}

const event = (status: string, at: string) => ({ status: status as never, at });

describe('analyzeIssue', () => {
  it('derives the calculated fields from the timeline', () => {
    const result = analyzeIssue(
      facts({
        labels: ['status:rejected', 'found:linkedin'],
        statusEvents: [
          event('new', '2026-08-30T10:00:00Z'),
          event('applied', '2026-09-01T10:00:00Z'),
          event('screening', '2026-09-10T10:00:00Z'),
          event('tech-interview', '2026-09-20T10:00:00Z'),
          event('rejected', '2026-09-25T10:00:00Z'),
        ],
      }),
    );
    expect(result).toMatchObject({
      status: 'rejected',
      appliedOn: '2026-09-01',
      furthestStage: 'tech-interview',
      responseDate: '2026-09-10',
      daysToResponse: 9,
      processDuration: 24,
      found: 'linkedin',
    });
  });

  it('does not count withdrawing as a response', () => {
    const result = analyzeIssue(
      facts({
        labels: ['status:withdrawn'],
        statusEvents: [event('applied', '2026-09-01T10:00:00Z'), event('withdrawn', '2026-09-05T10:00:00Z')],
      }),
    );
    expect(result.responseDate).toBeUndefined();
    expect(result.daysToResponse).toBeUndefined();
    expect(result.processDuration).toBe(4);
  });

  it('counts a rejection as the response', () => {
    const result = analyzeIssue(
      facts({ labels: ['status:rejected'], statusEvents: [event('applied', '2026-09-01T00:00:00Z'), event('rejected', '2026-09-03T00:00:00Z')] }),
    );
    expect(result).toMatchObject({ responseDate: '2026-09-03', daysToResponse: 2, furthestStage: 'applied' });
  });

  it('prefers an explicit Project field over the timeline', () => {
    const result = analyzeIssue(
      facts({
        labels: ['status:screening'],
        statusEvents: [event('applied', '2026-09-05T00:00:00Z'), event('screening', '2026-09-09T00:00:00Z')],
        fields: { 'Applied on': '2026-09-01', 'Response date': '2026-09-02' },
      }),
    );
    expect(result).toMatchObject({ appliedOn: '2026-09-01', responseDate: '2026-09-02', daysToResponse: 1 });
  });

  it('ignores the timeline of imported issues, whose labels were all added on the import day', () => {
    const result = analyzeIssue(
      facts({
        imported: true,
        labels: ['status:rejected'],
        statusEvents: [event('rejected', '2026-10-14T10:00:00Z')],
        fields: { 'Applied on': '2026-08-01', 'Response date': '2026-08-10', 'Furthest stage': 'HR interview', 'Days to response': 9 },
      }),
    );
    expect(result).toMatchObject({
      appliedOn: '2026-08-01',
      responseDate: '2026-08-10',
      daysToResponse: 9,
      furthestStage: 'hr-interview',
      processDuration: undefined,
    });
  });

  it('never moves the furthest stage backwards', () => {
    const result = analyzeIssue(facts({ labels: ['status:screening'], fields: { 'Furthest stage': 'Tech interview', 'Applied on': '2026-09-01' } }));
    expect(result.furthestStage).toBe('tech-interview');
  });

  it('only asks for fields it can compute, and never for "New"', () => {
    expect(desiredFields(analyzeIssue(facts({ labels: ['status:new'] })))).toEqual([]);
    const fields = desiredFields(
      analyzeIssue(facts({ labels: ['status:screening'], statusEvents: [event('applied', '2026-09-01T00:00:00Z'), event('screening', '2026-09-04T00:00:00Z')] })),
    );
    expect(fields.map((entry) => entry.field)).toEqual(['Furthest stage', 'Response date', 'Days to response']);
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-01', '2026-10-01T05:00:00Z')).toBe(30);
  });
});

describe('renderReport', () => {
  const applied = (number: number, overrides: Record<string, unknown> = {}) =>
    analyzeIssue(
      facts({
        number,
        title: `[Co${number}] QA`,
        labels: ['status:applied', 'found:linkedin', 'scope:brazil', 'contract:pj'],
        fields: { 'Applied on': '2026-08-01', ...overrides },
      }),
    );

  it('computes the overview, funnel and stalled applications', () => {
    const report = renderReport(
      [
        applied(1),
        applied(2, { 'Response date': '2026-08-11', 'Furthest stage': 'Tech interview' }),
        analyzeIssue(facts({ number: 3, title: '[Co3] QA', labels: ['status:hired'], fields: { 'Applied on': '2026-08-02', 'Response date': '2026-08-06', 'Furthest stage': 'Hired' } })),
        analyzeIssue(facts({ number: 4, title: '[Co4] QA', labels: ['status:new', 'found:himalayas'] })),
      ],
      TODAY,
    );
    expect(report).toContain(METRICS_MARKER);
    expect(report).toContain('| Applications | 3 |');
    expect(report).toContain('| In progress | 2 |');
    expect(report).toContain('| Response rate | 67% (2 of 3) |');
    expect(report).toContain('| Hired | 33% (1 of 3) |');
    expect(report).toContain('mean 7 days · median 7 days');
    expect(report).toContain('bar [3, 2, 2, 2, 1, 1, 1]');
    expect(report).toContain('| linkedin | 2 | 0 | 2 | 1 | 50% |');
    expect(report).toContain('| himalayas | 1 | 0 | 0 | 0 | — |');
    expect(report).toContain('- #1 [Co1] QA (75 days)');
    expect(report).not.toContain('#2 [Co2] QA (');
  });

  it('counts jobs closed without applying on their own, not as "New"', () => {
    const dropped = analyzeIssue(facts({ number: 5, title: '[Co5] QA', state: 'closed', labels: ['status:new', 'found:himalayas'] }));
    const gone = analyzeIssue(facts({ number: 6, title: '[Co6] QA', state: 'closed', labels: ['status:new', 'found:himalayas', 'closed-at-source'] }));
    const waiting = analyzeIssue(facts({ number: 7, title: '[Co7] QA', labels: ['status:new', 'found:himalayas'] }));
    const report = renderReport([dropped, gone, waiting, applied(1)], TODAY);
    expect(report).toContain('| Waiting for a decision | 1 |');
    expect(report).toContain('| Discarded without applying | 2 (1 gone from the source) |');
    expect(report).toContain('| New | 1 |');
    expect(report).toContain('| Discarded | 2 |');
    expect(report).toContain('| himalayas | 3 | 2 | 0 | 0 | — |');
  });

  it('copes with no data', () => {
    const report = renderReport([], TODAY);
    expect(report).toContain('| Applications | 0 |');
    expect(report).toContain('| Response rate | — (0 of 0) |');
    expect(report).not.toContain('```mermaid');
  });
});

describe('metrics command', () => {
  const issue = (number: number, labels: string[], body: string, extra: Record<string, unknown> = {}) => ({
    number,
    node_id: `I_${number}`,
    title: `[Co${number}] QA`,
    state: 'open',
    body,
    html_url: `https://github.com/me/jobs/issues/${number}`,
    labels: labels.map((name) => ({ name })),
    ...extra,
  });
  const labeled = (name: string, at: string) => ({ event: 'labeled', created_at: at, label: { name } });
  const item = (number: number, values: Record<string, unknown>) => ({
    id: `ITEM_${number}`,
    content: { number },
    fieldValues: {
      nodes: Object.entries(values).map(([name, value]) =>
        typeof value === 'number'
          ? { number: value, field: { name } }
          : name.includes('on') || name.includes('date')
            ? { date: value, field: { name } }
            : { name: value, field: { name } },
      ),
    },
  });

  function scenario() {
    return fakeContext({
      existingIssues: [
        issue(1, ['status:screening'], '<!-- job-radar:id=greenhouse:co1:aaaaaaaa -->'),
        issue(2, ['status:applied'], '<!-- job-radar:id=import:co2:bbbbbbbb -->'),
        issue(3, ['status:new'], '<!-- job-radar:id=himalayas:co3:cccccccc -->'),
      ],
      events: {
        1: [labeled('status:new', '2026-09-01T00:00:00Z'), labeled('status:applied', '2026-09-02T09:00:00Z'), labeled('status:screening', '2026-09-08T09:00:00Z')],
      },
      projectItems: [
        item(1, { 'Applied on': '2026-09-02' }),
        item(2, { 'Applied on': '2026-08-01' }),
        item(3, {}),
      ],
    });
  }

  it('writes the calculated fields, reads timelines only where useful, and creates and pins the Metrics issue', async () => {
    const { ctx, issues, graphqlCalls, fieldWrites } = scenario();
    const result = await metrics(ctx, { now: TODAY });

    expect(result).toMatchObject({ issues: 3, applications: 2, fieldsWritten: 4 });
    // only issue 1 has a real history: #2 is imported and #3 is still New
    const timelineCalls = (ctx.octokit.paginate as any).mock.calls.filter((call: any[]) => call[0] === issues.listEvents);
    expect(timelineCalls.map((call: any[]) => call[1].issue_number)).toEqual([1]);

    expect(fieldWrites()).toEqual(
      expect.arrayContaining([
        ['F_furthest', { singleSelectOptionId: 'O_Screening' }],
        ['F_response', { date: '2026-09-08' }],
        ['F_days', { number: 6 }],
        ['F_furthest', { singleSelectOptionId: 'O_Applied' }], // #2 reached "Applied"
      ]),
    );
    expect(issues.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Metrics', body: expect.stringContaining(METRICS_MARKER) }));
    expect(graphqlCalls.some((call) => call.query.includes('pinIssue'))).toBe(true);
  });

  it('leaves unchanged fields alone and updates the existing Metrics issue in place', async () => {
    const first = scenario();
    const { report } = await metrics(first.ctx, { now: TODAY });

    const second = fakeContext({
      existingIssues: [
        issue(9, [], report, { title: 'Metrics' }),
        issue(1, ['status:screening'], '<!-- job-radar:id=greenhouse:co1:aaaaaaaa -->'),
      ],
      events: { 1: [labeled('status:applied', '2026-09-02T09:00:00Z'), labeled('status:screening', '2026-09-08T09:00:00Z')] },
      projectItems: [
        item(1, { 'Applied on': '2026-09-02', 'Furthest stage': 'Screening', 'Response date': '2026-09-08', 'Days to response': 6 }),
      ],
    });
    const result = await metrics(second.ctx, { now: TODAY });

    expect(result.fieldsWritten).toBe(0);
    expect(second.issues.create).not.toHaveBeenCalled();
    expect(second.issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 9, state: 'open' }));
  });

  it('writes nothing in a dry run', async () => {
    const { ctx, issues, fieldWrites, log } = scenario();
    const result = await metrics(ctx, { dryRun: true, now: TODAY });
    expect(result.fieldsWritten).toBeGreaterThan(0);
    expect(fieldWrites()).toEqual([]);
    expect(issues.create).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Would update the Metrics issue'));
  });
});

describe('revalidate', () => {
  const CONFIG = parseConfig('sources:\n  greenhouse: { enabled: true }\n  himalayas: { enabled: true }');
  const issue = (number: number, labels: string[], body: string) => ({
    number,
    title: `[Acme] Role ${number}`,
    body,
    labels: labels.map((name) => ({ name })),
  });
  const marker = (id: string) => `**Apply:** https://x.test\n<!-- job-radar:id=${id} -->`;

  const board = (jobs: Job[] | Error): AnySourceAdapter => ({
    id: 'greenhouse',
    mode: 'company',
    fetch: async () => {
      if (jobs instanceof Error) throw jobs;
      return jobs;
    },
    normalize: (raw: Job) => raw,
  });
  const search: AnySourceAdapter = { id: 'himalayas', mode: 'search', fetch: async () => [], normalize: (raw: any) => raw };
  const companies = { inhire: [], greenhouse: ['acme'], lever: [], ashby: [] };

  function setup(issues: ReturnType<typeof issue>[]) {
    const fake = fakeContext({ existingIssues: issues });
    fake.ctx.config = CONFIG;
    return fake;
  }

  it('closes "New" jobs that left the board and keeps the ones still listed', async () => {
    const { ctx, issues } = setup([
      issue(1, ['status:new'], marker('greenhouse:acme:aaaaaaaa')),
      issue(2, ['status:new'], marker('greenhouse:acme:bbbbbbbb')),
    ]);
    const result = await revalidate(ctx, {
      companies,
      adapters: { greenhouse: board([job({ id: 'greenhouse:acme:bbbbbbbb' })]), himalayas: search },
    });

    expect(result).toEqual({ checked: 2, closed: 1 });
    expect(issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 1, labels: ['closed-at-source'] }));
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 1 }));
    expect(issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 1, state: 'closed', state_reason: 'not_planned' }));
    expect(issues.update).not.toHaveBeenCalledWith(expect.objectContaining({ issue_number: 2 }));
  });

  it('leaves alone anything past "New", imports, manual entries and search sources', async () => {
    const { ctx, issues } = setup([
      issue(1, ['status:new', 'status:applied'], marker('greenhouse:acme:aaaaaaaa')),
      issue(2, ['status:new'], marker('import:acme:aaaaaaaa')),
      issue(3, ['status:new'], marker('manual:acme:aaaaaaaa')),
      issue(4, ['status:new'], marker('himalayas:acme:aaaaaaaa')),
      issue(5, ['status:new', 'closed-at-source'], marker('greenhouse:acme:cccccccc')),
    ]);
    const result = await revalidate(ctx, { companies, adapters: { greenhouse: board([job({ id: 'greenhouse:acme:zzzzzzzz' })]), himalayas: search } });
    expect(result).toEqual({ checked: 0, closed: 0 });
    expect(issues.update).not.toHaveBeenCalled();
  });

  it('closes nothing when the board fails or comes back empty', async () => {
    const issues = [issue(1, ['status:new'], marker('greenhouse:acme:aaaaaaaa'))];

    const failing = setup(issues);
    await revalidate(failing.ctx, { companies, adapters: { greenhouse: board(new Error('HTTP 500')), himalayas: search } });
    expect(failing.issues.update).not.toHaveBeenCalled();
    expect(failing.log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be checked'));

    const empty = setup(issues);
    await revalidate(empty.ctx, { companies, adapters: { greenhouse: board([]), himalayas: search } });
    expect(empty.issues.update).not.toHaveBeenCalled();
    expect(empty.log.warn).toHaveBeenCalledWith(expect.stringContaining('outage'));
  });

  it('only reports in a dry run', async () => {
    const { ctx, issues } = setup([issue(1, ['status:new'], marker('greenhouse:acme:aaaaaaaa'))]);
    const result = await revalidate(ctx, { dryRun: true, companies, adapters: { greenhouse: board([job({ id: 'greenhouse:acme:other' })]), himalayas: search } });
    expect(result.closed).toBe(1);
    expect(issues.update).not.toHaveBeenCalled();
    expect(issues.addLabels).not.toHaveBeenCalled();
  });
});
