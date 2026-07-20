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
    case 'tool_call_delta':
    case 'native_tool_call':
    case 'citations':
      return true;
    default:
      return false;
  }
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
