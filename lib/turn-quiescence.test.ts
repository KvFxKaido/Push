import { describe, expect, it } from 'vitest';
import { createTurnQuiescedEvent, waitForTurnQuiescence } from './turn-quiescence.js';
import type { RunEvent } from './runtime-contract.js';

describe('turn quiescence', () => {
  it('builds a terminal receipt only for a real run', () => {
    expect(createTurnQuiescedEvent('', 'completed')).toBeNull();
    expect(createTurnQuiescedEvent('run-1', 'completed')).toEqual({
      type: 'turn.quiesced',
      runId: 'run-1',
      outcome: 'completed',
    });
  });

  it('waits on the receipt stream without polling', async () => {
    let listener: ((event: RunEvent) => void) | null = null;
    const settled = waitForTurnQuiescence(
      {
        subscribe(next) {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
      'run-1',
    );

    listener?.({
      id: 'event-1',
      timestamp: 1,
      type: 'turn.quiesced',
      runId: 'run-1',
      outcome: 'completed',
    });

    await expect(settled).resolves.toMatchObject({ runId: 'run-1', outcome: 'completed' });
  });
});
