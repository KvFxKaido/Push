/**
 * Shared smart-context management.
 *
 * Pure helpers that summarize, trim, and digest a message history to fit a
 * token budget. Extracted from `app/src/lib/orchestrator.ts` as part of the
 * Phase 5E follow-up so both the web runtime and pushd can reuse the same
 * context trimming without duplicating logic.
 *
 * The web consumer binds the generic `Message` parameter to its concrete
 * `ChatMessage` type and provides concrete implementations of the injected
 * dependencies (token estimation, compaction, metric recording, digest
 * message factory). Behaviour is identical to the pre-extraction helpers;
 * only the import boundary and dep-injection wrapper are new.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal message shape the context manager needs to read. Extracted as a
 * generic so consumers (web `ChatMessage`, pushd message records, tests) can
 * bind the concrete type without the lib module importing web-specific
 * structures.
 */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
  isToolCall?: boolean;
  isToolResult?: boolean;
}

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
  /** Threshold at which old tool results get summarized. Decoupled from
   *  targetTokens so large-context models (Gemini) still get lean working
   *  context without premature message dropping. */
  summarizeTokens: number;
}

const DEFAULT_CONTEXT_MAX_TOKENS = 100_000;
const DEFAULT_CONTEXT_TARGET_TOKENS = 88_000;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

export type SummarizationCause = 'tool_output' | 'long_message' | 'mixed';

export type ContextMetricPhase = 'summarization' | 'digest_drop' | 'hard_trim';

export interface ContextMetricInput {
  phase: ContextMetricPhase;
  beforeTokens: number;
  afterTokens: number;
  provider?: string;
  messagesDropped?: number;
  cause?: SummarizationCause;
}

export interface PreCompactEventLike {
  totalTokens: number;
  budgetThreshold: number;
  messageCount: number;
}

/**
 * Dependency bundle injected into the context manager so the lib module
 * stays agnostic of web-specific helpers (`estimateTokens`, `compactChatMessage`,
 * `recordContextMetric`, etc.) while still preserving exact behaviour.
 */
export interface ContextManagerDeps<M extends Message> {
  /** Returns `'none'` to disable context management entirely. */
  getContextMode: () => 'graceful' | 'none';
  estimateMessageTokens: (message: M) => number;
  estimateContextTokens: (messages: M[]) => number;
  /** Semantic summarization of a single verbose message (e.g. tool result). */
  compactMessage: (message: M) => M;
  /** Build the text block representing a group of removed messages. */
  buildContextDigestBlock: (removed: M[]) => string;
  /** Construct a synthetic digest message carrying the digest block content. */
  createDigestMessage: (content: string) => M;
  /** Optional metric recorder. Called with phase stats after each trim. */
  recordContextMetric?: (input: ContextMetricInput) => void;
  /** Optional logger (defaults to console.log). */
  log?: (line: string) => void;
}

