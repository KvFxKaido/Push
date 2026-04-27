/**
 * Boundary-only context transform.
 *
 * Push's loop body is append-only: every code path adds messages to the
 * canonical transcript via `.push()`. This module is the single seam where
 * messages get rewritten before reaching the LLM — filtering, compaction,
 * and (in PR-2) accumulated working-memory injection.
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
 * Pipeline ordering is fixed inside this module. Callers cannot reorder
 * stages — they can only enable/disable them via options. Stages added in
 * future PRs slot into the array; the public API doesn't change.
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
  trimmed: boolean;
}

export interface TransformContextOptions<M extends TransformableMessage> {
  surface: 'web' | 'cli';
  /** When true (default), drop messages with `visibleToModel === false`. */
  enableFilterVisible?: boolean;
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
  /** True if the compaction stage actually rewrote/dropped messages. When
   *  this fires the cache breakpoint may move backward — invariants that
   *  assume monotonicity should gate on this flag. */
  trimmingApplied: boolean;
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
      trimmed: false,
    }),
  };
}

function manageContextStage<M extends TransformableMessage>(): Stage<M> {
  return {
    name: 'manageContext',
    isEnabled: (o) => o.enableManageContext !== false && Boolean(o.manageContext),
    run: (messages, options) => {
      if (!options.manageContext) return { messages, trimmed: false };
      return options.manageContext(messages);
    },
  };
}

// Order is fixed. Callers cannot reorder; PR-2 stages append to this array.
function buildPipeline<M extends TransformableMessage>(): Stage<M>[] {
  return [filterVisibleStage<M>(), manageContextStage<M>()];
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
  let trimmingApplied = false;

  for (const stage of buildPipeline<M>()) {
    if (!stage.isEnabled(options)) continue;
    const result = stage.run(working, options);
    working = result.messages;
    if (result.trimmed) trimmingApplied = true;
  }

  return {
    messages: working,
    cacheBreakpointIndex: findLastUserIndex(working),
    trimmingApplied,
    metrics: { inputCount, outputCount: working.length },
  };
}

function findLastUserIndex<M extends TransformableMessage>(messages: ReadonlyArray<M>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}
