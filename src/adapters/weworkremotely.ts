import { z } from 'zod';
import type { Job } from '../domain/job.js';
import { canonicalUrl } from '../pipeline/url.js';
import { parseRssItems } from '../util/rss.js';
import { htmlToText } from '../util/text.js';
import { jobId } from './common.js';
import { SchemaError, type SourceAdapter } from './types.js';
import { parseItems } from './validate.js';

const FEED = 'https://weworkremotely.com/remote-jobs.rss';

const postingSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  guid: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  pubDate: z.string().optional(),
  expires_at: z.string().optional(),
  description: z.string().optional(),
});

export type WeWorkRemotelyPosting = z.infer<typeof postingSchema>;

function isoOf(value: string | undefined): string | undefined {
  const time = Date.parse(value ?? '');
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** "Acme: Senior QA Engineer" → company and role; a title without the colon keeps the whole text as the role. */
function splitTitle(title: string): { company: string; role: string } {
  const index = title.indexOf(': ');
  return index === -1
    ? { company: 'Unknown', role: title.trim() }
    : { company: title.slice(0, index).trim(), role: title.slice(index + 2).trim() };
}

/** We Work Remotely's official RSS feed of its latest remote jobs (all categories). */
export const weworkremotely: SourceAdapter<WeWorkRemotelyPosting> = {
  id: 'weworkremotely',
  mode: 'search',

  async fetch(ctx) {
    const items = parseRssItems(await ctx.http.getText(FEED));
    if (!items) throw new SchemaError('weworkremotely', 'the response is not an RSS feed');
    return parseItems('weworkremotely', postingSchema, items, ctx).filter((posting) => {
      const expires = Date.parse(posting.expires_at ?? '');
      return Number.isNaN(expires) || expires > ctx.now.getTime();
    });
  },

  normalize(posting): Job {
    const { company, role } = splitTitle(posting.title);
    const places = [posting.region, posting.country]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    const url = canonicalUrl(posting.link) ?? posting.link;
    return {
      id: jobId('weworkremotely', company, posting.guid ?? url),
      source: 'weworkremotely',
      atsApply: false,
      company,
      title: role,
      locations: places.length > 0 ? places : ['Worldwide'],
      restrictions: places,
      workModel: 'remote',
      seniority: [],
      contracts: [],
      postedAt: isoOf(posting.pubDate),
      applyUrl: url,
      description: htmlToText(posting.description),
    };
  },
};
