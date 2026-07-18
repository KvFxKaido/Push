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
 *   3. A trailing chain of side-effecting calls → `sideEffects`
 *      (sequential, fail-fast, capped at `maxSideEffectChain`).
 *   4. Anything that violates the ordering (read after mutations
 *      started, non-side-effect after the chain began, chain overflow)
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
 * Caps are also injected, not hardcoded. The shared canonical caps —
 * `DEFAULT_GROUPING_CAPS` (6 parallel reads, 8 file mutations) — are
 * exported from this module; both web and CLI pass them in. Passing
 * `null` for a cap disables that cap; `UNCAPPED_GROUPING` is the
 * convenience shape for callers that want no limits (used by tests
 * and one-off invocations, not by the production surfaces).
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
  /**
   * True when the call is a parallel-safe delegation — a read-only
   * investigation sub-agent (e.g. `delegate_explorer`) that may fan out
   * concurrently rather than occupy the single trailing side-effect slot.
   * Only consulted when `caps.maxParallelDelegations` is a positive number;
   * absent/disabled → such calls fall through to the `mutating` slot exactly
   * as before. The lead surfaces opt in (cap 2) so the single lead can spawn
   * a couple of Explorers in one turn — the web's Inline Foreground Lane and
   * the CLI lead lane (`cli/lead-turn.ts`); the Orchestrator and the
   * delegated Coder/Explorer nodes leave it disabled.
   */
  readonly isParallelDelegation?: (call: T) => boolean;
}

