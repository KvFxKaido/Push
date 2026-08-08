/**
 * Cloudflare AI Gateway unified `/compat` PushStream implementation
 * (client-side) — the AIG v2 "Path 2" spike.
 *
 * Hits the Worker proxy at `/api/cloudflare-gateway/chat`, which forwards to
 * `gateway.ai.cloudflare.com/v1/{account}/{slug}/compat/chat/completions`.
 * The compat endpoint speaks plain OpenAI Chat Completions SSE for every
 * upstream (`openai/...`, `anthropic/...`, `google-ai-studio/...`,
 * `workers-ai/@cf/...`), so the shared `openAISSEPump` consumes it without a
 * bespoke pump — the `{gateway-provider}/{model}` id is the entire routing
 * surface.
 *
 * Auth uses two deliberately independent roles. A Settings-saved compat token
 * rides `Authorization: Bearer`; the Worker may instead supply its dedicated
 * `CF_AI_GATEWAY_COMPAT_TOKEN` secret. The existing `CF_AI_GATEWAY_TOKEN`
 * authenticates the gateway hop only through `cf-aig-authorization`. Upstream
 * provider credentials resolve inside the gateway — stored BYOK keys or
 * unified billing — which is the point of the route.
 */

import { getCloudflareGatewayKey } from '@/hooks/useCloudflareGatewayConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIChatStream } from './openai-chat-stream-family';

export const cloudflareGatewayStream = createOpenAIChatStream({
  provider: 'cloudflare-gateway',
  endpoint: PROVIDER_URLS['cloudflare-gateway'].chat,
  displayName: 'Cloudflare AI Gateway',
  credential: { kind: 'bearer', getApiKey: getCloudflareGatewayKey },
  errorPrefix: 'always',
});
