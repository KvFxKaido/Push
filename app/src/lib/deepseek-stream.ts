/**
 * DeepSeek PushStream implementation.
 *
 * Hits the direct DeepSeek chat endpoint (api.deepseek.com, OpenAI-compatible),
 * then delegates SSE parsing to the shared `openAISSEPump` in `lib/`.
 *
 * DeepSeek's reasoning models (thinking mode) stream their chain-of-thought as
 * `reasoning_content` deltas, which `openAISSEPump` already splits into the
 * reasoning channel. Unlike the Zen Go gateway, the direct DeepSeek API rejects
 * `reasoning_content` echoed back on input, so prior CoT is intentionally NOT
 * replayed (the chat lock keeps `routeReplaysReasoningContent` zen-only).
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { flatToolToOpenAITool, toOpenAIResponseFormat } from '@push/lib/openai-chat-serializer';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { ProviderStreamError } from './stream-error';

export async function* deepseekStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context flows
  //    through the adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'deepseek',
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

  // 2. Plain OpenAI-compatible request body — no DeepSeek-specific fields.
  const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : undefined;
  const openAITools = nativeTools?.map(flatToolToOpenAITool);
  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    // Native function calling: forward the caller's tool schemas (gated on model
    // support upstream) so the OpenAI-compatible endpoint can answer through its
    // constrained tool-calling path. Additive to text-dispatch — `openAISSEPump`
    // emits native `tool_calls` as structured events. `tool_choice: 'auto'` keeps
    // prose answers available when no tool is needed.
    ...(openAITools ? { tools: openAITools, tool_choice: 'auto' } : {}),
    // Native structured outputs: forward the caller's JSON-Schema constraint so
    // the OpenAI-compatible endpoint constrains generation server-side.
    ...(req.responseFormat ? { response_format: toOpenAIResponseFormat(req.responseFormat) } : {}),
  };

  // 3. Headers. Bearer auth, single endpoint. Omit the header entirely when no
  //    client key is configured — `standardAuth` treats any non-empty client
  //    `Authorization` as "key supplied" and skips the Worker's
  //    `keyMissingError` 401, so sending `Bearer ` would bypass the configured
  //    fallback and forward an empty bearer upstream.
  const apiKey = (getDeepSeekKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.deepseek.chat, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let detail: string;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    throw new ProviderStreamError(`DeepSeek ${response.status}: ${detail}`, {
      status: response.status,
    });
  }

  if (!response.body) {
    throw new Error('DeepSeek response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
