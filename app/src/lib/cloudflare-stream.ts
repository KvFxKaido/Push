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

import { PROVIDER_URLS } from './providers';
import { createOpenAIChatStream } from './openai-chat-stream-family';

export const cloudflareStream = createOpenAIChatStream({
  provider: 'cloudflare',
  endpoint: PROVIDER_URLS.cloudflare.chat,
  displayName: 'Cloudflare Workers AI',
  credential: { kind: 'worker-binding' },
  errorPrefix: 'always',
});
