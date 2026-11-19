const TRACKING_PARAMS = new Set(['source', 'gh_src', 'fbclid', 'gclid', 'jobBoardSource', 'ref']);

const GUPY_PORTAL_JOB = /^\/job\/([A-Za-z0-9+/_-]+={0,2})$/;

/** The Gupy portal links `/job/<base64 of {"jobId":N,...}>` while every other source links `/jobs/N`; both are the same posting. */
function gupyJobPath(pathname: string): string | undefined {
  const encoded = GUPY_PORTAL_JOB.exec(pathname)?.[1];
  if (!encoded) return undefined;
  try {
    const jobId: unknown = (JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { jobId?: unknown }).jobId;
    return typeof jobId === 'number' && Number.isInteger(jobId) ? `/jobs/${jobId}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canonical form of a job URL: no tracking parameters (`utm_*`, `source`, `gh_src`...),
 * no fragment and no trailing slash; Gupy portal links become `/jobs/<id>`.
 * Returns undefined when the value is not an http(s) URL.
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
  if (url.hostname.endsWith('.gupy.io')) url.pathname = gupyJobPath(url.pathname.replace(/\/+$/, '')) ?? url.pathname;
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
