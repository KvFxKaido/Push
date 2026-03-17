import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStreamFn,
  mockGetActiveProvider,
  mockGetProviderStreamFn,
  mockGetModelForRole,
} = vi.hoisted(() => ({
  mockStreamFn: vi.fn(),
  mockGetActiveProvider: vi.fn(),
  mockGetProviderStreamFn: vi.fn(),
  mockGetModelForRole: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getProviderStreamFn: (...args: unknown[]) => mockGetProviderStreamFn(...args),
}));

vi.mock('./providers', () => ({
  getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
}));

vi.mock('./role-context', () => ({
  buildAuditorContextBlock: vi.fn(() => ''),
}));

import { runAuditor } from './auditor-agent';

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

describe('runAuditor', () => {
  beforeEach(() => {
    mockStreamFn.mockReset();
    mockGetActiveProvider.mockReset();
    mockGetProviderStreamFn.mockReset();
    mockGetModelForRole.mockReset();

    mockGetActiveProvider.mockReturnValue('openrouter');
    mockGetProviderStreamFn.mockImplementation((provider: string) => ({
      providerType: provider,
      streamFn: mockStreamFn,
    }));
    mockGetModelForRole.mockReturnValue({ id: 'default-auditor-model' });
    mockStreamFn.mockImplementation((
      _messages: unknown,
      onToken: (token: string) => void,
      onDone: () => void,
    ) => {
      onToken('{"verdict":"safe","summary":"Looks good","risks":[]}');
      onDone();
      return Promise.resolve();
    });
  });

  it('uses explicit provider/model overrides when supplied', async () => {
    const result = await runAuditor(
      'diff --git a/src/app.ts b/src/app.ts\n+const x = 1;\n',
      () => {},
      undefined,
      undefined,
      {
        providerOverride: 'vertex',
        modelOverride: 'google/gemini-2.5-pro',
      },
    );

    expect(result.verdict).toBe('safe');
    expect(mockGetProviderStreamFn).toHaveBeenCalledWith('vertex');
    expect(mockStreamFn).toHaveBeenCalled();
    expect(mockStreamFn.mock.calls[0]?.[7]).toBe('google/gemini-2.5-pro');
  });

  it('builds file hints from the chunked diff only', async () => {
    const hugeProductionDiff = makeAddedFileDiff('src/huge.ts', 'x'.repeat(31_000));
    const omittedTestDiff = makeAddedFileDiff('src/ignored.test.ts', 'test');

    await runAuditor(
      hugeProductionDiff + omittedTestDiff,
      () => {},
    );

    const messages = mockStreamFn.mock.calls[0]?.[0] as Array<{ content: string }>;
    const prompt = messages[0]?.content ?? '';
    const fileHints = prompt.match(/\[FILE HINTS\]\n([\s\S]*?)\n\[\/FILE HINTS\]/)?.[1] ?? '';

    expect(fileHints).toContain('- src/huge.ts: production');
    expect(fileHints).not.toContain('src/ignored.test.ts');
    expect(prompt).toContain('[1 file(s) omitted due to size limit: src/ignored.test.ts]');
  });
});
