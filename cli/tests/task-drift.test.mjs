import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTaskDriftMonitor, formatTaskDriftNudge } from '../../lib/task-drift.ts';

const read = (target, argsKey = target) => ({
  toolName: 'read_file',
  argsKey,
  target,
  sideEffect: 'read',
});

describe('task drift monitor', () => {
  it('fires and clears the identical-call signal mechanically', () => {
    const monitor = createTaskDriftMonitor({
      identicalCallRounds: 3,
      noNovelReadRounds: 99,
    });
    assert.equal(monitor.observeRound([read('lib/a.ts')]), null);
    assert.equal(monitor.observeRound([read('lib/a.ts')]), null);
    const fired = monitor.observeRound([read('lib/a.ts')]);
    assert.deepEqual(
      fired?.fired.map((signal) => signal.kind),
      ['repeated_tool_call'],
    );
    assert.equal(fired?.health, 'possibly_stalled');

    const cleared = monitor.observeRound([read('lib/b.ts')]);
    assert.deepEqual(cleared?.cleared, ['repeated_tool_call']);
    assert.equal(cleared?.health, 'working');
  });

  it('fires when reads stop discovering new targets and clears on a novel read', () => {
    const monitor = createTaskDriftMonitor({
      identicalCallRounds: 99,
      noNovelReadRounds: 2,
    });
    monitor.observeRound([read('lib/a.ts', 'first')]);
    monitor.observeRound([read('lib/a.ts', 'second')]);
    const fired = monitor.observeRound([read('lib/a.ts', 'third')]);
    assert.deepEqual(
      fired?.fired.map((signal) => signal.kind),
      ['no_novel_reads'],
    );

    const cleared = monitor.observeRound([read('lib/b.ts', 'fourth')]);
    assert.deepEqual(cleared?.cleared, ['no_novel_reads']);
  });

  it('only watches for missing mutations when the task is expected to mutate', () => {
    const observational = createTaskDriftMonitor({ noMutationRounds: 2 });
    observational.observeRound([read('lib/a.ts')]);
    assert.equal(observational.observeRound([read('lib/b.ts')]), null);

    const mutating = createTaskDriftMonitor({
      expectedToMutate: true,
      identicalCallRounds: 99,
      noNovelReadRounds: 99,
      noMutationRounds: 2,
    });
    mutating.observeRound([read('lib/a.ts')]);
    const fired = mutating.observeRound([read('lib/b.ts')]);
    assert.deepEqual(
      fired?.fired.map((signal) => signal.kind),
      ['no_mutation'],
    );

    const cleared = mutating.observeRound([
      { toolName: 'write_file', target: 'lib/a.ts', sideEffect: 'file_mutation' },
    ]);
    assert.deepEqual(cleared?.cleared, ['no_mutation']);
  });

  it('formats a bounded steering prompt with evidence and current position', () => {
    const nudge = formatTaskDriftNudge(
      [
        {
          kind: 'no_mutation',
          count: 6,
          detail: 'no workspace mutation observed for 6 active rounds',
        },
      ],
      [
        {
          id: 'implement',
          content: 'Implement the monitor',
          activeForm: 'Implementing the monitor',
          status: 'in_progress',
        },
      ],
    );
    assert.match(nudge, /no workspace mutation observed/);
    assert.match(nudge, /\[~\] Implementing the monitor/);
    assert.match(nudge, /continue with a materially new action/);
  });
});
