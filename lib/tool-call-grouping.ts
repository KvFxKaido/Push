/**
 * tool-call-grouping.ts — Shared per-turn mutation-transaction grouper.
 *
 * Both the web dispatcher (`app/src/lib/tool-dispatch.ts:classifyDetectedCalls`)
 * and the CLI engine (`cli/engine.ts:~1814`) ran structurally identical
 * state machines over a parser-produced tool-call list:
 *
 *   1. Contiguous prefix of read-only calls → `readOnly` (executed in
 *      parallel).
 *   2. Contiguous file mutations → `fileMutations` (sequential, fail-fast).
 *   3. At most one trailing side-effecting call → `mutating`.
 *   4. Anything that violates the ordering (read after mutations
 *      started, second side-effect, calls after a side-effect, overflow)
 *      → `extraMutations` so the caller can surface a structured error.
 *
 * Two parallel state machines with a comment in each pointing at the
 * other is the "shared semantics, divergent implementations" footgun
 * the parser-convergence doc already calls out. This module is the
 * shared kernel; web and CLI both call `groupCallsByPhase` with their
 * own typed predicates and per-surface caps.
 *
 * Generic over the call type. Web passes `AnyToolCall` + its predicates;
 * CLI passes its `ToolCall` + its predicates. Predicates are injected
 * rather than re-derived inside this module because the two surfaces
 * have different `ToolCall` shapes today — the only stable contract is
 * "given a call, is it read-only / a pure file mutation?"
 *
 * Caps are also injected, not hardcoded. Web caps reads at 6 and file
 * mutations at 8 (with documented overflow semantics); CLI does not cap
 * either today. Passing `null` for a cap disables that cap, matching
 * CLI's current behavior. The divergence is intentional for now — see
 * `docs/decisions/Tool-Call Parser Convergence Gap.md` for the open
 * question of whether CLI should adopt web's caps.
 */

export interface GroupingPredicates<T> {
  /** True when the call is safe to execute in parallel with other reads. */
  readonly isReadOnly: (call: T) => boolean;
  /**
   * True when the call is a pure file mutation — safe to batch
   * sequentially within one turn without side-effect ordering.
   *
   * The caller passes `!isReadOnly(call) && isFileMutation(call)` semantics
   * by convention: this predicate is only consulted for non-read calls.
   */
  readonly isFileMutation: (call: T) => boolean;
}

export interface GroupingCaps {
  /**
   * Maximum parallel read calls per turn. Overflow is **truncated**
   * (silently dropped) — the model can ask for the tail on the next
   * turn. `null` disables the cap entirely.
   */
  readonly maxParallelReads: number | null;
  /**
   * Maximum file mutations per turn. Overflow is **prepended to
   * `extraMutations`** so the caller can surface an overflow error
   * to the model instead of silently dropping. `null` disables the
   * cap entirely.
   */
  readonly maxFileMutationBatch: number | null;
}

/**
 * Per-turn cap on parallel read-only calls. Sized for a realistic
 * exploration burst (open a handful of related files, scan a search,
 * read a dir listing) without letting a runaway plan execute dozens
 * of reads in one turn.
 */
export const MAX_PARALLEL_TOOL_CALLS = 6;

/**
 * Per-turn cap on file-mutation calls. Generous enough to cover
 * realistic scaffolds (a handful of new docs, a coordinated multi-file
 * config update) but bounded so a runaway tool-call loop surfaces a
 * clear overflow error instead of executing thousands of writes
 * sequentially.
 */
export const MAX_FILE_MUTATION_BATCH = 8;

/**
 * Canonical caps used by both web (`app/src/lib/tool-dispatch.ts`) and
 * CLI (`cli/engine.ts`). Matches the web defaults shipped 2026-03 and
 * adopted by CLI on the parser-convergence followup (PR after #679).
 */
export const DEFAULT_GROUPING_CAPS: GroupingCaps = {
  maxParallelReads: MAX_PARALLEL_TOOL_CALLS,
  maxFileMutationBatch: MAX_FILE_MUTATION_BATCH,
};

