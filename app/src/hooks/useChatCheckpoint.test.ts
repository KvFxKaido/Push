import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentStatus,
  AgentStatusEvent,
  ChatMessage,
  Conversation,
  RunCheckpoint,
} from '@/types';

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
  recordResumeEvent: vi.fn(),
  saveRunCheckpoint: vi.fn(),
  sandboxStatus: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(initial: T) => [
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
    });

    await hook.resumeInterruptedRun();

    expect(checkpointMocks.clearRunCheckpoint).toHaveBeenCalledWith('chat-1');
    expect(checkpointMocks.recordResumeEvent).toHaveBeenCalledWith(checkpoint);
    expect(sendMessage).toHaveBeenCalledWith('resume content');
    expect(hookState.setInterruptedCheckpoint).toHaveBeenCalledWith(null);
  });
});
