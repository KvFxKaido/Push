/**
 * Google Vertex PushStream implementation (client-side).
 *
 * Hits the Worker proxy at `/api/vertex/chat`, then delegates SSE parsing
 * to the shared `openAISSEPump` in `lib/`. The Worker
 * (`handleVertexChat` in `app/src/worker/worker-providers.ts`) inspects
 * the request headers to pick a path:
 *
 *   - **Native mode** — the client sent `X-Push-Vertex-Service-Account`
 *     and `X-Push-Vertex-Region`. The Worker exchanges the service
 *     account for a Google access token and calls Vertex directly.
 *     Anthropic-transport models (`claude-*` IDs) stream raw Anthropic
 *     Messages SSE straight through, parsed here by `anthropicEventStream`
 *     (signed thinking + `pause_turn` native, no translator); Gemini
 *     models ride Vertex's OpenAI-compat endpoint, parsed by `openAISSEPump`.
 *   - **Legacy mode** — the client sent `X-Push-Upstream-Base`. The
 *     Worker falls through to `handleLegacyVertexChat` which proxies
 *     OpenAI-compatible upstreams the same way Azure / Bedrock do.
 *
 * Auth / headers therefore branch on the configured Vertex mode:
 *
 *   - native → no Bearer token; sends the two `X-Push-Vertex-*` headers.
 *   - legacy → Bearer token (omitted on empty key per Phase 10b sweep)
 *     plus `X-Push-Upstream-Base`.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { anthropicEventStream } from '@push/lib/anthropic-bridge';
import { flatToolToOpenAITool } from '@push/lib/openai-chat-serializer';
import { toPushStreamWire } from '@push/lib/provider-wire';
import type { WorkspaceContext } from '@/types';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import {
  getVertexBaseUrl,
  getVertexKey,
  getVertexMode,
  getVertexRegion,
} from '@/hooks/useVertexConfig';
import { PROVIDER_URLS } from './providers';
import { buildExperimentalProxyHeaders } from './experimental-providers';
import { encodeVertexServiceAccountHeader, normalizeVertexRegion } from './vertex-provider';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';
import { ProviderStreamError } from './stream-error';
import { resolvePushCapabilityProfile } from './model-catalog';

export async function* vertexStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const mode = getVertexMode();
  const capabilityProfile = resolvePushCapabilityProfile('vertex', req.model, {
    requestWire: mode === 'native' ? 'neutral' : 'openai',
  });
  // 1. Compose messages via the shared prompt builder. Runtime context flows
  //    through the adapter as opaque passthrough fields — cast locally.
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'vertex',
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

  // 2. Native web search splits by transport. Vertex carries both Claude and
  //    Gemini under one provider; the model id picks the transport server-side
  //    (`claude-*` → Anthropic, anything else → OpenAI-compat/Gemini), and the
  //    matching search flag rides along:
  //      - Anthropic transport → `anthropicWebSearch`; the bridge emits the
  //        `web_search_20250305` tool. AND-ed with `isAnthropicTransport` so an
  //        explicit `req.anthropicWebSearch=true` can't smuggle the field onto a
  //        Gemini turn.
  //      - Gemini transport → `googleSearchGrounding`; the Worker translates it
  //        into `tools: [{ googleSearch: {} }]`.
  const isAnthropicTransport =
    typeof req.model === 'string' && req.model.trim().toLowerCase().startsWith('claude-');
  // Native mode + Claude → the Worker proxies raw Anthropic Messages SSE, parsed
  // by `anthropicEventStream` (signed thinking + `pause_turn` surface natively, no
  // OpenAI-SSE translator). Legacy mode routes claude-* through the user's
  // OpenAI-compat proxy (`handleLegacyVertexChat`), which speaks OpenAI SSE, so it
  // stays on `openAISSEPump`. Gemini transport is OpenAI-compat either way.
  const useNativeAnthropic = mode === 'native' && isAnthropicTransport;
  const anthropicWebSearch =
    isAnthropicTransport &&
    (req.anthropicWebSearch ?? isNativeWebSearchEnabled('vertex', req.model));
  const googleSearchGrounding =
    !isAnthropicTransport &&
    (req.googleSearchGrounding ?? isNativeWebSearchEnabled('vertex', req.model));

  // 3. Headers — branch on configured Vertex mode. Native mode hits the
  //    dual-accept `handleVertexChat`, so it sends the neutral push.stream.v1
  //    wire; legacy mode falls through to `handleLegacyVertexChat`, which does
  //    NOT dual-accept, so it keeps the OpenAI Chat Completions shape.
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
  };

  if (mode === 'native') {
    // Native mode: encode the configured service account into a header so
    // the Worker can mint a Google access token. Region is normalized too —
    // the legacy validator rejected unrecognized regions, so do the same
    // client-side to fail fast rather than waiting for an upstream 4xx.
    const serviceAccount = getVertexKey();
    if (!serviceAccount) {
      throw new Error('Google Vertex service account is missing');
    }
    const encodedServiceAccount = encodeVertexServiceAccountHeader(serviceAccount);
    if (!encodedServiceAccount) {
      throw new Error('Google Vertex service account is invalid');
    }
    const region = normalizeVertexRegion(getVertexRegion());
    if (!region.ok) {
      throw new Error(region.error);
    }
    headers['X-Push-Vertex-Service-Account'] = encodedServiceAccount;
    headers['X-Push-Vertex-Region'] = region.normalized;
    // No Authorization — Worker uses the encoded service account instead.
  } else if (mode === 'legacy') {
    // Legacy mode: same shape as Azure / Bedrock — Bearer + upstream-base.
    const proxyHeaders = buildExperimentalProxyHeaders('vertex', getVertexBaseUrl());
    if (!proxyHeaders['X-Push-Upstream-Base']) {
      throw new Error('Google Vertex base URL is missing or invalid');
    }
    Object.assign(headers, proxyHeaders);
    const apiKey = (getVertexKey() ?? '').trim();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  } else {
    // mode === 'none' — partially or invalidly configured. Failing fast
    // with a local error is much clearer than letting the request fall
    // through to a legacy-shaped fetch that would send a service-account
    // JSON as a Bearer token (or skip Authorization entirely with a bad
    // base URL) and surface a misleading upstream auth/baseURL error.
    // PROVIDER_READY_CHECKS.vertex normally filters this out before the
    // stream is reached; this guard backstops a `providerOverride` path
    // that would otherwise bypass the readiness check.
    throw new Error('Google Vertex is not fully configured');
  }
  injectTraceHeaders(headers);

  // 4. Request body. Native → neutral push.stream.v1 wire (toPushStreamWire);
  //    legacy → the OpenAI Chat Completions shape `handleLegacyVertexChat` still
  //    expects. Both carry the matching search flag (only one is ever set).
  const isNeutral = mode === 'native';
  const nativeTools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : undefined;
  const openAITools = nativeTools?.map(flatToolToOpenAITool);
  const neutralBase = isNeutral
    ? toPushStreamWire(llmMessages, {
        provider: 'vertex',
        model: req.model,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        topP: req.topP,
        ...(anthropicWebSearch ? { anthropicWebSearch: true } : {}),
        ...(googleSearchGrounding ? { googleSearchGrounding: true } : {}),
        ...(nativeTools ? { tools: nativeTools } : {}),
        ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
      })
    : null;
  const legacyBase: Record<string, unknown> | null = isNeutral
    ? null
    : {
        model: req.model,
        messages: llmMessages,
        stream: true,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { top_p: req.topP } : {}),
        ...(anthropicWebSearch ? { anthropic_web_search: true } : {}),
        ...(googleSearchGrounding ? { google_search_grounding: true } : {}),
        ...(openAITools ? { tools: openAITools, tool_choice: req.toolChoice ?? 'auto' } : {}),
      };

  // 5. POST + stream response. Anthropic-transport models (Claude on Vertex)
  //    can return `stop_reason: pause_turn` mid-turn when the server-side
  //    sampling loop hits its iteration cap — replay the paused assistant
  //    content so it resumes. Neutral carries the paused blocks via
  //    `replayAssistantTurns` (the Worker forwards them to toAnthropicMessages);
  //    legacy appends them inline as `assistant_content_blocks` messages.
  //    OpenAI-compat transport (Gemini) never emits pause_turn, so the loop is
  //    a no-op for those models.
  const MAX_PAUSE_TURN_ITERATIONS = 3;
  const replayAssistantTurns: Array<Array<Record<string, unknown>>> = [];
  for (let attempt = 0; attempt <= MAX_PAUSE_TURN_ITERATIONS; attempt += 1) {
    // Branch on the base objects directly (not `isNeutral`) so TS narrows away
    // the nullable side — `neutralBase` is non-null exactly in native mode.
    const currentBody = neutralBase
      ? replayAssistantTurns.length > 0
        ? { ...neutralBase, replayAssistantTurns }
        : neutralBase
      : legacyBase && replayAssistantTurns.length > 0
        ? {
            ...legacyBase,
            messages: [
              ...llmMessages,
              ...replayAssistantTurns.map((blocks) => ({
                role: 'assistant',
                assistant_content_blocks: blocks,
              })),
            ],
          }
        : legacyBase;
    const response = await fetch(PROVIDER_URLS.vertex.chat, {
      method: 'POST',
      headers,
      body: JSON.stringify(currentBody),
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
      throw new ProviderStreamError(`Google Vertex ${response.status}: ${detail}`, {
        status: response.status,
      });
    }

    if (!response.body) {
      throw new Error('Google Vertex response had no body');
    }

    let paused: Array<Record<string, unknown>> | null = null;
    // Dual response pump by transport (mirrors the Worker's dual request
    // serialization). The `pause_turn` continuation handling is identical for
    // both — `anthropicEventStream` and `openAISSEPump` each surface `pause_turn`
    // with the paused `assistantBlocks` — so the replay loop is unchanged.
    const events = useNativeAnthropic
      ? anthropicEventStream(response, req.signal, (name) => KNOWN_TOOL_NAMES.has(name))
      : openAISSEPump({
          body: response.body,
          signal: req.signal,
          isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
        });
    for await (const event of events) {
      if (event.type === 'pause_turn') {
        paused = event.assistantBlocks;
        continue;
      }
      yield event;
    }

    if (!paused || paused.length === 0) return;
    if (attempt === MAX_PAUSE_TURN_ITERATIONS) {
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    // Record the paused blocks; the next iteration rebuilds `currentBody` from
    // the stable base + this growing array (neutral: replayAssistantTurns;
    // legacy: appended assistant_content_blocks messages).
    replayAssistantTurns.push(paused);
  }
}
