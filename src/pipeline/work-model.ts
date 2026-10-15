import type { Job, WorkModel } from '../domain/job.js';
import { normalizeText } from '../util/text.js';

/** From least to most demanding for a remote-only search. */
const RANK: Record<WorkModel, number> = { remote: 0, hybrid: 1, onsite: 2 };

// Patterns run on normalized text: lower case, no accents, punctuation turned into spaces.
const HYBRID_HEAD = /\b(hybrid|hibrido|hibrida)\b/;
const ONSITE_HEAD = /\b(onsite|on site|presencial|in office)\b/;

const HYBRID_BODY: RegExp[] = [
  /\bhybrid (role|position|job|work|working|model|schedule|setup|environment|opportunity|arrangement|basis)\b/,
  /\b(role|position|job|opportunity|vacancy) is hybrid\b/,
  /\bwork(ing)? (in a )?hybrid\b/,
  /\b(modelo|regime|formato|esquema|trabalho) hibrido\b/,
  /\bvaga hibrida\b/,
  /\b[1-5] (dias|x|days) (por |na |a |per )?(semana|week) (no|na|in the|at the|em) (escritorio|office|presencial|local|cliente)/,
  /\b(escritorio|office|cliente) [1-5] (dias|x|days)\b/,
];

const ONSITE_BODY: RegExp[] = [
  /\b(vaga|trabalho|atuacao|regime|modelo) presencial\b/,
  /\b(100|totalmente|integralmente) presencial\b/,
  /\b(100|fully|entirely) on ?site\b/,
  /\bon ?site (role|position|job|only)\b/,
];

/** Mentions of remote work close to a match mean the posting offers a choice ("hybrid or remote"). */
const REMOTE_NEARBY = /\b(remote|remoto|remota|remotely|home office)\b/;

function signal(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => {
    const match = pattern.exec(text);
    if (!match) return false;
    const around = text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40);
    return !REMOTE_NEARBY.test(around);
  });
}

export interface WorkModelResult {
  model?: WorkModel;
  /** Where the model came from, for the summary and tests. */
  source?: 'source' | 'title' | 'description' | 'inferred';
}

/**
 * Work model of a job. The source's own field is the starting point, but the title, the locations
 * and explicit phrases in the description can contradict it ("Remote" in the API, "Hybrid" in the
 * title): when they do, the more demanding model wins, because the search is remote-only and a
 * missed job costs less than a misleading one. A job with no stated model is "remote" only when
 * its text says so and nothing points the other way.
 */
export function detectWorkModel(job: Pick<Job, 'workModel' | 'title' | 'locations' | 'description'>): WorkModel | undefined {
  return resolveWorkModel(job).model;
}

export function resolveWorkModel(
  job: Pick<Job, 'workModel' | 'title' | 'locations' | 'description'>,
): WorkModelResult {
  const head = normalizeText(`${job.title} ${job.locations.join(' ')}`);
  const body = normalizeText(job.description);

  let model = job.workModel;
  let source: WorkModelResult['source'] = model ? 'source' : undefined;
  const raise = (candidate: WorkModel, from: 'title' | 'description') => {
    if (model === undefined || RANK[candidate] > RANK[model]) {
      model = candidate;
      source = from;
    }
  };

  if (ONSITE_HEAD.test(head)) raise('onsite', 'title');
  else if (HYBRID_HEAD.test(head)) raise('hybrid', 'title');
  if (signal(body, ONSITE_BODY)) raise('onsite', 'description');
  else if (signal(body, HYBRID_BODY)) raise('hybrid', 'description');

  if (model === undefined && /\b(remote|remoto|home office)\b/.test(`${head} ${normalizeText(job.description.slice(0, 2000))}`)) {
    return { model: 'remote', source: 'inferred' };
  }
  return { model, source };
}
