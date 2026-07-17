/**
 * Sakana AI (Fugu) PushStream implementation.
 *
 * Sakana Fugu speaks the OpenAI Responses API, so this mirrors the direct
 * OpenAI adapter rather than the Chat Completions ones. Hits the Worker proxy
 * at `/api/sakana/chat`, which proxies to `api.sakana.ai/v1/responses` with
 * Bearer auth and pipes the typed Responses SSE stream back unchanged.
 *
 * Fugu's prompt caching is automatic at the prefix level (no `cache_control`
 * markers required), so this adapter doesn't need any of the threading that
 * direct-Anthropic requires.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import { getSakanaKey } from '@/hooks/useSakanaConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIResponsesStream } from './openai-responses-stream-family';

export const sakanaStream = createOpenAIResponsesStream({
  provider: 'sakana',
  endpoint: PROVIDER_URLS.sakana.chat,
  displayName: 'Sakana AI',
  getApiKey: getSakanaKey,
});
