import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetProviderPushStream,
  mockGetModelForRole,
  mockGetUserProfile,
  mockGetSandboxDiff,
  mockIsProviderAvailable,
  mockExecuteSandboxToolCall,
} = vi.hoisted(() => ({
  mockGetProviderPushStream: vi.fn(),
  mockGetModelForRole: vi.fn(),
  mockGetUserProfile: vi.fn(),
  mockGetSandboxDiff: vi.fn(),
  mockIsProviderAvailable: vi.fn(),
  mockExecuteSandboxToolCall: vi.fn(),
}));

vi.mock('@/hooks/useUserProfile', () => ({
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
}));

vi.mock('./orchestrator', () => ({
  buildUserIdentityBlock: vi.fn(() => ''),
  getActiveProvider: vi.fn(() => 'openrouter'),
  isProviderAvailable: (...args: unknown[]) => mockIsProviderAvailable(...args),
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers');
  return {
    ...actual,
    getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
  };
});

vi.mock('./sandbox-client', async () => {
  const actual = await vi.importActual<typeof import('./sandbox-client')>('./sandbox-client');
  return {
    ...actual,
    getSandboxDiff: (...args: unknown[]) => mockGetSandboxDiff(...args),
  };
});

vi.mock('./sandbox-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox-tools')>();
  return {
    ...actual,
    executeSandboxToolCall: mockExecuteSandboxToolCall,
  };
});

import { detectToolCall } from './github-tools';
import { runCoderAgent } from './coder-agent';
import { runExplorerAgent } from './explorer-agent';
import { symbolLedger } from './symbol-persistence-ledger';
import type { PushStream } from '@push/lib/provider-contract';

interface CapturedRequest {
  model: string;
  systemPromptOverride?: string;
  messages: Array<{ content: string }>;
}

/**
 * Build a PushStream that returns one event sequence per round, computed by
 * `respond(round)`. Captures every request envelope so tests can assert on
 * the model and system prompt without relying on positional callback args.
 */
function makeRoundStream(respond: (round: number) => string): {
  stream: PushStream;
  capturedRequests: CapturedRequest[];
} {
  const capturedRequests: CapturedRequest[] = [];
  let round = 0;
  const stream: PushStream = (req) => {
    capturedRequests.push({
      model: req.model,
      systemPromptOverride: req.systemPromptOverride,
      messages: req.messages.map((m) => ({ content: m.content })),
    });
    const text = respond(round);
    round += 1;
    return (async function* () {
      yield { type: 'text_delta', text };
      yield { type: 'done', finishReason: 'stop' };
    })();
  };
  return { stream, capturedRequests };
}

