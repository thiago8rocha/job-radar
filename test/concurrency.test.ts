import { afterEach, describe, expect, it, vi } from 'vitest';
import { forEachCompany } from '../src/adapters/common.js';
import type { FetchContext } from '../src/adapters/types.js';
import { createHttpClient } from '../src/util/http.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function context(count: number, overrides: Partial<FetchContext> = {}, warnings: string[] = []): FetchContext {
  return {
    companies: Array.from({ length: count }, (_, index) => ({ slug: `c${index}` })),
    warn: (message) => warnings.push(message),
    ...overrides,
  } as FetchContext;
}

describe('forEachCompany', () => {
  it('fetches companies a few at a time and keeps their order', async () => {
    let active = 0;
    let peak = 0;
    const started = Date.now();
    const results = await forEachCompany('fake', context(200), async (company) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(50);
      active--;
      return [company.slug];
    });
    const elapsed = Date.now() - started;
    expect(results).toEqual(Array.from({ length: 200 }, (_, index) => `c${index}`));
    expect(peak).toBe(4);
    expect(elapsed).toBeLessThan(200 * 50 * 0.6);
  });

  it('stops starting companies at the deadline and reports the skipped ones', async () => {
    const warnings: string[] = [];
    const results = await forEachCompany('fake', context(20, { deadline: Date.now() + 120, concurrency: 2 }, warnings), async (company) => {
      await sleep(50);
      return [company.slug];
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(20);
    expect(warnings.at(-1)).toMatch(new RegExp(`fake: out of time, skipped ${20 - results.length} of 20 companies`));
  });

  it('fails only when every attempted company fails', async () => {
    const warnings: string[] = [];
    const ok = await forEachCompany('fake', context(3, {}, warnings), async (company) => {
      if (company.slug === 'c1') throw new Error('boom');
      return [company.slug];
    });
    expect(ok).toEqual(['c0', 'c2']);
    await expect(forEachCompany('fake', context(2), async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });
});

describe('http client under concurrency', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the per-host spacing across simultaneous calls', async () => {
    const times: number[] = [];
    vi.stubGlobal('fetch', async () => {
      times.push(Date.now());
      return new Response('{}', { status: 200 });
    });
    const client = createHttpClient({ hostDelayMs: 60 });
    await Promise.all(Array.from({ length: 5 }, () => client.getJson('https://api.test/x')));
    // Timers can fire a few ms early on Windows, so check the whole span rather than each gap.
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(4 * 60 * 0.85);
  });

  it('still retries a 429 when calls overlap', async () => {
    const attempts = new Map<string, number>();
    vi.stubGlobal('fetch', async (url: string) => {
      const count = (attempts.get(url) ?? 0) + 1;
      attempts.set(url, count);
      return count === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : new Response('{"ok":true}', { status: 200 });
    });
    const client = createHttpClient({ hostDelayMs: 5, backoffMs: 1 });
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((name) => client.getJson(`https://api.test/${name}`)));
    expect(results).toEqual(Array(4).fill({ ok: true }));
    expect([...attempts.values()]).toEqual([2, 2, 2, 2]);
  });
});
