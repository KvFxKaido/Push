import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStreamFn,
  mockGetActiveProvider,
  mockGetProviderStreamFn,
  mockGetModelForRole,
  mockBuildAuditorContextBlock,
} = vi.hoisted(() => ({
  mockStreamFn: vi.fn(),
  mockGetActiveProvider: vi.fn(),
  mockGetProviderStreamFn: vi.fn(),
  mockGetModelForRole: vi.fn(),
  mockBuildAuditorContextBlock: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getProviderStreamFn: (...args: unknown[]) => mockGetProviderStreamFn(...args),
}));

vi.mock(import('./providers'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
  };
});

vi.mock('./role-context', () => ({
  buildAuditorContextBlock: (...args: unknown[]) => mockBuildAuditorContextBlock(...args),
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
    mockBuildAuditorContextBlock.mockReset();

    mockGetActiveProvider.mockReturnValue('openrouter');
    mockGetProviderStreamFn.mockImplementation((provider: string) => ({
      providerType: provider,
      streamFn: mockStreamFn,
    }));
    mockGetModelForRole.mockReturnValue({ id: 'default-auditor-model' });
    mockBuildAuditorContextBlock.mockReturnValue('');
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

  it('coalesces concurrent identical audits into a single stream call', async () => {
    // Use an async mock so the first call is still in-flight when the second arrives
    mockStreamFn.mockImplementation(async (
      _messages: unknown,
      onToken: (token: string) => void,
      onDone: () => void,
    ) => {
      await new Promise((r) => setTimeout(r, 10));
      onToken('{"verdict":"safe","summary":"Looks good","risks":[]}');
      onDone();
    });

    const statuses1: string[] = [];
    const statuses2: string[] = [];
    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    const [r1, r2] = await Promise.all([
      runAuditor(diff, (phase) => { statuses1.push(phase); }),
      runAuditor(diff, (phase) => { statuses2.push(phase); }),
    ]);

    // Both callers get the same result
    expect(r1).toBe(r2);
    expect(r1.verdict).toBe('safe');
    // Only one stream call was made
    expect(mockStreamFn).toHaveBeenCalledTimes(1);
    // Both callers received status updates
    expect(statuses1.length).toBeGreaterThan(0);
    expect(statuses2.length).toBeGreaterThan(0);
  });

  it('does not coalesce concurrent audits with different hook output', async () => {
    mockStreamFn.mockImplementation(async (
      _messages: unknown,
      onToken: (token: string) => void,
      onDone: () => void,
    ) => {
      await new Promise((r) => setTimeout(r, 10));
      onToken('{"verdict":"safe","summary":"Looks good","risks":[]}');
      onDone();
    });

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    await Promise.all([
      runAuditor(diff, () => {}, undefined, { exitCode: 1, output: 'lint failed: a' }),
      runAuditor(diff, () => {}, undefined, { exitCode: 1, output: 'lint failed: b' }),
    ]);

    expect(mockStreamFn).toHaveBeenCalledTimes(2);
  });

  it('does not coalesce concurrent audits with different file context', async () => {
    mockStreamFn.mockImplementation(async (
      _messages: unknown,
      onToken: (token: string) => void,
      onDone: () => void,
    ) => {
      await new Promise((r) => setTimeout(r, 10));
      onToken('{"verdict":"safe","summary":"Looks good","risks":[]}');
      onDone();
    });

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    await Promise.all([
      runAuditor(diff, () => {}, undefined, undefined, undefined, [
        { path: 'src/app.ts', content: 'const x = 1;', truncated: false, classification: 'production' },
      ]),
      runAuditor(diff, () => {}, undefined, undefined, undefined, [
        { path: 'src/app.ts', content: 'const x = 2;', truncated: false, classification: 'production' },
      ]),
    ]);

    expect(mockStreamFn).toHaveBeenCalledTimes(2);
  });

  it('replays the latest status to a late-joining coalesced auditor subscriber', async () => {
    const releaseStream: { current: null | (() => void) } = { current: null };
    mockStreamFn.mockImplementation(async (
      _messages: unknown,
      onToken: (token: string) => void,
      onDone: () => void,
    ) => new Promise<void>((resolve) => {
      releaseStream.current = () => {
        onToken('{"verdict":"safe","summary":"Looks good","risks":[]}');
        onDone();
        resolve();
      };
    }));

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');
    const statuses1: string[] = [];
    const statuses2: string[] = [];

    const first = runAuditor(diff, (phase) => { statuses1.push(phase); });
    await Promise.resolve();
    const second = runAuditor(diff, (phase) => { statuses2.push(phase); });

    expect(statuses1).toContain('Auditor reviewing...');
    expect(statuses2).toContain('Auditor reviewing...');

    if (releaseStream.current) releaseStream.current();
    await Promise.all([first, second]);

    expect(mockStreamFn).toHaveBeenCalledTimes(1);
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
