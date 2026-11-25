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
  /** Epoch ms after which a per-company adapter starts no new company; it returns what it has. */
  deadline?: number;
  /** Companies fetched at the same time (default 4). */
  concurrency?: number;
  /** Lookups an adapter resolved once and wants kept between runs (Quickin account ids); `collect` persists it in the companies state. */
  resolved?: Record<string, string>;
  /** Called after each company is fetched, with what it returned or why it failed. */
  onCompany?(result: { company: CompanyRef; items: unknown[]; error?: Error }): void;
  /**
   * Cheap check on title and work model, so an adapter can skip a per-job detail request
   * for postings that the filters would discard anyway.
   */
  worthDetails(candidate: { title: string; company?: string; workModel?: WorkModel }): boolean;
  /** True when an issue already exists for this link, so an adapter can skip a detail request it would only repeat. */
  isKnownUrl?(url: string): boolean;
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
  /** For company sources: whether these results prove a job missing from them is gone. Default: yes. */
  provesAbsence?(raws: Raw[]): boolean;
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
