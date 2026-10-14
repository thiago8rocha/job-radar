import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseCompanies, parseConfig } from '../src/config/load.js';

describe('config', () => {
  it('applies defaults to an empty file', () => {
    const config = parseConfig('');
    expect(config.issues).toMatchObject({ max_per_run: 25, project_number: 1 });
    expect(config.search.max_age_days).toBe(15);
    expect(config.ai.enabled).toBe(false);
  });

  it('accepts the shipped examples', () => {
    const config = parseConfig(readFileSync('examples/job-radar.config.yml', 'utf8'));
    expect(config.sources.himalayas?.enabled).toBe(true);
    expect(parseCompanies(readFileSync('examples/companies.yml', 'utf8')).inhire).toEqual([]);
  });

  it('reports every invalid field', () => {
    const message = (() => {
      try {
        parseConfig('issues: { max_per_run: -1 }\nwork_model: [office]');
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('issues.max_per_run');
    expect(message).toContain('work_model.0');
    expect(() => parseConfig('a: [')).toThrowError(ConfigError);
  });
});
