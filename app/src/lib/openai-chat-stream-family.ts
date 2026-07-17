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
import { parseProviderError } from './orchestrator-streaming';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { ProviderStreamError } from './stream-error';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { injectTraceHeaders } from './tracing';

export type OpenAIChatFamilyProvider = Extract<
  AIProviderType,
  'zai' | 'nvidia' | 'huggingface' | 'cloudflare'
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

    const apiKey =
      config.credential.kind === 'bearer'
        ? (config.credential.getApiKey() ?? '').trim()
        : undefined;
    const requestId = createRequestId('chat');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [REQUEST_ID_HEADER]: requestId,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    injectTraceHeaders(headers);

    const response = await fetch(config.endpoint, {
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
      const preserveWorkerPrefix =
        config.errorPrefix === 'preserve-worker-prefix' &&
        detail.startsWith(`${config.displayName} `);
      const message = preserveWorkerPrefix
        ? detail
        : `${config.displayName} ${response.status}: ${detail}`;
      throw new ProviderStreamError(message, { status: response.status });
    }

    if (!response.body) {
      throw new Error(`${config.displayName} response had no body`);
    }

    yield* openAISSEPump({
      body: response.body,
      signal: req.signal,
      isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
    });
  };
}
