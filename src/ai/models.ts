import { HttpError, type HttpClient } from '../util/http.js';

/** The provider's quota or rate limit is used up (HTTP 429). Callers stop asking and carry on without AI. */
export class AiQuotaError extends Error {}

/** Any other failure talking to the model. The message never includes the API key. */
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
  /** Base URL of an OpenAI-compatible API, without `/chat/completions`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** A client without retries: waiting out an exhausted quota only wastes the run. */
  http: HttpClient;
  maxTokens?: number;
}

/**
 * Chat completions of any OpenAI-compatible provider (Gemini, Groq, OpenAI, Azure...).
 * Only the posting and the profile text are sent, as data in the user message.
 */
export function createModelsClient(options: ModelsClientOptions): ChatClient {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const provider = new URL(endpoint).host;
  return {
    async complete(messages) {
      let response: unknown;
      try {
        response = await options.http.getJson(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}` },
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
        if (status === 429) throw new AiQuotaError(`${provider} quota reached`);
        if (status === 401 || status === 403) throw new AiError(`${provider} refused the API key (HTTP ${status})`);
        throw new AiError(status ? `${provider} returned HTTP ${status}` : `request to ${provider} failed`);
      }
      const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') throw new AiError(`${provider} returned an empty reply`);
      return content;
    },
  };
}
