import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStreamFn, mockBuildReviewerRuntimeContext, mockReadSymbolsFromSandbox } = vi.hoisted(
  () => ({
    mockStreamFn: vi.fn(),
    mockBuildReviewerRuntimeContext: vi.fn(),
    mockReadSymbolsFromSandbox: vi.fn(),
  }),
);

vi.mock('./role-memory-context', () => ({
  buildReviewerRuntimeContext: (...args: unknown[]) => mockBuildReviewerRuntimeContext(...args),
}));

vi.mock('./sandbox-client', () => ({
  readSymbolsFromSandbox: (...args: unknown[]) => mockReadSymbolsFromSandbox(...args),
}));

import { runReviewer } from './reviewer-agent';

/**
 * Shared reviewer options used across tests. Providers now inject streamFn and
 * modelId, so tests pass them explicitly rather than letting reviewer-agent
 * look them up via getProviderStreamFn / getModelForRole.
 */
const baseReviewerOptions = {
  provider: 'openrouter' as const,
  streamFn: mockStreamFn as unknown as import('./orchestrator-provider-routing').StreamChatFn,
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
  beforeEach(() => {
    mockStreamFn.mockReset();
    mockBuildReviewerRuntimeContext.mockReset();
    mockReadSymbolsFromSandbox.mockReset();

    mockBuildReviewerRuntimeContext.mockResolvedValue('');
    mockStreamFn.mockImplementation(
      (_messages: unknown, onToken: (token: string) => void, onDone: () => void) => {
        onToken('{"summary":"Looks good","comments":[]}');
        onDone();
        return Promise.resolve();
      },
    );
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

    const messages = mockStreamFn.mock.calls[0]?.[0] as Array<{ content: string }>;
    const systemPrompt = mockStreamFn.mock.calls[0]?.[8] as string;
    const prompt = messages[0]?.content ?? '';

    expect(systemPrompt).toContain(
      "File structure is auto-fetched and shows the outline of changed files. Use it for orientation but don't assume it's complete.",
    );
    expect(prompt).toContain('[FILE STRUCTURE — auto-fetched from changed files]');
    expect(prompt).toContain('--- src/auth.ts ---');
    expect(prompt).toContain('export function validateToken(token: string) [L12]');
    expect(prompt).not.toContain('src/auth.test.ts ---');
  });

  it('coalesces concurrent identical reviews into a single stream call', async () => {
    // Use an async mock so the first call is still in-flight when the second arrives
    mockStreamFn.mockImplementation(
      async (_messages: unknown, onToken: (token: string) => void, onDone: () => void) => {
        await new Promise((r) => setTimeout(r, 10));
        onToken('{"summary":"Looks good","comments":[]}');
        onDone();
      },
    );

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
    expect(mockStreamFn).toHaveBeenCalledTimes(1);
    // Both callers received status updates
    expect(statuses1.length).toBeGreaterThan(0);
    expect(statuses2.length).toBeGreaterThan(0);
  });

  it('does not coalesce concurrent reviews with different runtime context', async () => {
    mockBuildReviewerRuntimeContext.mockImplementation(
      async (_diff: string, context?: { sourceLabel?: string }) => context?.sourceLabel ?? '',
    );
    mockStreamFn.mockImplementation(
      async (_messages: unknown, onToken: (token: string) => void, onDone: () => void) => {
        await new Promise((r) => setTimeout(r, 10));
        onToken('{"summary":"Looks good","comments":[]}');
        onDone();
      },
    );

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    await Promise.all([
      runReviewer(diff, { ...baseReviewerOptions, context: { sourceLabel: 'Repo A' } }, () => {}),
      runReviewer(diff, { ...baseReviewerOptions, context: { sourceLabel: 'Repo B' } }, () => {}),
    ]);

    expect(mockStreamFn).toHaveBeenCalledTimes(2);
  });

  it('replays the latest status to a late-joining coalesced reviewer subscriber', async () => {
    const releaseSymbols: { current: null | (() => void) } = { current: null };
    mockReadSymbolsFromSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSymbols.current = () => resolve({ totalLines: 1, symbols: [] });
        }),
    );

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

    expect(mockStreamFn).toHaveBeenCalledTimes(1);
  });

  it('omits file structure when sandbox is unavailable', async () => {
    const statuses: string[] = [];
    const diff = makeAddedFileDiff('src/auth.ts', 'const auth = true;');

    await runReviewer(diff, baseReviewerOptions, (phase) => {
      statuses.push(phase);
    });

    expect(statuses).not.toContain('Preparing review...');
    expect(mockReadSymbolsFromSandbox).not.toHaveBeenCalled();

    const messages = mockStreamFn.mock.calls[0]?.[0] as Array<{ content: string }>;
    const systemPrompt = mockStreamFn.mock.calls[0]?.[8] as string;
    const prompt = messages[0]?.content ?? '';

    expect(systemPrompt).not.toContain('File structure is auto-fetched');
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

    const systemPrompt = mockStreamFn.mock.calls[0]?.[8] as string;
    expect(systemPrompt).toContain('[RETRIEVED_TASK_MEMORY]');
    expect(systemPrompt).toContain('Prior review note');
  });
});
