/**
 * Cloudflare Workers AI PushStream implementation (client-side).
 *
 * Hits the Worker proxy at `/api/cloudflare/chat`, then delegates SSE
 * parsing to the shared `openAISSEPump` in `lib/`.
 *
 * Worker side: `handleCloudflareChat` in `app/src/worker/worker-providers.ts`
 * iterates a Worker-side `cloudflareStream` (which wraps `env.AI.run`) and
 * translates each `PushStreamEvent` back into OpenAI-shape SSE frames before
 * writing them to the response body. From the client's perspective, the wire
 * is plain `data: { choices: [{ delta: { content | reasoning_content } }] }`
 * + `[DONE]` — same shape every other adapter-routed provider speaks — which
 * is why the same `openAISSEPump` consumes it without a bespoke pump.
 *
 * Auth: no Bearer token. The Worker uses its `env.AI` binding for the
 * upstream call, so the legacy config left `apiKey: ''` and `authHeader: null`.
 * If the binding is missing, the Worker returns a 401 with
 * `CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR` — the failure path moves from
 * a client-side preflight throw to a round-trip 401 with the same message.
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
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* cloudflareStream(
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
    'cloudflare',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
    {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
  );

  // 2. Plain OpenAI-compatible request body. The Worker normalizes the
  //    upstream `env.AI.run` events back into this shape before responding.
  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
  };

  // 3. Headers. No Authorization — the Worker uses its `env.AI` binding for
  //    upstream auth and surfaces missing-binding as a 401 with
  //    CLOUDFLARE_WORKERS_AI_NOT_CONFIGURED_ERROR.
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
  };
  injectTraceHeaders(headers);

  // 4. POST + stream response.
  const response = await fetch(PROVIDER_URLS.cloudflare.chat, {
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
    throw new Error(`Cloudflare Workers AI ${response.status}: ${detail}`);
  }

  if (!response.body) {
    throw new Error('Cloudflare Workers AI response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
