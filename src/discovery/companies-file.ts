import { isSeq, parseDocument } from 'yaml';
import { ATS, slugKey, type AtsId, type AtsTable } from '../adapters/ats.js';
import { companiesSchema, companyRefs, type CompanyEntry, type Companies } from '../config/schema.js';

/** Slugs already listed per ATS (lower case), whether written as `slug` or `{ slug, name }`. */
export function listedSlugs(companies: Companies, table: AtsTable = ATS): Record<AtsId, Set<string>> {
  return Object.fromEntries(
    table.map((def) => [def.id, new Set(companyRefs(companies[def.id as AtsId]).map((ref) => slugKey(def, ref.slug)))]),
  ) as Record<AtsId, Set<string>>;
}

export function parseCompaniesText(text: string): Companies {
  const parsed = companiesSchema.safeParse(parseDocument(text || '{}').toJS() ?? {});
  if (!parsed.success) throw new Error(`companies.yml is not valid: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Removes the listed slugs (any entry form), keeping comments and the rest as they were. */
export function removeCompanies(text: string, removals: Partial<Record<AtsId, string[]>>, table: AtsTable = ATS): string {
  const doc = parseDocument(text || '{}\n');
  for (const [ats, slugs] of Object.entries(removals)) {
    const def = table.find((entry) => entry.id === ats);
    const list = doc.get(ats, true);
    if (!def || !slugs || !isSeq(list)) continue;
    const doomed = new Set(slugs.map((slug) => slugKey(def, slug)));
    list.items = list.items.filter((item) => {
      const [ref] = companyRefs([(item as { toJSON(): CompanyEntry }).toJSON()]);
      return !(ref && doomed.has(slugKey(def, ref.slug)));
    });
  }
  return doc.toString({ flowCollectionPadding: false });
}

/**
 * Adds slugs to `companies.yml` keeping everything else as it was: comments, order and the
 * `[a, b]` list style the file already uses.
 */
export function addCompanies(text: string, additions: Partial<Record<AtsId, string[]>>): string {
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
