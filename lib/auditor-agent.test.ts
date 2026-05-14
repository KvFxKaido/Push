import { describe, it, expect } from 'vitest';
import { runAuditor, runAuditorEvaluation } from './auditor-agent.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

function makeAddedFileDiff(path: string, addedContent: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${addedContent}`,
    '',
  ].join('\n');
}

/**
 * Build a PushStream that yields the given events. Captures the request it
 * receives so callers can assert on the assembled `PushStreamRequest`.
 */
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

describe('runAuditor (PushStream consumer)', () => {
  const noopRuntime = async () => '';

  it('accumulates text_delta events and parses the verdict JSON', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"verdict":"safe",' },
      { type: 'text_delta', text: '"summary":"OK","risks":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.verdict).toBe('safe');
    expect(result.card.summary).toBe('OK');

    const req = capturedRequest.current as { model: string; systemPromptOverride?: string };
    expect(req.model).toBe('test-model');
    expect(req.systemPromptOverride).toContain('Auditor agent');
  });

  it('passes a signal through the request so streams can abort', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"verdict":"safe","summary":"x","risks":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    const req = capturedRequest.current as { signal?: AbortSignal };
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns UNSAFE when the stream throws', async () => {
    const stream: PushStream = () =>
      (async function* () {
        throw new Error('upstream went away');
      })();

    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.verdict).toBe('unsafe');
    expect(result.card.summary).toContain('upstream went away');
  });

  it('returns UNSAFE when the JSON output is malformed', async () => {
    const { stream } = makePushStream([
      { type: 'text_delta', text: 'not json at all' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.verdict).toBe('unsafe');
    expect(result.card.summary).toMatch(/invalid response/i);
  });

  it('strips a fenced code block wrapper around the JSON', async () => {
    const { stream } = makePushStream([
      {
        type: 'text_delta',
        text: '```json\n{"verdict":"safe","summary":"fenced","risks":[]}\n```',
      },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.verdict).toBe('safe');
    expect(result.card.summary).toBe('fenced');
  });

  it('returns UNSAFE without invoking the stream when provider is demo', async () => {
    let invoked = false;
    const stream: PushStream = () => {
      invoked = true;
      return (async function* () {
        yield { type: 'done', finishReason: 'stop' };
      })();
    };

    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'demo',
        modelId: undefined,
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(invoked).toBe(false);
    expect(result.verdict).toBe('unsafe');
    expect(result.card.summary).toContain('No AI provider configured');
  });

  it('returns UNSAFE when no stream is provided', async () => {
    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream: undefined,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.verdict).toBe('unsafe');
  });

  it('returns UNSAFE without invoking the stream when modelId is missing', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"verdict":"safe","summary":"ok","risks":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: '   ',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );
    expect(result.verdict).toBe('unsafe');
    expect(result.card.summary).toContain('missing model id');
    expect(capturedRequest.current).toBeNull();
  });

  it('ignores reasoning_delta and reasoning_end while accumulating text', async () => {
    const { stream } = makePushStream([
      { type: 'reasoning_delta', text: 'thinking about it...' },
      { type: 'reasoning_end' },
      { type: 'text_delta', text: '{"verdict":"safe","summary":"OK","risks":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.verdict).toBe('safe');
    expect(result.card.summary).toBe('OK');
  });

  it('emits exactly one assistant.prompt_snapshot run event tagged with the auditor role', async () => {
    // Wire-through guard mirroring the coder/explorer/reviewer tests.
    const { stream } = makePushStream([
      { type: 'text_delta', text: '{"verdict":"safe","summary":"OK","risks":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const events: Array<{ type: string }> = [];

    await runAuditor(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
        resolveRuntimeContext: noopRuntime,
        onRunEvent: (event) => events.push(event),
      },
      () => {},
    );

    const snapshots = events.filter((e) => e.type === 'assistant.prompt_snapshot');
    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0] as { round: number; role: string; totalChars: number };
    expect(snap.round).toBe(0);
    expect(snap.role).toBe('auditor');
    expect(snap.totalChars).toBeGreaterThan(0);
  });
});

describe('runAuditorEvaluation (PushStream consumer)', () => {
  it('accumulates text_delta events and parses the verdict JSON', async () => {
    const { stream, capturedRequest } = makePushStream([
      {
        type: 'text_delta',
        text: '{"verdict":"complete","summary":"All done","gaps":[],"confidence":"high"}',
      },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runAuditorEvaluation(
      'finish the auth fix',
      'Updated the auth guard.',
      null,
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
      },
      () => {},
    );

    expect(result.verdict).toBe('complete');
    expect(result.confidence).toBe('high');
    const req = capturedRequest.current as { systemPromptOverride?: string };
    expect(req.systemPromptOverride).toContain('Evaluator');
  });

  it('returns INCOMPLETE on stream errors', async () => {
    const stream: PushStream = () =>
      (async function* () {
        throw new Error('eval upstream failed');
      })();

    const result = await runAuditorEvaluation(
      'finish the auth fix',
      'Updated the auth guard.',
      null,
      null,
      {
        provider: 'openrouter',
        modelId: 'test-model',
        stream,
      },
      () => {},
    );

    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('eval upstream failed');
  });

  it('returns INCOMPLETE without invoking the stream when modelId is missing', async () => {
    const { stream, capturedRequest } = makePushStream([
      {
        type: 'text_delta',
        text: '{"verdict":"complete","summary":"ok","gaps":[],"confidence":"high"}',
      },
      { type: 'done', finishReason: 'stop' },
    ]);
    const result = await runAuditorEvaluation(
      'finish the auth fix',
      'Updated the auth guard.',
      null,
      null,
      {
        provider: 'openrouter',
        modelId: '',
        stream,
      },
      () => {},
    );
    expect(result.verdict).toBe('incomplete');
    expect(result.summary).toContain('missing model id');
    expect(capturedRequest.current).toBeNull();
  });
});