export interface GroupedCalls<T> {
  /** Contiguous prefix of read-only calls (parallel-safe). */
  readOnly: T[];
  /**
   * Contiguous batch of pure file-mutation calls. Sequential,
   * fail-fast — NOT atomic.
   */
  fileMutations: T[];
  /** Optional trailing side-effecting call (at most one per turn). */
  mutating: T | null;
  /**
   * Overflow / ordering-violation calls the turn couldn't accept.
   * Callers reject these with a structured error so the model can
   * correct on the next turn. Sources include:
   *   - a second side-effect after `mutating` was set
   *   - any call after `mutating` was set
   *   - a read emitted after the mutation transaction began
   *   - file-mutation batch overflow beyond `maxFileMutationBatch`
   */
  extraMutations: T[];
}

/**
 * Group a parser-produced, deduped, textual-order tool-call list into
 * the per-turn mutation transaction shape. Pure function — no I/O, no
 * side effects.
 *
 * Ordering invariant: the caller MUST pass calls in the textual order
 * they appear in the model's output. `lib/tool-dispatch.ts:createToolDispatcher`
 * sorts by offset before returning, so the web/CLI callers can pass
 * the result through directly.
 */
export function groupCallsByPhase<T>(
  calls: readonly T[],
  predicates: GroupingPredicates<T>,
  caps: GroupingCaps,
): GroupedCalls<T> {
  const empty: GroupedCalls<T> = {
    readOnly: [],
    fileMutations: [],
    mutating: null,
    extraMutations: [],
  };

  if (calls.length === 0) return empty;

  // Single-call fast path — classify directly. Keeps the simple case
  // out of the state-machine branch and matches the legacy web shape.
  if (calls.length === 1) {
    const only = calls[0];
    if (predicates.isReadOnly(only)) return { ...empty, readOnly: [only] };
    if (predicates.isFileMutation(only)) return { ...empty, fileMutations: [only] };
    return { ...empty, mutating: only };
  }

  const readOnly: T[] = [];
  const fileMutations: T[] = [];
  let mutating: T | null = null;
  const extraMutations: T[] = [];
  let phase: 'reads' | 'mutations' | 'done' = 'reads';

  for (const call of calls) {
    const isRead = predicates.isReadOnly(call);
    const isFileMut = !isRead && predicates.isFileMutation(call);

    if (phase === 'done') {
      // A side-effect already landed — anything else is overflow.
      extraMutations.push(call);
      continue;
    }

    if (isRead) {
      if (phase === 'reads') {
        readOnly.push(call);
        continue;
      }
      // Read after a mutation has started — ordering violation. Push
      // it (and treat subsequent calls from here as overflow too) into
      // extraMutations so the caller can surface a structured error
      // and the model can correct on the next turn. Falling through
      // to the `done` branch on the next iteration keeps that behavior.
      extraMutations.push(call);
      phase = 'done';
      continue;
    }

    if (isFileMut) {
      phase = 'mutations';
      fileMutations.push(call);
      continue;
    }

    // Side-effecting call. Only one allowed per turn.
    mutating = call;
    phase = 'done';
  }

  // Cap parallel reads — truncate instead of bailing entirely. Reads
  // beyond the cap are dropped silently; the model can re-issue them
  // next turn if needed. See `GroupingCaps.maxParallelReads`.
  if (caps.maxParallelReads !== null && readOnly.length > caps.maxParallelReads) {
    readOnly.length = caps.maxParallelReads;
  }

  // Cap file-mutation batch — push overflow to extraMutations so the
  // caller surfaces a clear "too many writes" error instead of silently
  // dropping. See `GroupingCaps.maxFileMutationBatch`.
  if (caps.maxFileMutationBatch !== null && fileMutations.length > caps.maxFileMutationBatch) {
    const overflow = fileMutations.splice(caps.maxFileMutationBatch);
    extraMutations.unshift(...overflow);
  }

  return { readOnly, fileMutations, mutating, extraMutations };
}

/**
 * Convenience: pass-through caps that disable both limits. CLI uses
 * this today because the inline state machine has never enforced caps.
 */
export const UNCAPPED_GROUPING: GroupingCaps = {
  maxParallelReads: null,
  maxFileMutationBatch: null,
};
