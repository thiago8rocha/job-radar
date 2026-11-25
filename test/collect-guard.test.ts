import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('examples/.github/workflows/collect.yml', 'utf8'));
const guard = workflow.jobs.guard.steps[0].run as string;

function runGuard(env: Record<string, string>, recentSuccesses: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\necho ${recentSuccesses}\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  const output = join(dir, 'output');
  writeFileSync(output, '');
  execFileSync('bash', ['-c', guard], {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'o/r', MIN_INTERVAL_HOURS: '4', ...env },
  });
  return readFileSync(output, 'utf8').trim();
}

describe('collect workflow guard', () => {
  it('runs when no collect succeeded recently', () => {
    expect(runGuard({ FORCE: 'false' }, 0)).toBe('run=true');
  });

  it('skips a scheduled or dispatched run right after a successful collect', () => {
    expect(runGuard({ FORCE: 'false' }, 1)).toBe('run=false');
  });

  it('lets a forced run through', () => {
    expect(runGuard({ FORCE: 'true' }, 1)).toBe('run=true');
  });

  it('keeps the schedule off the congested UTC hours', () => {
    const hours = workflow.on.schedule.map((entry: { cron: string }) => Number(entry.cron.split(' ')[1]));
    expect(hours.every((hour: number) => hour >= 8)).toBe(true);
  });
});