export interface GroupingCaps {
  /**
   * Maximum parallel read calls per turn. Overflow is **truncated**
   * (silently dropped) — the model can ask for the tail on the next
   * turn. `null` disables the cap entirely (see `UNCAPPED_GROUPING`).
   */
  readonly maxParallelReads: number | null;
  /**
   * Maximum file mutations per turn. Overflow lands in
   * `GroupedCalls.batchOverflow` (separate from ordering-violation
   * `extraMutations`) so callers can give the model the right
   * correction hint. `null` disables the cap entirely (see
   * `UNCAPPED_GROUPING`).
   */
  readonly maxFileMutationBatch: number | null;
  /**
   * Maximum parallel-safe delegations per turn (concurrent Explorers).
   * Overflow lands in `extraMutations` (ordering-violation hint — the model
   * re-issues the tail next turn). `null`/`undefined`/absent disables the
   * parallel-delegation bucket entirely: delegations fall through to the
   * single trailing `mutating` slot exactly as before. This is the default
   * for the Orchestrator and the delegated sub-agent nodes; the lead
   * surfaces (web Inline Foreground Lane, CLI lead lane) set it to 2.
   * Requires `predicates.isParallelDelegation` to take effect.
   */
  readonly maxParallelDelegations?: number | null;
  /**
   * Maximum trailing side-effecting calls per turn (the sequential,
   * fail-fast chain: exec → exec → commit and similar). Overflow lands
   * in `extraMutations` (ordering-violation hint — the model re-issues
   * the tail next turn). `null` disables the cap (unbounded chain).
   *
   * Historically this was structurally fixed at 1 ("at most one trailing
   * side-effect") — a defensive default from the early single-model days.
   * Interleaved-tool-calling models (Kimi K2.7 et al.) natively chain
   * several side-effecting steps per turn; per-call Auditor gates and
   * Gate-at-Push audit cumulative state, so the chain does not weaken
   * governance. See `MAX_SIDE_EFFECT_CHAIN`.
   */
  readonly maxSideEffectChain: number | null;
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
 * Per-turn cap on the trailing side-effect chain. Sized for the dominant
 * real chain (exec → exec → commit); anything longer is usually a turn
 * that wanted to be two turns, and bounding it keeps the structured
 * overflow error as the runaway backstop.
 */
export const MAX_SIDE_EFFECT_CHAIN = 3;

/**
 * Canonical caps used by both web (`app/src/lib/tool-dispatch.ts`) and
 * CLI (`cli/engine.ts`). Matches the web defaults shipped 2026-03 and
 * adopted by CLI on the parser-convergence followup (PR after #679).
 */
export const DEFAULT_GROUPING_CAPS: GroupingCaps = {
  maxParallelReads: MAX_PARALLEL_TOOL_CALLS,
  maxFileMutationBatch: MAX_FILE_MUTATION_BATCH,
  maxSideEffectChain: MAX_SIDE_EFFECT_CHAIN,
};

export interface GroupedCalls<T> {
  /** Contiguous prefix of read-only calls (parallel-safe). */
  readOnly: T[];
  /**
   * Parallel-safe delegations collected during the read phase (concurrent
   * Explorers), capped at `maxParallelDelegations`. Empty when the bucket is
   * disabled — such calls then fall through to `mutating` as before. Callers
   * that opt in execute these alongside `readOnly` (they don't mutate the
   * workspace).
   */
  parallelDelegations: T[];
  /**
   * Contiguous batch of pure file-mutation calls. Sequential,
   * fail-fast — NOT atomic.
   */
  fileMutations: T[];
  /**
   * Trailing chain of side-effecting calls, in emission order. Executed
   * sequentially, fail-fast — a hard failure stops the chain and the
   * unexecuted tail returns to the model. Capped at
   * `maxSideEffectChain`; overflow lands in `extraMutations`.
   */
  sideEffects: T[];
  /**
   * File-mutation calls that exceeded `maxFileMutationBatch`. The
   * batch hit the cap, the rest of the input's contiguous file
   * mutations spilled here. Callers should emit a "split the batch
   * across turns" hint, NOT an ordering violation message.
   */
  batchOverflow: T[];
  /**
   * Ordering-violation calls the turn couldn't accept. Distinct from
   * `batchOverflow` so callers can give the model the right
   * correction hint. Sources:
   *   - a side-effect beyond the `maxSideEffectChain` cap
   *   - a non-side-effect call after the side-effect chain began
   *     (read / file mutation / delegation after an exec)
   *   - a read emitted after the mutation transaction began
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
    parallelDelegations: [],
    fileMutations: [],
    sideEffects: [],
    batchOverflow: [],
    extraMutations: [],
  };

  if (calls.length === 0) return empty;

  // Parallel-delegation bucket is opt-in: a positive cap AND a predicate.
  // Disabled → identical to the historical reads/mutations/trailing shape
  // (delegations fall through to `mutating`), so the Orchestrator and CLI
  // surfaces are byte-for-byte unchanged.
  const delegationCap = caps.maxParallelDelegations ?? null;
  const delegationsEnabled =
    delegationCap !== null && delegationCap > 0 && predicates.isParallelDelegation != null;
  const isParallelDelegation = (call: T): boolean =>
    delegationsEnabled ? predicates.isParallelDelegation!(call) : false;

  // Single-call fast path — classify directly. Keeps the simple case
  // out of the state-machine branch and matches the legacy web shape.
  if (calls.length === 1) {
    const only = calls[0];
    if (isParallelDelegation(only)) return { ...empty, parallelDelegations: [only] };
    if (predicates.isReadOnly(only)) return { ...empty, readOnly: [only] };
    if (predicates.isFileMutation(only)) return { ...empty, fileMutations: [only] };
    return { ...empty, sideEffects: [only] };
  }

  const readOnly: T[] = [];
  const parallelDelegations: T[] = [];
  const fileMutations: T[] = [];
  const sideEffects: T[] = [];
  const extraMutations: T[] = [];
  let phase: 'reads' | 'mutations' | 'sideEffects' | 'done' = 'reads';

  for (const call of calls) {
    const isDelegation = isParallelDelegation(call);
    const isRead = !isDelegation && predicates.isReadOnly(call);
    const isFileMut = !isDelegation && !isRead && predicates.isFileMutation(call);

    if (phase === 'done') {
      // An ordering violation already ended the turn — anything else is
      // overflow.
      extraMutations.push(call);
      continue;
    }

    if (phase === 'sideEffects') {
      // The side-effect chain is open: more side-effecting calls extend
      // it (the cap is applied after the walk); anything else — a read,
      // file mutation, or delegation after an exec — is an ordering
      // violation that also closes the turn.
      if (!isDelegation && !isRead && !isFileMut) {
        sideEffects.push(call);
        continue;
      }
      extraMutations.push(call);
      phase = 'done';
      continue;
    }

    if (isDelegation) {
      if (phase === 'reads') {
        // Parallel-safe delegations ride the read phase: they don't touch
        // the workspace, so they fan out alongside reads.
        parallelDelegations.push(call);
        continue;
      }
      // Delegation after a mutation began — ordering violation.
      extraMutations.push(call);
      phase = 'done';
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

    // Side-effecting call — opens the trailing chain.
    sideEffects.push(call);
    phase = 'sideEffects';
  }

  // Cap parallel reads — truncate instead of bailing entirely. Reads
  // beyond the cap are dropped silently; the model can re-issue them
  // next turn if needed. See `GroupingCaps.maxParallelReads`.
  if (caps.maxParallelReads !== null && readOnly.length > caps.maxParallelReads) {
    readOnly.length = caps.maxParallelReads;
  }

  // Cap parallel delegations — overflow is an ordering-violation-class
  // reject (model re-issues the tail next turn), NOT a silent truncation:
  // dropping an Explorer the model explicitly asked for would strand a
  // pending investigation with no feedback. Disabled cap → bucket is empty.
  if (delegationCap !== null && parallelDelegations.length > delegationCap) {
    const overflow = parallelDelegations.splice(delegationCap);
    extraMutations.push(...overflow);
  }

  // Cap file-mutation batch — surface overflow in `batchOverflow` (not
  // mixed into `extraMutations`) so the caller can give the model a
  // "split the batch across turns" hint distinct from the ordering-
  // violation hint that ordinary extras get. The two cases share a
  // need to reject + retry but have different correction shapes,
  // and mixing them led to the wrong hint in CLI rejection messages
  // (Copilot review on PR #680).
  let batchOverflow: T[] = [];
  if (caps.maxFileMutationBatch !== null && fileMutations.length > caps.maxFileMutationBatch) {
    batchOverflow = fileMutations.splice(caps.maxFileMutationBatch);
  }

  // Cap the side-effect chain — overflow is an ordering-violation-class
  // reject (model re-issues the tail next turn), NOT a silent truncation:
  // dropping a side-effect the model explicitly planned would desync its
  // mental model of the workspace with no feedback.
  if (caps.maxSideEffectChain !== null && sideEffects.length > caps.maxSideEffectChain) {
    const overflow = sideEffects.splice(caps.maxSideEffectChain);
    extraMutations.push(...overflow);
  }

  return {
    readOnly,
    parallelDelegations,
    fileMutations,
    sideEffects,
    batchOverflow,
    extraMutations,
  };
}

/**
 * Convenience: pass-through caps that disable all limits. Useful for
 * tests and any caller that explicitly wants no per-turn enforcement.
 * Production surfaces (web + CLI) pass `DEFAULT_GROUPING_CAPS`.
 */
export const UNCAPPED_GROUPING: GroupingCaps = {
  maxParallelReads: null,
  maxFileMutationBatch: null,
  maxSideEffectChain: null,
};
