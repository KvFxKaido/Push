/**
 * Client-side transport-family adapter for providers that expose the OpenAI
 * Responses wire through a Push Worker proxy.
 *
 * Provider modules keep their endpoint, credential lookup, and public name
 * explicit. This module owns only the copy-shaped Responses mechanics:
 * prompt composition, neutral-message conversion, request serialization,
 * and SSE pumping. The traced fetch, error normalization, and body
 * validation shared by all three families live in `provider-stream-fetch`.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type {
  AIProviderType,
  LlmContentBlock,
  LlmContentPart,
  LlmMessage,
  PushStreamEvent,
  PushStreamRequest,
} from '@push/lib/provider-contract';
import { toOpenAIResponses } from '@push/lib/openai-responses-serializer';
import { openAIResponsesSSEPump } from '@push/lib/openai-responses-sse-pump';
import { toLLMMessages } from './orchestrator';
import { buildProviderStreamHeaders, postProviderStream } from './provider-stream-fetch';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';

export type OpenAIResponsesFamilyProvider = Extract<
  AIProviderType,
  'openai' | 'xai' | 'sakana' | 'fireworks'
>;

export interface OpenAIResponsesStreamFamilyConfig {
  provider: OpenAIResponsesFamilyProvider;
  endpoint: string;
  displayName: string;
  getApiKey: () => string | null | undefined;
}

type ResponsesLlmMessage = {
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

function toNeutralMessages(
  provider: OpenAIResponsesFamilyProvider,
  messages: ResponsesLlmMessage[],
): LlmMessage[] {
  return messages.map((message, index) => ({
    id: `${provider}-response-${index}`,
    role: message.role,
    content: contentFallbackText(message.content),
    timestamp: 0,
    ...(Array.isArray(message.content) ? { contentParts: message.content } : {}),
    ...(message.contentBlocks && message.contentBlocks.length > 0
      ? { contentBlocks: message.contentBlocks }
      : {}),
  }));
}

export function createOpenAIResponsesStream(config: OpenAIResponsesStreamFamilyConfig) {
  return async function* openAIResponsesFamilyStream(
    req: PushStreamRequest<ChatMessage>,
  ): AsyncIterable<PushStreamEvent> {
    const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
    const llmMessages = toLLMMessages(req.messages, {
      workspaceContext,
      hasSandbox: req.hasSandbox,
      systemPromptOverride: req.systemPromptOverride,
      scratchpadContent: req.scratchpadContent,
      providerType: config.provider,
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
    }) as ResponsesLlmMessage[];

    const responsesWebSearch =
      req.responsesWebSearch ?? isNativeWebSearchEnabled(config.provider, req.model);
    const body = toOpenAIResponses({
      provider: config.provider,
      model: req.model,
      messages: toNeutralMessages(config.provider, llmMessages),
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      signal: req.signal,
      responseFormat: req.responseFormat,
      tools: req.tools,
      toolChoice: req.toolChoice,
      responsesWebSearch,
    });

    const response = await postProviderStream({
      endpoint: config.endpoint,
      headers: buildProviderStreamHeaders(config.getApiKey()),
      body,
      signal: req.signal,
      displayName: config.displayName,
      errorPrefix: 'preserve-worker-prefix',
    });

    yield* openAIResponsesSSEPump({
      body: response.body,
      signal: req.signal,
      isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
    });
  };
}
