/**
 * OpenAI direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/openai/chat`. The Worker
 * (`handleOpenAIChat` in `app/src/worker/worker-providers.ts`) proxies the
 * request to `api.openai.com/v1/responses` with Bearer auth and pipes the
 * typed Responses SSE stream back unchanged.
 *
 * OpenAI's prompt caching is automatic at the prefix level (no
 * `cache_control` markers required), so this adapter doesn't need any of
 * the threading that direct-Anthropic requires.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import { getOpenAIKey } from '@/hooks/useOpenAIConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIResponsesStream } from './openai-responses-stream-family';

export const openaiStream = createOpenAIResponsesStream({
  provider: 'openai',
  endpoint: PROVIDER_URLS.openai.chat,
  displayName: 'OpenAI',
  getApiKey: getOpenAIKey,
});
