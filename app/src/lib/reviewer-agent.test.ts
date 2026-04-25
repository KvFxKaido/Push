import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetProviderPushStream, mockBuildReviewerRuntimeContext, mockReadSymbolsFromSandbox } =
  vi.hoisted(() => ({
    mockGetProviderPushStream: vi.fn(),
    mockBuildReviewerRuntimeContext: vi.fn(),
    mockReadSymbolsFromSandbox: vi.fn(),
  }));

vi.mock('./orchestrator', () => ({
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock('./role-memory-context', () => ({
  buildReviewerRuntimeContext: (...args: unknown[]) => mockBuildReviewerRuntimeContext(...args),
}));

vi.mock('./sandbox-client', () => ({
  readSymbolsFromSandbox: (...args: unknown[]) => mockReadSymbolsFromSandbox(...args),
}));

import { runReviewer } from './reviewer-agent';
import type { PushStream, PushStreamEvent } from '@push/lib/provider-contract';

interface CapturedRequest {
  model: string;
  systemPromptOverride?: string;
  messages: Array<{ content: string }>;
}

/** Build a PushStream that emits a fixed event sequence and records the request. */
function makePushStream(events: PushStreamEvent[]): {
  stream: PushStream;
  capturedRequests: CapturedRequest[];
  callCount: () => number;
} {
  const capturedRequests: CapturedRequest[] = [];
  const stream: PushStream = (req) => {
    capturedRequests.push({
      model: req.model,
      systemPromptOverride: req.systemPromptOverride,
      messages: req.messages.map((m) => ({ content: m.content })),
    });
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  };
  return { stream, capturedRequests, callCount: () => capturedRequests.length };
}

const baseReviewerOptions = {
  provider: 'openrouter' as const,
  modelId: 'default-reviewer-model',
};

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

describe('runReviewer', () => {
  let currentStream: PushStream;
  let currentCapture: CapturedRequest[];

  beforeEach(() => {
    mockGetProviderPushStream.mockReset();
    mockBuildReviewerRuntimeContext.mockReset();
    mockReadSymbolsFromSandbox.mockReset();

    mockBuildReviewerRuntimeContext.mockResolvedValue('');

    const { stream, capturedRequests } = makePushStream([
      { type: 'text_delta', text: '{"summary":"Looks good","comments":[]}' },
      { type: 'done', finishReason: 'stop' },
    ]);
    currentStream = stream;
    currentCapture = capturedRequests;
    mockGetProviderPushStream.mockImplementation(() => currentStream);
  });

  it('prefetches file structure when a sandbox is available', async () => {
    mockReadSymbolsFromSandbox
      .mockResolvedValueOnce({
        totalLines: 120,
        symbols: [
          {
            name: 'validateToken',
            kind: 'function',
            line: 12,
            signature: 'export function validateToken(token: string)',
          },
          { name: 'AuthProvider', kind: 'class', line: 45, signature: 'export class AuthProvider' },
        ],
      })
      .mockRejectedValueOnce(new Error('missing file'));

    const statuses: string[] = [];
    const diff = [
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      makeAddedFileDiff('src/auth.test.ts', 'it("works", () => {})'),
    ].join('');

    await runReviewer(diff, { ...baseReviewerOptions, sandboxId: 'sb-123' }, (phase) => {
      statuses.push(phase);
    });

    expect(statuses).toContain('Preparing review...');
    expect(statuses).toContain('Reviewer reading diff…');
    expect(mockReadSymbolsFromSandbox).toHaveBeenCalledWith('sb-123', '/workspace/src/auth.ts');
    expect(mockReadSymbolsFromSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/auth.test.ts',
    );

    const req = currentCapture[0]!;
    const prompt = req.messages[0]?.content ?? '';

    expect(req.systemPromptOverride).toContain(
      "File structure is auto-fetched and shows the outline of changed files. Use it for orientation but don't assume it's complete.",
    );
    expect(prompt).toContain('[FILE STRUCTURE — auto-fetched from changed files]');
    expect(prompt).toContain('--- src/auth.ts ---');
    expect(prompt).toContain('export function validateToken(token: string) [L12]');
    expect(prompt).not.toContain('src/auth.test.ts ---');
  });

  it('coalesces concurrent identical reviews into a single stream call', async () => {
    let calls = 0;
    const slowStream: PushStream = (req) => {
      calls += 1;
      currentCapture.push({
        model: req.model,
        systemPromptOverride: req.systemPromptOverride,
        messages: req.messages.map((m) => ({ content: m.content })),
      });
      return (async function* () {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'text_delta', text: '{"summary":"Looks good","comments":[]}' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    currentStream = slowStream;
    mockGetProviderPushStream.mockImplementation(() => currentStream);

    const statuses1: string[] = [];
    const statuses2: string[] = [];
    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    const [r1, r2] = await Promise.all([
      runReviewer(diff, baseReviewerOptions, (phase) => {
        statuses1.push(phase);
      }),
      runReviewer(diff, baseReviewerOptions, (phase) => {
        statuses2.push(phase);
      }),
    ]);

    // Both callers get the same result
    expect(r1).toBe(r2);
    // Only one stream call was made
    expect(calls).toBe(1);
    // Both callers received status updates
    expect(statuses1.length).toBeGreaterThan(0);
    expect(statuses2.length).toBeGreaterThan(0);
  });

  it('does not coalesce concurrent reviews with different stream identities', async () => {
    // Regression for PR #273 review feedback: when getProviderPushStream
    // returns distinct PushStream instances (e.g., different session auth
    // wrappers), the coalescing key must treat them as distinct so the
    // second caller does not silently receive a result from the first.
    let aCalls = 0;
    let bCalls = 0;
    const streamA: PushStream = () => {
      aCalls += 1;
      return (async function* () {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'text_delta', text: '{"summary":"Looks good A","comments":[]}' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    const streamB: PushStream = () => {
      bCalls += 1;
      return (async function* () {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'text_delta', text: '{"summary":"Looks good B","comments":[]}' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    let next: 'A' | 'B' = 'A';
    mockGetProviderPushStream.mockImplementation(() => {
      const fn = next === 'A' ? streamA : streamB;
      next = next === 'A' ? 'B' : 'A';
      return fn;
    });

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    const [r1, r2] = await Promise.all([
      runReviewer(diff, baseReviewerOptions, () => {}),
      runReviewer(diff, baseReviewerOptions, () => {}),
    ]);

    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
    expect(r1.summary).toBe('Looks good A');
    expect(r2.summary).toBe('Looks good B');
  });

  it('does not coalesce concurrent reviews with different runtime context', async () => {
    mockBuildReviewerRuntimeContext.mockImplementation(
      async (_diff: string, context?: { sourceLabel?: string }) => context?.sourceLabel ?? '',
    );
    let calls = 0;
    const slowStream: PushStream = () => {
      calls += 1;
      return (async function* () {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'text_delta', text: '{"summary":"Looks good","comments":[]}' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    currentStream = slowStream;
    mockGetProviderPushStream.mockImplementation(() => currentStream);

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    await Promise.all([
      runReviewer(diff, { ...baseReviewerOptions, context: { sourceLabel: 'Repo A' } }, () => {}),
      runReviewer(diff, { ...baseReviewerOptions, context: { sourceLabel: 'Repo B' } }, () => {}),
    ]);

    expect(calls).toBe(2);
  });

  it('replays the latest status to a late-joining coalesced reviewer subscriber', async () => {
    const releaseSymbols: { current: null | (() => void) } = { current: null };
    mockReadSymbolsFromSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSymbols.current = () => resolve({ totalLines: 1, symbols: [] });
        }),
    );

    let calls = 0;
    const slowStream: PushStream = () => {
      calls += 1;
      return (async function* () {
        await new Promise((r) => setTimeout(r, 10));
        yield { type: 'text_delta', text: '{"summary":"Looks good","comments":[]}' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    currentStream = slowStream;
    mockGetProviderPushStream.mockImplementation(() => currentStream);

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');
    const statuses1: string[] = [];
    const statuses2: string[] = [];

    const first = runReviewer(diff, { ...baseReviewerOptions, sandboxId: 'sb-123' }, (phase) => {
      statuses1.push(phase);
    });

    await Promise.resolve();

    const second = runReviewer(diff, { ...baseReviewerOptions, sandboxId: 'sb-123' }, (phase) => {
      statuses2.push(phase);
    });

    expect(statuses1).toContain('Preparing review...');
    expect(statuses2).toContain('Preparing review...');

    if (releaseSymbols.current) releaseSymbols.current();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it('omits file structure when sandbox is unavailable', async () => {
    const statuses: string[] = [];
    const diff = makeAddedFileDiff('src/auth.ts', 'const auth = true;');

    await runReviewer(diff, baseReviewerOptions, (phase) => {
      statuses.push(phase);
    });

    expect(statuses).not.toContain('Preparing review...');
    expect(mockReadSymbolsFromSandbox).not.toHaveBeenCalled();

    const req = currentCapture[0]!;
    const prompt = req.messages[0]?.content ?? '';

    expect(req.systemPromptOverride).not.toContain('File structure is auto-fetched');
    expect(prompt).not.toContain('[FILE STRUCTURE — auto-fetched from changed files]');
  });

  it('passes retrieved reviewer memory through the runtime context block', async () => {
    mockBuildReviewerRuntimeContext.mockResolvedValue(
      '## Review Run Context\n\n[RETRIEVED_TASK_MEMORY]\n- [decision | orchestrator] Prior review note\n[/RETRIEVED_TASK_MEMORY]',
    );

    await runReviewer(
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      baseReviewerOptions,
      () => {},
    );

    const req = currentCapture[0]!;
    expect(req.systemPromptOverride).toContain('[RETRIEVED_TASK_MEMORY]');
    expect(req.systemPromptOverride).toContain('Prior review note');
  });
});
