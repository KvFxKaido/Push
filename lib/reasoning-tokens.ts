/**
 * Shared reasoning/thinking token parser.
 *
 * Two surfaces on the same problem:
 *
 * 1. `createReasoningTokenParser` — the callback-shaped parser used by the
 *    legacy `ProviderStreamFn` stack (Web orchestrator, CLI provider).
 *    Accepts content tokens, emits onContentToken / onThinkingToken.
 *
 * 2. `normalizeReasoning` — an async-iterable transducer for the
 *    `PushStream` world. Takes an `AsyncIterable<PushStreamEvent>` and yields
 *    the same event type with inline `<think>...</think>` tags inside
 *    `text_delta` events split out into `reasoning_delta` + `reasoning_end`
 *    events. Native `reasoning_delta` events pass through unchanged.
 *
 * Both handle the same two input channels:
 *   - Explicit `<think>...</think>` tags inside streamed content.
 *   - Native reasoning tokens (provider-emitted `reasoning_content` deltas
 *     in the callback path, `reasoning_delta` events in the stream path).
 */

import type { PushStreamEvent } from './provider-contract.js';

export interface ReasoningTokenParser {
  /** Push a content token from the model's response stream. */
  pushContent(token: string): void;
  /** Push a native reasoning token (e.g. from `reasoning_content` delta). */
  pushReasoning(token: string): void;
  /** Flush any buffered content at end of stream. */
  flush(): void;
  /** Close an open thinking block (emits null signal). */
  closeThinking(): void;
}

/**
 * Create a parser that splits streamed tokens into content vs. reasoning channels.
 *
 * @param onContentToken — called with visible assistant content tokens
 * @param onThinkingToken — called with reasoning tokens; `null` signals end of a thinking block
 */
export function createReasoningTokenParser(
  onContentToken?: (token: string) => void,
  onThinkingToken?: (token: string | null) => void,
): ReasoningTokenParser {
  let insideThink = false;
  let tagBuffer = '';
  let thinkingOpen = false;

  function emitContent(token: string): void {
    if (!token) return;
    onContentToken?.(token);
  }

  function emitThinking(token: string): void {
    if (!token) return;
    thinkingOpen = true;
    onThinkingToken?.(token);
  }

  function closeThinking(): void {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    onThinkingToken?.(null);
  }

  function pushContent(rawToken: string): void {
    if (!rawToken) return;
    tagBuffer += rawToken;

    // Detect <think> opening outside a think block.
    if (!insideThink && tagBuffer.includes('<think>')) {
      const parts = tagBuffer.split('<think>');
      const before = parts.shift() || '';
      const afterOpen = parts.join('<think>');
      if (before) {
        closeThinking();
        emitContent(before);
      }
      insideThink = true;
      thinkingOpen = true;
      tagBuffer = '';
      if (afterOpen) {
        pushContent(afterOpen);
      }
      return;
    }

    // Inside <think>...</think> — emit to reasoning channel.
    if (insideThink) {
      if (tagBuffer.includes('</think>')) {
        const thinkContent = tagBuffer.split('</think>')[0];
        if (thinkContent) emitThinking(thinkContent);
        closeThinking();

        const after = tagBuffer.split('</think>').slice(1).join('</think>');
        insideThink = false;
        tagBuffer = '';
        const cleaned = after.replace(/^\s+/, '');
        if (cleaned) emitContent(cleaned);
      } else {
        // Hold a short tail so split closing tags can still be detected.
        const safe = tagBuffer.slice(0, -10);
        if (safe) emitThinking(safe);
        tagBuffer = tagBuffer.slice(-10);
      }
      return;
    }

    // Normal content — flush when we are not holding a possible partial tag.
    if (tagBuffer.length > 50 || !tagBuffer.includes('<')) {
      closeThinking(); // native reasoning_content often precedes visible content
      emitContent(tagBuffer);
      tagBuffer = '';
    }
  }

  function pushReasoning(token: string): void {
    emitThinking(token);
  }

  function flush(): void {
    if (insideThink) {
      if (tagBuffer) emitThinking(tagBuffer);
      insideThink = false;
      tagBuffer = '';
      closeThinking();
      return;
    }
    if (tagBuffer) {
      closeThinking();
      emitContent(tagBuffer);
      tagBuffer = '';
      return;
    }
    closeThinking();
  }

  return { pushContent, pushReasoning, flush, closeThinking };
}

