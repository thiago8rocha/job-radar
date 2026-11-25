import { ATS, emptyByAts, slugKey, type AtsId, type AtsTable } from '../adapters/ats.js';

export type DiscoveredCompanies = Record<AtsId, string[]>;

/** Company slugs found in a list of search-result links, per ATS and without repeats. */
export function companiesFromLinks(links: string[], table: AtsTable = ATS): DiscoveredCompanies {
  const found: DiscoveredCompanies = emptyByAts<string>(table);
  for (const link of links) {
    for (const def of table) {
      if ('urlOnly' in def && def.urlOnly) continue;
      for (const { pattern, ignore = [] } of def.urls) {
        const raw = pattern.exec(link)?.[1];
        if (!raw) continue;
        const slug = slugKey(def, raw);
        const list = found[def.id as AtsId];
        if (!ignore.includes(slug.toLowerCase()) && !list.includes(slug)) list.push(slug);
      }
    }
  }
  return found;
}
