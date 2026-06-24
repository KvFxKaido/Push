import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentStatus,
  AgentStatusEvent,
  ChatMessage,
  Conversation,
  RunCheckpoint,
} from '@/types';
import { IDLE_RUN_STATE } from '@/lib/run-engine';

const hookState = vi.hoisted(() => ({
  interruptedCheckpoint: null as RunCheckpoint | null,
  setInterruptedCheckpoint: vi.fn(),
}));

const checkpointMocks = vi.hoisted(() => ({
  buildCheckpointReconciliationMessage: vi.fn(),
  buildRunCheckpoint: vi.fn(),
  checkpointRequiresLiveSandboxStatus: vi.fn(),
  clearRunCheckpoint: vi.fn(),
  detectInterruptedRun: vi.fn(),
  fetchSandboxDiff: vi.fn(),
  recordResumeEvent: vi.fn(),
  saveRunCheckpoint: vi.fn(),
  sandboxStatus: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(initial: T) => [
    (hookState.interruptedCheckpoint as T | null) ?? initial,
    hookState.setInterruptedCheckpoint,
  ],
}));

vi.mock('@/lib/checkpoint-manager', () => ({
  buildCheckpointReconciliationMessage: (...args: unknown[]) =>
    checkpointMocks.buildCheckpointReconciliationMessage(...args),
  buildRunCheckpoint: (...args: unknown[]) => checkpointMocks.buildRunCheckpoint(...args),
  checkpointRequiresLiveSandboxStatus: (...args: unknown[]) =>
    checkpointMocks.checkpointRequiresLiveSandboxStatus(...args),
  clearRunCheckpoint: (...args: unknown[]) => checkpointMocks.clearRunCheckpoint(...args),
  detectInterruptedRun: (...args: unknown[]) => checkpointMocks.detectInterruptedRun(...args),
  recordResumeEvent: (...args: unknown[]) => checkpointMocks.recordResumeEvent(...args),
  saveRunCheckpoint: (...args: unknown[]) => checkpointMocks.saveRunCheckpoint(...args),
}));

vi.mock('@/lib/sandbox-client', () => ({
  fetchSandboxDiff: (...args: unknown[]) => checkpointMocks.fetchSandboxDiff(...args),
  sandboxStatus: (...args: unknown[]) => checkpointMocks.sandboxStatus(...args),
}));

const { useChatCheckpoint } = await import('./useChatCheckpoint');

function makeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    chatId: 'chat-1',
    round: 2,
    phase: 'streaming_llm',
    baseMessageCount: 1,
    deltaMessages: [{ role: 'assistant', content: 'partial response' }],
    accumulated: 'partial response',
    thinkingAccumulated: '',
    coderDelegationActive: false,
    lastCoderState: null,
    savedAt: Date.now() - 1_000,
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.6:nitro',
    sandboxSessionId: 'sandbox-1',
    activeBranch: 'feature/checkpoint',
    repoId: 'owner/repo',
    workspaceSessionId: 'workspace-1',
    ...overrides,
  };
}

function makeConversation(messages: ChatMessage[] = []): Record<string, Conversation> {
  return {
    'chat-1': {
      id: 'chat-1',
      title: 'Chat',
      messages,
      createdAt: 1,
      lastMessageAt: 1,
    },
  };
}

