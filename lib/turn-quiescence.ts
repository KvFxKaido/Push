import type { RunEvent, RunEventInput } from './runtime-contract.js';

export type TurnQuiescedEvent = Extract<RunEventInput, { type: 'turn.quiesced' }>;

export type TurnQuiescenceSource = {
  subscribe(listener: (event: RunEvent) => void): () => void;
};

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
 */
export function waitForTurnQuiescence(
  source: TurnQuiescenceSource,
  runId: string,
): Promise<TurnQuiescedEvent & { id: string; timestamp: number }> {
  return new Promise((resolve) => {
    const unsubscribe = source.subscribe((event) => {
      if (event.type !== 'turn.quiesced' || event.runId !== runId) return;
      unsubscribe();
      resolve(event);
    });
  });
}
