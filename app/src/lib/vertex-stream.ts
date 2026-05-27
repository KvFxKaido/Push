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
 *     Anthropic-transport models (`claude-*` IDs) are wrapped through
 *     `createAnthropicTranslatedStream` server-side, so the wire shape
 *     coming back is plain OpenAI SSE for the client either way.
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

export async function* vertexStream(
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
    'vertex',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
    {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    req.linkedLibraryContent,
  );

  // 2. Plain OpenAI-compatible request body. The Worker forwards verbatim
  //    on the OpenAPI transport (Gemini) and rewrites via
  //    `buildAnthropicMessagesRequest` on the Anthropic transport (Claude).
  //
  //    Vertex carries both Claude and Gemini under one provider. The model
  //    id picks the transport: `claude-*` → Anthropic, anything else →
  //    OpenAI-compat (Gemini). Native web search splits the same way:
  //
  //      - Anthropic transport reads `anthropic_web_search`; the bridge
  //        emits the `web_search_20250305` tool on the upstream Anthropic
  //        body. AND-ed with `isAnthropicTransport` so an explicit
  //        `req.anthropicWebSearch=true` can't smuggle the field onto a
  //        Gemini turn (some strict OpenAI-compat proxies reject unknown
  //        root fields).
  //      - Gemini transport reads `google_search_grounding`; the Worker's
  //        `handleVertexChat` translates it into `tools: [{ googleSearch:
  //        {} }]` on the upstream body. Vertex's OpenAI-compat layer
  //        doesn't auto-translate the OpenAI `web_search` tool shape, so
  //        the rewrite has to live somewhere — the Worker keeps the
  //        Push-private flag out of the upstream request.
  const isAnthropicTransport =
    typeof req.model === 'string' && req.model.trim().toLowerCase().startsWith('claude-');
  const anthropicWebSearch =
    isAnthropicTransport &&
    (req.anthropicWebSearch ?? isNativeWebSearchEnabled('vertex', req.model));
  const googleSearchGrounding =
    !isAnthropicTransport &&
    (req.googleSearchGrounding ?? isNativeWebSearchEnabled('vertex', req.model));

  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(anthropicWebSearch ? { anthropic_web_search: true } : {}),
    ...(googleSearchGrounding ? { google_search_grounding: true } : {}),
  };

  // 3. Headers — branch on configured Vertex mode.
  const mode = getVertexMode();
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

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.vertex.chat, {
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
    throw new Error(`Google Vertex ${response.status}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('Google Vertex response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
