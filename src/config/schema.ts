import { z } from 'zod';

const sourceToggle = z.object({
  enabled: z.boolean().default(false),
  /** Name of the secret that holds the API key, for sources that need one (Google Jobs → SERPAPI_KEY). */
  api_key_secret: z.string().optional(),
  /** Search queries for sources that take free text; defaults are built from `search.include`. */
  queries: z.array(z.string()).optional(),
  /** Cap on paid or metered requests per run (SerpAPI's free plan allows 100 searches a month). */
  max_searches: z.number().int().positive().optional(),
  /** Location passed to the source's search, e.g. "Brazil". */
  location: z.string().optional(),
});

export const configSchema = z.object({
  locale: z.literal('en').default('en'),

  search: z
    .object({
      include: z.array(z.string()).default([]),
      /** Include terms too generic on their own (e.g. "Analista de Qualidade"). */
      ambiguous: z.array(z.string()).default([]),
      /** Words a title matched only by an ambiguous term must also have, in the title or description. */
      ambiguous_requires: z.array(z.string()).default([]),
      /** Terms (stack, tools) listed in the issue excerpt when the description mentions them. */
      highlight: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      seniority: z.array(z.string()).default([]),
      max_age_days: z.number().int().positive().default(15),
    })
    .default({
      include: [],
      ambiguous: [],
      ambiguous_requires: [],
      highlight: [],
      exclude: [],
      seniority: [],
      max_age_days: 15,
    }),

  eligibility: z
    .object({
      accept_regions: z.array(z.string()).default(['worldwide']),
      reject: z.array(z.string()).default([]),
    })
    .default({ accept_regions: ['worldwide'], reject: [] }),

  work_model: z.array(z.enum(['remote', 'hybrid', 'onsite'])).default(['remote']),

  sources: z.record(z.string(), sourceToggle).default({}),

  discovery: z
    .object({
      enabled: z.boolean().default(false),
      queries: z.array(z.string()).default([]),
      /** Cap on SerpAPI searches per run; the free plan allows 100 a month. */
      max_searches: z.number().int().positive().default(8),
    })
    .default({ enabled: false, queries: [], max_searches: 8 }),

  issues: z
    .object({
      max_per_run: z.number().int().positive().default(25),
      project_number: z.number().int().positive().default(1),
      /** Close the issue when its status becomes rejected, withdrawn or hired, and reopen it when it goes back. */
      close_on_final_status: z.boolean().default(true),
      /** Login that owns the Project. Defaults to the owner of the repository. */
      project_owner: z.string().optional(),
    })
    .default({ max_per_run: 25, project_number: 1, close_on_final_status: true }),

  metrics: z
    .object({
      /** An application with no answer after this many days counts as "no response" in the Metrics issue. */
      no_response_after_days: z.number().int().positive().default(60),
    })
    .default({ no_response_after_days: 60 }),

  ai: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.literal('github-models').default('github-models'),
      model: z.string().default('openai/gpt-4o-mini'),
      max_calls_per_run: z.number().int().positive().default(30),
      profile_secret: z.string().default('JOB_RADAR_PROFILE'),
    })
    .default({
      enabled: false,
      provider: 'github-models',
      model: 'openai/gpt-4o-mini',
      max_calls_per_run: 30,
      profile_secret: 'JOB_RADAR_PROFILE',
    }),
});

export type Config = z.infer<typeof configSchema>;

/** A company slug, optionally with the display name to use in issue titles. */
const company = z.union([z.string(), z.object({ slug: z.string(), name: z.string().optional() })]);

export const companiesSchema = z.object({
  inhire: z.array(company).default([]),
  greenhouse: z.array(company).default([]),
  lever: z.array(company).default([]),
  ashby: z.array(company).default([]),
});

export type Companies = z.infer<typeof companiesSchema>;

export interface CompanyRef {
  slug: string;
  /** Display name when the config gives one; adapters fall back to what the source returns. */
  name?: string;
}

export function companyRefs(entries: Companies[keyof Companies] | undefined): CompanyRef[] {
  return (entries ?? []).map((entry) => (typeof entry === 'string' ? { slug: entry } : entry));
}
