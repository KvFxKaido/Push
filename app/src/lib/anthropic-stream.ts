/**
 * Anthropic Claude direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/anthropic/chat`. The client serializes the
 * neutral `push.stream.v1` wire body (`toPushStreamWire`) — materialized
 * messages plus neutral scalars, tagged with `contract: "push.stream.v1"`. The
 * Worker (`handleAnthropicChat`) dual-accepts: a `contract` field routes to the
 * neutral branch, which serializes to Anthropic via `toAnthropicMessages`, POSTs
 * to `api.anthropic.com/v1/messages`, and returns the upstream stream translated
 * back to OpenAI SSE shape via `createAnthropicTranslatedStream`.
 *
 * Prompt materialization (`toLLMMessages`) stays client-side, so the wire carries
 * already-materialized `messages` and `systemPromptOverride` is baked in. The
 * *response* axis is unchanged — the client still reads OpenAI-shaped SSE. The
 * API key stays out of the browser (Worker-side injection).
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { toPushStreamWire } from '@push/lib/provider-wire';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getAnthropicKey } from '@/hooks/useAnthropicConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';
import { ProviderStreamError } from './stream-error';

export async function* anthropicStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'anthropic',
    providerModel: req.model,
    onPreCompact: req.onPreCompact,
    todoContent: req.todoContent,
    sessionDigestOptions: {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    linkedLibraryContent: req.linkedLibraryContent,
  });

  // Per-request flag wins; otherwise the Web Search menu's mode decides.
  // `'auto'` (the default) enables Anthropic's native `web_search_20250305`
  // server-side tool so Claude chats search the web without the user
  // having to opt in; explicit non-native backends suppress it.
  const anthropicWebSearch =
    req.anthropicWebSearch ?? isNativeWebSearchEnabled('anthropic', req.model);

  // Neutral `push.stream.v1` wire body. Sampling scalars and the web-search flag
  // ride as neutral fields; the Worker's dual-accept neutral branch serializes
  // them to Anthropic. System-prompt prefix caching is preserved unchanged: the
  // cacheable `toLLMMessages` output already bakes `cache_control` into the
  // system message's content-part array, which rides through the wire and is
  // honored by `toAnthropicMessages`. The separate `cacheBreakpointIndices`
  // rolling-tail mechanism is intentionally NOT sent — the legacy OpenAI-shape
  // body never carried it on this path, so enabling it is a deliberate change.
  const baseBody = toPushStreamWire(llmMessages, {
    provider: 'anthropic',
    model: req.model,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    ...(anthropicWebSearch ? { anthropicWebSearch: true } : {}),
    // Structured outputs: the neutral wire carries the JSON-Schema constraint
    // (validated by the wire guardrail); the Worker's `toAnthropicMessages`
    // turns it into a forced tool + `tool_choice`. Gated upstream by
    // `providerModelSupportsStructuredOutput('anthropic', model)`.
    ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
  });

  // The Worker prefers its own server-side ANTHROPIC_API_KEY when set and
  // ignores the client-side header. Sending the client key as a Bearer when
  // present preserves dev / unconfigured-Worker paths — the Worker uses the
  // same standardAuth fallback pattern as the other providers. Omit the
  // header entirely on empty key so the Worker's `keyMissingError` 401 fires.
  const apiKey = (getAnthropicKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // `pause_turn` continuation loop: the Anthropic bridge surfaces
  // `pause_turn` when the server-side sampling loop hits its iteration
  // cap mid-turn (common when `web_search_20250305` makes multiple
  // searches). We replay the assistant's captured content[] as the next
  // turn's prior assistant message; Anthropic resumes from where it
  // paused. Cap at 3 iterations as a runaway-defense — beyond that a
  // model is almost certainly stuck and the user would rather see what
  // we have than wait through more spins.
  const MAX_PAUSE_TURN_ITERATIONS = 3;
  // Paused assistant content[] arrays accumulate oldest-first across iterations.
  // The Worker forwards them to `toAnthropicMessages`' `replayAssistantTurns`,
  // which appends them as trailing assistant turns — the neutral-wire equivalent
  // of the old loop appending `assistant_content_blocks` messages inline.
  const replayAssistantTurns: Array<Array<Record<string, unknown>>> = [];
  for (let attempt = 0; attempt <= MAX_PAUSE_TURN_ITERATIONS; attempt += 1) {
    const currentBody =
      replayAssistantTurns.length > 0 ? { ...baseBody, replayAssistantTurns } : baseBody;
    const response = await fetch(PROVIDER_URLS.anthropic.chat, {
      method: 'POST',
      headers,
      body: JSON.stringify(currentBody),
      signal: req.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let detail = errBody;
      try {
        const parsed = JSON.parse(errBody);
        detail = parseProviderError(parsed, errBody.slice(0, 200), true);
      } catch {
        detail = errBody ? errBody.slice(0, 200) : 'empty body';
      }
      // Worker's handleAnthropicChat already prefixes its JSON error with
      // `Anthropic ${status}: …`, so don't re-prefix here — that produces
      // `Anthropic 401: Anthropic 401: …`. Fall back to a tagged prefix only
      // when the response came from somewhere other than our Worker (network
      // failure, dev proxy quirk) and didn't include the marker.
      const message = detail.startsWith('Anthropic ')
        ? detail
        : `Anthropic ${response.status}: ${detail}`;
      throw new ProviderStreamError(message, { status: response.status });
    }

    if (!response.body) {
      throw new Error('Anthropic response had no body');
    }

    let paused: Array<Record<string, unknown>> | null = null;
    for await (const event of openAISSEPump({
      body: response.body,
      signal: req.signal,
      isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
    })) {
      if (event.type === 'pause_turn') {
        paused = event.assistantBlocks;
        continue;
      }
      yield event;
    }

    // Defensive zero-length guard: the pump already drops empty pause_turn
    // events into `done` (see `openai-sse-pump.ts`), but treat an empty
    // array the same way at this layer so an upstream/test fake that emits
    // `pause_turn` with `[]` directly can't loop.
    if (!paused || paused.length === 0) return;
    if (attempt === MAX_PAUSE_TURN_ITERATIONS) {
      // Hit the cap. Synthesize a terminal `done` so the round loop sees
      // a clean finish — the user gets whatever text streamed through up
      // to this point instead of a hanging turn.
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    // Record the paused assistant blocks as the next request's replay turn.
    // The Worker forwards `replayAssistantTurns` to `toAnthropicMessages`, which
    // appends them as trailing assistant turns the upstream resumes from. The
    // next iteration rebuilds `currentBody` from `baseBody` + this growing array.
    replayAssistantTurns.push(paused);
  }
}
