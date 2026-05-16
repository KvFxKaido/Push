/**
 * CLI native-Anthropic PushStream.
 *
 * Calls `https://api.anthropic.com/v1/messages` directly with `x-api-key`,
 * translates the OpenAI-shaped body via the shared bridge
 * (`lib/openai-anthropic-bridge.ts`), then pumps the upstream Messages-API
 * stream through `createAnthropicTranslatedStream` so the events leave this
 * adapter in OpenAI Chat-Completions shape — exactly what `openAISSEPump`
 * (and downstream consumers) already expect.
 *
 * Shape mirrors the Worker's `handleAnthropicChat`: build body via
 * `buildAnthropicMessagesRequest`, POST, translate response, yield events.
 * Difference vs the Worker version: the CLI has no preamble / rate-limit
 * preflight, and the API key is read from `process.env` (or passed in)
 * rather than from a Worker secret.
 *
 * Reasoning blocks are NOT forwarded here today — `LlmMessage` in
 * `lib/provider-contract.ts` doesn't carry the `reasoning_blocks` sidecar,
 * so the bridge re-emits an empty reasoning prefix on every turn. Chained
 * extended-thinking + tool-use round trips therefore degrade to the same
 * (lossy) behavior the OpenRouter-Anthropic CLI path has today; persistence
 * on `Message` still survives so a follow-up can opt in by extending the
 * mapper plus the contract.
 */

import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '../lib/provider-contract.ts';
import {
  buildAnthropicMessagesRequest,
  createAnthropicTranslatedStream,
} from '../lib/openai-anthropic-bridge.ts';
import { openAISSEPump } from '../lib/openai-sse-pump.ts';
import type { OpenAIChatRequest, OpenAIMessage } from '../lib/openai-chat-types.ts';
import { CliProviderError } from './openai-stream.ts';
import type { ProviderConfig } from './provider.ts';

const ANTHROPIC_API_VERSION = '2023-06-01';

export function createCliAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliAnthropicStream(config, apiKey, req);
}

async function* cliAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
  req: PushStreamRequest<LlmMessage>,
): AsyncIterable<PushStreamEvent> {
  const model = req.model && req.model.trim() ? req.model : config.defaultModel;

  // Build an OpenAI-shaped request so the shared bridge can translate it.
  // Two callers feed messages differently (see `cli/openai-stream.ts` for
  // the comment); handle both by treating an unset `systemPromptOverride`
  // as "system already in messages".
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

  // `buildAnthropicMessagesRequest` does not include `model` in the body
  // (the Worker re-attaches it for the direct API; the Vertex path carries
  // it in the URL). Direct `/v1/messages` requires `model` in JSON, so
  // re-attach here too — same as the Worker's `handleAnthropicChat`.
  const upstreamBody = JSON.stringify({
    ...buildAnthropicMessagesRequest(openAIRequest),
    model,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: upstreamBody,
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '(no body)');
    throw new CliProviderError(
      `Provider error ${response.status} [provider=${config.id} model=${model} url=${config.url}]: ${errBody.slice(0, 400)}`,
      response.status,
    );
  }

  if (!response.body) {
    // The Messages API normally streams. A bodyless response means upstream
    // declined to stream (rare; usually only on errors which we've already
    // handled). Yield a synthetic terminal event so the consumer doesn't
    // hang waiting for `done`.
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  // Translate the Anthropic SSE into OpenAI-shaped SSE, then pump it through
  // the standard parser. This keeps every downstream consumer (CLI engine,
  // daemon-provider-stream, lib-side agent roles) on a single event surface.
  const translated = createAnthropicTranslatedStream(response, model);
  yield* openAISSEPump({ body: translated, signal: req.signal });
}