describe('delegation handoff integration', () => {
  beforeEach(() => {
    mockGetProviderPushStream.mockReset();
    mockGetModelForRole.mockReset();
    mockGetUserProfile.mockReset();
    mockGetSandboxDiff.mockReset();
    mockIsProviderAvailable.mockReset();
    mockExecuteSandboxToolCall.mockReset();

    symbolLedger.reset();
    symbolLedger.setRepo('KvFxKaido/Push:feature/auth-flow');
    symbolLedger.store(
      '/workspace/src/auth.ts',
      [
        {
          name: 'refreshSession',
          kind: 'function',
          line: 42,
          signature: 'export async function refreshSession()',
        },
      ],
      120,
    );

    mockIsProviderAvailable.mockReturnValue(true);
    mockGetModelForRole.mockImplementation((_provider: string, role: string) => ({
      id: `${role}-default-model`,
    }));
    mockGetUserProfile.mockReturnValue({ displayName: '', bio: '', githubLogin: undefined });
    mockGetSandboxDiff.mockResolvedValue({ diff: '', truncated: false });
    mockExecuteSandboxToolCall.mockResolvedValue({
      text: 'sandbox result',
    });
  });

  it('carries parsed explorer handoff fields and symbol cache into the delegated Explorer run', async () => {
    const parsed = detectToolCall(
      '```json\n{"tool":"explorer","args":{"task":"  Trace the auth refresh flow  ","files":[" src/auth.ts ","  "],"deliverable":" Return the trigger path with evidence ","knownContext":[" Refresh seems to start in auth.ts:42 ","   "],"constraints":[" Stay read-only "," "]}}\n```',
    );

    expect(parsed).toEqual({
      tool: 'delegate_explorer',
      args: {
        task: 'Trace the auth refresh flow',
        files: ['src/auth.ts'],
        deliverable: 'Return the trigger path with evidence',
        knownContext: ['Refresh seems to start in auth.ts:42'],
        constraints: ['Stay read-only'],
      },
    });

    const { stream, capturedRequests } = makeRoundStream(
      () =>
        'Summary:\nAuth refresh traced.\nFindings:\n- src/auth.ts:42 triggers the refresh path.\nRelevant files:\n- src/auth.ts\nOpen questions:\n- none\nRecommended next step:\nanswer directly with the trace.',
    );
    mockGetProviderPushStream.mockImplementation(() => stream);

    if (!parsed || parsed.tool !== 'delegate_explorer' || !parsed.args.task) {
      throw new Error('Expected delegate_explorer tool call');
    }

    const result = await runExplorerAgent(
      {
        task: parsed.args.task,
        files: parsed.args.files || [],
        deliverable: parsed.args.deliverable,
        knownContext: parsed.args.knownContext,
        constraints: parsed.args.constraints,
        provider: 'openrouter',
        model: 'explorer-test-model',
        branchContext: {
          activeBranch: 'feature/auth-flow',
          defaultBranch: 'main',
          protectMain: true,
        },
      },
      'sb-123',
      'KvFxKaido/Push',
      { onStatus: () => {} },
    );

    const taskBrief = capturedRequests[0]?.messages[0]?.content ?? '';
    const systemPrompt = capturedRequests[0]?.systemPromptOverride ?? '';

    expect(result.summary).toContain('Summary:');
    expect(taskBrief).toContain('Task: Trace the auth refresh flow');
    expect(taskBrief).toContain('Deliverable: Return the trigger path with evidence');
    expect(taskBrief).toContain('Known context:');
    expect(taskBrief).toContain('Refresh seems to start in auth.ts:42');
    expect(taskBrief).toContain('Constraints:');
    expect(taskBrief).toContain('Stay read-only');
    expect(taskBrief).toContain('Relevant files: src/auth.ts');
    expect(systemPrompt).toContain('[SYMBOL_CACHE]');
    expect(systemPrompt).toContain('src/auth.ts: 1 symbols (120 lines)');
  });

  it('carries parsed coder handoff fields and symbol cache into the delegated Coder run', async () => {
    const parsed = detectToolCall(
      '```json\n{"tool":"coder","args":{"task":"  Implement the auth refresh fix  ","files":[" src/auth.ts "," src/auth.test.ts "],"deliverable":" Ship the fix with updated auth coverage ","knownContext":[" Explorer traced the refresh trigger to src/auth.ts:42 "," "],"constraints":[" Keep the public auth API stable "," "],"declaredCapabilities":["repo:read","repo:write","sandbox:test","not:a-real-capability"],"acceptanceCriteria":[{"id":"auth-tests","check":"npm test -- auth","description":" Auth tests pass "} ]}}\n```',
    );

    expect(parsed).toEqual({
      tool: 'delegate_coder',
      args: {
        task: 'Implement the auth refresh fix',
        files: ['src/auth.ts', 'src/auth.test.ts'],
        deliverable: 'Ship the fix with updated auth coverage',
        knownContext: ['Explorer traced the refresh trigger to src/auth.ts:42'],
        constraints: ['Keep the public auth API stable'],
        declaredCapabilities: ['repo:read', 'repo:write', 'sandbox:test'],
        acceptanceCriteria: [
          {
            id: 'auth-tests',
            check: 'npm test -- auth',
            description: ' Auth tests pass ',
            exitCode: undefined,
          },
        ],
      },
    });

    const { stream, capturedRequests } = makeRoundStream(
      () =>
        '**Done:** Implemented the auth refresh fix.\n**Changed:** src/auth.ts, src/auth.test.ts\n**Verified:** not run\n**Open:** nothing',
    );
    mockGetProviderPushStream.mockImplementation(() => stream);

    if (!parsed || parsed.tool !== 'delegate_coder' || !parsed.args.task) {
      throw new Error('Expected delegate_coder tool call');
    }

    const result = await runCoderAgent(
      {
        task: parsed.args.task,
        files: parsed.args.files || [],
        acceptanceCriteria: parsed.args.acceptanceCriteria,
        deliverable: parsed.args.deliverable,
        knownContext: parsed.args.knownContext,
        constraints: parsed.args.constraints,
        declaredCapabilities: parsed.args.declaredCapabilities,
        provider: 'openrouter',
        model: 'coder-test-model',
        branchContext: {
          activeBranch: 'feature/auth-flow',
          defaultBranch: 'main',
          protectMain: true,
        },
      },
      'sb-123',
      { onStatus: () => {} },
    );

    const taskBrief = capturedRequests[0]?.messages[0]?.content ?? '';
    const systemPrompt = capturedRequests[0]?.systemPromptOverride ?? '';

    expect(result.summary).toContain('**Done:** Implemented the auth refresh fix.');
    expect(result.summary).not.toContain('[Sandbox State]');
    expect(taskBrief).toContain('Task: Implement the auth refresh fix');
    expect(taskBrief).toContain('Deliverable: Ship the fix with updated auth coverage');
    expect(taskBrief).toContain('Known context:');
    expect(taskBrief).toContain('Explorer traced the refresh trigger to src/auth.ts:42');
    expect(taskBrief).toContain('Constraints:');
    expect(taskBrief).toContain('Keep the public auth API stable');
    expect(taskBrief).toContain('Relevant files: src/auth.ts, src/auth.test.ts');
    expect(taskBrief).toContain('Acceptance checks:');
    expect(taskBrief).toContain('auth-tests: Auth tests pass');
    expect(systemPrompt).toContain('[SYMBOL_CACHE]');
    expect(systemPrompt).toContain('src/auth.ts: 1 symbols (120 lines)');
  });

  it('keeps Coder tool detection scoped to sandbox and web-search calls', async () => {
    const { stream } = makeRoundStream((round) => {
      if (round === 0) {
        return [
          '{"tool":"ask_user","args":{"question":"Which option?","options":[{"id":"a","label":"A"}]}}',
          '{"tool":"sandbox_read_file","args":{"path":"/workspace/src/auth.ts"}}',
        ].join('\n');
      }
      return '**Done:** Read src/auth.ts through sandbox_read_file.\n**Changed:** No file changes; read src/auth.ts only.\n**Verified:** sandbox_read_file completed for /workspace/src/auth.ts.\n**Open:** nothing';
    });
    mockGetProviderPushStream.mockImplementation(() => stream);

    const result = await runCoderAgent(
      {
        task: 'Read auth.ts',
        files: ['src/auth.ts'],
        declaredCapabilities: ['repo:read'],
        provider: 'openrouter',
        model: 'coder-test-model',
      },
      'sb-123',
      { onStatus: () => {} },
    );

    expect(mockExecuteSandboxToolCall).toHaveBeenCalledTimes(1);
    expect(mockExecuteSandboxToolCall.mock.calls[0]?.[0]).toEqual({
      tool: 'sandbox_read_file',
      args: { path: '/workspace/src/auth.ts' },
    });
    expect(result.summary).toContain('**Done:** Read src/auth.ts through sandbox_read_file.');
  });

  it('falls back to the active provider model when the delegated explorer provider is unavailable', async () => {
    mockIsProviderAvailable.mockImplementation((provider: string) => provider === 'openrouter');
    const { stream, capturedRequests } = makeRoundStream(
      () =>
        'Summary:\nFallback used.\nFindings:\n- none\nRelevant files:\n- none\nOpen questions:\n- none\nRecommended next step:\nanswer directly with the result.',
    );
    mockGetProviderPushStream.mockImplementation(() => stream);

    await runExplorerAgent(
      {
        task: 'Trace auth fallback behavior',
        files: [],
        provider: 'vertex',
        model: 'google/gemini-2.5-pro',
      },
      null,
      'KvFxKaido/Push',
      { onStatus: () => {} },
    );

    expect(mockGetProviderPushStream).toHaveBeenCalledWith('openrouter');
    expect(capturedRequests[0]?.model).toBe('explorer-default-model');
  });
});
