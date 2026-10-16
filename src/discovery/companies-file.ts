import { isSeq, parseDocument } from 'yaml';
import { companiesSchema, companyRefs, type Companies } from '../config/schema.js';

/** Slugs already listed per ATS (lower case), whether written as `slug` or `{ slug, name }`. */
export function listedSlugs(companies: Companies): Record<keyof Companies, Set<string>> {
  const slugs = (key: keyof Companies) => new Set(companyRefs(companies[key]).map((ref) => ref.slug.toLowerCase()));
  return { inhire: slugs('inhire'), greenhouse: slugs('greenhouse'), lever: slugs('lever'), ashby: slugs('ashby') };
}

export function parseCompaniesText(text: string): Companies {
  const parsed = companiesSchema.safeParse(parseDocument(text || '{}').toJS() ?? {});
  if (!parsed.success) throw new Error(`companies.yml is not valid: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/**
 * Adds slugs to `companies.yml` keeping everything else as it was: comments, order and the
 * `[a, b]` list style the file already uses.
 */
export function addCompanies(text: string, additions: Partial<Record<keyof Companies, string[]>>): string {
  const doc = parseDocument(text || '{}\n');
  for (const [ats, slugs] of Object.entries(additions)) {
    if (!slugs || slugs.length === 0) continue;
    let list = doc.get(ats, true);
    if (!isSeq(list)) {
      doc.set(ats, doc.createNode([]));
      list = doc.get(ats, true);
      if (isSeq(list)) list.flow = true;
    }
    if (isSeq(list)) for (const slug of slugs) list.add(doc.createNode(slug));
  }
  return doc.toString({ flowCollectionPadding: false });
}
