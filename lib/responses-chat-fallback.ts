/**
 * responses-chat-fallback.ts — attempt an OpenAI Responses stream, and if it
 * fails BEFORE producing any consumer-visible output, transparently restart the
 * turn on Chat Completions.
 *
 * Why: OpenRouter's `/responses` beta serves essentially every live model, but
 * it's still beta ("may have breaking changes") and a given model/route can
 * fail (a transient provider error, an unforeseen incompatibility). Going
 * responses-first for all of OpenRouter is only safe if a surprise failure
 * degrades to chat instead of taking the turn down — which is exactly what
 * "going all-in" did before. This combinator is that safety net, shared so the
 * web, background Worker, and CLI apply one policy.
 *
 * The hard constraint: fallback is only possible while nothing has been emitted
 * yet. Once a `text_delta` / tool call / reasoning delta has reached the
 * consumer, the turn is committed to the responses stream — a later error
 * propagates normally, because you cannot un-send bytes and re-run on chat.
 */

import type { PushStreamEvent } from './provider-contract.js';

/**
 * True once the stream has delivered output the consumer can see or act on —
 * past this point the turn is committed and cannot fall back. `done` is
 * deliberately excluded: it is the terminal marker, and a stream that reaches it
 * succeeded (an empty-but-successful response is a model behavior, not a
 * transport failure to retry).
 */
export function isCommittedResponsesEvent(event: PushStreamEvent): boolean {
  switch (event.type) {
    case 'text_delta':
    case 'reasoning_delta':
    case 'reasoning_block':
    case 'responses_reasoning_item':
    case 'native_tool_call':
    case 'citations':
      return true;
    default:
      return false;
  }
}

/**
 * OpenRouter's routing filter found no provider endpoint that honors every
 * parameter the request sent — the failure mode of `provider.require_parameters`,
 * which Push sets whenever it ships native tools or a `response_format`
 * (`openrouter-stream.ts`).
 *
 * This is a property of the REQUEST, not of the transport, so it is exactly the
 * class `shouldFallback` exists to exclude. The chat leg computes the identical
 * `requireParameters` value and sends it to the same upstream providers, plus the
 * `openrouter:web_search` server tool — a strictly narrower filter. Chat therefore
 * cannot succeed where responses failed this way; falling back only spends a
 * second round trip to arrive at a second, less accurate error.
 *
 * Verified against OpenRouter's published per-endpoint capabilities: all five
 * endpoints serving `anthropic/claude-sonnet-4` report `response_format`
 * unsupported, so `require_parameters` plus a schema constraint is unsatisfiable
 * by construction on that model — deterministic, never transient.
 */
const OPENROUTER_ROUTING_CONSTRAINT_MARKER =
  'no endpoints found that can handle the requested parameters';

/**
 * True when `error` carries OpenRouter's routing-constraint rejection. Matches on
 * the message because that is the one representation all three lanes share: the
 * web lane throws `OpenRouter 404: <extracted error.message>`, while the Worker
 * and CLI lanes embed a prefix of the raw JSON body — the marker phrase appears
 * in every one.
 */
export function isOpenRouterRoutingConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.toLowerCase().includes(OPENROUTER_ROUTING_CONSTRAINT_MARKER);
}

export interface ResponsesChatFallbackOptions {
  /** Build the Responses stream (fresh iterable; called once). */
  responses: () => AsyncIterable<PushStreamEvent>;
  /** Build the Chat Completions stream (fresh iterable; called only on fallback). */
  chat: () => AsyncIterable<PushStreamEvent>;
  /**
   * Whether a pre-output failure should fall back rather than propagate. Default
   * always falls back. Callers can narrow this (e.g. never retry an auth error,
   * which chat would also reject).
   */
  shouldFallback?: (error: unknown) => boolean;
  /** Observe a fallback for logging/learning which models needed it. */
  onFallback?: (error: unknown) => void;
}

/**
 * Yields the Responses stream, or — if it throws before any committed output —
 * the Chat stream instead. A failure after output has started re-throws (too
 * late to retry). Never falls back on a clean terminal (`done`) or an empty
 * success.
 */
export async function* streamResponsesWithChatFallback(
  opts: ResponsesChatFallbackOptions,
): AsyncIterable<PushStreamEvent> {
  const { responses, chat, shouldFallback, onFallback } = opts;
  let committed = false;
  try {
    for await (const event of responses()) {
      if (isCommittedResponsesEvent(event)) committed = true;
      yield event;
    }
    return;
  } catch (error) {
    // Committed → the consumer already has partial output; retrying on chat would
    // duplicate or splice two turns. Propagate. Same if the caller declines this
    // error class (e.g. auth failures chat would reject too).
    if (committed || (shouldFallback && !shouldFallback(error))) throw error;
    onFallback?.(error);
  }
  // Pre-output failure the caller accepted: run the whole turn on chat instead.
  yield* chat();
}
