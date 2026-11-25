import { ashby } from './ashby.js';
import { careers } from './careers.js';
import { freehire } from './freehire.js';
import { getonbrd } from './getonbrd.js';
import { googleJobs } from './google-jobs.js';
import { githubRepos } from './github-repos.js';
import { greenhouse } from './greenhouse.js';
import { gupy } from './gupy.js';
import { himalayas } from './himalayas.js';
import { hnHiring } from './hn-hiring.js';
import { inhire } from './inhire.js';
import { jobicy } from './jobicy.js';
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
  [inhire, himalayas, freehire, getonbrd, linkedin, greenhouse, lever, ashby, workable, smartrecruiters, recruitee, teamtailor, quickin, solides, workday, careers, gupy, remoteok, weworkremotely, jobicy, githubRepos, hnHiring, googleJobs].map((adapter) => [adapter.id, adapter]),
);
