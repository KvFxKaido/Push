/**
 * Azure OpenAI PushStream implementation (client-side).
 *
 * Hits the Worker proxy at `/api/azure/chat`, then delegates SSE parsing
 * to the shared `openAISSEPump` in `lib/`. The Worker
 * (`createExperimentalStreamProxyHandler('azure', ...)` in
 * `app/src/worker/worker-providers.ts`) forwards the request to the
 * configured upstream — extracted from the `X-Push-Upstream-Base` header
 * the client sends — and proxies the upstream OpenAI-compatible SSE
 * response back unchanged.
 *
 * Auth: Bearer token. The Worker uses `passthroughAuth`, which forwards
 * the client's `Authorization` header verbatim (no env-key override). Per
 * the Phase 10b auth sweep, omit Authorization when the client key is
 * empty so the Worker's `keyMissingError` 401 fires instead of an empty
 * `Bearer ` being forwarded upstream.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getAzureBaseUrl, getAzureKey } from '@/hooks/useExperimentalProviderConfig';
import { PROVIDER_URLS } from './providers';
import { buildExperimentalProxyHeaders } from './experimental-providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* azureStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context flows
  //    through the adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'azure',
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

  // 2. Plain OpenAI-compatible request body. The Worker forwards verbatim.
  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
  };

  // 3. Headers. The Worker reads `X-Push-Upstream-Base` to pick the upstream
  //    chat endpoint, so a missing/invalid base URL is a hard client-side
  //    error. Bearer auth is omitted on empty key so `keyMissingError` fires
  //    instead of forwarding an empty bearer (Phase 10b auth sweep pattern).
  const proxyHeaders = buildExperimentalProxyHeaders('azure', getAzureBaseUrl());
  if (!proxyHeaders['X-Push-Upstream-Base']) {
    throw new Error('Azure OpenAI base URL is missing or invalid');
  }
  const apiKey = (getAzureKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...proxyHeaders,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.azure.chat, {
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
    throw new Error(`Azure OpenAI ${response.status}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('Azure OpenAI response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
