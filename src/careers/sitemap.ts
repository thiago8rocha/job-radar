import { decodeEntities } from '../util/text.js';

export interface Sitemap {
  /** Page URLs of a `urlset`. */
  urls: string[];
  /** Child sitemaps of a `sitemapindex`. */
  sitemaps: string[];
}

export function parseSitemap(xml: string): Sitemap {
  const locations = (block: string) => [...block.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1]!));
  if (/<sitemapindex[\s>]/i.test(xml)) return { urls: [], sitemaps: locations(xml) };
  return { urls: locations(xml), sitemaps: [] };
}

/** The words of a posting URL's last path segment, as a stand-in for its title: `/jobs/8786914-qa-engineer` → `qa engineer`. */
export function titleFromUrl(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  return decodeURIComponent(last)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/^\d+[-_]/, '')
    .replace(/[-_+]+/g, ' ')
    .trim();
}
