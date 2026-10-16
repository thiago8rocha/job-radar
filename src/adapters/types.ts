import type { CompanyRef } from '../config/schema.js';
import type { Config } from '../config/schema.js';
import type { Job, WorkModel } from '../domain/job.js';
import type { HttpClient } from '../util/http.js';

export interface FetchContext {
  http: HttpClient;
  config: Config;
  /** Companies configured for this source (`company` mode only). */
  companies: CompanyRef[];
  /** Today, for adapters that stop paging at the age limit. */
  now: Date;
  /**
   * Cheap check on title and work model, so an adapter can skip a per-job detail request
   * for postings that the filters would discard anyway.
   */
  worthDetails(candidate: { title: string; workModel?: WorkModel }): boolean;
  /** API key for sources that need one (SerpAPI), from the Action input; undefined when not provided. */
  apiKey?: string;
  /** Records a problem that does not fail the whole source (one company down, one bad entry). */
  warn(message: string): void;
}

/**
 * One job source. `fetch` returns raw postings already validated against the source's zod
 * schema (a format change throws, failing only this source); `normalize` maps one to a `Job`.
 */
export interface SourceAdapter<Raw = unknown> {
  /** Id used in `sources:` of the config and in labels: `greenhouse`, `himalayas`... */
  id: string;
  /** `search` runs a global search by term; `company` looks up each company in `companies.yml`. */
  mode: 'search' | 'company';
  /** True when the source only works with an API key; without one it is skipped, not failed. */
  requiresKey?: boolean;
  fetch(ctx: FetchContext): Promise<Raw[]>;
  normalize(raw: Raw): Job;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySourceAdapter = SourceAdapter<any>;

/** The response of a source no longer matches the schema the adapter expects. */
export class SchemaError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: response does not match the expected schema (${detail})`);
  }
}
