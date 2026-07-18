/**
 * Pinning tests for the shared phase-grouping state machine. These
 * mirror the cases that previously lived in
 * `app/src/lib/tool-dispatch.test.ts` and the inline assumptions
 * baked into `cli/engine.ts`'s state machine — extracting the kernel
 * meant the test pins live with the kernel.
 *
 * Stub call type with explicit read/mutation/side-effect tags so the
 * tests don't need to import the web or CLI ToolCall unions.
 *
 * Runner note: this file uses Vitest because `app/vitest.config.ts`
 * picks up sibling lib test files (`../lib/...test.ts`) and treats them
 * as part of the app test suite. A node:test runner here would silently
 * not register the cases and CI would report "No test suite found".
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GROUPING_CAPS,
  groupCallsByPhase,
  MAX_FILE_MUTATION_BATCH,
  MAX_PARALLEL_TOOL_CALLS,
  MAX_SIDE_EFFECT_CHAIN,
  UNCAPPED_GROUPING,
  type GroupingPredicates,
} from './tool-call-grouping.js';

interface StubCall {
  id: string;
  kind: 'read' | 'file' | 'side' | 'deleg';
}

const predicates: GroupingPredicates<StubCall> = {
  isReadOnly: (c) => c.kind === 'read',
  isFileMutation: (c) => c.kind === 'file',
};

// A predicate set that opts into the parallel-delegation bucket (mirrors the
// Inline Foreground Lane wiring). `deleg` calls are otherwise side-effecting.
const delegPredicates: GroupingPredicates<StubCall> = {
  isReadOnly: (c) => c.kind === 'read',
  isFileMutation: (c) => c.kind === 'file',
  isParallelDelegation: (c) => c.kind === 'deleg',
};

const r = (id: string): StubCall => ({ id, kind: 'read' });
const f = (id: string): StubCall => ({ id, kind: 'file' });
const s = (id: string): StubCall => ({ id, kind: 'side' });
const d = (id: string): StubCall => ({ id, kind: 'deleg' });

describe('groupCallsByPhase — empty + single-call paths', () => {
  it('empty input returns the empty shape', () => {
    const result = groupCallsByPhase<StubCall>([], predicates, UNCAPPED_GROUPING);
    expect(result).toEqual({
      readOnly: [],
      parallelDelegations: [],
      fileMutations: [],
      sideEffects: [],
      batchOverflow: [],
      extraMutations: [],
    });
  });

  it('single read classifies directly into readOnly', () => {
    const result = groupCallsByPhase([r('a')], predicates, UNCAPPED_GROUPING);
    expect(result.readOnly).toEqual([r('a')]);
    expect(result.fileMutations).toHaveLength(0);
    expect(result.sideEffects).toEqual([]);
    expect(result.extraMutations).toHaveLength(0);
  });

  it('single file mutation classifies directly into fileMutations', () => {
    const result = groupCallsByPhase([f('a')], predicates, UNCAPPED_GROUPING);
    expect(result.fileMutations).toEqual([f('a')]);
    expect(result.readOnly).toHaveLength(0);
    expect(result.sideEffects).toEqual([]);
  });

  it('single side-effect classifies directly into sideEffects', () => {
    const result = groupCallsByPhase([s('a')], predicates, UNCAPPED_GROUPING);
    expect(result.sideEffects).toEqual([s('a')]);
    expect(result.readOnly).toHaveLength(0);
    expect(result.fileMutations).toHaveLength(0);
  });
});

describe('groupCallsByPhase — parallel delegations (opt-in bucket)', () => {
  it('disabled by default: a delegation falls through to the side-effect chain', () => {
    // No `isParallelDelegation` predicate AND no cap → a `deleg` call is
    // just a side-effect.
    const single = groupCallsByPhase([d('a')], predicates, UNCAPPED_GROUPING);
    expect(single.sideEffects.map((c) => c.id)).toEqual(['a']);
    expect(single.parallelDelegations).toHaveLength(0);

    // Predicate present but cap absent → still disabled; with the chain
    // uncapped both fall-through delegations chain as side-effects.
    const capless = groupCallsByPhase([d('a'), d('b')], delegPredicates, UNCAPPED_GROUPING);
    expect(capless.sideEffects.map((c) => c.id)).toEqual(['a', 'b']);
    expect(capless.extraMutations).toHaveLength(0);
    expect(capless.parallelDelegations).toHaveLength(0);
  });

  it('enabled (cap 2): single delegation lands in the parallel bucket, not the chain', () => {
    const caps = { ...UNCAPPED_GROUPING, maxParallelDelegations: 2 };
    const result = groupCallsByPhase([d('a')], delegPredicates, caps);
    expect(result.parallelDelegations.map((c) => c.id)).toEqual(['a']);
    expect(result.sideEffects).toEqual([]);
  });

  it('enabled (cap 2): fans out two delegations, third overflows to extraMutations', () => {
    const caps = { ...UNCAPPED_GROUPING, maxParallelDelegations: 2 };
    const result = groupCallsByPhase([d('a'), d('b'), d('c')], delegPredicates, caps);
    expect(result.parallelDelegations.map((c) => c.id)).toEqual(['a', 'b']);
    expect(result.extraMutations.map((c) => c.id)).toEqual(['c']);
    expect(result.sideEffects).toEqual([]);
  });

  it('delegations ride the read phase alongside reads, still leaving the chain open', () => {
    const caps = { ...UNCAPPED_GROUPING, maxParallelDelegations: 2 };
    const result = groupCallsByPhase([r('1'), d('2'), s('3')], delegPredicates, caps);
    expect(result.readOnly.map((c) => c.id)).toEqual(['1']);
    expect(result.parallelDelegations.map((c) => c.id)).toEqual(['2']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['3']);
  });

  it('a delegation after a mutation began is an ordering violation', () => {
    const caps = { ...UNCAPPED_GROUPING, maxParallelDelegations: 2 };
    const result = groupCallsByPhase([f('1'), d('2')], delegPredicates, caps);
    expect(result.fileMutations.map((c) => c.id)).toEqual(['1']);
    expect(result.parallelDelegations).toHaveLength(0);
    expect(result.extraMutations.map((c) => c.id)).toEqual(['2']);
  });

  it('a delegation after the side-effect chain began is an ordering violation', () => {
    const caps = { ...UNCAPPED_GROUPING, maxParallelDelegations: 2 };
    const result = groupCallsByPhase([s('1'), d('2')], delegPredicates, caps);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['1']);
    expect(result.parallelDelegations).toHaveLength(0);
    expect(result.extraMutations.map((c) => c.id)).toEqual(['2']);
  });
});

describe('groupCallsByPhase — multi-call state machine', () => {
  it('reads → file mutations → trailing side-effect: happy path', () => {
    const result = groupCallsByPhase(
      [r('1'), r('2'), f('3'), f('4'), s('5')],
      predicates,
      UNCAPPED_GROUPING,
    );
    expect(result.readOnly.map((c) => c.id)).toEqual(['1', '2']);
    expect(result.fileMutations.map((c) => c.id)).toEqual(['3', '4']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['5']);
    expect(result.extraMutations).toHaveLength(0);
  });

  it('consecutive side-effects chain in emission order', () => {
    const result = groupCallsByPhase(
      [r('1'), f('2'), s('3'), s('4'), s('5')],
      predicates,
      UNCAPPED_GROUPING,
    );
    expect(result.readOnly.map((c) => c.id)).toEqual(['1']);
    expect(result.fileMutations.map((c) => c.id)).toEqual(['2']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['3', '4', '5']);
    expect(result.extraMutations).toHaveLength(0);
  });

  it('a non-side-effect after the chain began → ordering violation, rest spills to extra', () => {
    const result = groupCallsByPhase(
      [r('1'), s('2'), r('3'), f('4')],
      predicates,
      UNCAPPED_GROUPING,
    );
    expect(result.readOnly.map((c) => c.id)).toEqual(['1']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['2']);
    // r('3') triggered the violation and flipped phase to 'done',
    // then f('4') was caught in the done branch.
    expect(result.extraMutations.map((c) => c.id)).toEqual(['3', '4']);
  });

  it('a side-effect after a chain-closing violation stays rejected (no chain re-open)', () => {
    const result = groupCallsByPhase([s('1'), f('2'), s('3')], predicates, UNCAPPED_GROUPING);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['1']);
    // f('2') closed the chain as a violation; s('3') must NOT re-enter
    // the chain — the model's plan already diverged from what will run.
    expect(result.extraMutations.map((c) => c.id)).toEqual(['2', '3']);
  });

  it('read after mutations started → ordering violation, rest spills to extra', () => {
    const result = groupCallsByPhase(
      [r('1'), f('2'), r('3'), f('4')],
      predicates,
      UNCAPPED_GROUPING,
    );
    expect(result.readOnly.map((c) => c.id)).toEqual(['1']);
    expect(result.fileMutations.map((c) => c.id)).toEqual(['2']);
    expect(result.sideEffects).toEqual([]);
    // r('3') triggered the violation and flipped phase to 'done',
    // then f('4') was caught in the done branch.
    expect(result.extraMutations.map((c) => c.id)).toEqual(['3', '4']);
  });

  it('file mutation followed by side-effect is valid (file batch + trailing exec)', () => {
    const result = groupCallsByPhase([f('1'), f('2'), s('3')], predicates, UNCAPPED_GROUPING);
    expect(result.fileMutations.map((c) => c.id)).toEqual(['1', '2']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['3']);
    expect(result.extraMutations).toHaveLength(0);
  });
});

describe('groupCallsByPhase — caps', () => {
  it('parallel-reads cap truncates overflow silently', () => {
    const calls = [r('1'), r('2'), r('3'), r('4'), r('5'), r('6'), r('7'), r('8')];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: 6,
      maxFileMutationBatch: null,
      maxSideEffectChain: null,
    });
    expect(result.readOnly.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    // Reads beyond the cap are dropped, not pushed to extra.
    expect(result.extraMutations).toHaveLength(0);
  });

  it('file-mutation cap pushes overflow to batchOverflow (not extraMutations)', () => {
    const calls = [f('1'), f('2'), f('3'), f('4'), f('5'), f('6'), f('7'), f('8'), f('9')];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: null,
      maxFileMutationBatch: 8,
      maxSideEffectChain: null,
    });
    expect(result.fileMutations.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    // Overflow file mutations land in batchOverflow, not extraMutations.
    // Callers distinguish "split the batch" hint (batchOverflow) from
    // "ordering violation" hint (extraMutations). Copilot review on
    // PR #680.
    expect(result.batchOverflow.map((c) => c.id)).toEqual(['9']);
    expect(result.extraMutations).toHaveLength(0);
  });

  it('side-effect chain cap pushes overflow to extraMutations', () => {
    const calls = [s('1'), s('2'), s('3'), s('4'), s('5')];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: null,
      maxFileMutationBatch: null,
      maxSideEffectChain: 3,
    });
    expect(result.sideEffects.map((c) => c.id)).toEqual(['1', '2', '3']);
    // Chain overflow is a reject-with-feedback (re-issue next turn), NOT
    // a silent truncation — dropping a planned side-effect without signal
    // would desync the model's view of the workspace.
    expect(result.extraMutations.map((c) => c.id)).toEqual(['4', '5']);
  });

  it('null caps disable all limits (CLI reads/mutations behavior)', () => {
    const calls = [
      r('1'),
      r('2'),
      r('3'),
      r('4'),
      r('5'),
      r('6'),
      r('7'),
      r('8'),
      f('9'),
      f('10'),
      f('11'),
      f('12'),
      f('13'),
      f('14'),
      f('15'),
      f('16'),
      f('17'),
    ];
    const result = groupCallsByPhase(calls, predicates, UNCAPPED_GROUPING);
    expect(result.readOnly).toHaveLength(8);
    expect(result.fileMutations).toHaveLength(9);
    expect(result.extraMutations).toHaveLength(0);
  });

  it('batchOverflow stays separate from ordering violations when a side-effect arrives after the cap', () => {
    // The model emits 10 file mutations and then a side-effect.
    // Overflow (positions 9, 10) belong in `batchOverflow` (split the
    // batch hint). The trailing exec lands in `sideEffects` (it didn't
    // exceed its own cap). `extraMutations` remains empty.
    //
    // Pre-fix this test asserted `extraMutations = ['9', '10']` because
    // overflow was being prepended to extras. Splitting the two cases
    // makes the caller's correction hint precise.
    const calls = [
      f('1'),
      f('2'),
      f('3'),
      f('4'),
      f('5'),
      f('6'),
      f('7'),
      f('8'),
      f('9'),
      f('10'),
      s('11'),
    ];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: null,
      maxFileMutationBatch: 8,
      maxSideEffectChain: null,
    });
    expect(result.fileMutations.map((c) => c.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['11']);
    expect(result.batchOverflow.map((c) => c.id)).toEqual(['9', '10']);
    expect(result.extraMutations).toHaveLength(0);
  });

  it('a file mutation arriving after a side-effect lands in extraMutations, not batchOverflow', () => {
    // Pre-fix this was the wrong-hint bug: exec followed by write_file
    // was an ordering violation (not batch overflow), but the global
    // `batchOverflowed` flag in the CLI rejection handler would have
    // labeled it FILE_MUTATION_BATCH_OVERFLOW. The kernel now keeps the
    // two lists distinct so the caller can emit the right hint.
    const calls = [f('1'), f('2'), f('3'), s('4'), f('5')];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: null,
      maxFileMutationBatch: 8,
      maxSideEffectChain: null,
    });
    expect(result.fileMutations.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['4']);
    expect(result.batchOverflow).toHaveLength(0);
    expect(result.extraMutations.map((c) => c.id)).toEqual(['5']);
  });

  it('DEFAULT_GROUPING_CAPS accepts the canonical exec → exec → commit chain', () => {
    const result = groupCallsByPhase(
      [f('1'), s('2'), s('3'), s('4')],
      predicates,
      DEFAULT_GROUPING_CAPS,
    );
    expect(result.fileMutations.map((c) => c.id)).toEqual(['1']);
    expect(result.sideEffects.map((c) => c.id)).toEqual(['2', '3', '4']);
    expect(result.extraMutations).toHaveLength(0);
  });
});

describe('canonical cap constants', () => {
  // Drift detector: both surfaces import these from this module.
  // Changing the values is a deliberate behavior change that should
  // touch this test, not a casual edit.
  it('MAX_PARALLEL_TOOL_CALLS pinned at 6', () => {
    expect(MAX_PARALLEL_TOOL_CALLS).toBe(6);
  });

  it('MAX_FILE_MUTATION_BATCH pinned at 8', () => {
    expect(MAX_FILE_MUTATION_BATCH).toBe(8);
  });

  it('MAX_SIDE_EFFECT_CHAIN pinned at 3', () => {
    expect(MAX_SIDE_EFFECT_CHAIN).toBe(3);
  });

  it('DEFAULT_GROUPING_CAPS matches the pinned constants', () => {
    expect(DEFAULT_GROUPING_CAPS).toEqual({
      maxParallelReads: MAX_PARALLEL_TOOL_CALLS,
      maxFileMutationBatch: MAX_FILE_MUTATION_BATCH,
      maxSideEffectChain: MAX_SIDE_EFFECT_CHAIN,
    });
  });
});
