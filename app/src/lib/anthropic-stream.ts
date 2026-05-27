/**
 * Anthropic Claude direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/anthropic/chat`. The Worker (`handleAnthropicChat`
 * in `app/src/worker/worker-providers.ts`) translates the OpenAI-shaped body via
 * `buildAnthropicMessagesRequest`, POSTs to `api.anthropic.com/v1/messages` with
 * the `x-api-key` + `anthropic-version` headers, and returns the upstream stream
 * already translated back to OpenAI SSE shape via `createAnthropicTranslatedStream`.
 *
 * So from the client adapter's perspective this looks identical to any other
 * OpenAI-compatible provider: send OpenAI-shaped JSON, read OpenAI-shaped SSE.
 * The Anthropic-specific protocol details live on the Worker side, which keeps
 * the API key out of the browser.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getAnthropicKey } from '@/hooks/useAnthropicConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';

export async function* anthropicStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'anthropic',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
    {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    req.linkedLibraryContent,
  );

  // Per-request flag wins; otherwise the Web Search menu's mode decides.
  // `'auto'` (the default) enables Anthropic's native `web_search_20250305`
  // server-side tool so Claude chats search the web without the user
  // having to opt in; explicit non-native backends suppress it.
  const anthropicWebSearch =
    req.anthropicWebSearch ?? isNativeWebSearchEnabled('anthropic', req.model);

  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(anthropicWebSearch ? { anthropic_web_search: true } : {}),
  };

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
  let currentBody = body;
  for (let attempt = 0; attempt <= MAX_PAUSE_TURN_ITERATIONS; attempt += 1) {
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
      throw new Error(message);
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

    if (!paused) return;
    if (attempt === MAX_PAUSE_TURN_ITERATIONS) {
      // Hit the cap. Synthesize a terminal `done` so the round loop sees
      // a clean finish — the user gets whatever text streamed through up
      // to this point instead of a hanging turn.
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    // Append the paused assistant blocks as the next request's prior
    // assistant turn. The Anthropic bridge picks up
    // `assistant_content_blocks` and uses them verbatim as the upstream
    // content[]. Cloning by spread keeps each iteration's body
    // independent for telemetry / debugging.
    const nextMessages = Array.isArray(currentBody.messages)
      ? [...(currentBody.messages as unknown[])]
      : [];
    nextMessages.push({ role: 'assistant', assistant_content_blocks: paused });
    currentBody = { ...currentBody, messages: nextMessages };
  }
}
