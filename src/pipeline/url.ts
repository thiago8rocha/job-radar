const TRACKING_PARAMS = new Set(['source', 'gh_src', 'fbclid', 'gclid', 'jobBoardSource', 'ref']);

/**
 * Canonical form of a job URL: no tracking parameters (`utm_*`, `source`, `gh_src`...),
 * no fragment and no trailing slash. Returns undefined when the value is not an http(s) URL.
 */
export function canonicalUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
