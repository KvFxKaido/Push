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
  /** True if the distillation step actually preserved a strict subset.
   *  Surfaces that pass through unchanged should report false. */
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
}

export interface TransformedContext<M extends TransformableMessage> {
  messages: M[];
  /** Index of the last `role: 'user'` message in `messages`, or -1 if none.
   *  Provider format adapters apply `cache_control` here. */
  cacheBreakpointIndex: number;
  /** True if any rewrite stage (compaction or distillation) actually
   *  rewrote/dropped messages. When this fires the cache breakpoint may
   *  move backward — invariants that assume monotonicity should gate on
   *  this flag. Filter-induced drops do not flip this flag because
   *  filtering is consistent across turns and does not by itself break
   *  breakpoint monotonicity. */
  compactionApplied: boolean;
  metrics: {
    inputCount: number;
    outputCount: number;
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface Stage<M extends TransformableMessage> {
  name: string;
  isEnabled: (options: TransformContextOptions<M>) => boolean;
  run: (messages: M[], options: TransformContextOptions<M>) => ManageContextResult<M>;
}

function filterVisibleStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'filterVisible',
    isEnabled: (o) => o.enableFilterVisible !== false,
    run: (messages) => ({
      messages: messages.filter((m) => m.visibleToModel !== false),
      compactionApplied: false,
    }),
  };
}

function distillStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'distill',
    isEnabled: (o) => o.enableDistillation === true && Boolean(o.distill),
    run: (messages, options) => {
      if (!options.distill) return { messages, compactionApplied: false };
      const result = options.distill(messages);
      return { messages: result.messages, compactionApplied: result.distilled };
    },
  };
}

function manageContextStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'manageContext',
    isEnabled: (o) => o.enableManageContext !== false && Boolean(o.manageContext),
    run: (messages, options) => {
      if (!options.manageContext) return { messages, compactionApplied: false };
      return options.manageContext(messages);
    },
  };
}

// Order is fixed: filter (drop hidden) → distill (preserve essentials) →
// manageContext (compact for budget). Callers cannot reorder.
function buildPipeline<M extends TransformableMessage>(): Stage<M>[] {
  return [filterVisibleStage<M>(), distillStage<M>(), manageContextStage<M>()];
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
  let compactionApplied = false;

  for (const stage of buildPipeline<M>()) {
    if (!stage.isEnabled(options)) continue;
    const result = stage.run(working, options);
    working = result.messages;
    if (result.compactionApplied) compactionApplied = true;
  }

  return {
    messages: working,
    cacheBreakpointIndex: findLastUserIndex(working),
    compactionApplied,
    metrics: { inputCount, outputCount: working.length },
  };
}

function findLastUserIndex<M extends TransformableMessage>(messages: ReadonlyArray<M>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}
