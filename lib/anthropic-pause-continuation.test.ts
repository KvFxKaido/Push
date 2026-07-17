import { describe, expect, it } from 'vitest';
import type { PushStreamEvent } from './provider-contract';
import {
  MAX_ANTHROPIC_PAUSE_TURN_ITERATIONS,
  completeAnthropicStreamWithoutPause,
  continueAnthropicPauseTurns,
} from './anthropic-pause-continuation';

async function* events(...items: PushStreamEvent[]): AsyncIterable<PushStreamEvent> {
  yield* items;
}

async function collect(iterable: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const result: PushStreamEvent[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

describe('continueAnthropicPauseTurns', () => {
  it('passes through a terminal attempt without adding replay state', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const output = await collect(
      continueAnthropicPauseTurns({
        baseBody: { model: 'claude-test' },
        runAttempt: (body) => {
          bodies.push(body);
          return events(
            { type: 'text_delta', text: 'done' },
            { type: 'done', finishReason: 'stop' },
          );
        },
      }),
    );

    expect(bodies).toEqual([{ model: 'claude-test' }]);
    expect(output).toEqual([
      { type: 'text_delta', text: 'done' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('hides pause events and replays captured assistant turns oldest-first', async () => {
    const pauseA = [{ type: 'text', text: 'first' }];
    const pauseB = [{ type: 'server_tool_use', id: 'tool-1', name: 'web_search' }];
    const bodies: Array<Record<string, unknown>> = [];
    const attempts = [
      [
        { type: 'text_delta', text: 'A' },
        { type: 'pause_turn', assistantBlocks: pauseA },
      ],
      [
        { type: 'text_delta', text: 'B' },
        { type: 'pause_turn', assistantBlocks: pauseB },
      ],
      [
        { type: 'text_delta', text: 'C' },
        { type: 'done', finishReason: 'stop' },
      ],
    ] satisfies PushStreamEvent[][];

    const output = await collect(
      continueAnthropicPauseTurns({
        baseBody: { model: 'claude-test', messages: [] },
        runAttempt: (body, attempt) => {
          bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
          return events(...attempts[attempt]);
        },
      }),
    );

    expect(output).toEqual([
      { type: 'text_delta', text: 'A' },
      { type: 'text_delta', text: 'B' },
      { type: 'text_delta', text: 'C' },
      { type: 'done', finishReason: 'stop' },
    ]);
    expect(bodies).toEqual([
      { model: 'claude-test', messages: [] },
      { model: 'claude-test', messages: [], replayAssistantTurns: [pauseA] },
      { model: 'claude-test', messages: [], replayAssistantTurns: [pauseA, pauseB] },
    ]);
  });

  it('does not retry a pause event with no replay blocks', async () => {
    let attempts = 0;
    const output = await collect(
      continueAnthropicPauseTurns({
        baseBody: { model: 'claude-test' },
        runAttempt: () => {
          attempts += 1;
          return events({ type: 'pause_turn', assistantBlocks: [] });
        },
      }),
    );

    expect(attempts).toBe(1);
    expect(output).toEqual([]);
  });

  it('caps replay attempts and guarantees a terminal event', async () => {
    let attempts = 0;
    const output = await collect(
      continueAnthropicPauseTurns({
        baseBody: { model: 'claude-test' },
        runAttempt: () => {
          attempts += 1;
          return events({
            type: 'pause_turn',
            assistantBlocks: [{ type: 'text', text: `pause-${attempts}` }],
          });
        },
      }),
    );

    expect(attempts).toBe(MAX_ANTHROPIC_PAUSE_TURN_ITERATIONS + 1);
    expect(output).toEqual([{ type: 'done', finishReason: 'stop' }]);
  });
});

describe('completeAnthropicStreamWithoutPause', () => {
  it('hides defensive pause events and adds a terminal event when absent', async () => {
    const output = await collect(
      completeAnthropicStreamWithoutPause(
        events(
          { type: 'text_delta', text: 'partial' },
          { type: 'pause_turn', assistantBlocks: [{ type: 'text', text: 'ignored' }] },
        ),
      ),
    );

    expect(output).toEqual([
      { type: 'text_delta', text: 'partial' },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('does not duplicate an upstream terminal event', async () => {
    const output = await collect(
      completeAnthropicStreamWithoutPause(events({ type: 'done', finishReason: 'length' })),
    );

    expect(output).toEqual([{ type: 'done', finishReason: 'length' }]);
  });
});
