/**
 * Kilo Code PushStream implementation.
 *
 * Hits the Kilo Code chat endpoint, then delegates SSE parsing to the shared
 * `openAISSEPump` in `lib/`.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getKilocodeKey } from '@/hooks/useKilocodeConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* kilocodeStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  // 1. Compose messages via the shared prompt builder. Runtime context flows
  //    through the adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'kilocode',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
  );

  // 2. Plain OpenAI-compatible request body — no Kilo Code-specific fields.
  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
  };

  // 3. Headers. Bearer auth, single endpoint.
  const apiKey = getKilocodeKey() ?? '';
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    Authorization: `Bearer ${apiKey}`,
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.kilocode.chat, {
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
    throw new Error(`Kilo Code ${response.status}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('Kilo Code response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
