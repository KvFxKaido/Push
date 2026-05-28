/**
 * Pinning tests for the shared phase-grouping state machine. These
 * mirror the cases that previously lived in
 * `app/src/lib/tool-dispatch.test.ts` and the inline assumptions
 * baked into `cli/engine.ts`'s state machine — extracting the kernel
 * meant the test pins live with the kernel.
 *
 * Stub call type with explicit read/mutation/side-effect tags so the
 * tests don't need to import the web or CLI ToolCall unions.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  groupCallsByPhase,
  UNCAPPED_GROUPING,
  type GroupingPredicates,
} from './tool-call-grouping.js';

interface StubCall {
  id: string;
  kind: 'read' | 'file' | 'side';
}

const predicates: GroupingPredicates<StubCall> = {
  isReadOnly: (c) => c.kind === 'read',
  isFileMutation: (c) => c.kind === 'file',
};

const r = (id: string): StubCall => ({ id, kind: 'read' });
const f = (id: string): StubCall => ({ id, kind: 'file' });
const s = (id: string): StubCall => ({ id, kind: 'side' });

describe('groupCallsByPhase — empty + single-call paths', () => {
  it('empty input returns the empty shape', () => {
    const result = groupCallsByPhase<StubCall>([], predicates, UNCAPPED_GROUPING);
    assert.deepEqual(result, {
      readOnly: [],
      fileMutations: [],
      mutating: null,
      extraMutations: [],
    });
  });

  it('single read classifies directly into readOnly', () => {
    const result = groupCallsByPhase([r('a')], predicates, UNCAPPED_GROUPING);
    assert.deepEqual(result.readOnly, [r('a')]);
    assert.equal(result.fileMutations.length, 0);
    assert.equal(result.mutating, null);
    assert.equal(result.extraMutations.length, 0);
  });

  it('single file mutation classifies directly into fileMutations', () => {
    const result = groupCallsByPhase([f('a')], predicates, UNCAPPED_GROUPING);
    assert.deepEqual(result.fileMutations, [f('a')]);
    assert.equal(result.readOnly.length, 0);
    assert.equal(result.mutating, null);
  });

  it('single side-effect classifies directly into mutating', () => {
    const result = groupCallsByPhase([s('a')], predicates, UNCAPPED_GROUPING);
    assert.deepEqual(result.mutating, s('a'));
    assert.equal(result.readOnly.length, 0);
    assert.equal(result.fileMutations.length, 0);
  });
});

describe('groupCallsByPhase — multi-call state machine', () => {
  it('reads → file mutations → trailing side-effect: happy path', () => {
    const result = groupCallsByPhase(
      [r('1'), r('2'), f('3'), f('4'), s('5')],
      predicates,
      UNCAPPED_GROUPING,
    );
    assert.deepEqual(
      result.readOnly.map((c) => c.id),
      ['1', '2'],
    );
    assert.deepEqual(
      result.fileMutations.map((c) => c.id),
      ['3', '4'],
    );
    assert.equal(result.mutating?.id, '5');
    assert.equal(result.extraMutations.length, 0);
  });

  it('side-effect terminates the turn — anything after is extra', () => {
    const result = groupCallsByPhase(
      [r('1'), s('2'), r('3'), f('4')],
      predicates,
      UNCAPPED_GROUPING,
    );
    assert.deepEqual(
      result.readOnly.map((c) => c.id),
      ['1'],
    );
    assert.equal(result.mutating?.id, '2');
    assert.deepEqual(
      result.extraMutations.map((c) => c.id),
      ['3', '4'],
    );
  });

  it('second side-effect lands in extraMutations', () => {
    const result = groupCallsByPhase([s('a'), s('b')], predicates, UNCAPPED_GROUPING);
    assert.equal(result.mutating?.id, 'a');
    assert.deepEqual(
      result.extraMutations.map((c) => c.id),
      ['b'],
    );
  });

  it('read after mutations started → ordering violation, rest spills to extra', () => {
    const result = groupCallsByPhase(
      [r('1'), f('2'), r('3'), f('4')],
      predicates,
      UNCAPPED_GROUPING,
    );
    assert.deepEqual(
      result.readOnly.map((c) => c.id),
      ['1'],
    );
    assert.deepEqual(
      result.fileMutations.map((c) => c.id),
      ['2'],
    );
    assert.equal(result.mutating, null);
    // r('3') triggered the violation and flipped phase to 'done',
    // then f('4') was caught in the done branch.
    assert.deepEqual(
      result.extraMutations.map((c) => c.id),
      ['3', '4'],
    );
  });

  it('file mutation followed by side-effect is valid (file batch + trailing exec)', () => {
    const result = groupCallsByPhase([f('1'), f('2'), s('3')], predicates, UNCAPPED_GROUPING);
    assert.deepEqual(
      result.fileMutations.map((c) => c.id),
      ['1', '2'],
    );
    assert.equal(result.mutating?.id, '3');
    assert.equal(result.extraMutations.length, 0);
  });
});

describe('groupCallsByPhase — caps', () => {
  it('parallel-reads cap truncates overflow silently', () => {
    const calls = [r('1'), r('2'), r('3'), r('4'), r('5'), r('6'), r('7'), r('8')];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: 6,
      maxFileMutationBatch: null,
    });
    assert.deepEqual(
      result.readOnly.map((c) => c.id),
      ['1', '2', '3', '4', '5', '6'],
    );
    // Reads beyond the cap are dropped, not pushed to extra.
    assert.equal(result.extraMutations.length, 0);
  });

  it('file-mutation cap pushes overflow to extraMutations (prepended)', () => {
    const calls = [f('1'), f('2'), f('3'), f('4'), f('5'), f('6'), f('7'), f('8'), f('9')];
    const result = groupCallsByPhase(calls, predicates, {
      maxParallelReads: null,
      maxFileMutationBatch: 8,
    });
    assert.deepEqual(
      result.fileMutations.map((c) => c.id),
      ['1', '2', '3', '4', '5', '6', '7', '8'],
    );
    assert.deepEqual(
      result.extraMutations.map((c) => c.id),
      ['9'],
    );
  });

  it('null caps disable both limits (CLI behavior)', () => {
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
    assert.equal(result.readOnly.length, 8);
    assert.equal(result.fileMutations.length, 9);
    assert.equal(result.extraMutations.length, 0);
  });

  it('file overflow lands before any post-cap calls in extraMutations', () => {
    // If the model emits 10 file mutations and then a side-effect, the
    // overflow (positions 9, 10) should land in extraMutations BEFORE
    // any other extras (none here, but the unshift semantics matter
    // for downstream messaging — the user-facing "too many writes"
    // error keys off the front of extraMutations).
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
    });
    assert.deepEqual(
      result.fileMutations.map((c) => c.id),
      ['1', '2', '3', '4', '5', '6', '7', '8'],
    );
    assert.equal(result.mutating?.id, '11');
    assert.deepEqual(
      result.extraMutations.map((c) => c.id),
      ['9', '10'],
    );
  });
});
