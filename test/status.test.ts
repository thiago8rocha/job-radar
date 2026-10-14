import { describe, expect, it } from 'vitest';
import { planStatusSync } from '../src/commands/plan.js';
import { isTerminalStatus, parseStatusLabel, stageNumber, type Status } from '../src/domain/status.js';

describe('parseStatusLabel', () => {
  it('maps status labels and rejects everything else', () => {
    expect(parseStatusLabel('status:hr-interview')).toBe('hr-interview');
    expect(parseStatusLabel('status:nova')).toBeUndefined();
    expect(parseStatusLabel('found:linkedin')).toBeUndefined();
  });
});

describe('stages', () => {
  it('numbers stages 1 to 8 and leaves final states out', () => {
    expect(stageNumber('new')).toBe(1);
    expect(stageNumber('hired')).toBe(8);
    expect(stageNumber('rejected')).toBeUndefined();
    expect(stageNumber('withdrawn')).toBeUndefined();
  });

  it('treats hired, rejected and withdrawn as terminal', () => {
    const statuses: Status[] = ['hired', 'rejected', 'withdrawn', 'offer'];
    expect(statuses.map(isTerminalStatus)).toEqual([true, true, true, false]);
  });
});

describe('planStatusSync', () => {
  it('removes the previous status label and keeps unrelated ones', () => {
    const plan = planStatusSync('status:screening', ['status:applied', 'status:screening', 'found:linkedin']);
    expect(plan).toEqual({ status: 'screening', remove: ['status:applied'], fillAppliedOn: false });
  });

  it('asks to fill Applied on when applying', () => {
    expect(planStatusSync('status:applied', ['status:new', 'status:applied'])?.fillAppliedOn).toBe(true);
  });

  it('ignores labels that are not status labels', () => {
    expect(planStatusSync('found:linkedin', ['found:linkedin'])).toBeUndefined();
  });

  it('ignores an event whose label was already removed by a concurrent run', () => {
    expect(planStatusSync('status:screening', ['status:applied'])).toBeUndefined();
  });
});
