/**
 * Hugging Face PushStream implementation.
 *
 * Hugging Face's Inference Providers router exposes open-weight models from
 * many hosts through an OpenAI-compatible Chat Completions API
 * (router.huggingface.co). Hits the Worker proxy at `/api/huggingface/chat`
 * (or the Vite dev passthrough at `/huggingface/v1/chat/completions`), then
 * delegates SSE parsing to the shared `openAISSEPump` in `lib/`.
 */

import { getHuggingFaceKey } from '@/hooks/useHuggingFaceConfig';
import { PROVIDER_URLS } from './providers';
import { createOpenAIChatStream } from './openai-chat-stream-family';

export const huggingfaceStream = createOpenAIChatStream({
  provider: 'huggingface',
  endpoint: PROVIDER_URLS.huggingface.chat,
  displayName: 'Hugging Face',
  credential: { kind: 'bearer', getApiKey: getHuggingFaceKey },
  errorPrefix: 'preserve-worker-prefix',
});
