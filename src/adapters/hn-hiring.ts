import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { jobId, workModelFrom } from './common.js';
import { SchemaError, type SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const SEARCH = 'https://hn.algolia.com/api/v1/search_by_date';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';
const PAGE_SIZE = 1000;
const MAX_PAGES = 3;

const threadsSchema = z.object({ hits: z.array(z.object({ objectID: z.string(), title: z.string().nullish() })) });
const commentsSchema = z.object({ nbPages: z.number().nullish(), hits: z.array(z.unknown()) });

const commentSchema = z.object({
  objectID: z.string(),
  parent_id: z.union([z.number(), z.string()]),
  story_id: z.union([z.number(), z.string()]).nullish(),
  created_at: z.string(),
  comment_text: z.string().min(1),
});

export type HnComment = z.infer<typeof commentSchema>;

/** The first line of a posting is `Company | Role | Location | Remote | ...`; the rest is free text. */
function headline(comment: HnComment): string[] {
  return htmlToText(comment.comment_text.split(/<p>/i)[0])
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The latest "Ask HN: Who is hiring?" thread, through the Algolia HN API (no key): one request to find
 * the thread and one per page of 1000 comments, keeping the top-level ones (the postings). Few QA roles
 * appear, so it is off by default. Postings follow a loose `Company | Role | Place | Remote` convention.
 */
export const hnHiring: SourceAdapter<HnComment> = {
  id: 'hn_hiring',
  mode: 'search',

  async fetch(ctx) {
    const threads = parseEnvelope('hn_hiring', threadsSchema, await ctx.http.getJson(`${SEARCH}?${new URLSearchParams({ tags: 'story,author_whoishiring', query: 'Who is hiring', hitsPerPage: '10' })}`));
    const thread = threads.hits.find((hit) => /^Ask HN: Who is hiring\?/i.test(hit.title ?? ''));
    if (!thread) throw new SchemaError('hn_hiring', 'no "Who is hiring?" thread found');

    const postings: HnComment[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ tags: `comment,story_${thread.objectID}`, hitsPerPage: String(PAGE_SIZE), page: String(page) });
      const { hits, nbPages } = parseEnvelope('hn_hiring', commentsSchema, await ctx.http.getJson(`${SEARCH}?${query}`));
      postings.push(...parseItems('hn_hiring', commentSchema, hits, ctx).filter((comment) => String(comment.parent_id) === thread.objectID));
      if (page + 1 >= (nbPages ?? 1)) break;
    }
    return postings;
  },

  normalize(comment): Job {
    const [company = 'Unknown', role = '', ...rest] = headline(comment);
    const text = htmlToText(comment.comment_text);
    return {
      id: jobId('hn_hiring', company, comment.objectID),
      source: 'hn_hiring',
      atsApply: false,
      company,
      title: role || text.slice(0, 120),
      locations: rest.filter((part) => !/^(?:full[- ]?time|part[- ]?time|contract|https?:)/i.test(part)),
      workModel: rest.map(workModelFrom).find(Boolean),
      seniority: [],
      contracts: [],
      postedAt: comment.created_at,
      applyUrl: canonicalUrl(`${ITEM_URL}${comment.objectID}`) ?? `${ITEM_URL}${comment.objectID}`,
      description: text,
    };
  },
};
