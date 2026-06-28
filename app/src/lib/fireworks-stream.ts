/**
 * Fireworks AI PushStream implementation.
 *
 * Fireworks exposes an OpenAI-compatible Responses API, so this mirrors the
 * direct OpenAI / Sakana adapters rather than the Chat Completions ones. Hits
 * the Worker proxy at `/api/fireworks/chat`, which proxies to
 * `api.fireworks.ai/inference/v1/responses` with Bearer auth and pipes the
 * typed Responses SSE stream back unchanged.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type {
  LlmContentBlock,
  LlmContentPart,
  LlmMessage,
  PushStreamEvent,
  PushStreamRequest,
} from '@push/lib/provider-contract';
import { toOpenAIResponses } from '@push/lib/openai-responses-serializer';
import { openAIResponsesSSEPump } from '@push/lib/openai-responses-sse-pump';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { ProviderStreamError } from './stream-error';

type FireworksLlmMessage = {
  role: LlmMessage['role'];
  content: string | LlmContentPart[];
  contentBlocks?: LlmContentBlock[];
};

function contentFallbackText(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<LlmContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function toNeutralMessages(messages: FireworksLlmMessage[]): LlmMessage[] {
  return messages.map((message, index) => ({
    id: `fireworks-response-${index}`,
    role: message.role,
    content: contentFallbackText(message.content),
    timestamp: 0,
    ...(Array.isArray(message.content) ? { contentParts: message.content } : {}),
    ...(message.contentBlocks && message.contentBlocks.length > 0
      ? { contentBlocks: message.contentBlocks }
      : {}),
  }));
}

export async function* fireworksStream(
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
    providerType: 'fireworks',
    providerModel: req.model,
    onPreCompact: req.onPreCompact,
    todoContent: req.todoContent,
    sessionDigestOptions: {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    linkedLibraryContent: req.linkedLibraryContent,
    emitContentBlocks: true,
  }) as FireworksLlmMessage[];

  // 2. Typed Responses `input`-item body via the shared serializer.
  const body = toOpenAIResponses({
    provider: 'fireworks',
    model: req.model,
    messages: toNeutralMessages(llmMessages),
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    signal: req.signal,
    responseFormat: req.responseFormat,
    tools: req.tools,
  });

  // 3. Headers. The Worker prefers its own server-side FIREWORKS_API_KEY when
  //    set and ignores the client-side header. Sending the client key as a
  //    Bearer when present preserves dev / unconfigured-Worker paths via
  //    standardAuth's fallback. Omit the header entirely on empty key so the
  //    Worker's keyMissingError 401 fires (sending `Bearer ` would be treated
  //    as "key supplied" and forward an empty bearer upstream).
  const apiKey = (getFireworksKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.fireworks.chat, {
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
    // Worker's handleFireworksChat already prefixes its JSON error with
    // `Fireworks AI ${status}: …`, so don't re-prefix here.
    const message = detail.startsWith('Fireworks AI ')
      ? detail
      : `Fireworks AI ${response.status}: ${detail}`;
    throw new ProviderStreamError(message, { status: response.status });
  }

  if (!response.body) {
    throw new Error('Fireworks AI response had no body');
  }

  yield* openAIResponsesSSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