describe('useChatCheckpoint', () => {
  beforeEach(() => {
    hookState.interruptedCheckpoint = null;
    hookState.setInterruptedCheckpoint.mockReset();
    checkpointMocks.buildCheckpointReconciliationMessage.mockReset();
    checkpointMocks.buildRunCheckpoint.mockReset();
    checkpointMocks.checkpointRequiresLiveSandboxStatus.mockReset();
    checkpointMocks.clearRunCheckpoint.mockReset();
    checkpointMocks.detectInterruptedRun.mockReset();
    checkpointMocks.fetchSandboxDiff.mockReset();
    checkpointMocks.recordResumeEvent.mockReset();
    checkpointMocks.saveRunCheckpoint.mockReset();
    checkpointMocks.sandboxStatus.mockReset();
  });

  it('dedupes identical agent status events within the dedupe window', () => {
    let agentStatus: AgentStatus = { active: false, phase: '' };
    let agentEventsByChat: Record<string, AgentStatusEvent[]> = {};
    const agentEventsByChatRef = { current: agentEventsByChat };
    let conversations = makeConversation();

    const hook = useChatCheckpoint({
      runEngineStateRef: { current: { ...IDLE_RUN_STATE } },
      sandboxIdRef: { current: null },
      branchInfoRef: { current: undefined },
      repoRef: { current: null },
      workspaceSessionIdRef: { current: null },
      ensureSandboxRef: { current: null },
      abortRef: { current: false },
      setConversations: (next) => {
        conversations = typeof next === 'function' ? next(conversations) : next;
      },
      dirtyConversationIdsRef: { current: new Set<string>() },
      conversations,
      setAgentStatus: (next) => {
        agentStatus = typeof next === 'function' ? next(agentStatus) : next;
      },
      agentEventsByChatRef,
      replaceAgentEvents: (next) => {
        agentEventsByChat = next;
        agentEventsByChatRef.current = agentEventsByChat;
      },
      activeChatIdRef: { current: 'chat-1' },
      sendMessageRef: { current: null },
      isStreaming: false,
      activeChatId: 'chat-1',
      getVerificationPolicyForChat: () => ({ name: 'Standard', rules: [] }),
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      hook.updateAgentStatus({ active: true, phase: 'Thinking...' }, { chatId: 'chat-1' });
      hook.updateAgentStatus({ active: true, phase: 'Thinking...' }, { chatId: 'chat-1' });
    } finally {
      nowSpy.mockRestore();
    }

    expect(agentStatus).toEqual({ active: true, phase: 'Thinking...' });
    expect(agentEventsByChat['chat-1']).toHaveLength(1);
    expect(agentEventsByChat['chat-1'][0]).toMatchObject({
      source: 'orchestrator',
      phase: 'Thinking...',
    });
    expect(conversations['chat-1'].runState?.agentEvents).toHaveLength(1);
  });

  it('resumes expiry checkpoints by sending a reconciliation message through sendMessageRef', async () => {
    const checkpoint = makeCheckpoint({
      reason: 'expiry',
      savedDiff: 'diff --git a/app.ts b/app.ts',
    });
    hookState.interruptedCheckpoint = checkpoint;
    checkpointMocks.detectInterruptedRun.mockResolvedValue(checkpoint);
    checkpointMocks.checkpointRequiresLiveSandboxStatus.mockReturnValue(false);
    checkpointMocks.buildCheckpointReconciliationMessage.mockReturnValue('resume content');

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let agentEventsByChat: Record<string, AgentStatusEvent[]> = {};
    const agentEventsByChatRef = { current: agentEventsByChat };

    const hook = useChatCheckpoint({
      runEngineStateRef: { current: { ...IDLE_RUN_STATE } },
      sandboxIdRef: { current: null },
      branchInfoRef: { current: { currentBranch: 'feature/checkpoint', defaultBranch: 'main' } },
      repoRef: { current: 'owner/repo' },
      workspaceSessionIdRef: { current: 'workspace-1' },
      ensureSandboxRef: { current: null },
      abortRef: { current: false },
      setConversations: vi.fn(),
      dirtyConversationIdsRef: { current: new Set<string>() },
      conversations: makeConversation(),
      setAgentStatus: vi.fn(),
      agentEventsByChatRef,
      replaceAgentEvents: (next) => {
        agentEventsByChat = next;
        agentEventsByChatRef.current = agentEventsByChat;
      },
      activeChatIdRef: { current: 'chat-1' },
      sendMessageRef: { current: sendMessage },
      isStreaming: false,
      activeChatId: 'chat-1',
      getVerificationPolicyForChat: () => ({ name: 'Standard', rules: [] }),
    });

    await hook.resumeInterruptedRun();

    expect(checkpointMocks.clearRunCheckpoint).toHaveBeenCalledWith('chat-1');
    expect(checkpointMocks.recordResumeEvent).toHaveBeenCalledWith(checkpoint);
    expect(sendMessage).toHaveBeenCalledWith('resume content');
    expect(hookState.setInterruptedCheckpoint).toHaveBeenCalledWith(null);
  });

  it('cold-resumes a mid-run checkpoint by recreating the sandbox when it was lost', async () => {
    const checkpoint = makeCheckpoint();
    hookState.interruptedCheckpoint = checkpoint;
    checkpointMocks.detectInterruptedRun.mockResolvedValue(checkpoint);
    checkpointMocks.checkpointRequiresLiveSandboxStatus.mockReturnValue(true);
    checkpointMocks.buildCheckpointReconciliationMessage.mockReturnValue('cold resume content');

    const ensureSandbox = vi.fn().mockResolvedValue('sandbox-2');
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sandboxIdRef = { current: null as string | null };
    let agentEventsByChat: Record<string, AgentStatusEvent[]> = {};
    const agentEventsByChatRef = { current: agentEventsByChat };

    const hook = useChatCheckpoint({
      runEngineStateRef: { current: { ...IDLE_RUN_STATE } },
      sandboxIdRef,
      branchInfoRef: { current: { currentBranch: 'feature/checkpoint', defaultBranch: 'main' } },
      repoRef: { current: 'owner/repo' },
      workspaceSessionIdRef: { current: 'workspace-1' },
      ensureSandboxRef: { current: ensureSandbox },
      abortRef: { current: false },
      setConversations: vi.fn(),
      dirtyConversationIdsRef: { current: new Set<string>() },
      conversations: makeConversation(),
      setAgentStatus: vi.fn(),
      agentEventsByChatRef,
      replaceAgentEvents: (next) => {
        agentEventsByChat = next;
        agentEventsByChatRef.current = agentEventsByChat;
      },
      activeChatIdRef: { current: 'chat-1' },
      sendMessageRef: { current: sendMessage },
      isStreaming: false,
      activeChatId: 'chat-1',
      getVerificationPolicyForChat: () => ({ name: 'Standard', rules: [] }),
    });

    await hook.resumeInterruptedRun();

    expect(ensureSandbox).toHaveBeenCalled();
    expect(sandboxIdRef.current).toBe('sandbox-2');
    // A recreated sandbox is a fresh clone — its live status must not feed
    // the reconciliation message.
    expect(checkpointMocks.sandboxStatus).not.toHaveBeenCalled();
    // Off the native shell, localCheckpointRecovery is false → the normal
    // saved-diff reconciliation path; on native it would be true (the on-device
    // checkpoint owns WIP, so no re-apply). The message behavior for both is
    // unit-tested in checkpoint-manager.test.ts.
    expect(checkpointMocks.buildCheckpointReconciliationMessage).toHaveBeenCalledWith(
      checkpoint,
      expect.anything(),
      { sandboxLost: true, localCheckpointRecovery: false },
    );
    expect(sendMessage).toHaveBeenCalledWith('cold resume content');
  });

  it('starts fresh when a lost sandbox cannot be recreated', async () => {
    const checkpoint = makeCheckpoint();
    hookState.interruptedCheckpoint = checkpoint;
    checkpointMocks.detectInterruptedRun.mockResolvedValue(checkpoint);
    checkpointMocks.checkpointRequiresLiveSandboxStatus.mockReturnValue(true);

    const ensureSandbox = vi.fn().mockResolvedValue(null);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let conversations = makeConversation();
    let agentEventsByChat: Record<string, AgentStatusEvent[]> = {};
    const agentEventsByChatRef = { current: agentEventsByChat };

    const hook = useChatCheckpoint({
      runEngineStateRef: { current: { ...IDLE_RUN_STATE } },
      sandboxIdRef: { current: null },
      branchInfoRef: { current: { currentBranch: 'feature/checkpoint', defaultBranch: 'main' } },
      repoRef: { current: 'owner/repo' },
      workspaceSessionIdRef: { current: 'workspace-1' },
      ensureSandboxRef: { current: ensureSandbox },
      abortRef: { current: false },
      setConversations: (next) => {
        conversations = typeof next === 'function' ? next(conversations) : next;
      },
      dirtyConversationIdsRef: { current: new Set<string>() },
      conversations,
      setAgentStatus: vi.fn(),
      agentEventsByChatRef,
      replaceAgentEvents: (next) => {
        agentEventsByChat = next;
        agentEventsByChatRef.current = agentEventsByChat;
      },
      activeChatIdRef: { current: 'chat-1' },
      sendMessageRef: { current: sendMessage },
      isStreaming: false,
      activeChatId: 'chat-1',
      getVerificationPolicyForChat: () => ({ name: 'Standard', rules: [] }),
    });

    await hook.resumeInterruptedRun();

    expect(ensureSandbox).toHaveBeenCalled();
    expect(checkpointMocks.clearRunCheckpoint).toHaveBeenCalledWith('chat-1');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(conversations['chat-1'].messages.at(-1)?.content).toContain(
      'the sandbox is no longer available',
    );
  });

  it('folds a mid-run diff snapshot into the next checkpoint flush', async () => {
    checkpointMocks.fetchSandboxDiff.mockResolvedValue('diff --git a/mid.ts b/mid.ts');

    let agentEventsByChat: Record<string, AgentStatusEvent[]> = {};
    const agentEventsByChatRef = { current: agentEventsByChat };

    const hook = useChatCheckpoint({
      runEngineStateRef: {
        current: {
          ...IDLE_RUN_STATE,
          chatId: 'chat-1',
          phase: 'executing_tools',
          round: 2,
          provider: 'openrouter',
          model: 'test-model',
        },
      },
      sandboxIdRef: { current: 'sandbox-1' },
      branchInfoRef: { current: { currentBranch: 'feature/checkpoint', defaultBranch: 'main' } },
      // No repo: keeps captureV1Checkpoint on its skip path so this test
      // exercises only the legacy buildRunCheckpoint snapshot.
      repoRef: { current: null },
      workspaceSessionIdRef: { current: 'workspace-1' },
      ensureSandboxRef: { current: null },
      abortRef: { current: false },
      setConversations: vi.fn(),
      dirtyConversationIdsRef: { current: new Set<string>() },
      conversations: makeConversation(),
      setAgentStatus: vi.fn(),
      agentEventsByChatRef,
      replaceAgentEvents: (next) => {
        agentEventsByChat = next;
        agentEventsByChatRef.current = agentEventsByChat;
      },
      activeChatIdRef: { current: 'chat-1' },
      sendMessageRef: { current: null },
      isStreaming: true,
      activeChatId: 'chat-1',
      getVerificationPolicyForChat: () => ({ name: 'Standard', rules: [] }),
    });

    // First flush: no snapshot yet — kicks the async capture.
    hook.flushCheckpoint();
    expect(checkpointMocks.buildRunCheckpoint).toHaveBeenCalledTimes(1);
    expect(checkpointMocks.buildRunCheckpoint.mock.calls[0][0]).toMatchObject({
      savedDiff: undefined,
    });

    // Let the capture promise settle.
    await vi.waitFor(() => {
      expect(checkpointMocks.fetchSandboxDiff).toHaveBeenCalledWith('sandbox-1');
    });
    await Promise.resolve();

    // Second flush: the stashed snapshot rides along.
    hook.flushCheckpoint();
    expect(checkpointMocks.buildRunCheckpoint).toHaveBeenCalledTimes(2);
    expect(checkpointMocks.buildRunCheckpoint.mock.calls[1][0]).toMatchObject({
      savedDiff: 'diff --git a/mid.ts b/mid.ts',
    });
  });
});
