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
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import { getDeepSeekKey } from '@/hooks/useDeepSeekConfig';
import { PROVIDER_URLS } from './providers';
import { createAnthropicFamilyStream } from './anthropic-stream-family';

export const deepseekStream = createAnthropicFamilyStream({
  provider: 'deepseek',
  endpoint: PROVIDER_URLS.deepseek.chat,
  displayName: 'DeepSeek',
  getApiKey: getDeepSeekKey,
  nativeWebSearch: 'none',
  pauseTurns: 'complete-without-pause',
});
