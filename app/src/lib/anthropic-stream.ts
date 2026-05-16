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
  );

  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
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

  const response = await fetch(PROVIDER_URLS.anthropic.chat, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
