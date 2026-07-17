/**
 * Fireworks AI PushStream implementation.
 *
 * Fireworks exposes an OpenAI-compatible Responses API, so this mirrors the
 * direct OpenAI / Sakana adapters rather than the Chat Completions ones. Hits
 * the Worker proxy at `/api/fireworks/chat`, which proxies to
 * `api.fireworks.ai/inference/v1/responses` with Bearer auth and pipes the
 * typed Responses SSE stream back unchanged.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import { getFireworksKey } from '@/hooks/useFireworksConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIResponsesStream } from './openai-responses-stream-family';

export const fireworksStream = createOpenAIResponsesStream({
  provider: 'fireworks',
  endpoint: PROVIDER_URLS.fireworks.chat,
  displayName: 'Fireworks AI',
  getApiKey: getFireworksKey,
});
