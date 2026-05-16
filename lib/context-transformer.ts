/**
 * Boundary-only context transform.
 *
 * Push's loop body is append-only: every code path adds messages to the
 * canonical transcript via `.push()`. This module is the single seam where
 * messages get rewritten before reaching the LLM — visibility filtering,
 * surgical distillation, and compaction.
 *
 * Contract:
 *   pure function of (messages, options). Identical inputs produce
 *   identical outputs. Side-effecting observers (metric recorders) are
 *   injected by the caller and are not part of the determinism contract;
 *   tests pass no-ops to keep snapshots stable.
 *
 * Why this matters: providers cache prompt prefixes. If the transformed
 * prefix changes between turns when only new messages were appended, the
 * cache misses. Keeping the pipeline pure + driven by an append-only input
 * keeps the cached prefix stable.
 *
 * Pipeline ordering is fixed inside this module (filter → distill →
 * manageContext). Callers cannot reorder stages — they can only
 * enable/disable them via options. New stages slot into the pipeline
 * array; the public API stays the same.
 */

import {
  formatUserGoalBlock,
  USER_GOAL_COMPACTION_MARKER,
  USER_GOAL_HEADER,
  type UserGoalAnchor,
} from './user-goal-anchor.ts';
import {
  type BuildSessionDigestInputs,
  buildSessionDigest,
  mergeSessionDigests,
  parseSessionDigest,
  renderSessionDigest,
  SESSION_DIGEST_HEADER,
} from './session-digest.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformableMessage {
  role: string;
  visibleToModel?: boolean;
}

export interface ManageContextResult<M extends TransformableMessage> {
  messages: M[];
  /** True if the compaction step actually rewrote or dropped messages.
   *  Filter-induced drops are tracked separately at the top level. */
  compactionApplied: boolean;
}

export interface DistillResult<M extends TransformableMessage> {
  messages: M[];
  /** True if the output differs from the input — i.e., distillation
   *  rewrote, inserted, dropped, or replaced messages (e.g., swapping a
   *  span of turns for a digest message). Pass-through implementations
   *  that return the input unchanged should report false. This flag is
   *  what trips `rewriteApplied` on the top-level result, so set it
   *  whenever the prefix may have moved and cache invariants need to
   *  gate on a structural rewrite. */
  distilled: boolean;
}

export interface TransformContextOptions<M extends TransformableMessage> {
  surface: 'web' | 'cli';
  /** When true (default), drop messages with `visibleToModel === false`. */
  enableFilterVisible?: boolean;
  /** When true and `distill` is provided, run the distillation step.
   *  Caller decides the trigger (round count, message count, working-
   *  memory pressure, etc.) and flips this flag accordingly — the stage
   *  itself only invokes the function. */
  enableDistillation?: boolean;
  /** Pre-bound distillation function. Must be a pure function of its
   *  input. CLI binds `distillContext` here; web does not use this stage. */
  distill?: (messages: M[]) => DistillResult<M>;
  /** When true and `manageContext` is provided, run the compaction step. */
  enableManageContext?: boolean;
  /** Pre-bound compaction function. Must be a pure function of its input. */
  manageContext?: (messages: M[]) => ManageContextResult<M>;
  /** Optional user-goal anchor. When provided alongside `createGoalMessage`,
   *  a `[USER_GOAL]` block is injected just before the last message whenever
   *  compaction has run — this turn (`rewriteApplied` upstream) or in a
   *  prior turn (durable `[CONTEXT DIGEST]` marker in the transcript). The
   *  anchor stage is a no-op when no compaction has happened, so short
   *  chats keep the natural first-user-turn position. */
  userGoalAnchor?: UserGoalAnchor;
  /** Factory for the synthetic message that carries the goal-anchor text.
   *  Surface-specific (web `ChatMessage` vs CLI `Message`); mirrors the
   *  pattern used by `createDigestMessage` in the manager. */
  createGoalMessage?: (content: string) => M;
  /** Inputs for materializing a `SessionDigest` block at compaction time.
   *  When provided alongside `createSessionDigestMessage`, the digest stage
   *  fires whenever compaction is in play (same trigger as `userGoalAnchor`),
   *  injecting a typed structured-summary message near the head of the
   *  rolling tail. On subsequent compactions, the prior digest message is
   *  detected via its `[SESSION_DIGEST]` marker and **merged in place** so
   *  the summary grows cumulatively rather than churning.
   *
   *  Callers supply the scope-filtered records and working-memory snapshot;
   *  the transformer is pure and doesn't read from any store. See
   *  `lib/session-digest.ts` for the builder contract. */
  sessionDigestInputs?: BuildSessionDigestInputs;
  /** Factory for the synthetic message that carries the digest block.
   *  Mirrors `createGoalMessage` — typically a hidden user message
   *  (`isToolResult: true`) so it informs the model without surfacing in
   *  the UI transcript. */
  createSessionDigestMessage?: (content: string) => M;
  /** Optional last-line-of-defense token-budget check. When set and the
   *  output of all upstream stages still estimates over `safetyNet.threshold`
   *  of `safetyNet.budget`, the safety-net stage hard-trims oldest non-
   *  protected messages (preserving system at index 0 and the last
   *  `safetyNet.preserveTail ?? 4` messages) until the estimate fits.
   *
   *  This is the gateway-level net that Hermes Agent documents at 85% (their
   *  per-agent compactor runs at 50%, this catches escape). Push's
   *  `message-context-manager` already has a 100% fallback; this stage
   *  fires earlier so over-budget bodies never reach the provider. */
  safetyNet?: SafetyNetOptions;
}

