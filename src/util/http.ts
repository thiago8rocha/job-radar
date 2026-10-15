import { setTimeout as sleep } from 'node:timers/promises';

export const USER_AGENT = 'job-radar (+https://github.com/thiago8rocha/job-radar)';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpClient {
  getJson(url: string, options?: RequestOptions): Promise<unknown>;
}

export interface HttpClientOptions {
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries after HTTP 429 and 5xx, with backoff (or the server's Retry-After). */
  retries?: number;
  /** Base for the exponential backoff, in ms. */
  backoffMs?: number;
  /** Minimum time between two requests to the same host, in ms. */
  hostDelayMs?: number;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * JSON-over-HTTP client for the source adapters: identifying User-Agent, a timeout, retry with
 * backoff on 429 and 5xx, and a small delay between requests to the same host.
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const { timeoutMs = 20_000, retries = 3, backoffMs = 1000, hostDelayMs = 0 } = options;
  const lastRequest = new Map<string, number>();

  async function throttle(url: string): Promise<void> {
    if (hostDelayMs <= 0) return;
    const host = new URL(url).host;
    const wait = (lastRequest.get(host) ?? 0) + hostDelayMs - Date.now();
    lastRequest.set(host, Math.max(Date.now(), (lastRequest.get(host) ?? 0) + hostDelayMs));
    if (wait > 0) await sleep(wait);
  }

  return {
    async getJson(url, request = {}) {
      for (let attempt = 0; ; attempt++) {
        await throttle(url);
        const response = await fetch(url, {
          method: request.method ?? 'GET',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...request.headers,
          },
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok) return response.json();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= retries) throw new HttpError(response.status, url);
        await sleep(retryAfterMs(response.headers.get('retry-after')) ?? backoffMs * 2 ** attempt);
      }
    },
  };
}
