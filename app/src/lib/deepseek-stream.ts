/**
 * DeepSeek PushStream — Anthropic Messages transport.
 *
 * DeepSeek exposes an Anthropic-compatible endpoint (`api.deepseek.com/anthropic`);
 * we route through it rather than OpenAI Chat Completions so thinking returns as
 * signed reasoning blocks that round-trip across turns (the OpenAI endpoint's
 * `reasoning_content` can't be replayed). The client posts the neutral
 * `push.stream.v1` wire to the Worker proxy `/api/deepseek/chat`, which serializes
 * to Anthropic via `toAnthropicMessages` and proxies the raw Anthropic SSE back;
 * we parse it natively with `anthropicEventStream` — same shape as the direct
 * Anthropic / Vertex-Claude / Zen-Go routes. DeepSeek's automatic prompt caching
 * still applies on this endpoint (verified); only the explicit `cache_control`
 * directive is ignored, which this path never sends.
 *
 * Runs client-side. Timer/abort safety comes from `createProviderStreamAdapter`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { anthropicEventStream } from '@push/lib/anthropic-bridge';
import { toPushStreamWire } from '@push/lib/provider-wire';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { ProviderStreamError } from './stream-error';
import { resolvePushCapabilityProfile } from './model-catalog';

export async function* deepseekStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const capabilityProfile = resolvePushCapabilityProfile('deepseek', req.model);
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'deepseek',
    providerModel: req.model,
    onPreCompact: req.onPreCompact,
    todoContent: req.todoContent,
    sessionDigestOptions: {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    linkedLibraryContent: req.linkedLibraryContent,
    emitContentBlocks: capabilityProfile.contentBlocks,
  });

  // Neutral `push.stream.v1` wire body — the Worker's dual-accept neutral branch
  // serializes it to Anthropic Messages via `toAnthropicMessages`. No
  // `anthropicWebSearch` flag: DeepSeek's Anthropic endpoint has no server-side
  // web_search tool.
  const body = toPushStreamWire(llmMessages, {
    provider: 'deepseek',
    model: req.model,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
    ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
  });

  // The Worker prefers its own DEEPSEEK_API_KEY; the client Bearer is the
  // dev / unconfigured-Worker fallback. Omit on empty key so the Worker's
  // keyMissingError 401 fires.
  const apiKey = (getDeepSeekKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const response = await fetch(PROVIDER_URLS.deepseek.chat, {
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
    // The Worker already prefixes its JSON error with `DeepSeek ${status}:` —
    // don't double-prefix when the marker is present.
    const message = detail.startsWith('DeepSeek ')
      ? detail
      : `DeepSeek ${response.status}: ${detail}`;
    throw new ProviderStreamError(message, { status: response.status });
  }

  if (!response.body) {
    throw new Error('DeepSeek response had no body');
  }

  // DeepSeek's Anthropic endpoint never enables server-side web_search, so
  // `pause_turn` can't arise; drain it defensively and guarantee a terminal
  // `done` so a stream that ends without one can't hang the round loop.
  let sawDone = false;
  for await (const event of anthropicEventStream(response, req.signal, (name) =>
    KNOWN_TOOL_NAMES.has(name),
  )) {
    if (event.type === 'pause_turn') continue;
    if (event.type === 'done') sawDone = true;
    yield event;
  }
  if (!sawDone) yield { type: 'done', finishReason: 'stop' };
}