// ---------------------------------------------------------------------------
// normalizeReasoning — PushStream-shaped transducer
// ---------------------------------------------------------------------------

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';
// Hold this many trailing chars of the content buffer while waiting for a
// possibly-split opening tag. `<think>` is 7 chars; 50 matches the legacy
// `createReasoningTokenParser` threshold and leaves plenty of slack for
// providers that pad leading whitespace before the tag.
const OPEN_PREFIX_HOLD = 50;
// Inside a `<think>` block, hold this many trailing chars of the reasoning
// buffer so a closing tag split across chunks (`</thi` / `nk>`) still matches.
// `</think>` is 8 chars; 10 is a conservative margin.
const CLOSE_PREFIX_HOLD = 10;

/**
 * Split inline `<think>...</think>` tags out of `text_delta` events into
 * `reasoning_delta` + `reasoning_end` events. Native `reasoning_delta`,
 * `reasoning_end`, and `done` events pass through unchanged.
 *
 * Handles tag splits across chunk boundaries (e.g. `'<thi'` then `'nk>foo'`)
 * by holding a bounded tail of the text buffer until the next chunk arrives
 * or the stream ends.
 *
 * Leading whitespace immediately after a closing `</think>` tag is stripped
 * to match the legacy callback parser's behavior — most templates emit a
 * newline after the closing tag that the user doesn't want to see.
 *
 * Per-stream native-channel latch: once the source stream emits any native
 * `reasoning_delta` event, subsequent `text_delta` events pass through
 * unchanged (no `<think>` parsing). This prevents double-reporting reasoning
 * if a provider ever starts mixing both channels in the same stream —
 * today's providers are mutually exclusive per model, but new reasoning
 * models ship often. The latch is one-way; once engaged it stays on for
 * the remainder of the stream.
 */
