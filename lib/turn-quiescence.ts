import type { RunEvent, RunEventInput } from './runtime-contract.js';

export type TurnQuiescedEvent = Extract<RunEventInput, { type: 'turn.quiesced' }>;

export type TurnQuiescenceSource = {
  subscribe(listener: (event: RunEvent) => void): () => void;
};

export interface WaitForTurnQuiescenceOptions {
  /** Reject if the receipt has not arrived after this many milliseconds. */
  timeoutMs?: number;
  /** Reject (and unsubscribe) as soon as this signal aborts. */
  signal?: AbortSignal;
}

/** Build the terminal receipt after all foreground-turn cleanup has settled. */
export function createTurnQuiescedEvent(
  runId: string,
  outcome: TurnQuiescedEvent['outcome'],
): TurnQuiescedEvent | null {
  return runId ? { type: 'turn.quiesced', runId, outcome } : null;
}

/**
 * Event-driven test seam for work that must wait until a foreground turn is
 * actually quiet. It deliberately subscribes to the lifecycle stream rather
 * than polling timers, git state, or React rendering.
 *
 * Deadline-aware like the repo's other event-wait helpers: a run that never
 * quiesces (a bug, or an event that fired before subscription) rejects with a
 * diagnostic instead of hanging until the runner's global timeout.
 */
export function waitForTurnQuiescence(
  source: TurnQuiescenceSource,
  runId: string,
  options: WaitForTurnQuiescenceOptions = {},
): Promise<TurnQuiescedEvent & { id: string; timestamp: number }> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};

    const cleanup = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    };

    const onAbort = () => {
      cleanup();
      reject(new Error(`waitForTurnQuiescence aborted while waiting on run ${runId}`));
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (options.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(`turn.quiesced for run ${runId} did not arrive within ${options.timeoutMs}ms`),
        );
      }, options.timeoutMs);
    }

    unsubscribe = source.subscribe((event) => {
      if (event.type !== 'turn.quiesced' || event.runId !== runId) return;
      cleanup();
      resolve(event);
    });
  });
}
