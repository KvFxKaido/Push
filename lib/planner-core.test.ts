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

  // ---------------------------------------------------------------------------
  // Goal-anchor support — CLI parity with the web runtime gate (PR #550 follow-up).
  // ---------------------------------------------------------------------------

  it('omits the [USER_GOAL] block from the user message when no goal is provided', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"approach":"x","features":[{"id":"a","description":"b"}]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    const req = capturedRequest.current as { messages: Array<{ content: string }> };
    expect(req.messages[0].content).not.toContain('[USER_GOAL]');
  });

  it('prepends a [USER_GOAL] block to the user message when a goal is provided', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"approach":"x","features":[{"id":"a","description":"b"}]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
      goal: {
        initialAsk: 'restore the auth flow regression',
        currentWorkingGoal: 'narrow to session refresh',
      },
    });

    const req = capturedRequest.current as { messages: Array<{ content: string }> };
    expect(req.messages[0].content).toContain('[USER_GOAL]');
    expect(req.messages[0].content).toContain('Initial ask: restore the auth flow regression');
    expect(req.messages[0].content).toContain('Current working goal: narrow to session refresh');
    // Goal block must appear before the task body so the planner reads
    // the constraint first.
    const goalIdx = req.messages[0].content.indexOf('[USER_GOAL]');
    const taskIdx = req.messages[0].content.indexOf('Decompose this coding task');
    expect(taskIdx).toBeGreaterThan(goalIdx);
  });

  it('documents the addresses field in the planner system prompt', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"approach":"x","features":[{"id":"a","description":"b"}]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runPlannerCore({
      task: 'Fix the auth flow',
      files: [],
      stream,
      provider: 'openrouter',
      modelId: 'planner-model',
    });

    const req = capturedRequest.current as { systemPromptOverride?: string };
    expect(req.systemPromptOverride).toContain('addresses');
    expect(req.systemPromptOverride).toContain('[USER_GOAL]');
  });

  it('parses an addresses field per feature when the planner emits it', async () => {
    const { stream } = makePushStream([
      {
        type: 'text_delta',
        text: '{"approach":"x","features":[{"id":"a","description":"b","addresses":"Initial ask"}]}',
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

    expect(plan?.features[0].addresses).toBe('Initial ask');
  });

  it('drops whitespace-only addresses rather than passing them downstream', async () => {
    const { stream } = makePushStream([
      {
        type: 'text_delta',
        text: '{"approach":"x","features":[{"id":"a","description":"b","addresses":"   \\n  "}]}',
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

    expect(plan?.features[0].addresses).toBeUndefined();
  });
});