export async function* normalizeReasoning(
  stream: AsyncIterable<PushStreamEvent>,
): AsyncIterable<PushStreamEvent> {
  let insideThink = false;
  let buffer = '';
  // True once we've yielded a reasoning_delta without a matching reasoning_end.
  let reasoningOpen = false;
  // Per-stream latch: true once we've seen a native reasoning_delta from the
  // source stream. Engages the "trust native, ignore <think>" path for all
  // subsequent text_delta events.
  let nativeSeen = false;

  function* closeReasoningIfOpen(): Generator<PushStreamEvent> {
    if (reasoningOpen) {
      yield { type: 'reasoning_end' };
      reasoningOpen = false;
    }
  }

  function* consumeBuffer(): Generator<PushStreamEvent> {
    // Resolve as many full tags as the buffer contains, then hold any
    // trailing partial-tag prefix for the next chunk.
    while (true) {
      if (!insideThink) {
        const openIdx = buffer.indexOf(OPEN_TAG);
        if (openIdx === -1) break;
        const before = buffer.slice(0, openIdx);
        buffer = buffer.slice(openIdx + OPEN_TAG.length);
        if (before) {
          yield* closeReasoningIfOpen();
          yield { type: 'text_delta', text: before };
        }
        insideThink = true;
        // Mark the block as open on the tag itself, matching
        // createReasoningTokenParser semantics — an empty `<think></think>`
        // still produces a reasoning_end signal so the UI can open+close its
        // thinking panel consistently.
        reasoningOpen = true;
      } else {
        const closeIdx = buffer.indexOf(CLOSE_TAG);
        if (closeIdx === -1) break;
        const before = buffer.slice(0, closeIdx);
        buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
        if (before) {
          reasoningOpen = true;
          yield { type: 'reasoning_delta', text: before };
        }
        yield* closeReasoningIfOpen();
        insideThink = false;
        // Strip whitespace that templates commonly emit right after `</think>`.
        buffer = buffer.replace(/^\s+/, '');
      }
    }

    // Drain everything that's definitely safe to emit, keeping a tail that
    // might still complete into a tag.
    if (insideThink) {
      if (buffer.length > CLOSE_PREFIX_HOLD) {
        const safe = buffer.slice(0, -CLOSE_PREFIX_HOLD);
        buffer = buffer.slice(-CLOSE_PREFIX_HOLD);
        if (safe) {
          reasoningOpen = true;
          yield { type: 'reasoning_delta', text: safe };
        }
      }
      return;
    }

    // Outside a think block: if the buffer can't be the start of an `<think>`
    // tag, flush it all. Otherwise hold up to OPEN_PREFIX_HOLD chars.
    const lastOpenChevron = buffer.lastIndexOf('<');
    if (lastOpenChevron === -1 || buffer.length - lastOpenChevron > OPEN_PREFIX_HOLD) {
      if (buffer) {
        yield* closeReasoningIfOpen();
        yield { type: 'text_delta', text: buffer };
        buffer = '';
      }
      return;
    }
    // Safe prefix: everything before the trailing `<...` that might be a tag.
    if (lastOpenChevron > 0) {
      const safe = buffer.slice(0, lastOpenChevron);
      buffer = buffer.slice(lastOpenChevron);
      yield* closeReasoningIfOpen();
      yield { type: 'text_delta', text: safe };
    }
  }

  function* flushRemaining(): Generator<PushStreamEvent> {
    if (!buffer) return;
    if (insideThink) {
      reasoningOpen = true;
      yield { type: 'reasoning_delta', text: buffer };
    } else {
      yield* closeReasoningIfOpen();
      yield { type: 'text_delta', text: buffer };
    }
    buffer = '';
  }

  try {
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        if (nativeSeen) {
          // Latch engaged — trust the native reasoning channel and pass
          // content through verbatim, including any `<think>` markup. This
          // avoids double-reporting reasoning if a hybrid provider ever
          // emits both channels in the same stream.
          if (reasoningOpen) {
            reasoningOpen = false;
            yield { type: 'reasoning_end' };
          }
          if (event.text) yield event;
          continue;
        }
        buffer += event.text;
        yield* consumeBuffer();
        continue;
      }
      if (event.type === 'reasoning_delta') {
        // Native reasoning channel. Flush any buffered tokens first so the
        // order stays correct even if the provider mixes inline and native
        // channels — buffered inline text (think or visible) must land
        // before the new native token. Engage the per-stream latch so
        // subsequent text_delta events skip `<think>` parsing.
        yield* flushRemaining();
        nativeSeen = true;
        reasoningOpen = true;
        yield event;
        continue;
      }
      if (event.type === 'reasoning_end') {
        // Forward the upstream event unchanged so the "pass through" contract
        // holds. If we already have local reasoning open, flip the flag
        // without emitting a duplicate synthetic reasoning_end — the yielded
        // event IS the close signal.
        yield* flushRemaining();
        reasoningOpen = false;
        yield event;
        continue;
      }
      // done — drain buffer, close any open reasoning block, then forward.
      yield* flushRemaining();
      yield* closeReasoningIfOpen();
      yield event;
      return;
    }
    // Stream ended without a `done` event. Still drain cleanly.
    yield* flushRemaining();
    yield* closeReasoningIfOpen();
  } finally {
    // If the consumer aborted mid-iteration, ensure no orphaned reasoning
    // block is left open. Buffer state is intentionally dropped — the
    // generator is done.
    if (reasoningOpen) {
      reasoningOpen = false;
      yield { type: 'reasoning_end' };
    }
  }
}
