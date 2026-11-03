import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeJob } from '../src/ai/insight.js';
import { MIN_AGREEMENT, scoreGolden, type GoldenCase } from '../src/ai/golden.js';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const cases = read('evals/cases.json') as GoldenCase[];
const replies = (existsSync(new URL('../evals/replies.json', import.meta.url)) ? read('evals/replies.json') : {}) as Record<string, string>;

describe('golden cases', () => {
  it('are well formed and carry no profile', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    for (const item of cases) {
      expect(item.description.length, item.id).toBeGreaterThan(300);
      expect(item.expect.min, item.id).toBeLessThanOrEqual(item.expect.max);
      expect(item.expect.min, item.id).toBeGreaterThanOrEqual(1);
      expect(item.expect.max, item.id).toBeLessThanOrEqual(5);
    }
  });

  it('counts the scores that fall inside what the decision allows', () => {
    const item = (id: string, min: number, max: number): GoldenCase => ({ id, title: 't', company: 'c', description: 'd', expect: { min, max }, label: 'l' });
    const sample = [item('a', 3, 5), item('b', 1, 2), item('c', 1, 3)];

    const result = scoreGolden(sample, { a: 4, b: 3 });
    expect(result).toMatchObject({ total: 2, agreed: 1, rate: 0.5 });
    expect(result.misses).toEqual([{ id: 'b', fit: 3, expect: { min: 1, max: 2 } }]);
    expect(scoreGolden(sample, {}).rate).toBe(0);
  });

  it('replays the recorded model replies for free and keeps the agreement above the minimum', async () => {
    const recorded = cases.filter((item) => replies[item.id] !== undefined);
    if (recorded.length === 0) return; // nothing recorded yet: run `npm run eval:golden -- --profile <file> --record`

    const fits: Record<string, number> = {};
    for (const item of recorded) {
      const client = { complete: async () => replies[item.id]! };
      fits[item.id] = (await analyzeJob(client, 'recorded', { title: item.title, company: item.company, locations: [], description: item.description })).fit;
    }
    const result = scoreGolden(recorded, fits);
    expect(result.rate, `misses: ${JSON.stringify(result.misses)}`).toBeGreaterThanOrEqual(MIN_AGREEMENT);
  });
});
