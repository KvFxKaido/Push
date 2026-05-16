/**
 * CLI native-Gemini PushStream.
 *
 * Calls `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
 * directly with `x-goog-api-key`, translates the OpenAI-shaped body via the
 * shared bridge (`lib/openai-gemini-bridge.ts`), then pumps the upstream
 * SSE through `createGeminiTranslatedStream` so the events leave this
 * adapter in OpenAI Chat-Completions shape.
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
import {
  buildGeminiGenerateContentRequest,
  createGeminiTranslatedStream,
} from '../lib/openai-gemini-bridge.ts';
import { openAISSEPump } from '../lib/openai-sse-pump.ts';
import type { OpenAIChatRequest, OpenAIMessage } from '../lib/openai-chat-types.ts';
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

async function* cliGeminiStream(
  config: ProviderConfig,
  apiKey: string,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const model = req.model && req.model.trim() ? req.model : config.defaultModel;

  const openAIMessages: OpenAIMessage[] = [];
  if (req.systemPromptOverride) {
    openAIMessages.push({ role: 'system', content: req.systemPromptOverride });
  }
  for (const m of req.messages) {
    openAIMessages.push({ role: m.role, content: m.content });
  }

  const openAIRequest: OpenAIChatRequest = {
    model,
    messages: openAIMessages,
    stream: true,
    temperature: req.temperature ?? 0.1,
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
  };

  const upstreamBody = JSON.stringify(buildGeminiGenerateContentRequest(openAIRequest));
  const upstreamUrl = buildGeminiUpstreamUrl(config.url, model);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;

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

  const translated = createGeminiTranslatedStream(response, model);
  yield* openAISSEPump({ body: translated, signal: req.signal });
}
