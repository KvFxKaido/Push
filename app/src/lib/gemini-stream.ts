/**
 * Google Gemini direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/google/chat`. The Worker
 * (`handleGoogleChat` in `app/src/worker/worker-providers.ts`) translates the
 * OpenAI-shaped body via `buildGeminiGenerateContentRequest`, POSTs to
 * `generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`
 * with `x-goog-api-key` auth, and returns the response already translated back
 * to OpenAI SSE shape via `createGeminiTranslatedStream`.
 *
 * From the client adapter's perspective this is identical to any other
 * OpenAI-compatible provider: post OpenAI-shaped JSON, read OpenAI-shaped SSE.
 * Gemini-specific request/response shape lives on the Worker side so the API
 * key never reaches the browser.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';

export async function* geminiStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(
    req.messages,
    workspaceContext,
    req.hasSandbox,
    req.systemPromptOverride,
    req.scratchpadContent,
    'google',
    req.model,
    req.onPreCompact,
    undefined,
    req.todoContent,
    {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
  );

  const body: Record<string, unknown> = {
    model: req.model,
    messages: llmMessages,
    stream: true,
    ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { top_p: req.topP } : {}),
    ...(req.googleSearchGrounding !== undefined
      ? { google_search_grounding: req.googleSearchGrounding }
      : {}),
  };

  // The Worker prefers its own server-side GOOGLE_API_KEY when set and ignores
  // the client-side header. Sending the client key as a Bearer when present
  // preserves dev / unconfigured-Worker paths via the standardAuth fallback
  // pattern. Omit the header entirely on empty key so the Worker's
  // keyMissingError 401 fires.
  const apiKey = (getGoogleKey() ?? '').trim();
  const requestId = createRequestId('chat');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [REQUEST_ID_HEADER]: requestId,
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  injectTraceHeaders(headers);

  const response = await fetch(PROVIDER_URLS.google.chat, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    let detail = errBody;
    try {
      const parsed = JSON.parse(errBody);
      detail = parseProviderError(parsed, errBody.slice(0, 200), true);
    } catch {
      detail = errBody ? errBody.slice(0, 200) : 'empty body';
    }
    // Worker's handleGoogleChat already prefixes its JSON error with
    // `Google ${status}: …`, so don't re-prefix here — that produces
    // `Google 401: Google 401: …`.
    const message = detail.startsWith('Google ') ? detail : `Google ${response.status}: ${detail}`;
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('Google response had no body');
  }

  yield* openAISSEPump({
    body: response.body,
    signal: req.signal,
    isKnownToolName: (name) => KNOWN_TOOL_NAMES.has(name),
  });
}
