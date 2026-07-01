/**
 * OpenAI direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/openai/chat`. The Worker
 * (`handleOpenAIChat` in `app/src/worker/worker-providers.ts`) proxies the
 * request to `api.openai.com/v1/responses` with Bearer auth and pipes the
 * typed Responses SSE stream back unchanged.
 *
 * OpenAI's prompt caching is automatic at the prefix level (no
 * `cache_control` markers required), so this adapter doesn't need any of
 * the threading that direct-Anthropic requires.
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
import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';
import { ProviderStreamError } from './stream-error';

type OpenAILlmMessage = {
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

function toNeutralMessages(messages: OpenAILlmMessage[]): LlmMessage[] {
  return messages.map((message, index) => ({
    id: `openai-response-${index}`,
    role: message.role,
    content: contentFallbackText(message.content),
    timestamp: 0,
    ...(Array.isArray(message.content) ? { contentParts: message.content } : {}),
    ...(message.contentBlocks && message.contentBlocks.length > 0
      ? { contentBlocks: message.contentBlocks }
      : {}),
  }));
}

export async function* openaiStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'openai',
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
  }) as OpenAILlmMessage[];

  // Per-request flag wins; otherwise the Web Search menu's mode decides.
  // `'auto'` (the default) turns on OpenAI's server-side `web_search` tool so
  // chats search the web without the user opting in. Mirrors the OpenRouter /
  // Anthropic native-search adapters.
  const responsesWebSearch =
    req.responsesWebSearch ?? isNativeWebSearchEnabled('openai', req.model);

  const body = toOpenAIResponses({
    provider: 'openai',
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
    let detail: string;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    // Worker's handleOpenAIChat already prefixes its JSON error with
    // `OpenAI ${status}: …`, so don't re-prefix here.
    const message = detail.startsWith('OpenAI ') ? detail : `OpenAI ${response.status}: ${detail}`;
    throw new ProviderStreamError(message, { status: response.status });
  }

  if (!response.body) {
    throw new Error('OpenAI response had no body');
  }

  yield* openAIResponsesSSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
