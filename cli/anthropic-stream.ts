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
 * Reasoning blocks ride through verbatim. When `LlmMessage.reasoningBlocks`
 * is populated on an assistant turn (typically by a lib-side agent role
 * that captured them from a prior `reasoning_block` event), they're
 * forwarded as `reasoning_blocks` on the OpenAI-shaped message, and the
 * bridge re-emits them as the FIRST entries of the upstream assistant
 * `content[]` so signed thinking round-trips across chained turns.
 * Without this, Anthropic + extended-thinking + tool-use combinations
 * 400 on the second turn with `invalid_request_error`.
 *
 * Prompt caching: when `req.cacheBreakpointIndices` is set, the system
 * message + indicated tail messages get tagged with
 * `cache_control: { type: 'ephemeral' }`. The bridge preserves these
 * markers as it translates into Anthropic block shape, so direct-Anthropic
 * CLI sessions get the same Hermes `system_and_3` prefix caching the
 * OpenRouter-Anthropic CLI path already has. Anthropic caps a request at
 * 4 cache breakpoints; the tail is hard-capped here at
 * MAX_ROLLING_CACHE_BREAKPOINTS as a wire-layer defense.
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
import type {
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIMessage,
} from '../lib/openai-chat-types.ts';
import { MAX_ROLLING_CACHE_BREAKPOINTS } from '../lib/context-transformer.ts';
import { CliProviderError } from './openai-stream.ts';
import type { ProviderConfig } from './provider.ts';

const ANTHROPIC_API_VERSION = '2023-06-01';

/** Per-request flag wins; otherwise Anthropic's native `web_search_20250305`
 *  tool defaults ON so Claude CLI chats search the web without an opt-in
 *  step (parity with the web app's `'auto'` web-search mode). Set
 *  `PUSH_ANTHROPIC_WEB_SEARCH=0` (or `false`/`no`/`off`) to disable. */
function resolveAnthropicWebSearch(req: PushStreamRequest<LlmMessage>): boolean {
  if (typeof req.anthropicWebSearch === 'boolean') return req.anthropicWebSearch;
  const env = process.env.PUSH_ANTHROPIC_WEB_SEARCH?.trim().toLowerCase();
  if (!env) return true;
  return !(env === '0' || env === 'false' || env === 'no' || env === 'off');
}

export function createCliAnthropicStream(
  config: ProviderConfig,
  apiKey: string,
): PushStream<LlmMessage> {
  return (req: PushStreamRequest<LlmMessage>): AsyncIterable<PushStreamEvent> =>
    cliAnthropicStream(config, apiKey, req);
}

/** Tag a message's content with `cache_control: ephemeral`. Promotes a
 *  bare-string content to a single-element block array so the bridge sees
 *  the marker — preserving it through translation requires the array form. */
function tagWithCacheControl(message: OpenAIMessage): void {
  if (typeof message.content === 'string') {
    message.content = [
      { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
    ];
    return;
  }
  if (Array.isArray(message.content) && message.content.length > 0) {
    // Already an array (multimodal / future attachment shape). Tag the last
    // text part so multi-part messages don't lose their cache slot —
    // mirrors `cli/openai-stream.ts`.
    const lastPart: OpenAIContentPart | undefined = message.content[message.content.length - 1];
    if (lastPart && lastPart.type === 'text') {
      lastPart.cache_control = { type: 'ephemeral' };
    }
  }
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
  const systemPrependOffset =
    typeof req.systemPromptOverride === 'string' && req.systemPromptOverride ? 1 : 0;
  if (systemPrependOffset === 1) {
    openAIMessages.push({ role: 'system', content: req.systemPromptOverride as string });
  }
  for (const m of req.messages) {
    // `reasoningBlocks` only meaningful on assistant turns; the bridge
    // skips them on user/system messages. Forward unconditionally and let
    // the bridge filter — keeps the mapper simple.
    const msg: OpenAIMessage = { role: m.role, content: m.content };
    if (m.reasoningBlocks && m.reasoningBlocks.length > 0) {
      msg.reasoning_blocks = m.reasoningBlocks;
    }
    openAIMessages.push(msg);
  }

  // Apply cache_control tagging when the caller opted in. Unlike
  // `cli/openai-stream.ts`'s OpenRouter gating, we know the upstream here
  // is Anthropic, so no `config.id` check is needed — the bridge
  // preserves the markers verbatim into Anthropic block shape.
  const rawBreakpoints = req.cacheBreakpointIndices;
  if (Array.isArray(rawBreakpoints) && rawBreakpoints.length > 0) {
    if (openAIMessages[0]?.role === 'system') {
      tagWithCacheControl(openAIMessages[0]);
    }
    // Hard cap at MAX_ROLLING_CACHE_BREAKPOINTS — slice the most recent N
    // if the caller provided more. Anthropic's per-request cap is 4
    // (system + 3); this defends against a transformer-bypass that
    // would otherwise blow the budget.
    const breakpoints = rawBreakpoints.slice(-MAX_ROLLING_CACHE_BREAKPOINTS);
    for (const reqIndex of breakpoints) {
      const wireIndex = reqIndex + systemPrependOffset;
      const target = openAIMessages[wireIndex];
      if (!target) continue;
      // Skip duplicate tagging when the rolling tail's index 0 collides
      // with the system message that was already tagged above. When
      // there's no system at wire index 0 (user-first transcript), index
      // 0 legitimately belongs to the tail and must be tagged.
      if (wireIndex === 0 && openAIMessages[0]?.role === 'system') continue;
      tagWithCacheControl(target);
    }
  }

  const openAIRequest: OpenAIChatRequest = {
    model,
    messages: openAIMessages,
    stream: true,
    temperature: req.temperature ?? 0.1,
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(resolveAnthropicWebSearch(req) ? { anthropic_web_search: true } : {}),
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  // `pause_turn` continuation loop — mirrors `app/src/lib/anthropic-stream.ts`.
  // The Anthropic bridge surfaces `pause_turn` when the server-side
  // sampling loop hits its iteration cap (web_search_20250305 can trigger
  // this for multi-search turns); we replay the assistant's captured
  // content[] until the turn terminates. Capped at 3 iterations.
  const MAX_PAUSE_TURN_ITERATIONS = 3;
  let currentRequest = openAIRequest;
  for (let attempt = 0; attempt <= MAX_PAUSE_TURN_ITERATIONS; attempt += 1) {
    const upstreamBody = JSON.stringify({
      ...buildAnthropicMessagesRequest(currentRequest),
      model,
    });

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

    const translated = createAnthropicTranslatedStream(response, model);
    let paused: Array<Record<string, unknown>> | null = null;
    for await (const event of openAISSEPump({ body: translated, signal: req.signal })) {
      if (event.type === 'pause_turn') {
        paused = event.assistantBlocks;
        continue;
      }
      yield event;
    }

    if (!paused) return;
    if (attempt === MAX_PAUSE_TURN_ITERATIONS) {
      // Cap exhausted. Synthesize a terminal `done` so the consumer
      // doesn't hang — whatever text streamed so far becomes the answer.
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    currentRequest = {
      ...currentRequest,
      messages: [
        ...(currentRequest.messages ?? []),
        { role: 'assistant', assistant_content_blocks: paused },
      ],
    };
  }
}