export interface ContextManager<M extends Message> {
  manageContext: (
    messages: M[],
    budget?: ContextBudget,
    provider?: string,
    onPreCompact?: (event: PreCompactEventLike) => void,
  ) => M[];
  classifySummarizationCause: (messages: M[], recentBoundary: number) => SummarizationCause;
  buildContextDigest: (removed: M[]) => string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a context-manager bundle against a concrete `Message` type and the
 * host's dependency implementations. Pure — no module-level state.
 */
export function createContextManager<M extends Message>(
  deps: ContextManagerDeps<M>,
): ContextManager<M> {
  const log = deps.log ?? ((line: string) => console.log(line));

  function buildContextDigest(removed: M[]): string {
    return deps.buildContextDigestBlock(removed);
  }

  /**
   * Classify what caused summarization pressure: tool output, long messages, or a mix.
   */
  function classifySummarizationCause(messages: M[], recentBoundary: number): SummarizationCause {
    let toolResults = 0;
    let longMessages = 0;

    for (let i = 0; i < recentBoundary && i < messages.length; i++) {
      const msg = messages[i];
      if (msg.isToolResult && msg.content.length > 800) toolResults++;
      else if (!msg.isToolResult && msg.content.length > 800) longMessages++;
    }

    if (toolResults > 0 && longMessages === 0) return 'tool_output';
    if (longMessages > 0 && toolResults === 0) return 'long_message';
    return 'mixed';
  }

  /**
   * Manage context window: summarize old messages instead of dropping them.
   *
   * Strategy:
   * 1. Always keep the first user message verbatim (the original task)
   * 2. Keep recent messages verbatim (they're most relevant)
   * 3. Summarize old tool results (biggest token consumers)
   * 4. If still over budget, start dropping oldest summarized pairs
   */
  function manageContext(
    messages: M[],
    budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
    provider?: string,
    onPreCompact?: (event: PreCompactEventLike) => void,
  ): M[] {
    if (deps.getContextMode() === 'none') {
      return messages;
    }

    const totalTokens = deps.estimateContextTokens(messages);

    // Use the lower summarizeTokens threshold to decide when to compress old
    // tool results.  This keeps working context lean even for large-context
    // models (e.g. Gemini 1M) where targetTokens is much higher.
    const summarizeThreshold = budget.summarizeTokens;
    const adaptiveRecentBoundary = totalTokens > summarizeThreshold * 0.8 ? 6 : 14;

    // Under summarize threshold — keep everything as-is
    if (totalTokens <= summarizeThreshold) {
      return messages;
    }

    // Fire PreCompact event before any compaction begins
    onPreCompact?.({
      totalTokens,
      budgetThreshold: summarizeThreshold,
      messageCount: messages.length,
    });

    // Find first user message index (to pin it)
    const firstUserIdx = messages.findIndex((m) => m.role === 'user' && !m.isToolResult);

    // Phase 1: Summarize old verbose content (walk from oldest to newest, skip recent tail)
    const result = [...messages];
    const recentBoundary = Math.max(0, result.length - adaptiveRecentBoundary);
    let currentTokens = totalTokens;

    for (let i = 0; i < recentBoundary && currentTokens > summarizeThreshold; i++) {
      const msg = result[i];
      const before = deps.estimateMessageTokens(msg);
      const summarized = deps.compactMessage(msg);
      const after = deps.estimateMessageTokens(summarized);
      result[i] = summarized;
      currentTokens -= before - after;
    }

    // Phase 2: Remove oldest non-pinned messages with a digest fallback.
    // Only drop messages when over the (potentially much higher) targetTokens —
    // for Gemini this means we summarize at 88K but only drop at 800K.
    if (currentTokens <= budget.targetTokens) {
      const cause = classifySummarizationCause(messages, recentBoundary);
      deps.recordContextMetric?.({
        phase: 'summarization',
        beforeTokens: totalTokens,
        afterTokens: currentTokens,
        provider,
        cause,
      });
      log(`[Push] Context managed via summarization: ${totalTokens} → ${currentTokens} tokens`);
      return result;
    }

    const tailStart = Math.max(0, result.length - adaptiveRecentBoundary);
    const protectedIdx = new Set<number>();
    if (firstUserIdx >= 0) protectedIdx.add(firstUserIdx);
    for (let i = tailStart; i < result.length; i++) protectedIdx.add(i);

    const toRemove = new Set<number>();
    const removed: M[] = [];

    for (let i = 0; i < result.length && currentTokens > budget.targetTokens; i++) {
      if (protectedIdx.has(i) || toRemove.has(i)) continue;

      // Keep tool call/result paired for coherence.
      if (
        result[i].isToolCall &&
        i + 1 < result.length &&
        result[i + 1]?.isToolResult &&
        !protectedIdx.has(i + 1)
      ) {
        toRemove.add(i);
        toRemove.add(i + 1);
        removed.push(result[i], result[i + 1]);
        currentTokens -=
          deps.estimateMessageTokens(result[i]) + deps.estimateMessageTokens(result[i + 1]);
        i++;
        continue;
      }
      if (
        result[i].isToolResult &&
        i > 0 &&
        result[i - 1]?.isToolCall &&
        !protectedIdx.has(i - 1)
      ) {
        // Let the pair be removed when the call index is processed.
        continue;
      }

      toRemove.add(i);
      removed.push(result[i]);
      currentTokens -= deps.estimateMessageTokens(result[i]);
    }

    if (toRemove.size === 0) {
      return result;
    }

    const digestMessage = deps.createDigestMessage(buildContextDigest(removed));

    const kept: M[] = [];
    let digestInserted = false;
    for (let i = 0; i < result.length; i++) {
      if (toRemove.has(i)) continue;

      if (!digestInserted) {
        if (firstUserIdx >= 0 && i === firstUserIdx + 1) {
          kept.push(digestMessage);
          digestInserted = true;
        } else if (firstUserIdx < 0 && i === 0) {
          kept.push(digestMessage);
          digestInserted = true;
        }
      }

      kept.push(result[i]);
    }
    if (!digestInserted) kept.unshift(digestMessage);

    if (deps.estimateContextTokens(kept) > budget.maxTokens) {
      // Last resort hard trim from oldest non-protected while keeping digest and recent tail.
      // Invariants: (1) digest is never removed, (2) recent tail is never removed,
      // (3) loop terminates if no removable candidates remain.
      const hardResult = [...kept];
      while (deps.estimateContextTokens(hardResult) > budget.maxTokens && hardResult.length > 16) {
        const tailStart = Math.max(1, hardResult.length - 15);
        const removeIndex = hardResult.findIndex(
          (msg, idx) => idx >= 1 && idx < tailStart && msg !== digestMessage,
        );
        if (removeIndex === -1) break;
        hardResult.splice(removeIndex, 1);
      }
      const hardAfter = deps.estimateContextTokens(hardResult);
      deps.recordContextMetric?.({
        phase: 'hard_trim',
        beforeTokens: totalTokens,
        afterTokens: hardAfter,
        provider,
        // Baseline is `kept` (post Phase 2 + digest insertion), not the original
        // `messages` array — we're counting drops within the hard-trim phase only.
        messagesDropped: kept.length - hardResult.length,
      });
      log(`[Push] Context managed (hard fallback): ${totalTokens} → ${hardAfter} tokens`);
      return hardResult;
    }

    const keptTokens = deps.estimateContextTokens(kept);
    deps.recordContextMetric?.({
      phase: 'digest_drop',
      beforeTokens: totalTokens,
      afterTokens: keptTokens,
      provider,
      messagesDropped: toRemove.size,
    });
    log(
      `[Push] Context managed with digest: ${totalTokens} → ${keptTokens} tokens (${messages.length} → ${kept.length} messages)`,
    );
    return kept;
  }

  return {
    manageContext,
    classifySummarizationCause,
    buildContextDigest,
  };
}
