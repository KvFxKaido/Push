import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStreamFn,
  mockGetProviderStreamFn,
  mockGetModelForRole,
  mockBuildReviewerContextBlock,
  mockReadSymbolsFromSandbox,
} = vi.hoisted(() => ({
  mockStreamFn: vi.fn(),
  mockGetProviderStreamFn: vi.fn(),
  mockGetModelForRole: vi.fn(),
  mockBuildReviewerContextBlock: vi.fn(),
  mockReadSymbolsFromSandbox: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  getProviderStreamFn: (...args: unknown[]) => mockGetProviderStreamFn(...args),
}));

vi.mock('./providers', () => ({
  getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
}));

vi.mock('./role-context', () => ({
  buildReviewerContextBlock: (...args: unknown[]) => mockBuildReviewerContextBlock(...args),
}));

vi.mock('./sandbox-client', () => ({
  readSymbolsFromSandbox: (...args: unknown[]) => mockReadSymbolsFromSandbox(...args),
}));

import { runReviewer } from './reviewer-agent';

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
    mockGetProviderStreamFn.mockReset();
    mockGetModelForRole.mockReset();
    mockBuildReviewerContextBlock.mockReset();
    mockReadSymbolsFromSandbox.mockReset();

    mockGetProviderStreamFn.mockImplementation((provider: string) => ({
      providerType: provider,
      streamFn: mockStreamFn,
    }));
    mockGetModelForRole.mockReturnValue({ id: 'default-reviewer-model' });
    mockBuildReviewerContextBlock.mockReturnValue('');
    mockStreamFn.mockImplementation((
      _messages: unknown,
      onToken: (token: string) => void,
      onDone: () => void,
    ) => {
      onToken('{"summary":"Looks good","comments":[]}');
      onDone();
      return Promise.resolve();
    });
  });

  it('prefetches file structure when a sandbox is available', async () => {
    mockReadSymbolsFromSandbox
      .mockResolvedValueOnce({
        totalLines: 120,
        symbols: [
          { name: 'validateToken', kind: 'function', line: 12, signature: 'export function validateToken(token: string)' },
          { name: 'AuthProvider', kind: 'class', line: 45, signature: 'export class AuthProvider' },
        ],
      })
      .mockRejectedValueOnce(new Error('missing file'));

    const statuses: string[] = [];
    const diff = [
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      makeAddedFileDiff('src/auth.test.ts', 'it("works", () => {})'),
    ].join('');

    await runReviewer(
      diff,
      { provider: 'openrouter', sandboxId: 'sb-123' },
      (phase) => { statuses.push(phase); },
    );

    expect(statuses).toContain('Preparing review...');
    expect(statuses).toContain('Reviewer reading diff…');
    expect(mockReadSymbolsFromSandbox).toHaveBeenCalledWith('sb-123', '/workspace/src/auth.ts');
    expect(mockReadSymbolsFromSandbox).toHaveBeenCalledWith('sb-123', '/workspace/src/auth.test.ts');

    const messages = mockStreamFn.mock.calls[0]?.[0] as Array<{ content: string }>;
    const systemPrompt = mockStreamFn.mock.calls[0]?.[8] as string;
    const prompt = messages[0]?.content ?? '';

    expect(systemPrompt).toContain("File structure is auto-fetched and shows the outline of changed files. Use it for orientation but don't assume it's complete.");
    expect(prompt).toContain('[FILE STRUCTURE — auto-fetched from changed files]');
    expect(prompt).toContain('--- src/auth.ts ---');
    expect(prompt).toContain('export function validateToken(token: string) [L12]');
    expect(prompt).not.toContain('src/auth.test.ts ---');
  });

  it('omits file structure when sandbox is unavailable', async () => {
    const statuses: string[] = [];
    const diff = makeAddedFileDiff('src/auth.ts', 'const auth = true;');

    await runReviewer(
      diff,
      { provider: 'openrouter' },
      (phase) => { statuses.push(phase); },
    );

    expect(statuses).not.toContain('Preparing review...');
    expect(mockReadSymbolsFromSandbox).not.toHaveBeenCalled();

    const messages = mockStreamFn.mock.calls[0]?.[0] as Array<{ content: string }>;
    const systemPrompt = mockStreamFn.mock.calls[0]?.[8] as string;
    const prompt = messages[0]?.content ?? '';

    expect(systemPrompt).not.toContain('File structure is auto-fetched');
    expect(prompt).not.toContain('[FILE STRUCTURE — auto-fetched from changed files]');
  });
});
