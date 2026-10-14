import { describe, expect, it } from 'vitest';
import { intake } from '../src/commands/intake.js';
import { setup } from '../src/commands/setup.js';
import { syncStatus } from '../src/commands/sync-status.js';
import { BASE_FIELDS, fakeContext } from './fake-github.js';

describe('setup', () => {
  it('creates the labels and the missing Project fields, and aligns Status options', async () => {
    const { ctx, issues, graphqlCalls } = fakeContext({ fields: BASE_FIELDS });
    await setup(ctx);

    expect(issues.createLabel).toHaveBeenCalledWith(expect.objectContaining({ owner: 'me', repo: 'jobs', name: 'status:new' }));
    expect(issues.createLabel).toHaveBeenCalledWith(expect.objectContaining({ name: 'scope:international' }));

    const created = graphqlCalls
      .filter((call) => call.query.includes('createProjectV2Field'))
      .map((call) => call.variables.input.name);
    expect(created).toEqual([
      'Applied on',
      'Target salary',
      'Offered salary',
      'Currency',
      'Contact',
      'Furthest stage',
      'Response date',
      'Days to response',
      'Process duration',
    ]);

    const update = graphqlCalls.find((call) => call.query.includes('updateProjectV2Field'));
    expect(update?.variables.input.fieldId).toBe('F_status');
    expect(update?.variables.input.singleSelectOptions.map((o: { name: string }) => o.name)).toEqual([
      'New', 'Applied', 'Screening', 'HR interview', 'Tech interview', 'Take-home', 'Offer', 'Hired', 'Rejected', 'Withdrawn',
    ]);
  });

  it('is idempotent: nothing is created or replaced when everything is in place', async () => {
    const { ctx, issues, graphqlCalls } = fakeContext();
    issues.createLabel.mockRejectedValue({ status: 422 });
    await setup(ctx);

    expect(issues.updateLabel).toHaveBeenCalled();
    expect(graphqlCalls.some((call) => call.query.includes('mutation'))).toBe(false);
  });

  it('refuses to touch a field that exists with another type', async () => {
    const { ctx } = fakeContext({
      fields: [...BASE_FIELDS, { id: 'F_x', name: 'Applied on', dataType: 'TEXT' }],
    });
    await expect(setup(ctx)).rejects.toThrowError(/Applied on.*TEXT.*DATE/);
  });
});

describe('syncStatus', () => {
  const event = (label: string) => ({
    action: 'labeled',
    label: { name: label },
    issue: { number: 7, node_id: 'I_7' },
  });

  it('keeps one status label, mirrors it to the Project and fills Applied on', async () => {
    const { ctx, issues, fieldWrites } = fakeContext({ labelsOnIssue: ['status:new', 'status:applied', 'found:linkedin'] });
    await syncStatus(ctx, event('status:applied'), new Date('2026-10-14T12:00:00Z'));

    expect(issues.removeLabel).toHaveBeenCalledTimes(1);
    expect(issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7, name: 'status:new' }));
    expect(fieldWrites()).toEqual([
      ['F_status', { singleSelectOptionId: 'O_Applied' }],
      ['F_applied', { date: '2026-10-14' }],
    ]);
  });

  it('does not overwrite an existing Applied on', async () => {
    const { ctx, fieldWrites } = fakeContext({ labelsOnIssue: ['status:applied'], appliedOn: '2026-09-01' });
    await syncStatus(ctx, event('status:applied'));
    expect(fieldWrites()).toEqual([['F_status', { singleSelectOptionId: 'O_Applied' }]]);
  });

  it('does nothing for other labels or superseded events', async () => {
    const other = fakeContext({ labelsOnIssue: ['found:linkedin'] });
    await syncStatus(other.ctx, event('found:linkedin'));
    expect(other.graphql).not.toHaveBeenCalled();

    const superseded = fakeContext({ labelsOnIssue: ['status:applied'] });
    await syncStatus(superseded.ctx, event('status:screening'));
    expect(superseded.issues.removeLabel).not.toHaveBeenCalled();
    expect(superseded.graphql).not.toHaveBeenCalled();
  });
});

describe('intake', () => {
  const body = `### Company

Luby

### Role

Senior QA Automation Engineer

### Application link

https://luby.inhire.app/vagas/abc?utm_source=x

### Contract

CLT, PJ

### Compensation

R$ 15.000,00

### Currency

_No response_

### Contact

Recruiter

### Notes

Process has 3 stages.
`;
  const event = (overrides: Record<string, unknown> = {}) => ({
    action: 'opened',
    issue: { number: 9, node_id: 'I_9', body, labels: [{ name: 'manual' }, { name: 'status:new' }], ...overrides },
  });

  it('rewrites the issue, adds labels and fills the Project fields', async () => {
    const { ctx, issues, fieldWrites } = fakeContext();
    await intake(ctx, event());

    const update = issues.update.mock.calls[0]?.[0] as { title: string; body: string };
    expect(update.title).toBe('[Luby] Senior QA Automation Engineer');
    expect(update.body.split('\n')[0]).toBe('**Apply:** https://luby.inhire.app/vagas/abc');
    expect(update.body).toContain('**Source:** manual');
    expect(update.body).toMatch(/<!-- job-radar:id=manual:luby:[0-9a-f]{8} -->/);

    expect(issues.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 9, labels: ['found:recruiter', 'contract:clt', 'contract:pj'] }),
    );
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'Process has 3 stages.' }));
    expect(fieldWrites()).toEqual([
      ['F_status', { singleSelectOptionId: 'O_New' }],
      ['F_currency', { singleSelectOptionId: 'O_BRL' }],
      ['F_contact', { singleSelectOptionId: 'O_Recruiter' }],
      ['F_offered', { number: 15000 }],
    ]);
  });

  it('leaves non-manual issues alone', async () => {
    const { ctx, issues, graphql } = fakeContext();
    await intake(ctx, event({ labels: [{ name: 'bug' }] }));
    expect(issues.update).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it('asks for a valid link instead of creating a broken entry', async () => {
    const { ctx, issues, graphql } = fakeContext();
    await intake(ctx, event({ body: body.replace('https://luby.inhire.app/vagas/abc?utm_source=x', 'see LinkedIn') }));
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('not a valid') }));
    expect(issues.update).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });
});
