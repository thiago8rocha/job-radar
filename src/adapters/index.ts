import { ashby } from './ashby.js';
import { googleJobs } from './google-jobs.js';
import { greenhouse } from './greenhouse.js';
import { gupy } from './gupy.js';
import { himalayas } from './himalayas.js';
import { inhire } from './inhire.js';
import { lever } from './lever.js';
import { remoteok } from './remoteok.js';
import { weworkremotely } from './weworkremotely.js';
import type { AnySourceAdapter } from './types.js';

/** Every adapter available in this version, by source id (the keys of `sources:` in the config). */
export const ADAPTERS: Record<string, AnySourceAdapter> = Object.fromEntries(
  [inhire, himalayas, greenhouse, lever, ashby, gupy, remoteok, weworkremotely, googleJobs].map((adapter) => [adapter.id, adapter]),
);
