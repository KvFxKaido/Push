/**
 * Compaction tiers — an ordered list of strategies applied to a message
 * list until it fits inside a token budget.
 *
 * Pattern borrowed from Claude Code's documented compaction model (see
 * `docs/decisions/Claude Code In-App Patterns — Lessons For Push.md`
 * §7): cheap strategies fire first (drop stale tool outputs), expensive
 * ones only when the cheap pass isn't enough (semantic summarize, then
 * a hard drop-oldest-pairs fallback).
 *
 * This module defines the primitive — `CompactionTier`, `applyTiers`,
 * default tier factories — without replacing the existing concrete
 * managers (`createContextManager` in `lib/message-context-manager.ts`,
 * `cli/context-manager.ts`). Those are tuned for their surfaces. New
 * compaction sites and future migrations can adopt this shape; the
 * test surface for the tier composition lives in
 * `lib/compaction-tiers.test.ts`.
 *
 * The primitive is generic over a minimal message shape so web's
 * `ChatMessage` and CLI's `Message` are both structurally assignable.
 */

import { compactMessage, type ContextSummaryMessage } from './context-summary.ts';

export interface CompactionTierMessage extends ContextSummaryMessage {
  /**
   * Stable index hint — set by the caller if the tier needs to know
   * relative order. Not used by the default tiers (they treat array
   * position as authoritative).
   */
  readonly _idx?: number;
}

export interface CompactionContext {
  /** Maximum tokens the resulting message list should fit in. */
  budget: number;
  /** Token estimator. Same fn used to size each tier's output. */
  estimate: (messages: CompactionTierMessage[]) => number;
  /**
   * Number of recent messages to preserve verbatim across all tiers.
   * Default 4 — keeps the most recent user turn + assistant turn +
   * the latest tool exchange untouched so the model never sees its
   * own newest output mangled.
   */
  preserveTail?: number;
  /**
   * Index of the first message that may be touched by tiers. Anything
   * at `[0, preserveHead)` is considered system context and stays
   * verbatim. Default 1 — preserves the system prompt only.
   *
   * **Caller responsibility:** when the conversation starts with
   * `[system, user_root_task, ...]`, the default `preserveHead: 1`
   * leaves the user's root request inside the touchable window. The
   * hard-fallback `createDropOldestPairsTier` will drop it under
   * sufficient budget pressure. Callers with that conversation shape
   * should bump `preserveHead` to 2 (or use a tier list that excludes
   * the pair-drop fallback). See the
   * `createDropOldestPairsTier — preserveHead caveat` test in
   * `lib/compaction-tiers.test.ts` for the exact behavior.
   */
  preserveHead?: number;
}

export interface CompactionTierResult<M extends CompactionTierMessage> {
  /** Possibly-modified message array (caller may swap in place). */
  messages: M[];
  /** True when this tier shaved enough that we're now under budget. */
  fits: boolean;
  /**
   * Characters (JS string length, NOT UTF-8 bytes) of `content`
   * removed by this tier — for telemetry. Consumers that need actual
   * byte counts should reuse `utf8ByteLength` from `lib/run-events.ts`
   * on the input/output diff.
   */
  savedChars: number;
  /** Whether this tier actually modified anything. */
  applied: boolean;
}

