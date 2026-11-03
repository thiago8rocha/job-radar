import { z } from 'zod';
import type { Job, WorkModel } from '../domain/job.js';
import { htmlToText } from '../util/text.js';
import { isoFromEpoch, jobId } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const CATEGORY = 'https://www.getonbrd.com/api/v0/categories/sysadmin-devops-qa/jobs';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ total_pages: z.number().optional() }).nullish(),
});

const postingSchema = z.object({
  id: z.string(),
  attributes: z.object({
    title: z.string(),
    description: z.string().nullish(),
    functions: z.string().nullish(),
    desirable: z.string().nullish(),
    remote_modality: z.string().nullish(),
    countries: z.array(z.string()).nullish(),
    published_at: z.number().nullish(),
    seniority: z.object({ data: z.object({ id: z.union([z.number(), z.string()]) }).nullish() }).nullish(),
    company: z.object({ data: z.object({ id: z.string(), attributes: z.object({ name: z.string() }) }) }),
  }),
  links: z.object({ public_url: z.string() }),
});

export type GetOnBoardPosting = z.infer<typeof postingSchema>;

const SENIORITY: Record<string, string> = { '1': 'entry', '2': 'junior', '3': 'mid-level', '4': 'senior', '5': 'specialist' };
const WORK_MODEL: Record<string, WorkModel> = { fully_remote: 'remote', hybrid: 'hybrid', no_remote: 'onsite' };

/**
 * Get on Board public API (tech jobs, many from LatAm, no key). It has no text search, so this reads the
 * SysAdmin / DevOps / QA category newest first and leaves the title filter to the pipeline.
 * `remote_local` postings are dropped: they are remote only for people living in a country the API
 * does not name, so eligibility cannot be checked.
 */
export const getonbrd: SourceAdapter<GetOnBoardPosting> = {
  id: 'getonbrd',
  mode: 'search',

  async fetch(ctx) {
    const oldest = ctx.now.getTime() - ctx.config.search.max_age_days * DAY_MS;
    const byId = new Map<string, GetOnBoardPosting>();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${CATEGORY}?per_page=${PAGE_SIZE}&page=${page}&expand[]=company`;
      const { data, meta } = parseEnvelope('getonbrd', envelopeSchema, await ctx.http.getJson(url));
      const postings = parseItems('getonbrd', postingSchema, data, ctx);
      for (const posting of postings) {
        if (posting.attributes.remote_modality !== 'remote_local') byId.set(posting.id, posting);
      }

      const dates = postings.map((posting) => (posting.attributes.published_at ?? 0) * 1000).filter((time) => time > 0);
      if (data.length === 0 || page >= (meta?.total_pages ?? 1) || (dates.length > 0 && Math.min(...dates) < oldest)) break;
    }
    return [...byId.values()];
  },

  normalize(posting): Job {
    const { attributes } = posting;
    const company = attributes.company.data;
    const countries = (attributes.countries ?? []).filter((country) => country !== 'Remote');
    const level = attributes.seniority?.data?.id;
    return {
      id: jobId('getonbrd', company.id, posting.id),
      source: 'getonbrd',
      atsApply: false,
      company: company.attributes.name.trim(),
      title: attributes.title.trim(),
      locations: countries.length > 0 ? countries : ['Remote'],
      restrictions: countries,
      workModel: WORK_MODEL[attributes.remote_modality ?? ''],
      seniority: level === undefined ? [] : [SENIORITY[String(level)] ?? ''].filter(Boolean),
      contracts: [],
      postedAt: isoFromEpoch(attributes.published_at ?? undefined, 's'),
      applyUrl: posting.links.public_url,
      description: [attributes.description, attributes.functions, attributes.desirable].map((html) => htmlToText(html)).filter(Boolean).join('\n\n'),
    };
  },
};
