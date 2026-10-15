export type WorkModel = 'remote' | 'hybrid' | 'onsite';

export type Currency = 'BRL' | 'USD' | 'EUR';

/** A job in the shape every adapter produces and the pipeline works on. */
export interface Job {
  /** Stable id, also written in the hidden issue marker: `<source>:<company>:<hash>`. */
  id: string;
  /** Adapter id: `greenhouse`, `himalayas`... */
  source: string;
  /** True when the application URL is the company's own ATS page (not an aggregator). */
  atsApply: boolean;
  company: string;
  title: string;
  /** Location texts as the source states them, e.g. `Remote - Brazil`. */
  locations: string[];
  /** Explicit eligibility list from the source (Himalayas `locationRestrictions`), when it has one. */
  restrictions?: string[];
  workModel?: WorkModel;
  /** Seniority levels the source states explicitly, lower case (`senior`, `staff`...). */
  seniority: string[];
  contracts: string[];
  /** Compensation as stated, e.g. `USD 80,000 – 100,000 / year`. */
  compensation?: string;
  currency?: Currency;
  /** Set only when the posting states a single amount. */
  salaryAmount?: number;
  /** ISO 8601 timestamp. */
  postedAt?: string;
  applyUrl: string;
  /** Plain-text description, used for matching and the issue excerpt. */
  description: string;
}
