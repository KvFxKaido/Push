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
import { toPushStreamWire } from '@push/lib/provider-wire';
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

  // 2. Request body — two shapes by tier:
  //    - **Go mode** posts the neutral `push.stream.v1` wire (`toPushStreamWire`)
  //      to `handleZenGoChat`, which dual-accepts and re-serializes per transport
  //      (`toOpenAIChat` for the OpenAI-transport models, `toAnthropicMessages`
  //      for the minimax/qwen Anthropic transport). Native FC schemas + the
  //      structured-output constraint ride as neutral fields; the Worker's
  //      `toOpenAIChat` emits `tools` + `tool_choice: 'auto'` and `response_format`
  //      from them. This completes the Anthropic Worker Contract migration for
  //      Zen Go — the last client on the legacy passthrough.
  //    - **Standard mode** stays on the legacy OpenAI body: its endpoint
  //      (`handleZenChat`) is a plain stream proxy with no dual-accept, so it must
  //      receive an OpenAI-shape body. Standard Zen is pure OpenAI-compat (no
  //      Anthropic transport) and was never a migration target.
  //  Native FC is additive either way — `openAISSEPump` normalizes any native
  //  `tool_calls` back into the dispatcher's fenced JSON. Anthropic-transport Go
  //  models (minimax/qwen) translate `tools` to Anthropic's custom-tool shape via
  //  `toAnthropicMessages`, and their `tool_use` responses round-trip through
  //  `createAnthropicTranslatedStream` — see model-catalog's ZEN_NATIVE_TOOL_CALLING_MODELS.
  const goMode = getZenGoMode();
  const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : undefined;
  const body = goMode
    ? toPushStreamWire(llmMessages, {
        provider: 'zen',
        model: req.model,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        topP: req.topP,
        ...(nativeTools ? { tools: nativeTools } : {}),
        ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
      })
    : {
        model: req.model,
        messages: llmMessages,
        stream: true,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(nativeTools ? { tools: nativeTools, tool_choice: 'auto' } : {}),
        ...(req.responseFormat
          ? { response_format: toOpenAIResponseFormat(req.responseFormat) }
          : {}),
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

  const url = goMode ? ZEN_GO_URLS.chat : PROVIDER_URLS.zen.chat;

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
