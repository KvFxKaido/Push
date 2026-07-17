import type { PushStreamEvent } from './provider-contract.ts';

export const MAX_ANTHROPIC_PAUSE_TURN_ITERATIONS = 3;

export type AnthropicReplayAssistantTurns = Array<Array<Record<string, unknown>>>;

export interface AnthropicReplayRequest {
  replayAssistantTurns?: AnthropicReplayAssistantTurns;
}

export interface AnthropicPauseContinuationOptions<TBody extends object> {
  baseBody: TBody;
  runAttempt: (
    body: TBody & AnthropicReplayRequest,
    attempt: number,
  ) => AsyncIterable<PushStreamEvent>;
  maxPauseTurnIterations?: number;
}

/**
 * Run Anthropic's `pause_turn` replay loop around a shell-owned transport.
 *
 * The shell callback owns credentials, fetch/error handling, and SSE parsing.
 * This helper owns the protocol decision: hide `pause_turn`, append captured
 * assistant blocks oldest-first to the next request, stop on an empty replay,
 * and synthesize a terminal event when the replay cap is exhausted.
 */
export async function* continueAnthropicPauseTurns<TBody extends object>(
  options: AnthropicPauseContinuationOptions<TBody>,
): AsyncIterable<PushStreamEvent> {
  const maxPauseTurnIterations =
    options.maxPauseTurnIterations ?? MAX_ANTHROPIC_PAUSE_TURN_ITERATIONS;
  const replayAssistantTurns: AnthropicReplayAssistantTurns = [];

  for (let attempt = 0; attempt <= maxPauseTurnIterations; attempt += 1) {
    const currentBody = (
      replayAssistantTurns.length > 0
        ? { ...options.baseBody, replayAssistantTurns }
        : options.baseBody
    ) as TBody & AnthropicReplayRequest;
    let paused: Array<Record<string, unknown>> | null = null;

    for await (const event of options.runAttempt(currentBody, attempt)) {
      if (event.type === 'pause_turn') {
        paused = event.assistantBlocks;
        continue;
      }
      yield event;
    }

    if (!paused || paused.length === 0) return;
    if (attempt === maxPauseTurnIterations) {
      yield { type: 'done', finishReason: 'stop' };
      return;
    }
    replayAssistantTurns.push(paused);
  }
}

/**
 * Consume an Anthropic-compatible stream on a route that cannot legitimately
 * continue `pause_turn`. Defensive pause events are hidden and a terminal
 * `done` is guaranteed when the upstream closes without one.
 */
export async function* completeAnthropicStreamWithoutPause(
  events: AsyncIterable<PushStreamEvent>,
): AsyncIterable<PushStreamEvent> {
  let sawDone = false;
  for await (const event of events) {
    if (event.type === 'pause_turn') continue;
    if (event.type === 'done') sawDone = true;
    yield event;
  }
  if (!sawDone) yield { type: 'done', finishReason: 'stop' };
}
