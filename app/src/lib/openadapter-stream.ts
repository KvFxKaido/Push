/**
 * OpenAdapter PushStream implementation.
 *
 * Hits the Worker proxy at `/api/openadapter/chat`, then delegates SSE
 * parsing to the shared `openAISSEPump` in `lib/`.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here. Plain OpenAI-
 * compatible gateway: single endpoint, Bearer auth, no provider-specific
 * body extensions.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getOpenAdapterKey } from '@/hooks/useOpenAdapterConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* openadapterStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'openadapter',
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

  // Omit Authorization entirely when no client key is configured —
  // `standardAuth` treats any non-empty client `Authorization` as "key
  // supplied" and skips the Worker's `keyMissingError` 401, so sending
  // `Bearer ` would bypass the configured fallback and forward an empty
  // bearer upstream.
  const apiKey = (getOpenAdapterKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const response = await fetch(PROVIDER_URLS.openadapter.chat, {
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
    throw new Error(`OpenAdapter ${response.status}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('OpenAdapter response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
