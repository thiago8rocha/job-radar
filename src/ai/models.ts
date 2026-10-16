import { HttpError, type HttpClient } from '../util/http.js';

const ENDPOINT = 'https://models.github.ai/inference/chat/completions';

/** The free quota of GitHub Models is used up (HTTP 429). Callers stop asking and carry on without AI. */
export class AiQuotaError extends Error {}

/** Any other failure talking to the model. The message never includes the token. */
export class AiError extends Error {}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ChatClient {
  /** The model's reply as text. Throws AiQuotaError or AiError. */
  complete(messages: ChatMessage[]): Promise<string>;
}

export interface ModelsClientOptions {
  /** The workflow's `GITHUB_TOKEN`, with `permissions: models: read`. */
  token: string;
  model: string;
  /** A client without retries: waiting out an exhausted quota only wastes the run. */
  http: HttpClient;
  maxTokens?: number;
}

/**
 * GitHub Models chat completions, free within rate limits and billed to no one when paid usage is off.
 * Only the posting and the profile text are sent, as data in the user message.
 */
export function createModelsClient(options: ModelsClientOptions): ChatClient {
  return {
    async complete(messages) {
      let response: unknown;
      try {
        response = await options.http.getJson(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: {
            model: options.model,
            messages,
            temperature: 0.2,
            max_tokens: options.maxTokens ?? 700,
            response_format: { type: 'json_object' },
          },
        });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : undefined;
        if (status === 429) throw new AiQuotaError('GitHub Models quota reached');
        if (status === 401 || status === 403) {
          throw new AiError('GitHub Models refused the token; the workflow needs "permissions: models: read"');
        }
        throw new AiError(status ? `GitHub Models returned HTTP ${status}` : 'GitHub Models request failed');
      }
      const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') throw new AiError('GitHub Models returned an empty reply');
      return content;
    },
  };
}
