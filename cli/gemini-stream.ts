/**
 * CLI native-Gemini PushStream.
 *
 * Calls `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
 * directly with `x-goog-api-key`, builds the `:generateContent` body straight
 * from the neutral `PushStreamRequest` via `toGeminiGenerateContent`, and parses
 * the upstream SSE directly into neutral `PushStreamEvent`s via
 * `geminiEventStream` (no OpenAI-SSE serialize/reparse round-trip). The direct
 * web Gemini path now uses this same native pump — the worker proxies Gemini's
 * raw upstream SSE straight through — so there is no translator left.
 *
 * Shape mirrors the Worker's `handleGoogleChat`. Difference vs the Worker
 * version: no preamble / rate-limit preflight, and `config.url` is treated
 * as the API base (the model name is appended into the URL path; if a
 * caller pre-bakes a fully-qualified `:streamGenerateContent` URL we use
 * it as-is).
 *
 * The bridge handles all of Gemini's wire-shape quirks (role rename,
 * `systemInstruction` hoist, `generationConfig` placement, user-first
 * padding, CRLF SSE normalization). This adapter is the thin transport
 * shim.
 */

import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '../lib/provider-contract.ts';
import { aiGatewaySkipCacheHeaders } from '../lib/ai-gateway.ts';
import { geminiEventStream, toGeminiGenerateContent } from '../lib/gemini-bridge.ts';
import { CliProviderError } from './openai-stream.ts';
import type { ProviderConfig } from './provider.ts';

/** Append the streamGenerateContent path onto a `generativelanguage.googleapis.com/v1beta`
 *  base URL. If the caller pre-baked a full URL with `:streamGenerateContent`
 *  in it, return it untouched — supports `PUSH_GOOGLE_URL` overrides that
 *  want to hit a different endpoint (e.g. a regional mirror). */
export function buildGeminiUpstreamUrl(baseUrl: string, model: string): string {
  if (baseUrl.includes(':streamGenerateContent')) return baseUrl;
  const trimmed = baseUrl.replace(/\/$/, '');
  return `${trimmed}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function createCliGeminiStream(
  config: ProviderConfig,
  apiKey: string,
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliGeminiStream(config, apiKey, req);
}

/** Per-request flag wins; otherwise grounding defaults ON so Gemini chats
 *  get the native `googleSearch` tool without an opt-in step (parity with
 *  the web app's `'auto'` web-search mode). Set
 *  `PUSH_GOOGLE_SEARCH_GROUNDING=0` (or `false`/`no`/`off`) to disable. */
function resolveGoogleSearchGrounding(req: PushStreamRequest<LlmMessage>): boolean {
  if (typeof req.googleSearchGrounding === 'boolean') return req.googleSearchGrounding;
  const env = process.env.PUSH_GOOGLE_SEARCH_GROUNDING?.trim().toLowerCase();
  if (!env) return true;
  return !(env === '0' || env === 'false' || env === 'no' || env === 'off');
}

async function* cliGeminiStream(
  config: ProviderConfig,
  apiKey: string,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const model = req.model && req.model.trim() ? req.model : config.defaultModel;

  // Direct neutral → Gemini serialization (no OpenAI Chat-Completions
  // intermediate — see docs/runbooks/Provider Request Normalization.md). The
  // serializer carries multimodal `contentParts` and fails loudly on a part it
  // can't represent; `temperatureDefault: 0.1` preserves the CLI's historical
  // default.
  const upstreamBody = JSON.stringify(
    toGeminiGenerateContent(req, {
      enableGoogleSearch: resolveGoogleSearchGrounding(req),
      temperatureDefault: 0.1,
    }),
  );
  const upstreamUrl = buildGeminiUpstreamUrl(config.url, model);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  Object.assign(headers, aiGatewaySkipCacheHeaders(upstreamUrl));

  const response = await fetch(upstreamUrl, {
    method: 'POST',
    headers,
    body: upstreamBody,
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)');
    throw new CliProviderError(
      `Provider error ${response.status} [provider=${config.id} model=${model} url=${upstreamUrl}]: ${errBody.slice(0, 400)}`,
      response.status,
    );
  }

  if (!response.body) {
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  yield* geminiEventStream(response, req.signal);
}
