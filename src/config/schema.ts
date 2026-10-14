import { z } from 'zod';

const sourceToggle = z.object({
  enabled: z.boolean().default(false),
  api_key_secret: z.string().optional(),
});

export const configSchema = z.object({
  locale: z.literal('en').default('en'),

  search: z
    .object({
      include: z.array(z.string()).default([]),
      ambiguous_requires: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
      seniority: z.array(z.string()).default([]),
      max_age_days: z.number().int().positive().default(15),
    })
    .default({ include: [], ambiguous_requires: [], exclude: [], seniority: [], max_age_days: 15 }),

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
    })
    .default({ enabled: false, queries: [] }),

  issues: z
    .object({
      max_per_run: z.number().int().positive().default(25),
      project_number: z.number().int().positive().default(1),
      /** Login that owns the Project. Defaults to the owner of the repository. */
      project_owner: z.string().optional(),
    })
    .default({ max_per_run: 25, project_number: 1 }),

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

export const companiesSchema = z.object({
  inhire: z.array(z.string()).default([]),
  greenhouse: z.array(z.string()).default([]),
  lever: z.array(z.string()).default([]),
  ashby: z.array(z.string()).default([]),
});

export type Companies = z.infer<typeof companiesSchema>;
