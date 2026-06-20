/**
 * Google Gemini direct PushStream implementation.
 *
 * Hits the Worker proxy at `/api/google/chat`. The client serializes the neutral
 * `push.stream.v1` wire body (`toPushStreamWire`) — materialized messages plus
 * neutral scalars, `contract: "push.stream.v1"`. The Worker (`handleGoogleChat`)
 * dual-accepts: a `contract` field routes to the neutral branch, which serializes
 * to Gemini via `toGeminiGenerateContent`, POSTs to
 * `generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`,
 * and returns the response translated back to OpenAI SSE via
 * `createGeminiTranslatedStream`.
 *
 * Prompt materialization (`toLLMMessages`) stays client-side; the wire carries
 * already-materialized `messages`. The *response* axis is unchanged — the client
 * still reads OpenAI-shaped SSE. The API key never reaches the browser.
 *
 * Runs client-side. Timer/abort safety comes from `iterateChatStream`
 * wrapping this stream — no timer machinery lives here.
 */

import type { ChatMessage, WorkspaceContext } from '@/types';
import type { PushStreamEvent, PushStreamRequest } from '@push/lib/provider-contract';
import { openAISSEPump } from '@push/lib/openai-sse-pump';
import { toPushStreamWire } from '@push/lib/provider-wire';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { injectTraceHeaders } from './tracing';
import { parseProviderError } from './orchestrator-streaming';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { PROVIDER_URLS } from './providers';
import { toLLMMessages } from './orchestrator';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { isNativeWebSearchEnabled } from './web-search-mode';
import { ProviderStreamError } from './stream-error';

export async function* geminiStream(
  req: PushStreamRequest<ChatMessage>,
): AsyncIterable<PushStreamEvent> {
  const workspaceContext = req.workspaceContext as WorkspaceContext | undefined;
  const llmMessages = toLLMMessages(req.messages, {
    workspaceContext,
    hasSandbox: req.hasSandbox,
    systemPromptOverride: req.systemPromptOverride,
    scratchpadContent: req.scratchpadContent,
    providerType: 'google',
    providerModel: req.model,
    onPreCompact: req.onPreCompact,
    todoContent: req.todoContent,
    sessionDigestOptions: {
      records: req.sessionDigestRecords,
      prior: req.priorSessionDigest,
      onEmit: req.onSessionDigestEmitted,
    },
    linkedLibraryContent: req.linkedLibraryContent,
  });

  // Per-request flag wins; otherwise the Web Search menu's mode decides.
  // `'auto'` (the default) enables grounding so Gemini chats get their
  // native search tool out of the box; explicit non-Google backends
  // (`tavily`, `duckduckgo`, `ollama`) and `'off'` suppress it.
  const grounding = req.googleSearchGrounding ?? isNativeWebSearchEnabled('google', req.model);

  // Neutral `push.stream.v1` wire body. Sampling scalars and the grounding flag
  // ride as neutral fields; the Worker's dual-accept neutral branch serializes
  // them to Gemini via `toGeminiGenerateContent`.
  const body = toPushStreamWire(llmMessages, {
    provider: 'google',
    model: req.model,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    ...(grounding ? { googleSearchGrounding: true } : {}),
  });

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
    let detail: string;
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
    throw new ProviderStreamError(message, { status: response.status });
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
