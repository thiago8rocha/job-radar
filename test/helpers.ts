import type { Job } from '../src/domain/job.js';

/** A job that passes the default test filters; override what a test needs. */
export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'greenhouse:acme:aaaaaaaa',
    source: 'greenhouse',
    atsApply: true,
    company: 'Acme',
    title: 'Senior QA Engineer',
    locations: ['Remote - Brazil'],
    workModel: 'remote',
    seniority: [],
    contracts: [],
    postedAt: '2026-10-10T00:00:00Z',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    description: 'We test things with Playwright.',
    ...overrides,
  };
}