export interface SafetyNetOptions {
  /** Returns an estimated token count for the given messages. Caller-provided
   *  so the transformer stays pure and surface-agnostic (web's heuristic vs
   *  CLI's may differ). */
  estimateTokens: (messages: TransformableMessage[]) => number;
  /** Hard budget. The stage acts when the estimate exceeds `threshold * budget`. */
  budget: number;
  /** Fraction of `budget` that triggers the safety net. Defaults to 0.85. */
  threshold?: number;
  /** Messages at indices `[length - preserveTail, length)` are protected
   *  from removal — the most recent turns the model is about to read.
   *  Defaults to 4. */
  preserveTail?: number;
}

export interface TransformedContext<M extends TransformableMessage> {
  messages: M[];
  /** Indices in `messages` to tag with `cache_control: ephemeral`, ordered
   *  oldest-first. Computed as the most-recent up to {@link MAX_ROLLING_CACHE_BREAKPOINTS}
   *  non-system messages — the "rolling tail" of the conversation. Combined
   *  with the system-message marker that wire adapters apply separately, this
   *  yields the Hermes-documented `system_and_3` shape: at most one cached
   *  prefix per breakpoint, with the system prompt as the longest-lived one
   *  and the rolling tail catching intermediate states (assistant + tool result
   *  pairs from prior rounds).
   *
   *  Empty array when the transcript has no non-system messages. -1 is no
   *  longer used — consumers should `if (indices.length > 0)`. */
  cacheBreakpointIndices: number[];
  /** True if any rewrite stage (currently distillation or compaction)
   *  rewrote, inserted, dropped, or replaced messages. When this fires
   *  the cache breakpoint may move backward — invariants that assume
   *  monotonicity should gate on this flag. Filter-induced drops do not
   *  flip this flag because filtering is consistent across turns and
   *  does not by itself break breakpoint monotonicity.
   *
   *  The name is deliberately stage-agnostic: the manageContext callback
   *  contract still uses `compactionApplied` (it IS compaction-specific
   *  from that callback's point of view), but at the top level we report
   *  the union of all rewrite-style stages. */
  rewriteApplied: boolean;
  metrics: {
    inputCount: number;
    outputCount: number;
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface StageResult<M extends TransformableMessage> {
  messages: M[];
  /** True if this stage rewrote, inserted, dropped, or replaced messages.
   *  Aggregated across stages into `TransformedContext.rewriteApplied`. */
  rewriteApplied: boolean;
}

/** Accumulated state visible to subsequent stages. Lets a stage condition
 *  its behaviour on upstream rewrites (e.g. the goal-anchor stage only
 *  fires when compaction also ran). */
interface PipelineState {
  rewriteApplied: boolean;
}

interface Stage<M extends TransformableMessage> {
  name: string;
  isEnabled: (options: TransformContextOptions<M>) => boolean;
  run: (messages: M[], options: TransformContextOptions<M>, state: PipelineState) => StageResult<M>;
}

function filterVisibleStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'filterVisible',
    isEnabled: (o) => o.enableFilterVisible !== false,
    run: (messages) => ({
      messages: messages.filter((m) => m.visibleToModel !== false),
      rewriteApplied: false,
    }),
  };
}

function distillStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'distill',
    isEnabled: (o) => o.enableDistillation === true && Boolean(o.distill),
    // isEnabled guarantees options.distill is defined; no defensive guard.
    run: (messages, options) => {
      const result = options.distill!(messages);
      return { messages: result.messages, rewriteApplied: result.distilled };
    },
  };
}

function manageContextStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'manageContext',
    isEnabled: (o) => o.enableManageContext !== false && Boolean(o.manageContext),
    // isEnabled guarantees options.manageContext is defined; no defensive guard.
    run: (messages, options) => {
      const result = options.manageContext!(messages);
      return { messages: result.messages, rewriteApplied: result.compactionApplied };
    },
  };
}

function readContent<M extends TransformableMessage>(msg: M): string {
  const content = (msg as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

function hasCompactionMarker<M extends TransformableMessage>(messages: M[]): boolean {
  return messages.some((m) => readContent(m).includes(USER_GOAL_COMPACTION_MARKER));
}

function hasExistingGoalAnchor<M extends TransformableMessage>(
  messages: M[],
  blockContent: string,
): boolean {
  // Match on the header + initial-ask line so adjacent unrelated content
  // (e.g. a digest that happens to mention `[USER_GOAL]` in prose) doesn't
  // false-positive, while a re-derived anchor with identical seed is
  // recognized even if a v2 surface adds optional trailing fields.
  const askLine = blockContent.split('\n').find((line) => line.startsWith('Initial ask:'));
  if (!askLine) return false;
  return messages.some((m) => {
    const content = readContent(m);
    return content.startsWith(USER_GOAL_HEADER) && content.includes(askLine);
  });
}

function injectUserGoalStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'injectUserGoal',
    isEnabled: (o) => Boolean(o.userGoalAnchor && o.createGoalMessage),
    run: (messages, options, state) => {
      // Inject only when compaction is in play. Two signals: (a) an upstream
      // stage rewrote this turn, (b) a prior turn left the durable digest
      // marker. (b) keeps the anchor present in subsequent turns even if
      // none of them individually crosses the summarize threshold.
      const compactionDetected = state.rewriteApplied || hasCompactionMarker(messages);
      if (!compactionDetected) return { messages, rewriteApplied: false };

      const blockContent = formatUserGoalBlock(options.userGoalAnchor!);
      if (hasExistingGoalAnchor(messages, blockContent)) {
        return { messages, rewriteApplied: false };
      }

      const goalMessage = options.createGoalMessage!(blockContent);
      if (messages.length === 0) {
        return { messages: [goalMessage], rewriteApplied: true };
      }
      // Anchor lands just before the last message — typically the latest
      // user turn or tool result the model is about to read. Maximum
      // recency without disturbing the trailing slot.
      const insertIdx = messages.length - 1;
      const result = [...messages.slice(0, insertIdx), goalMessage, ...messages.slice(insertIdx)];
      return { messages: result, rewriteApplied: true };
    },
  };
}

function findSessionDigestIndex<M extends TransformableMessage>(messages: M[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (readContent(messages[i]).includes(SESSION_DIGEST_HEADER)) return i;
  }
  return -1;
}

function injectSessionDigestStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'injectSessionDigest',
    isEnabled: (o) => Boolean(o.sessionDigestInputs && o.createSessionDigestMessage),
    run: (messages, options, state) => {
      // Same trigger as the goal-anchor stage: only inject/merge a digest when
      // compaction is in play — either this turn (upstream `rewriteApplied`)
      // or in a prior turn (durable marker survives in the transcript).
      // Short chats with no compaction stay digest-free; the digest is a
      // compaction-time tool, not a permanent fixture.
      const compactionDetected = state.rewriteApplied || hasCompactionMarker(messages);
      if (!compactionDetected) return { messages, rewriteApplied: false };

      const nextDigest = buildSessionDigest(options.sessionDigestInputs!);

      // Locate a prior digest message by its marker. If found, parse it,
      // merge with `nextDigest`, and rewrite that message's content in place
      // — the rolling tail keeps the same position so the cache breakpoint
      // doesn't shift.
      const priorIdx = findSessionDigestIndex(messages);
      if (priorIdx !== -1) {
        const priorContent = readContent(messages[priorIdx]);
        const prior = parseSessionDigest(priorContent);
        if (prior) {
          const merged = mergeSessionDigests(prior, nextDigest);
          const newContent = renderSessionDigest(merged);
          if (newContent === priorContent) {
            // No new information — leave the prefix bytes alone so the cached
            // prefix from the prior turn still hits.
            return { messages, rewriteApplied: false };
          }
          const updated = [...messages];
          updated[priorIdx] = options.createSessionDigestMessage!(newContent);
          return { messages: updated, rewriteApplied: true };
        }
        // Marker was present but content unparseable (extremely unlikely —
        // we wrote it). Fall through to emit a fresh digest at the tail.
      }

      const blockContent = renderSessionDigest(nextDigest);
      const digestMessage = options.createSessionDigestMessage!(blockContent);
      if (messages.length === 0) {
        return { messages: [digestMessage], rewriteApplied: true };
      }
      // Inject just before the last message, after any goal-anchor message
      // injected by the prior stage (the rolling-tail head). When both
      // stages fire on the same turn, the order in the transcript becomes:
      //   …, [goal-anchor], [session-digest], <last message>
      // because injectUserGoal runs first and we insert ahead of the last
      // message it just pushed forward.
      const insertIdx = messages.length - 1;
      const result = [...messages.slice(0, insertIdx), digestMessage, ...messages.slice(insertIdx)];
      return { messages: result, rewriteApplied: true };
    },
  };
}

function safetyNetStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'safetyNet',
    isEnabled: (o) => Boolean(o.safetyNet),
    run: (messages, options) => {
      const cfg = options.safetyNet!;
      const threshold = cfg.threshold ?? 0.85;
      const preserveTail = cfg.preserveTail ?? 4;
      const ceiling = cfg.budget * threshold;

      const estimate = cfg.estimateTokens(messages);
      if (estimate <= ceiling) return { messages, rewriteApplied: false };

      // Walk forward dropping non-protected messages from the head onward.
      // We preserve a system message at index 0 if present (otherwise that
      // index is just another non-protected message) and the trailing
      // `preserveTail` messages. The session-digest message at the head of
      // the rolling tail is also preserved if it falls within the tail
      // window — its position is what keeps the cache breakpoint stable.
      const working = [...messages];
      const head = working[0]?.role === 'system' ? 1 : 0;
      let rewriteApplied = false;
      while (cfg.estimateTokens(working) > ceiling) {
        const tailStart = Math.max(head, working.length - preserveTail);
        if (tailStart <= head) break; // nothing left to drop without breaching protection
        working.splice(head, 1);
        rewriteApplied = true;
      }
      return { messages: working, rewriteApplied };
    },
  };
}

// Order is fixed: filter (drop hidden) → distill (preserve essentials) →
// manageContext (compact for budget) → injectUserGoal (anchor goal near tail
// iff compaction ran) → injectSessionDigest (typed structured summary near
// the head of the rolling tail iff compaction ran, merged in place when a
// prior digest exists) → safetyNet (last-chance hard trim if the estimated
// body is still over the gateway threshold). Callers cannot reorder.
function buildPipeline<M extends TransformableMessage>(): Stage<M>[] {
  return [
    filterVisibleStage<M>(),
    distillStage<M>(),
    manageContextStage<M>(),
    injectUserGoalStage<M>(),
    injectSessionDigestStage<M>(),
    safetyNetStage<M>(),
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function transformContextBeforeLLM<M extends TransformableMessage>(
  messages: ReadonlyArray<M>,
  options: TransformContextOptions<M>,
): TransformedContext<M> {
  const inputCount = messages.length;
  let working: M[] = [...messages];
  let rewriteApplied = false;

  for (const stage of buildPipeline<M>()) {
    if (!stage.isEnabled(options)) continue;
    const result = stage.run(working, options, { rewriteApplied });
    working = result.messages;
    if (result.rewriteApplied) rewriteApplied = true;
  }

  return {
    messages: working,
    cacheBreakpointIndices: findRollingCacheBreakpoints(working, MAX_ROLLING_CACHE_BREAKPOINTS),
    rewriteApplied,
    metrics: { inputCount, outputCount: working.length },
  };
}

/** Anthropic supports up to 4 `cache_control` markers per request. Wire adapters
 *  reserve one for the system prompt, leaving 3 for the rolling tail. Hermes
 *  Agent documents this as the `system_and_3` strategy; see
 *  `docs/decisions/Hermes Agent — Lessons For Push.md` item 1. */
export const MAX_ROLLING_CACHE_BREAKPOINTS = 3;

/**
 * Return up to `count` indices in `messages` for the most-recent non-system
 * messages, ordered oldest-first.
 *
 * The cache value of a tail breakpoint comes from its content being byte-stable
 * across turns when only new messages are appended. A breakpoint at the
 * last assistant message stays valid for the *next* turn (the assistant text
 * doesn't change once emitted). With multiple breakpoints, each older one
 * keeps catching cache hits even after newer turns push it further from the tail.
 */
export function findRollingCacheBreakpoints<M extends TransformableMessage>(
  messages: ReadonlyArray<M>,
  count: number,
): number[] {
  if (count <= 0) return [];
  const picked: number[] = [];
  for (let i = messages.length - 1; i >= 0 && picked.length < count; i--) {
    if (messages[i].role !== 'system') picked.push(i);
  }
  // Ordered oldest-first so wire layers can iterate naturally without re-sorting.
  return picked.reverse();
}
