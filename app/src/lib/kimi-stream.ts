/**
 * Kimi PushStream implementation.
 *
 * Kimi exposes K2 models through an OpenAI-compatible Chat Completions API.
 * Hits the Worker proxy at `/api/kimi/chat` (or the Vite dev passthrough at
 * `/kimi/v1/chat/completions`), then delegates SSE parsing to the
 * shared `openAISSEPump` in `lib/`.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { flatToolToOpenAITool, toOpenAIResponseFormat } from '@push/lib/openai-chat-serializer';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getKimiKey } from '@/hooks/useKimiConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { ProviderStreamError } from './stream-error';

export async function* kimiStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'kimi',
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
    ...(/^kimi-k2\.7-code(?:-highspeed)?$/i.test(req.model ?? '')
      ? { temperature: 1, top_p: 0.95 }
      : {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        }),
    ...(openAITools ? { tools: openAITools, tool_choice: req.toolChoice ?? 'auto' } : {}),
    ...(req.responseFormat ? { response_format: toOpenAIResponseFormat(req.responseFormat) } : {}),
  };

  const apiKey = (getKimiKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const response = await fetch(PROVIDER_URLS.kimi.chat, {
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
    const message = detail.startsWith('Kimi ') ? detail : `Kimi ${response.status}: ${detail}`;
    throw new ProviderStreamError(message, { status: response.status });
  }

  if (!response.body) {
    throw new Error('Kimi response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
