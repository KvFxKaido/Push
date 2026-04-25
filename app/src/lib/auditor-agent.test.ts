import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetProviderPushStream,
  mockGetActiveProvider,
  mockGetModelForRole,
  mockBuildAuditorRuntimeContext,
  mockBuildAuditorEvaluationMemoryBlock,
} = vi.hoisted(() => ({
  mockGetProviderPushStream: vi.fn(),
  mockGetActiveProvider: vi.fn(),
  mockGetModelForRole: vi.fn(),
  mockBuildAuditorRuntimeContext: vi.fn(),
  mockBuildAuditorEvaluationMemoryBlock: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock(import('./providers'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
  };
});

vi.mock('./role-memory-context', () => ({
  buildAuditorRuntimeContext: (...args: unknown[]) => mockBuildAuditorRuntimeContext(...args),
  buildAuditorEvaluationMemoryBlock: (...args: unknown[]) =>
    mockBuildAuditorEvaluationMemoryBlock(...args),
}));

import { runAuditor, runAuditorEvaluation } from './auditor-agent';
import type { PushStream } from '@push/lib/provider-contract';

interface CapturedRequest {
  model: string;
  systemPromptOverride?: string;
  messages: Array<{ content: string }>;
}

function captureStream(events?: () => string): {
  stream: PushStream;
  capturedRequests: CapturedRequest[];
} {
  const capturedRequests: CapturedRequest[] = [];
  const stream: PushStream = (req) => {
    capturedRequests.push({
      model: req.model,
      systemPromptOverride: req.systemPromptOverride,
      messages: req.messages.map((m) => ({ content: m.content })),
    });
    const text = events ? events() : '{"verdict":"safe","summary":"Looks good","risks":[]}';
    return (async function* () {
      yield { type: 'text_delta', text };
      yield { type: 'done', finishReason: 'stop' };
    })();
  };
  return { stream, capturedRequests };
}

function asyncStream(text: string, delayMs = 10): { stream: PushStream; calls: () => number } {
  let calls = 0;
  const stream: PushStream = () => {
    calls += 1;
    return (async function* () {
      await new Promise((r) => setTimeout(r, delayMs));
      yield { type: 'text_delta', text };
      yield { type: 'done', finishReason: 'stop' };
    })();
  };
  return { stream, calls: () => calls };
}

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
  let captured: CapturedRequest[];
  let activeStream: PushStream;

  beforeEach(() => {
    mockGetProviderPushStream.mockReset();
    mockGetActiveProvider.mockReset();
    mockGetModelForRole.mockReset();
    mockBuildAuditorRuntimeContext.mockReset();
    mockBuildAuditorEvaluationMemoryBlock.mockReset();

    mockGetActiveProvider.mockReturnValue('openrouter');
    mockGetModelForRole.mockReturnValue({ id: 'default-auditor-model' });
    mockBuildAuditorRuntimeContext.mockResolvedValue('');
    mockBuildAuditorEvaluationMemoryBlock.mockResolvedValue(null);

    const { stream, capturedRequests } = captureStream();
    captured = capturedRequests;
    activeStream = stream;
    mockGetProviderPushStream.mockImplementation(() => activeStream);
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
    expect(mockGetProviderPushStream).toHaveBeenCalledWith('vertex');
    expect(captured[0]?.model).toBe('google/gemini-2.5-pro');
  });

  it('coalesces concurrent identical audits into a single stream call', async () => {
    const { stream, calls } = asyncStream('{"verdict":"safe","summary":"Looks good","risks":[]}');
    activeStream = stream;

    const statuses1: string[] = [];
    const statuses2: string[] = [];
    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    const [r1, r2] = await Promise.all([
      runAuditor(diff, (phase) => {
        statuses1.push(phase);
      }),
      runAuditor(diff, (phase) => {
        statuses2.push(phase);
      }),
    ]);

    expect(r1).toBe(r2);
    expect(r1.verdict).toBe('safe');
    expect(calls()).toBe(1);
    expect(statuses1.length).toBeGreaterThan(0);
    expect(statuses2.length).toBeGreaterThan(0);
  });

  it('does not coalesce concurrent audits with different stream functions', async () => {
    const primary = asyncStream('{"verdict":"safe","summary":"Primary","risks":[]}');
    const alternate = asyncStream('{"verdict":"safe","summary":"Alternate","risks":[]}');
    mockGetProviderPushStream
      .mockReturnValueOnce(primary.stream)
      .mockReturnValueOnce(alternate.stream);

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    const [primaryResult, alternateResult] = await Promise.all([
      runAuditor(diff, () => {}),
      runAuditor(diff, () => {}),
    ]);

    expect(primary.calls()).toBe(1);
    expect(alternate.calls()).toBe(1);
    expect(primaryResult.card.summary).toBe('Primary');
    expect(alternateResult.card.summary).toBe('Alternate');
  });

  it('does not coalesce concurrent audits with different hook output', async () => {
    const { stream, calls } = asyncStream('{"verdict":"safe","summary":"Looks good","risks":[]}');
    activeStream = stream;

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    await Promise.all([
      runAuditor(diff, () => {}, undefined, { exitCode: 1, output: 'lint failed: a' }),
      runAuditor(diff, () => {}, undefined, { exitCode: 1, output: 'lint failed: b' }),
    ]);

    expect(calls()).toBe(2);
  });

  it('does not coalesce concurrent audits with different file context', async () => {
    const { stream, calls } = asyncStream('{"verdict":"safe","summary":"Looks good","risks":[]}');
    activeStream = stream;

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');

    await Promise.all([
      runAuditor(diff, () => {}, undefined, undefined, undefined, [
        {
          path: 'src/app.ts',
          content: 'const x = 1;',
          truncated: false,
          classification: 'production',
        },
      ]),
      runAuditor(diff, () => {}, undefined, undefined, undefined, [
        {
          path: 'src/app.ts',
          content: 'const x = 1;\nexport default x;',
          truncated: false,
          classification: 'production',
        },
      ]),
    ]);

    expect(calls()).toBe(2);
  });

  it('replays the latest status to a late-joining coalesced auditor subscriber', async () => {
    const releaseStream: { current: null | (() => void) } = { current: null };
    let calls = 0;
    const slowStream: PushStream = () => {
      calls += 1;
      return (async function* () {
        await new Promise<void>((resolve) => {
          releaseStream.current = resolve;
        });
        yield {
          type: 'text_delta',
          text: '{"verdict":"safe","summary":"Looks good","risks":[]}',
        };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    activeStream = slowStream;

    const diff = makeAddedFileDiff('src/app.ts', 'const x = 1;');
    const statuses1: string[] = [];
    const statuses2: string[] = [];

    const first = runAuditor(diff, (phase) => {
      statuses1.push(phase);
    });
    await Promise.resolve();
    const second = runAuditor(diff, (phase) => {
      statuses2.push(phase);
    });

    expect(statuses1).toContain('Auditor reviewing...');
    expect(statuses2).toContain('Auditor reviewing...');

    if (releaseStream.current) releaseStream.current();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it('builds file hints from the chunked diff only', async () => {
    const hugeProductionDiff = makeAddedFileDiff('src/huge.ts', 'x'.repeat(31_000));
    const omittedTestDiff = makeAddedFileDiff('src/ignored.test.ts', 'test');

    await runAuditor(hugeProductionDiff + omittedTestDiff, () => {});

    const prompt = captured[0]?.messages[0]?.content ?? '';
    const fileHints = prompt.match(/\[FILE HINTS\]\n([\s\S]*?)\n\[\/FILE HINTS\]/)?.[1] ?? '';

    expect(fileHints).toContain('- src/huge.ts: production');
    expect(fileHints).not.toContain('src/ignored.test.ts');
    expect(prompt).toContain('[1 file(s) omitted due to size limit: src/ignored.test.ts]');
  });

  it('passes retrieved auditor memory through the runtime context block', async () => {
    mockBuildAuditorRuntimeContext.mockResolvedValue(
      '## Audit Run Context\n\n[RETRIEVED_VERIFICATION]\n- [verification_result | coder] npm test: passed\n[/RETRIEVED_VERIFICATION]',
    );

    await runAuditor(makeAddedFileDiff('src/app.ts', 'const x = 1;'), () => {}, {
      repoFullName: 'owner/repo',
      activeBranch: 'feature/audit',
    });

    expect(captured[0]?.systemPromptOverride).toContain('[RETRIEVED_VERIFICATION]');
    expect(captured[0]?.systemPromptOverride).toContain('npm test: passed');
  });

  it('injects retrieved memory into auditor evaluation requests', async () => {
    mockBuildAuditorEvaluationMemoryBlock.mockResolvedValue(
      '[RETRIEVED_TASK_MEMORY]\n- [decision | orchestrator] Previous checkpoint answer\n[/RETRIEVED_TASK_MEMORY]',
    );

    await runAuditorEvaluation(
      'finish the auth fix',
      'Updated the auth guard and reran tests.',
      null,
      makeAddedFileDiff('src/auth.ts', 'const auth = true;'),
      () => {},
      {
        memoryScope: {
          repoFullName: 'owner/repo',
          branch: 'feature/auth',
          chatId: 'chat-1',
        },
      },
    );

    const prompt = captured[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('[RETRIEVED_TASK_MEMORY]');
    expect(prompt).toContain('Previous checkpoint answer');
  });
});
