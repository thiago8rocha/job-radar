import type { HttpClient } from '../util/http.js';

const ENDPOINT = 'https://serpapi.com/search.json';

/** SerpAPI answers 200 with `error` for a query that simply has no results; that is not a failure. */
const NO_RESULTS = /hasn't returned any results|no results/i;

export class SerpApiError extends Error {}

/**
 * One SerpAPI search. The key travels in the query string, as SerpAPI requires, so it must never be
 * logged: callers pass only the parsed response onwards, and errors here never include the URL.
 */
export async function serpApiSearch(
  http: HttpClient,
  apiKey: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ ...params, api_key: apiKey });
  let body: unknown;
  try {
    body = await http.getJson(`${ENDPOINT}?${query}`);
  } catch (error) {
    // HttpError messages carry the URL, which holds the key
    const status = (error as { status?: number }).status;
    throw new SerpApiError(status ? `SerpAPI returned HTTP ${status}` : 'SerpAPI request failed');
  }
  if (typeof body !== 'object' || body === null) throw new SerpApiError('SerpAPI returned an unexpected response');
  const result = body as Record<string, unknown>;
  if (typeof result.error === 'string') {
    if (NO_RESULTS.test(result.error)) return {};
    throw new SerpApiError(`SerpAPI: ${result.error}`);
  }
  return result;
}
