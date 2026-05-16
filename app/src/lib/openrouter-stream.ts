/**
 * OpenRouter PushStream implementation.
 *
 * Hits the existing Worker proxy at `/api/openrouter/chat` (or the Vite dev
 * passthrough at `/openrouter/api/v1/chat/completions`), then delegates SSE
 * parsing to the shared `openAISSEPump` in `lib/`.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { buildOpenRouterTrace, getOpenRouterSessionId } from './openrouter-session';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { openRouterModelSupportsReasoning, getReasoningEffort } from './model-catalog';
import { PROVIDER_URLS } from './providers';
import type { WorkspaceContext } from '@/types';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* openrouterStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context
  //    (workspaceContext, hasSandbox, onPreCompact) flows through the
  //    adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'openrouter',
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

  // 2. Layer in OpenRouter-specific body extensions (reasoning effort,
  //    Push session id, trace flags). These were previously injected via the
  //    legacy `bodyTransform` slot on `StreamProviderConfig`; that slot is
  //    gone post-Phase-9c, so the wire shape now lives here directly.
  const supportsReasoning = openRouterModelSupportsReasoning(req.model);
  const effort = getReasoningEffort('openrouter');
  const useReasoning = supportsReasoning && effort !== 'off';
  const sessionId = getOpenRouterSessionId();
  const trace = buildOpenRouterTrace();

  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(useReasoning ? { reasoning: { effort } } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    trace,
  };

  // 3. Headers. The Worker proxy overrides Authorization server-side when
  //    OPENROUTER_API_KEY is configured; we still send the client-side key
  //    so dev (Vite passthrough) and unconfigured-Worker paths work. Omit
  //    the header entirely when no client key is configured — `standardAuth`
  //    treats any non-empty client `Authorization` as "key supplied" and
  //    skips the Worker's `keyMissingError` 401, so sending `Bearer ` would
  //    bypass the configured fallback and forward an empty bearer upstream.
  const apiKey = (getOpenRouterKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.openrouter.chat, {
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
    throw new Error(`OpenRouter ${response.status}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('OpenRouter response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
