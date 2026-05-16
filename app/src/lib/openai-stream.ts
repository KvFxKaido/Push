/**
 * OpenAI direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/openai/chat`. The Worker
 * (`handleOpenAIChat` in `app/src/worker/worker-providers.ts`) proxies the
 * request to `api.openai.com/v1/chat/completions` with Bearer auth and
 * pipes the OpenAI-shape SSE response back unchanged — no bridge needed
 * since OpenAI is, by definition, OpenAI-compatible.
 *
 * OpenAI's prompt caching is automatic at the prefix level (no
 * `cache_control` markers required), so this adapter doesn't need any of
 * the threading that direct-Anthropic requires.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* openaiStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'openai',
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

  // The Worker prefers its own server-side OPENAI_API_KEY when set and
  // ignores the client-side header. Sending the client key as a Bearer when
  // present preserves dev / unconfigured-Worker paths via standardAuth's
  // fallback. Omit the header entirely on empty key so the Worker's
  // keyMissingError 401 fires.
  const apiKey = (getOpenAIKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const response = await fetch(PROVIDER_URLS.openai.chat, {
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
    // Worker's handleOpenAIChat already prefixes its JSON error with
    // `OpenAI ${status}: …`, so don't re-prefix here.
    const message = detail.startsWith('OpenAI ') ? detail : `OpenAI ${response.status}: ${detail}`;
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('OpenAI response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
