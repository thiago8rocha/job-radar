import { ashby } from './ashby.js';
import { freehire } from './freehire.js';
import { getonbrd } from './getonbrd.js';
import { googleJobs } from './google-jobs.js';
import { greenhouse } from './greenhouse.js';
import { gupy } from './gupy.js';
import { himalayas } from './himalayas.js';
import { inhire } from './inhire.js';
import { lever } from './lever.js';
import { linkedin } from './linkedin.js';
import { quickin } from './quickin.js';
import { recruitee } from './recruitee.js';
import { remoteok } from './remoteok.js';
import { smartrecruiters } from './smartrecruiters.js';
import { solides } from './solides.js';
import { teamtailor } from './teamtailor.js';
import { weworkremotely } from './weworkremotely.js';
import { workday } from './workday.js';
import { workable } from './workable.js';
import type { AnySourceAdapter } from './types.js';

/** Every adapter available in this version, by source id (the keys of `sources:` in the config). */
export const ADAPTERS: Record<string, AnySourceAdapter> = Object.fromEntries(
  [inhire, himalayas, freehire, getonbrd, linkedin, greenhouse, lever, ashby, workable, smartrecruiters, recruitee, teamtailor, quickin, solides, workday, gupy, remoteok, weworkremotely, googleJobs].map((adapter) => [adapter.id, adapter]),
);
