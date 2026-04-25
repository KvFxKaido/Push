import { describe, it, expect } from 'vitest';
import { runReviewer } from './reviewer-agent.js';
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

describe('runReviewer (PushStream consumer)', () => {
  const noopRuntime = async () => '';

  it('accumulates text_delta events and parses the review JSON', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"summary":"Looks good",' },
      { type: 'text_delta', text: '"comments":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runReviewer(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'reviewer-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.summary).toBe('Looks good');
    expect(result.comments).toEqual([]);

    const req = capturedRequest.current as { model: string; systemPromptOverride?: string };
    expect(req.model).toBe('reviewer-model');
    expect(req.systemPromptOverride).toContain('Reviewer agent');
  });

  it('throws when the stream errors', async () => {
    const stream: PushStream = () =>
      (async function* () {
        throw new Error('upstream went away');
      })();

    await expect(
      runReviewer(
        makeAddedFileDiff('src/app.ts', 'const x = 1;'),
        {
          provider: 'openrouter',
          modelId: 'reviewer-model',
          stream,
          resolveRuntimeContext: noopRuntime,
        },
        () => {},
      ),
    ).rejects.toThrow(/upstream went away/);
  });

  it('passes a signal through the request so streams can abort', async () => {
    const { stream, capturedRequest } = makePushStream([
      { type: 'text_delta', text: '{"summary":"x","comments":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    await runReviewer(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'reviewer-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    const req = capturedRequest.current as { signal?: AbortSignal };
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('coalesces concurrent reviews on the same stream + diff into one call', async () => {
    let calls = 0;
    const stream: PushStream = () => {
      calls++;
      return (async function* () {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'text_delta', text: '{"summary":"shared","comments":[]}' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');
    const opts = {
      provider: 'openrouter' as const,
      modelId: 'reviewer-model',
      stream,
      resolveRuntimeContext: noopRuntime,
    };

    const [r1, r2] = await Promise.all([
      runReviewer(diff, opts, () => {}),
      runReviewer(diff, opts, () => {}),
    ]);

    expect(calls).toBe(1);
    expect(r1).toBe(r2);
    expect(r1.summary).toBe('shared');
  });

  it('does not coalesce concurrent reviews on different streams', async () => {
    const make =
      (label: string): PushStream =>
      () =>
        (async function* () {
          await new Promise((r) => setTimeout(r, 5));
          yield { type: 'text_delta', text: `{"summary":"${label}","comments":[]}` };
          yield { type: 'done', finishReason: 'stop' };
        })();

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    const [r1, r2] = await Promise.all([
      runReviewer(
        diff,
        {
          provider: 'openrouter',
          modelId: 'reviewer-model',
          stream: make('A'),
          resolveRuntimeContext: noopRuntime,
        },
        () => {},
      ),
      runReviewer(
        diff,
        {
          provider: 'openrouter',
          modelId: 'reviewer-model',
          stream: make('B'),
          resolveRuntimeContext: noopRuntime,
        },
        () => {},
      ),
    ]);

    expect(r1.summary).toBe('A');
    expect(r2.summary).toBe('B');
  });

  it('ignores reasoning_delta and reasoning_end while accumulating text', async () => {
    const { stream } = makePushStream([
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'reasoning_end' },
      { type: 'text_delta', text: '{"summary":"OK","comments":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);

    const result = await runReviewer(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      {
        provider: 'openrouter',
        modelId: 'reviewer-model',
        stream,
        resolveRuntimeContext: noopRuntime,
      },
      () => {},
    );

    expect(result.summary).toBe('OK');
  });
});
