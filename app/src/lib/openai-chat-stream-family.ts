/**
 * Client-side transport-family adapter for copy-shaped OpenAI Chat
 * Completions providers routed through a Push Worker proxy.
 *
 * The family boundary is deliberately declarative: provider leaves choose
 * their endpoint, credential source, public name, and error-prefix behavior.
 * Providers with request-specific fields stay in their own adapters instead
 * of injecting arbitrary body hooks here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type {
  AIProviderType,
  PushStreamEvent,
  PushStreamRequest,
} from '@push/lib/provider-contract';
import { flatToolToOpenAITool, toOpenAIResponseFormat } from '@push/lib/openai-chat-serializer';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { toLLMMessages } from './orchestrator';
import { buildProviderStreamHeaders, postProviderStream } from './provider-stream-fetch';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export type OpenAIChatFamilyProvider = Extract<
  AIProviderType,
  'zai' | 'huggingface' | 'cloudflare'
>;

export type OpenAIChatFamilyCredential =
  | { kind: 'bearer'; getApiKey: () => string | null | undefined }
  | { kind: 'worker-binding' };

export interface OpenAIChatStreamFamilyConfig {
  provider: OpenAIChatFamilyProvider;
  endpoint: string;
  displayName: string;
  credential: OpenAIChatFamilyCredential;
  errorPrefix: 'always' | 'preserve-worker-prefix';
}

export function createOpenAIChatStream(config: OpenAIChatStreamFamilyConfig) {
  return async function* openAIChatFamilyStream(
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
    });

    const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : undefined;
    const openAITools = nativeTools?.map(flatToolToOpenAITool);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: llmMessages,
      stream: true,
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(openAITools ? { tools: openAITools, tool_choice: req.toolChoice ?? 'auto' } : {}),
      ...(req.responseFormat
        ? { response_format: toOpenAIResponseFormat(req.responseFormat) }
        : {}),
    };

    const response = await postProviderStream({
      endpoint: config.endpoint,
      headers: buildProviderStreamHeaders(
        config.credential.kind === 'bearer' ? config.credential.getApiKey() : undefined,
      ),
      body,
      signal: req.signal,
      displayName: config.displayName,
      errorPrefix: config.errorPrefix,
    });

    yield* openAISSEPump({
      body: response.body,
      signal: req.signal,
      isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
    });
  };
}
