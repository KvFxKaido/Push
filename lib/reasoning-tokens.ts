/**
 * Shared reasoning/thinking token parser.
 *
 * Handles both:
 * 1. Explicit `<think>...</think>` tags in streamed content
 * 2. Native `reasoning_content` deltas (via pushReasoning())
 *
 * Unified module used by both the web app and CLI.
 * Based on CLI's createReasoningTokenParser (more complete than web version).
 */

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
