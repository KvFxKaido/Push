/**
 * Anthropic Claude direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/anthropic/chat`. The client serializes the
 * neutral `push.stream.v1` wire body (`toPushStreamWire`) — materialized
 * messages plus neutral scalars, tagged with `contract: "push.stream.v1"`. The
 * Worker (`handleAnthropicChat`) dual-accepts: a `contract` field routes to the
 * neutral branch, which serializes to Anthropic via `toAnthropicMessages`, POSTs
 * to `api.anthropic.com/v1/messages`, and proxies the raw Anthropic SSE back.
 *
 * Prompt materialization (`toLLMMessages`) stays client-side, so the wire carries
 * already-materialized `messages` and `systemPromptOverride` is baked in. The
 * *response* axis is now native: the client parses Anthropic's raw SSE with
 * `anthropicEventStream` (signed thinking + `pause_turn` continuation surface
 * directly, no OpenAI-SSE round-trip), matching the CLI. The API key stays out of
 * the browser (Worker-side injection).
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import { getAnthropicKey } from '@/hooks/useAnthropicConfig';
import { PROVIDER_URLS } from './providers';
import { createAnthropicFamilyStream } from './anthropic-stream-family';

export const anthropicStream = createAnthropicFamilyStream({
  provider: 'anthropic',
  endpoint: PROVIDER_URLS.anthropic.chat,
  displayName: 'Anthropic',
  getApiKey: getAnthropicKey,
  nativeWebSearch: 'anthropic',
  pauseTurns: 'continue',
});
