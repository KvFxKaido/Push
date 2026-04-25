import { describe, it, expect } from 'vitest';
import { runPlannerCore } from './planner-core.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

function makePushStream(events: PushStreamEvent[]): {
  stream: PushStream;
  capturedRequest: { current: unknown };
} {
  const capturedRequest: { current: unknown } = { current: null };
  const stream: PushStream = (req) => {
    capturedRequest.current = req;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  };
  return { stream, capturedRequest };
}

describe('runPlannerCore (PushStream consumer)', () => {
  it('accumulates text_delta events and parses the feature list', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"approach":"ship it",' },
      {
        type: 'text_delta',
        text: '"features":[{"id":"auth","description":"update auth flow"}]}',
      },
      { type: 'done', finishReason: 'stop' },
    ]);

    const plan = await runPlannerCore({
      task: 'Fix the auth flow',
      files: ['src/auth.ts'],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    expect(plan?.approach).toBe('ship it');
    expect(plan?.features).toHaveLength(1);
    expect(plan?.features[0].id).toBe('auth');

    const req = capturedRequest.current as { model: string; systemPromptOverride?: string };
    expect(req.model).toBe('planner-model');
    expect(req.systemPromptOverride).toContain('Planner agent');
  });

  it('returns null on stream errors (fail-open)', async () => {
    const stream: PushStream = () =>
      (async function* () {
        throw new Error('upstream went away');
      })();

    const plan = await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    expect(plan).toBeNull();
  });

  it('returns null when the JSON output is malformed', async () => {
    const { stream } = makePushStream([
      { type: 'text_delta', text: 'not json at all' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const plan = await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    expect(plan).toBeNull();
  });

  it('strips a fenced code block wrapper around the JSON', async () => {
    const { stream } = makePushStream([
      {
        type: 'text_delta',
        text: '```json\n{"approach":"x","features":[{"id":"a","description":"b"}]}\n```',
      },
      { type: 'done', finishReason: 'stop' },
    ]);

    const plan = await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    expect(plan?.features).toHaveLength(1);
    expect(plan?.features[0].id).toBe('a');
  });

  it('passes a signal through the request so streams can abort', async () => {
    const { stream, capturedRequest } = makePushStream([
      {
        type: 'text_delta',
        text: '{"approach":"x","features":[{"id":"a","description":"b"}]}',
      },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    const req = capturedRequest.current as { signal?: AbortSignal };
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('ignores reasoning_delta and reasoning_end while accumulating text', async () => {
    const { stream } = makePushStream([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'reasoning_end' },
      {
        type: 'text_delta',
        text: '{"approach":"x","features":[{"id":"a","description":"b"}]}',
      },
      { type: 'done', finishReason: 'stop' },
    ]);

    const plan = await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    expect(plan?.features).toHaveLength(1);
  });
});
