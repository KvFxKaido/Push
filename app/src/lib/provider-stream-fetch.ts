/**
 * Shared traced POST + error normalization for the provider stream-family
 * adapters (`openai-responses-stream-family`, `openai-chat-stream-family`,
 * `anthropic-stream-family`).
 *
 * This is transport plumbing only — request headers, the fetch itself,
 * Worker-error normalization, and response-body validation. Wire-body
 * construction and SSE pumping stay in the family adapters, so this helper
 * cannot grow into the mega-adapter the Runtime Unification Plan rules out.
 */

import { parseProviderError } from './orchestrator-streaming';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { ProviderStreamError } from './stream-error';
import { injectTraceHeaders } from './tracing';

/**
 * `always` re-prefixes every error with `<displayName> <status>:` (the
 * historical behavior of leaves whose Worker route never prefixed);
 * `preserve-worker-prefix` keeps a detail the Worker already prefixed with
 * the display name, avoiding `Anthropic 401: Anthropic 401: …` doubling.
 */
export type ProviderErrorPrefixMode = 'always' | 'preserve-worker-prefix';

/**
 * Standard family headers: JSON content type, per-request id, optional client
 * Bearer, trace propagation. The Worker prefers its own server-side provider
 * key when set and ignores the client header; sending the client key when
 * present preserves dev / unconfigured-Worker paths via standardAuth's
 * fallback. Omit the header entirely on an empty key so the Worker's
 * `keyMissingError` 401 fires — sending `Bearer ` would be treated as "key
 * supplied" and forward an empty bearer upstream.
 */
export function buildProviderStreamHeaders(
  apiKey: string | null | undefined,
): Record<string, string> {
  const trimmed = (apiKey ?? '').trim();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: createRequestId('chat'),
    ...(trimmed ? { Authorization: `Bearer ${trimmed}` } : {}),
  };
  injectTraceHeaders(headers);
  return headers;
}

export interface PostProviderStreamOptions {
  endpoint: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  displayName: string;
  errorPrefix: ProviderErrorPrefixMode;
}

/** A validated streaming response — `body` is proven non-null by the helper. */
export type ProviderStreamResponse = Response & { body: ReadableStream<Uint8Array> };

/**
 * POST the serialized body and validate the streaming response. Non-OK
 * responses throw `ProviderStreamError` with the normalized Worker error;
 * an OK response without a body throws a named plain error. Returns the
 * validated `Response` so families can hand it to their own SSE consumer.
 */
export async function postProviderStream(
  options: PostProviderStreamOptions,
): Promise<ProviderStreamResponse> {
  const response = await fetch(options.endpoint, {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let detail: string;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    const preserveWorkerPrefix =
      options.errorPrefix === 'preserve-worker-prefix' &&
      detail.startsWith(`${options.displayName} `);
    const message = preserveWorkerPrefix
      ? detail
      : `${options.displayName} ${response.status}: ${detail}`;
    throw new ProviderStreamError(message, { status: response.status });
  }

  if (!response.body) {
    throw new Error(`${options.displayName} response had no body`);
  }

  return response as ProviderStreamResponse;
}
