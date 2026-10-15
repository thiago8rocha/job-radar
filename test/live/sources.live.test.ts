import { describe, expect, it } from 'vitest';
import { ashby } from '../../src/adapters/ashby.js';
import { greenhouse } from '../../src/adapters/greenhouse.js';
import { himalayas } from '../../src/adapters/himalayas.js';
import { inhire } from '../../src/adapters/inhire.js';
import { lever } from '../../src/adapters/lever.js';
import type { FetchContext, SourceAdapter } from '../../src/adapters/types.js';
import { parseConfig } from '../../src/config/load.js';
import { createHttpClient } from '../../src/util/http.js';

/**
 * One real request per source, checking only that the response still matches the adapter's schema
 * and normalizes into usable jobs. Filters and dates are out of scope: a source with no QA jobs today
 * is fine, a source whose format changed is not. Runs daily in CI; a failure opens an issue.
 */
const config = parseConfig('search: { include: ["QA"], max_age_days: 30 }');
const http = createHttpClient({ hostDelayMs: 500 });

function context(slugs: string[]): FetchContext {
  return {
    http,
    config,
    companies: slugs.map((slug) => ({ slug })),
    now: new Date(),
    worthDetails: () => false, // skip the per-job detail requests; the list endpoint is the contract
    warn: (message) => console.warn(message),
  };
}

async function check<Raw>(adapter: SourceAdapter<Raw>, slugs: string[]): Promise<void> {
  const raws = await adapter.fetch(context(slugs));
  expect(raws.length, `${adapter.id} returned no postings`).toBeGreaterThan(0);
  for (const raw of raws.slice(0, 25)) {
    const job = adapter.normalize(raw);
    expect(job.id).toMatch(new RegExp(`^${adapter.id}:`));
    expect(job.title.length).toBeGreaterThan(0);
    expect(() => new URL(job.applyUrl)).not.toThrow();
  }
}

describe('live sources', () => {
  // Public boards that have been stable for years; swap one if a company ever closes its board.
  it('inhire', () => check(inhire, ['luby']));
  it('greenhouse', () => check(greenhouse, ['airbnb']));
  it('lever', () => check(lever, ['palantir']));
  it('ashby', () => check(ashby, ['ramp']));
  it('himalayas', () => check(himalayas, []));
});
