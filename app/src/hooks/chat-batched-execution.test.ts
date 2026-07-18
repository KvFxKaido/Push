import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyToolCall, DetectedToolCalls } from '@/lib/tool-dispatch';
import type { ChatMessage, Conversation, VerificationRuntimeState } from '@/types';
import type { SendLoopContext } from './chat-send-types';
import type { TurnRunContext } from './chat-send-helpers';

const { mockExecuteTool, mockSwitchMergedBaseInWorkspace } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn(),
  mockSwitchMergedBaseInWorkspace: vi.fn(),
}));

vi.mock('@/lib/chat-tool-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-tool-execution')>();
  return {
    ...actual,
    executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  };
});

vi.mock('@/lib/fork-branch-in-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fork-branch-in-workspace')>();
  return {
    ...actual,
    switchMergedBaseInWorkspace: (...args: unknown[]) => mockSwitchMergedBaseInWorkspace(...args),
  };
});

const { executeBatchedToolCalls } = await import('./chat-batched-execution');

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'streaming',
    ...overrides,
  };
}

function makeVerificationState(): VerificationRuntimeState {
  return {
    policyName: 'Test',
    backendTouched: false,
    mutationOccurred: false,
    requirements: [],
    lastUpdatedAt: 1,
  };
}

function makeContext(store: { current: Record<string, Conversation> }): SendLoopContext {
  let verificationState = makeVerificationState();
  const setConversations: SendLoopContext['setConversations'] = (updater) => {
    store.current = typeof updater === 'function' ? updater(store.current) : updater;
  };
  const updateVerificationState: SendLoopContext['updateVerificationState'] = (
    _chatId,
    updater,
  ) => {
    verificationState = updater(verificationState);
    return verificationState;
  };

  return {
    chatId: 'chat-1',
    lockedProvider: 'openrouter',
    resolvedModel: 'anthropic/claude-sonnet-4.6:nitro',
    abortRef: { current: false },
    abortControllerRef: { current: null },
    sandboxIdRef: { current: 'sb-1' },
    ensureSandboxRef: { current: null },
    localDaemonBindingRef: { current: null },
    scratchpadRef: { current: undefined },
    todoRef: { current: undefined },
    workspaceContextRef: { current: { mode: 'repo', includeGitHubTools: true, description: '' } },
    runtimeHandlersRef: { current: undefined },
    repoRef: { current: 'owner/repo' },
    isMainProtectedRef: { current: false },
    branchInfoRef: { current: { currentBranch: 'feature/pr', defaultBranch: 'main' } },
    checkpointRefs: { apiMessages: { current: [] } },
    processedContentRef: { current: new Set<string>() },
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef: store,
    setConversations,
    dirtyConversationIdsRef: { current: new Set<string>() },
    updateAgentStatus: vi.fn(),
    appendRunEvent: vi.fn(),
    emitRunEngineEvent: vi.fn(),
    flushCheckpoint: vi.fn(),
    getVerificationState: () => verificationState,
    updateVerificationState,
    executeDelegateCall: vi.fn(),
  } as unknown as SendLoopContext;
}

function makeTurnContext(): TurnRunContext {
  return {
    applyPostToolPolicyEffects: vi.fn(() => null),
    recordToolFailure: vi.fn(),
    recordDelegationOutcome: vi.fn(),
    getRoundSandboxStatus: vi.fn(async () => null),
    invalidateSandboxStatus: vi.fn(),
  };
}

describe('executeBatchedToolCalls', () => {
  beforeEach(() => {
    mockExecuteTool.mockReset();
    mockSwitchMergedBaseInWorkspace.mockReset();
  });

  it('commits merge-follow warnings into trailing batched merge_pr result messages', async () => {
    const readCall = {
      source: 'sandbox',
      call: { tool: 'sandbox_read_file', args: { path: 'README.md' } },
    } as unknown as AnyToolCall;
    const mergeCall = {
      source: 'github',
      call: { tool: 'merge_pr', args: { repo: 'owner/repo', pr_number: 7 } },
    } as unknown as AnyToolCall;
    const branchSwitch = {
      name: 'main',
      kind: 'merged' as const,
      from: 'feature/pr',
      prNumber: 7,
      source: 'merge_pr' as const,
    };
    const warning = 'Fast-forward failed — fatal: Not possible to fast-forward, aborting.';

    mockExecuteTool.mockImplementation(async (call: AnyToolCall) => {
      if (call === mergeCall) {
        return {
          call,
          raw: {
            text: '[Tool Result — merge_pr]\nMerged PR #7.',
            branchSwitch,
          },
          cards: [],
          durationMs: 2,
        };
      }
      return {
        call,
        raw: { text: '[Tool Result — sandbox_read_file]\nRead README.' },
        cards: [],
        durationMs: 1,
      };
    });
    mockSwitchMergedBaseInWorkspace.mockResolvedValue({
      ok: false,
      branchSwitch,
      errorMessage: warning,
      raw: { text: `[Tool Result — sandbox_exec]\n${warning}` },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = {
      current: {
        'chat-1': {
          id: 'chat-1',
          title: 'Chat',
          repoFullName: 'owner/repo',
          branch: 'feature/pr',
          messages: [makeMessage({ id: 'assistant-1' })],
          createdAt: 1,
          lastMessageAt: 1,
        } as Conversation,
      },
    };

    const result = await executeBatchedToolCalls(
      {
        readOnly: [readCall],
        fileMutations: [],
        sideEffects: [mergeCall],
        batchOverflow: [],
        extraMutations: [],
        droppedCandidates: [],
      } satisfies DetectedToolCalls,
      0,
      'I will merge it.',
      '',
      [],
      [makeMessage({ id: 'user-1', role: 'user', content: 'Merge PR 7', status: 'done' })],
      makeContext(store),
      { diagnosisRetries: 0, recoveryAttempted: false },
      makeTurnContext(),
    );

    warnSpy.mockRestore();

    const apiMergeResult = result.nextApiMessages.find((message) =>
      message.content.includes('[Tool Result — merge_pr]'),
    );
    expect(apiMergeResult?.content).toContain('[Workspace Follow Warning]');
    expect(apiMergeResult?.content).toContain(warning);
    expect(apiMergeResult?.toolResults?.[0]?.content).toContain('[Workspace Follow Warning]');
    expect(apiMergeResult?.toolResults?.[0]?.content).toContain(warning);

    const transcriptMergeResult = store.current['chat-1'].messages.find((message) =>
      message.content.includes('[Tool Result — merge_pr]'),
    );
    expect(transcriptMergeResult?.content).toContain('[Workspace Follow Warning]');
    expect(transcriptMergeResult?.content).toContain(warning);
    expect(transcriptMergeResult?.toolResults?.[0]?.content).toContain(
      '[Workspace Follow Warning]',
    );
  });
});
