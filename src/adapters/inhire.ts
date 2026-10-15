import { z } from 'zod';
import type { CompanyRef } from '../config/schema.js';
import type { Job } from '../domain/job.js';
import { slugify } from '../domain/labels.js';
import { canonicalUrl } from '../pipeline/url.js';
import { htmlToText } from '../util/text.js';
import { companyName, forEachCompany, jobId, workModelFrom } from './common.js';
import type { SourceAdapter } from './types.js';
import { parseEnvelope, parseItems } from './validate.js';

const API = 'https://api.inhire.app/job-posts/public/pages';

const envelopeSchema = z.object({
  tenantName: z.string().nullish(),
  jobsPage: z.array(z.unknown()),
});

const listItemSchema = z.object({
  jobId: z.string(),
  displayName: z.string(),
  status: z.string().nullish(),
  workplaceType: z.string().nullish(),
  location: z.string().nullish(),
});

const detailSchema = z.object({
  jobId: z.string().nullish(),
  displayName: z.string().nullish(),
  publishedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  contractType: z.array(z.string()).nullish(),
  salaryCurrency: z.string().nullish(),
  description: z.string().nullish(),
  workplaceType: z.string().nullish(),
  location: z.string().nullish(),
});

export type InhireListItem = z.infer<typeof listItemSchema>;
export type InhireDetail = z.infer<typeof detailSchema>;

export interface InhireRaw {
  company: CompanyRef;
  tenantName?: string | null;
  item: InhireListItem;
  /** Only requested for jobs that pass the title and remote filters. */
  detail?: InhireDetail;
}

/** Talent pools are not jobs: "Banco de Talentos | #VemPraLuby" and the like. */
const TALENT_POOL = /banco de talentos|talent (pool|bank)|cadastro reserva/i;

/** The page only uses the jobId; the slug just keeps the link readable. */
export function inhireApplyUrl(company: string, id: string, title: string): string {
  return `https://${company}.inhire.app/vagas/${id}/${slugify(title)}`;
}

/**
 * InHire career pages. The list endpoint returns every published job of a company in one response;
 * the detail endpoint (publication date, contract, description) is only called for jobs that
 * pass the title and remote filters.
 */
export const inhire: SourceAdapter<InhireRaw> = {
  id: 'inhire',
  mode: 'company',

  async fetch(ctx) {
    return forEachCompany('inhire', ctx, async (company) => {
      const headers = { 'X-Tenant': company.slug, 'X-Inhire-Client': 'web-inhire' };
      const data = await ctx.http.getJson(API, { headers });
      const { tenantName, jobsPage } = parseEnvelope('inhire', envelopeSchema, data);

      const items = parseItems('inhire', listItemSchema, jobsPage, ctx).filter(
        (item) => (item.status ?? 'published') === 'published' && !TALENT_POOL.test(item.displayName),
      );

      const raws: InhireRaw[] = [];
      for (const item of items) {
        const raw: InhireRaw = { company, tenantName, item };
        if (ctx.worthDetails({ title: item.displayName, workModel: workModelFrom(item.workplaceType) })) {
          try {
            const detail = await ctx.http.getJson(`${API}/${encodeURIComponent(item.jobId)}`, { headers });
            raw.detail = parseEnvelope('inhire', detailSchema, detail);
          } catch (error) {
            ctx.warn(`inhire/${company.slug}: details of "${item.displayName}" failed (${(error as Error).message})`);
          }
        }
        raws.push(raw);
      }
      return raws;
    });
  },

  normalize({ company, tenantName, item, detail }): Job {
    const location = (detail?.location ?? item.location)?.trim();
    const title = item.displayName.trim();
    return {
      id: jobId('inhire', company.slug, item.jobId),
      source: 'inhire',
      atsApply: true,
      company: companyName(company, tenantName),
      title,
      locations: location ? [location] : [],
      workModel: workModelFrom(detail?.workplaceType ?? item.workplaceType),
      seniority: [],
      contracts: detail?.contractType ?? [],
      postedAt: detail?.publishedAt ?? detail?.createdAt ?? undefined,
      applyUrl: canonicalUrl(inhireApplyUrl(company.slug, item.jobId, title)) ?? inhireApplyUrl(company.slug, item.jobId, title),
      description: htmlToText(detail?.description),
    };
  },
};
