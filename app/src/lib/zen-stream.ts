/**
 * OpenCode Zen PushStream implementation.
 *
 * Hits the Zen chat endpoint (or the Zen Go endpoint when Go mode is on),
 * then delegates SSE parsing to the shared `openAISSEPump` in `lib/`.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { toOpenAIResponseFormat } from '@push/lib/openai-chat-serializer';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getZenKey } from '@/hooks/useZenConfig';
import { PROVIDER_URLS, ZEN_GO_URLS, getZenGoMode } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { ProviderStreamError } from './stream-error';

export async function* zenStream(
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
    providerType: 'zen',
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

  // 2. Plain OpenAI-compatible request body — Zen has no provider-specific
  //    extensions.
  const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : [];
  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    // Native function calling: forward the caller's tool schemas (gated on model
    // support via `providerModelSupportsNativeToolCalling`) so the OpenAI-compatible
    // endpoint can answer through its constrained tool-calling path. Additive to
    // text-dispatch — `openAISSEPump` normalizes any native `tool_calls` back into
    // the fenced JSON the dispatcher consumes. `tool_choice: 'auto'` keeps prose
    // answers available when no tool is needed. In Go mode the body is forwarded
    // verbatim to the OpenAI-transport endpoint (the legacy validator preserves
    // unknown fields); the Anthropic-transport Go models rebuild their own body
    // and drop `tools`, so they fall back to text-dispatch (see model-catalog's
    // ZEN_NATIVE_TOOL_CALLING_MODELS note).
    ...(nativeTools.length > 0 ? { tools: nativeTools, tool_choice: 'auto' } : {}),
    // Native structured outputs: forward the caller's JSON-Schema constraint so
    // the OpenAI-compatible endpoint constrains generation server-side. Shared
    // wire builder with the CLI/OpenRouter paths. No `provider.require_parameters`
    // guard — that field is OpenRouter-specific.
    ...(req.responseFormat ? { response_format: toOpenAIResponseFormat(req.responseFormat) } : {}),
  };

  // 3. Headers. Zen uses a straight Bearer token. The Go-mode URL switch is
  //    the only endpoint branch. Omit the header entirely when no client key
  //    is configured — `standardAuth` treats any non-empty client
  //    `Authorization` as "key supplied" and skips the Worker's
  //    `keyMissingError` 401, so sending `Bearer ` would bypass the
  //    configured fallback and forward an empty bearer upstream.
  const apiKey = (getZenKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const url = getZenGoMode() ? ZEN_GO_URLS.chat : PROVIDER_URLS.zen.chat;

  // 4. POST + stream response.
  const response = await fetch(url, {
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
    throw new ProviderStreamError(`OpenCode Zen ${response.status}: ${detail}`, {
      status: response.status,
    });
  }

  if (!response.body) {
    throw new Error('OpenCode Zen response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