export interface CompactionTier<M extends CompactionTierMessage> {
  /** Stable id for telemetry / debugging. */
  name: string;
  apply(messages: M[], ctx: CompactionContext): CompactionTierResult<M>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalChars(messages: { content: string }[]): number {
  let n = 0;
  for (const m of messages) n += m.content.length;
  return n;
}

/**
 * The window of messages a tier may touch: indices `[head, len - tail)`.
 * Tiers must never modify messages outside this window. The system
 * prompt at `[0, head)` and the recent tail at `[len - tail, len)`
 * stay verbatim.
 */
function touchableWindow(len: number, ctx: CompactionContext): { start: number; end: number } {
  const head = Math.max(0, ctx.preserveHead ?? 1);
  const tail = Math.max(0, ctx.preserveTail ?? 4);
  const start = Math.min(head, len);
  const end = Math.max(start, len - tail);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Default tiers — cheap to expensive
// ---------------------------------------------------------------------------

/**
 * Tier 1 — Drop intermediate tool outputs older than the tail window.
 *
 * Cheapest strategy: just remove old `isToolResult` messages that the
 * orchestrator no longer needs to reason over. Preserves the assistant
 * tool calls that paired with them (those carry the request the model
 * issued and stay useful as context).
 *
 * `keepLatestN` — keep this many of the most recent tool results
 * inside the touchable window even when over budget; the model often
 * needs to see the latest few tool exchanges in detail.
 */
export function createDropToolOutputsTier<M extends CompactionTierMessage>(
  opts: { keepLatestN?: number } = {},
): CompactionTier<M> {
  const keepLatestN = opts.keepLatestN ?? 2;
  return {
    name: 'drop-old-tool-outputs',
    apply(messages, ctx) {
      const { start, end } = touchableWindow(messages.length, ctx);
      const beforeChars = totalChars(messages);

      // Walk back-to-front to find which tool results are inside the
      // keep-latest-N window; everything else inside [start, end) is
      // dropped.
      const keepFlags = new Set<number>();
      let seen = 0;
      for (let i = end - 1; i >= start; i--) {
        if (messages[i].isToolResult) {
          if (seen < keepLatestN) {
            keepFlags.add(i);
            seen++;
          }
        }
      }

      const next: M[] = [];
      let applied = false;
      for (let i = 0; i < messages.length; i++) {
        const inWindow = i >= start && i < end;
        const isOldToolResult = inWindow && messages[i].isToolResult && !keepFlags.has(i);
        if (isOldToolResult) {
          applied = true;
          continue;
        }
        next.push(messages[i]);
      }

      const afterChars = totalChars(next);
      return {
        messages: next,
        fits: ctx.estimate(next) <= ctx.budget,
        savedChars: beforeChars - afterChars,
        applied,
      };
    },
  };
}

/**
 * Tier 2 — Semantic compaction. Rewrites each message in the touchable
 * window through `compactMessage` from `context-summary.ts`. Tool
 * results get richer summaries (header preserved, list-meta tracked,
 * omission markers), assistant turns get key-line extraction.
 *
 * This is the medium-cost tier — runs full per-message analysis but
 * doesn't drop anything wholesale.
 */
export function createSemanticCompactTier<M extends CompactionTierMessage>(
  opts: {
    /** Skip messages whose content is below this threshold (default uses compactMessage's own per-type defaults). */
    threshold?: number;
    /** Max lines per compacted message. */
    maxLines?: number;
  } = {},
): CompactionTier<M> {
  return {
    name: 'semantic-compact',
    apply(messages, ctx) {
      const { start, end } = touchableWindow(messages.length, ctx);
      const beforeChars = totalChars(messages);
      let applied = false;

      const next = messages.map((msg, i) => {
        if (i < start || i >= end) return msg;
        const compacted = compactMessage(msg, {
          threshold: opts.threshold,
          maxLines: opts.maxLines,
        });
        if (compacted !== msg) applied = true;
        return compacted;
      });

      const afterChars = totalChars(next);
      return {
        messages: next,
        fits: ctx.estimate(next) <= ctx.budget,
        savedChars: beforeChars - afterChars,
        applied,
      };
    },
  };
}

/**
 * Tier 3 — Hard fallback. Drops oldest messages from the touchable
 * window (in pairs when possible: assistant + following tool result)
 * until the budget fits or the window is exhausted. Use this as the
 * last-resort tier when cheap + medium aren't enough; it loses real
 * information.
 */
export function createDropOldestPairsTier<M extends CompactionTierMessage>(): CompactionTier<M> {
  return {
    name: 'drop-oldest-pairs',
    apply(messages, ctx) {
      const beforeChars = totalChars(messages);
      let applied = false;
      const next = messages.slice();

      while (ctx.estimate(next) > ctx.budget) {
        const { start, end } = touchableWindow(next.length, ctx);
        if (start >= end) break;
        // Drop the oldest in-window message; if it's an assistant
        // tool call followed by a user tool result, drop both
        // together so the request/response pairing stays consistent.
        const dropAt = start;
        const next1 = next[dropAt];
        const isPair =
          dropAt + 1 < end &&
          (next1.isToolCall || next1.role === 'assistant') &&
          next[dropAt + 1].isToolResult;
        next.splice(dropAt, isPair ? 2 : 1);
        applied = true;
      }

      const afterChars = totalChars(next);
      return {
        messages: next,
        fits: ctx.estimate(next) <= ctx.budget,
        savedChars: beforeChars - afterChars,
        applied,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface TieredCompactionTrace {
  /** Name of each tier that ran, in order. */
  tiersAttempted: string[];
  /** Names of tiers that actually modified the message list. */
  tiersApplied: string[];
  /** Total characters removed across all tiers. */
  totalSavedChars: number;
  /** True if the final result fits the budget. */
  fits: boolean;
}

export interface TieredCompactionResult<M extends CompactionTierMessage> {
  messages: M[];
  trace: TieredCompactionTrace;
}

/**
 * Run `tiers` in order, stopping the first time the result fits the
 * budget. The semantics are "do the least amount of compaction
 * necessary": each tier runs on the output of the previous, so
 * downstream tiers see what the cheaper tiers already shaved.
 *
 * Returns the final message list plus a trace of which tiers ran and
 * how much each saved. The caller decides what to do with the trace
 * (emit a run event, fold into metrics, etc.).
 */
export function applyTiers<M extends CompactionTierMessage>(
  messages: M[],
  ctx: CompactionContext,
  tiers: CompactionTier<M>[],
): TieredCompactionResult<M> {
  const trace: TieredCompactionTrace = {
    tiersAttempted: [],
    tiersApplied: [],
    totalSavedChars: 0,
    fits: ctx.estimate(messages) <= ctx.budget,
  };

  if (trace.fits) {
    return { messages, trace };
  }

  let current: M[] = messages;
  for (const tier of tiers) {
    trace.tiersAttempted.push(tier.name);
    const result = tier.apply(current, ctx);
    if (result.applied) trace.tiersApplied.push(tier.name);
    trace.totalSavedChars += result.savedChars;
    current = result.messages;
    if (result.fits) {
      trace.fits = true;
      return { messages: current, trace };
    }
  }

  trace.fits = ctx.estimate(current) <= ctx.budget;
  return { messages: current, trace };
}

/**
 * Default tier order: cheap → medium → hard fallback. Suitable as a
 * sensible starting point for new compaction sites; callers can build
 * their own ordering or insert custom tiers.
 */
export function createDefaultTiers<M extends CompactionTierMessage>(): CompactionTier<M>[] {
  return [
    createDropToolOutputsTier<M>(),
    createSemanticCompactTier<M>(),
    createDropOldestPairsTier<M>(),
  ];
}
