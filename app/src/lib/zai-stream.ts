/**
 * Z.ai PushStream implementation.
 *
 * Z.ai exposes GLM models through an OpenAI-compatible Chat Completions API.
 * Hits the Worker proxy at `/api/zai/chat` (or the Vite dev passthrough at
 * `/zai/api/paas/v4/chat/completions`), then delegates SSE parsing to the
 * shared `openAISSEPump` in `lib/`.
 */

import { getZaiKey } from '@/hooks/useZaiConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIChatStream } from './openai-chat-stream-family';

export const zaiStream = createOpenAIChatStream({
  provider: 'zai',
  endpoint: PROVIDER_URLS.zai.chat,
  displayName: 'Z.ai',
  credential: { kind: 'bearer', getApiKey: getZaiKey },
  errorPrefix: 'preserve-worker-prefix',
});
