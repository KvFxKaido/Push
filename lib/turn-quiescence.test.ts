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

  it('rejects with a diagnostic when the receipt never arrives before the deadline', async () => {
    // Deadline-aware per the #1410 review: a run that never quiesces must
    // fail fast with the runId in the message, not hang to the global timeout.
    let unsubscribed = false;
    const settled = waitForTurnQuiescence(
      {
        subscribe() {
          return () => {
            unsubscribed = true;
          };
        },
      },
      'run-lost',
      { timeoutMs: 10 },
    );

    await expect(settled).rejects.toThrow(/run-lost.*10ms/);
    expect(unsubscribed).toBe(true);
  });

  it('rejects and unsubscribes when the abort signal fires (or is already aborted)', async () => {
    const controller = new AbortController();
    let unsubscribed = false;
    const settled = waitForTurnQuiescence(
      {
        subscribe() {
          return () => {
            unsubscribed = true;
          };
        },
      },
      'run-2',
      { signal: controller.signal },
    );
    controller.abort();
    await expect(settled).rejects.toThrow(/aborted.*run-2/);
    expect(unsubscribed).toBe(true);

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      waitForTurnQuiescence({ subscribe: () => () => {} }, 'run-3', {
        signal: preAborted.signal,
      }),
    ).rejects.toThrow(/aborted.*run-3/);
  });
});
