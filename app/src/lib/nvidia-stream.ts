/**
 * Nvidia NIM PushStream implementation.
 *
 * Hits the Worker proxy at `/api/nvidia/chat` (or the Vite dev passthrough
 * at `/nvidia/v1/chat/completions`), then delegates SSE parsing to the
 * shared `openAISSEPump` in `lib/`.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here. Plain OpenAI-
 * compatible gateway: single endpoint, Bearer auth, no provider-specific
 * body extensions.
 */

import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIChatStream } from './openai-chat-stream-family';

export const nvidiaStream = createOpenAIChatStream({
  provider: 'nvidia',
  endpoint: PROVIDER_URLS.nvidia.chat,
  displayName: 'Nvidia NIM',
  credential: { kind: 'bearer', getApiKey: getNvidiaKey },
  errorPrefix: 'always',
});
