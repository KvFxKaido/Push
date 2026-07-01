/**
 * Sakana AI (Fugu) PushStream implementation.
 *
 * Sakana Fugu speaks the OpenAI Responses API, so this mirrors the direct
 * OpenAI adapter rather than the Chat Completions ones. Hits the Worker proxy
 * at `/api/sakana/chat`, which proxies to `api.sakana.ai/v1/responses` with
 * Bearer auth and pipes the typed Responses SSE stream back unchanged.
 *
 * Fugu's prompt caching is automatic at the prefix level (no `cache_control`
 * markers required), so this adapter doesn't need any of the threading that
 * direct-Anthropic requires.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
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
import { getSakanaKey } from '@/hooks/useSakanaConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';
import { ProviderStreamError } from './stream-error';

type SakanaLlmMessage = {
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

function toNeutralMessages(messages: SakanaLlmMessage[]): LlmMessage[] {
  return messages.map((message, index) => ({
    id: `sakana-response-${index}`,
    role: message.role,
    content: contentFallbackText(message.content),
    timestamp: 0,
    ...(Array.isArray(message.content) ? { contentParts: message.content } : {}),
    ...(message.contentBlocks && message.contentBlocks.length > 0
      ? { contentBlocks: message.contentBlocks }
      : {}),
  }));
}

export async function* sakanaStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'sakana',
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
  }) as SakanaLlmMessage[];

  // Per-request flag wins; otherwise the Web Search menu's mode decides.
  // `'auto'` (the default) turns on OpenAI's server-side `web_search` tool so
  // Fugu chats search the web without the user opting in. Mirrors the
  // OpenRouter / Anthropic native-search adapters.
  const responsesWebSearch =
    req.responsesWebSearch ?? isNativeWebSearchEnabled('sakana', req.model);

  const body = toOpenAIResponses({
    provider: 'sakana',
    model: req.model,
    messages: toNeutralMessages(llmMessages),
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    signal: req.signal,
    responseFormat: req.responseFormat,
    tools: req.tools,
    toolChoice: req.toolChoice,
    responsesWebSearch,
  });

  // The Worker prefers its own server-side SAKANA_API_KEY when set and
  // ignores the client-side header. Sending the client key as a Bearer when
  // present preserves dev / unconfigured-Worker paths via standardAuth's
  // fallback. Omit the header entirely on empty key so the Worker's
  // keyMissingError 401 fires.
  const apiKey = (getSakanaKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const response = await fetch(PROVIDER_URLS.sakana.chat, {
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
    // Worker's handleSakanaChat already prefixes its JSON error with
    // `Sakana AI ${status}: …`, so don't re-prefix here.
    const message = detail.startsWith('Sakana AI ')
      ? detail
      : `Sakana AI ${response.status}: ${detail}`;
    throw new ProviderStreamError(message, { status: response.status });
  }

  if (!response.body) {
    throw new Error('Sakana AI response had no body');
  }

  yield* openAIResponsesSSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
