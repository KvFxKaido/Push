/**
 * xAI direct PushStream implementation.
 *
 * xAI speaks the OpenAI-compatible Responses API, so this mirrors the direct
 * OpenAI adapter. The Worker proxy at `/api/xai/chat` forwards to
 * `api.x.ai/v1/responses` with Bearer auth and pipes the typed Responses SSE
 * stream back unchanged.
 */

import { getXAIKey } from '@/hooks/useXAIConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIResponsesStream } from './openai-responses-stream-family';

export const xaiStream = createOpenAIResponsesStream({
  provider: 'xai',
  endpoint: PROVIDER_URLS.xai.chat,
  displayName: 'xAI',
  getApiKey: getXAIKey,
});
