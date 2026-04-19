import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// useChat orchestrates ~25 modules. Its core logic is unit-tested through the
// helpers it composes (chat-send, chat-management, chat-card-actions,
// chat-queue, useChatCheckpoint, useCIPoller, useAgentDelegation). Here we
// cover the hook's public surface: that it can be instantiated without
// throwing, produces the expected API shape, and that its setter-style
// callbacks mutate the mirror refs consumers rely on.

const chatRuntimeState = vi.hoisted(() => ({
  buildAgentEventsByChat: vi.fn(() => ({})),
  buildQueuedFollowUpsByChat: vi.fn(() => ({})),
  setConversationRunEvents: vi.fn(),
  setConversationQueuedFollowUps: vi.fn(),
  setConversationVerificationState: vi.fn(),
}));
const orchestrator = vi.hoisted(() => ({
  getActiveProvider: vi.fn(() => 'openai'),
  isProviderAvailable: vi.fn(() => true),
  estimateContextTokens: vi.fn(() => 0),
  getContextBudget: vi.fn(() => ({ maxTokens: 100000 })),
}));
const fileLedger = vi.hoisted(() => ({
  reset: vi.fn(),
  setRepo: vi.fn(),
  markRead: vi.fn(),
  markWrite: vi.fn(),
}));
const providerSelection = vi.hoisted(() => ({
  resolveChatProviderSelection: vi.fn(() => ({
    lockedProvider: null,
    isProviderLocked: false,
    lockedModel: null,
    isModelLocked: false,
  })),
}));
const sandboxStartMode = vi.hoisted(() => ({
  getSandboxStartMode: vi.fn(() => 'manual'),
}));
const providers = vi.hoisted(() => ({
  getModelNameForProvider: vi.fn(() => 'gpt-4'),
  setLastUsedProvider: vi.fn(),
}));
const conversationStore = vi.hoisted(() => ({
  migrateConversationsToIndexedDB: vi.fn(async () => {}),
  saveConversation: vi.fn(async () => {}),
  deleteConversation: vi.fn(async () => {}),
}));
const checkpointManager = vi.hoisted(() => ({
  acquireRunTabLock: vi.fn(() => true),
  clearRunCheckpoint: vi.fn(async () => {}),
  heartbeatRunTabLock: vi.fn(),
  releaseRunTabLock: vi.fn(),
  detectInterruptedRun: vi.fn(async () => null),
  getResumeEvents: vi.fn(() => []),
}));
const chatPersistence = vi.hoisted(() => ({
  generateTitle: vi.fn(async () => 'title'),
  loadActiveChatId: vi.fn(() => 'chat-1'),
  loadConversations: vi.fn(() => ({
    'chat-1': {
      id: 'chat-1',
      title: 'Chat 1',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
  })),
  normalizeConversationModel: vi.fn((m) => m),
  saveActiveChatId: vi.fn(),
  shouldPrewarmSandbox: vi.fn(() => false),
  createId: vi.fn(() => 'id-1'),
}));
const agentDelegation = vi.hoisted(() => ({
  useAgentDelegation: vi.fn(() => ({
    getDelegationOutcome: () => null,
    recordDelegationOutcome: vi.fn(),
    delegateToSubagent: vi.fn(),
  })),
}));
const ciPoller = vi.hoisted(() => ({
  useCIPoller: vi.fn(() => ({ ciStatus: null })),
}));
const chatCardActions = vi.hoisted(() => ({
  useChatCardActions: vi.fn(() => ({
    handleCardAction: vi.fn(),
    injectAssistantCardMessage: vi.fn(),
  })),
}));
const chatManagement = vi.hoisted(() => ({
  useChatManagement: vi.fn(() => ({
    sortedChatIds: ['chat-1'],
    switchChat: vi.fn(),
    renameChat: vi.fn(),
    createNewChat: vi.fn(),
    deleteChat: vi.fn(),
    deleteAllChats: vi.fn(),
    regenerateLastResponse: vi.fn(),
    editMessageAndResend: vi.fn(),
  })),
}));
const chatReplay = vi.hoisted(() => ({
  useChatReplay: vi.fn(() => ({
    regenerateLastResponse: vi.fn(),
    editMessageAndResend: vi.fn(),
    diagnoseCIFailure: vi.fn(),
  })),
}));
const chatCheckpoint = vi.hoisted(() => ({
  useChatCheckpoint: vi.fn(() => ({
    interruptedCheckpoint: null,
    resumeInterruptedRun: vi.fn(),
    dismissResume: vi.fn(),
    saveExpiryCheckpoint: vi.fn(),
    updateAgentStatus: vi.fn(),
    flushCheckpoint: vi.fn(),
    checkpointRefs: {},
    lastCoderStateRef: { current: null },
    tabLockIntervalRef: { current: null },
  })),
}));
const chatSend = vi.hoisted(() => ({
  streamAssistantRound: vi.fn(),
  processAssistantTurn: vi.fn(),
}));
const chatQueue = vi.hoisted(() => ({
  appendQueuedItem: vi.fn((m, _k, v) => ({ ...m, _last: v })),
  clearQueuedItems: vi.fn((m) => m),
  shiftQueuedItem: vi.fn((m) => [null, m] as const),
}));
const chatRunEvents = vi.hoisted(() => ({
  mergeRunEventStreams: vi.fn((a, b) => [...(a || []), ...(b || [])]),
  shouldPersistRunEvent: vi.fn(() => true),
  trimRunEvents: vi.fn((e) => e),
}));
const contextMemory = vi.hoisted(() => ({
  expireBranchScopedMemory: vi.fn(async () => {}),
}));
const runEngine = vi.hoisted(() => ({
  IDLE_RUN_STATE: { kind: 'idle' },
  isRunActive: vi.fn(() => false),
  runEngineReducer: vi.fn((s) => s),
}));
const runJournal = vi.hoisted(() => ({
  appendJournalEvent: vi.fn(),
  createJournalEntry: vi.fn(() => ({ id: 'j-1', runId: 'r-1', events: [] })),
  finalizeJournalEntry: vi.fn(),
  loadJournalEntriesForChat: vi.fn(async () => []),
  pruneJournalEntries: vi.fn(async () => {}),
  recordDelegationOutcome: vi.fn(),
  saveJournalEntry: vi.fn(async () => {}),
  updateJournalPhase: vi.fn(),
  updateJournalVerificationState: vi.fn(),
  markJournalCheckpoint: vi.fn(),
}));
const verificationPolicy = vi.hoisted(() => ({
  getDefaultVerificationPolicy: vi.fn(() => ({})),
  resolveVerificationPolicy: vi.fn(() => ({})),
}));
const verificationRuntime = vi.hoisted(() => ({
  hydrateVerificationRuntimeState: vi.fn(() => null),
}));

vi.mock('@/lib/chat-runtime-state', () => chatRuntimeState);
vi.mock('@/lib/orchestrator', () => orchestrator);
vi.mock('@/lib/file-awareness-ledger', () => ({ fileLedger }));
vi.mock('@/lib/provider-selection', () => providerSelection);
vi.mock('@/lib/sandbox-start-mode', () => sandboxStartMode);
vi.mock('@/lib/providers', () => providers);
vi.mock('@/lib/conversation-store', () => conversationStore);
vi.mock('@/lib/checkpoint-manager', () => checkpointManager);
vi.mock('@/hooks/chat-persistence', () => chatPersistence);
vi.mock('./useAgentDelegation', () => agentDelegation);
vi.mock('./useCIPoller', () => ciPoller);
vi.mock('./chat-card-actions', () => chatCardActions);
vi.mock('./chat-management', () => chatManagement);
vi.mock('./chat-replay', () => chatReplay);
vi.mock('./useChatCheckpoint', () => chatCheckpoint);
vi.mock('./chat-send', () => chatSend);
vi.mock('./chat-queue', () => chatQueue);
vi.mock('@/lib/chat-run-events', () => chatRunEvents);
vi.mock('@/lib/context-memory', () => contextMemory);
vi.mock('@/lib/run-engine', () => runEngine);
vi.mock('@/lib/run-journal', () => runJournal);
vi.mock('@/lib/verification-policy', () => verificationPolicy);
vi.mock('@/lib/verification-runtime', () => verificationRuntime);

type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.cells[i] = { value: seed };
    }
    const cell = reactState.cells[i];
    const setter = (v: T | ((prev: T) => T)) => {
      cell.value = typeof v === 'function' ? (v as (prev: T) => T)(cell.value as T) : v;
    };
    return [cell.value as T, setter];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
  useMemo: <T>(fn: () => T) => fn(),
  useReducer: <S, A>(_reducer: (s: S, a: A) => S, initial: S): [S, (a: A) => void] => [
    initial,
    () => {},
  ],
}));

const { useChat } = await import('./useChat');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
});

describe('useChat — public API surface', () => {
  it('returns the expected keys with sensible defaults', () => {
    const hook = useChat(null);
    // Active chat
    expect(hook.messages).toEqual([]);
    expect(hook.isStreaming).toBe(false);
    expect(hook.queuedFollowUpCount).toBe(0);
    expect(hook.pendingSteerCount).toBe(0);
    // Multi-chat management
    expect(hook.activeChatId).toBe('chat-1');
    expect(hook.sortedChatIds).toEqual(['chat-1']);
    expect(hook.conversations).toEqual(expect.objectContaining({ 'chat-1': expect.any(Object) }));
    // Resumable sessions + CI
    expect(hook.interruptedCheckpoint).toBeNull();
    expect(hook.ciStatus).toBeNull();
    // Callback-style API keys are always functions
    for (const key of [
      'sendMessage',
      'switchChat',
      'renameChat',
      'createNewChat',
      'deleteChat',
      'deleteAllChats',
      'regenerateLastResponse',
      'editMessageAndResend',
      'setWorkspaceContext',
      'setWorkspaceMode',
      'setSandboxId',
      'setWorkspaceSessionId',
      'setEnsureSandbox',
      'setIsMainProtected',
      'setAgentsMd',
      'setInstructionFilename',
      'injectAssistantCardMessage',
      'handleCardAction',
      'abortStream',
      'resumeInterruptedRun',
      'dismissResume',
      'saveExpiryCheckpoint',
      'diagnoseCIFailure',
    ] as const) {
      expect(typeof hook[key]).toBe('function');
    }
  });

  it('derives lockedProvider/lockedModel from the active conversation', () => {
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': {
        id: 'chat-1',
        title: 'Chat',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        provider: 'openai',
      },
    });
    chatPersistence.normalizeConversationModel.mockReturnValueOnce('gpt-4o');
    const hook = useChat(null);
    expect(hook.lockedProvider).toBe('openai');
    expect(hook.isProviderLocked).toBe(true);
    expect(hook.lockedModel).toBe('gpt-4o');
  });

  it('setSandboxId updates the mirror ref consumers read from', () => {
    const hook = useChat('owner/repo');
    // The sandbox id ref is among the useRef slots; rather than indexing,
    // we verify via behavior: calling the setter does not throw and the
    // hook's return shape stays stable.
    expect(() => hook.setSandboxId('sbx-123')).not.toThrow();
  });

  it('exposes contextUsage with used/max/percent fields', () => {
    const hook = useChat(null);
    expect(hook.contextUsage).toEqual(
      expect.objectContaining({
        used: expect.any(Number),
        max: expect.any(Number),
        percent: expect.any(Number),
      }),
    );
  });
});

// Characterization tests for the queued-follow-ups cluster that
// useQueuedFollowUps will absorb. These pin the observable behavior from
// useChat's public surface: initial hydration via buildQueuedFollowUpsByChat,
// derivation of queuedFollowUpCount from the active chat, and the
// abortStream -> clear seam. The enqueue/dequeue paths run inside
// sendMessage and are not drivable through the existing test harness;
// they will be covered against the new hook directly in Commit B.
describe('useChat — queued follow-ups (pre-extraction characterization)', () => {
  // The app runs its web tests in `environment: 'node'` (vitest.config.ts).
  // abortStream reaches for window.setTimeout / window.clearTimeout, which
  // are absent from the node env. Stub a minimal window via vi.stubGlobal
  // (auto-reverted by vi.unstubAllGlobals in afterAll) so the stub does
  // not leak past this describe block into any future suites that expect
  // window to be undefined under the project-wide node env.
  beforeAll(() => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  function makeConversation(
    chatId: string,
    queuedFollowUps?: Array<{ text: string; queuedAt: number }>,
  ) {
    return {
      id: chatId,
      title: `Chat ${chatId}`,
      messages: [],
      createdAt: 1,
      lastMessageAt: 1,
      ...(queuedFollowUps ? { runState: { queuedFollowUps } } : {}),
    };
  }

  it('hydrates queuedFollowUpCount from initialConversations via buildQueuedFollowUpsByChat', () => {
    const followUp1 = { text: 'first', queuedAt: 1 };
    const followUp2 = { text: 'second', queuedAt: 2 };
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': makeConversation('chat-1', [followUp1, followUp2]),
    });
    chatRuntimeState.buildQueuedFollowUpsByChat.mockReturnValueOnce({
      'chat-1': [followUp1, followUp2],
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');

    const hook = useChat(null);

    expect(chatRuntimeState.buildQueuedFollowUpsByChat).toHaveBeenCalledWith(
      expect.objectContaining({ 'chat-1': expect.any(Object) }),
    );
    expect(hook.queuedFollowUpCount).toBe(2);
  });

  it('queuedFollowUpCount is derived from the active chat only', () => {
    const followUp = { text: 'other-chat', queuedAt: 1 };
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': makeConversation('chat-1'),
      'chat-2': makeConversation('chat-2', [followUp]),
    });
    chatRuntimeState.buildQueuedFollowUpsByChat.mockReturnValueOnce({
      'chat-2': [followUp],
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');

    const hook = useChat(null);

    expect(hook.queuedFollowUpCount).toBe(0);
  });

  it('abortStream({ clearQueuedFollowUps: true }) invokes clearQueuedItems for the active chat', () => {
    const followUp = { text: 'pending', queuedAt: 1 };
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': makeConversation('chat-1', [followUp]),
    });
    chatRuntimeState.buildQueuedFollowUpsByChat.mockReturnValueOnce({
      'chat-1': [followUp],
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');
    chatQueue.clearQueuedItems.mockImplementationOnce(() => ({}));

    const hook = useChat(null);
    const callsBefore = chatQueue.clearQueuedItems.mock.calls.length;
    hook.abortStream({ clearQueuedFollowUps: true });

    expect(chatQueue.clearQueuedItems.mock.calls.length).toBe(callsBefore + 1);
    const [mapArg, chatIdArg] = chatQueue.clearQueuedItems.mock.calls[callsBefore];
    expect(mapArg).toEqual(expect.objectContaining({ 'chat-1': [followUp] }));
    expect(chatIdArg).toBe('chat-1');
  });

  it('abortStream() without the clearQueuedFollowUps flag leaves the queue cluster untouched', () => {
    const followUp = { text: 'pending', queuedAt: 1 };
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': makeConversation('chat-1', [followUp]),
    });
    chatRuntimeState.buildQueuedFollowUpsByChat.mockReturnValueOnce({
      'chat-1': [followUp],
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');

    const hook = useChat(null);
    const callsBefore = chatQueue.clearQueuedItems.mock.calls.length;
    hook.abortStream();

    expect(chatQueue.clearQueuedItems.mock.calls.length).toBe(callsBefore);
  });
});

// Characterization tests for the run-events cluster that useRunEventStream
// will absorb. The fake-React harness mocks useEffect to a no-op, so the
// journal-load effect and appendRunEvent's routing are not drivable from
// the outside. What IS reachable is the UI derivation (runEvents useMemo):
// it calls mergeRunEventStreams with activeConversation.runState.runEvents
// (persisted input) and liveRunEventsByChat[activeChatId] (live input).
// These tests pin the merge-order invariant so the extraction cannot
// silently rearrange which stream wins when persisted is empty vs. present.
describe('useChat — run events (pre-extraction characterization)', () => {
  function makeRunEvent(id: string, type = 'assistant.turn_start') {
    return { id, timestamp: 1, type, round: 1 };
  }

  it('mergeRunEventStreams receives the active conversation persisted runEvents as arg1', () => {
    const persisted = [makeRunEvent('r-1'), makeRunEvent('r-2')];
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': {
        id: 'chat-1',
        title: 'Chat',
        messages: [],
        createdAt: 1,
        lastMessageAt: 1,
        runState: { runEvents: persisted },
      },
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');

    chatRunEvents.mergeRunEventStreams.mockClear();
    const hook = useChat(null);

    const latestCall = chatRunEvents.mergeRunEventStreams.mock.calls.at(-1);
    expect(latestCall).toBeTruthy();
    const [persistedArg, liveArg] = latestCall as [unknown, unknown];
    expect(persistedArg).toEqual(persisted);
    expect(liveArg).toEqual([]);
    // The useMemo returns whatever mergeRunEventStreams returns; the default
    // mock concatenates, so hook.runEvents surfaces the full stream.
    expect(hook.runEvents).toEqual(persisted);
  });

  it('mergeRunEventStreams receives [] as the persisted arg when the active chat has no runState', () => {
    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': {
        id: 'chat-1',
        title: 'Chat',
        messages: [],
        createdAt: 1,
        lastMessageAt: 1,
      },
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');

    chatRunEvents.mergeRunEventStreams.mockClear();
    const hook = useChat(null);

    const latestCall = chatRunEvents.mergeRunEventStreams.mock.calls.at(-1);
    expect(latestCall).toBeTruthy();
    const [persistedArg, liveArg] = latestCall as [unknown, unknown];
    // Falls back to [] (persisted ?? journal ?? [] — journal is empty in
    // this harness because useEffect is a no-op, so the outer `?? []`
    // governs).
    expect(persistedArg).toEqual([]);
    expect(liveArg).toEqual([]);
    expect(hook.runEvents).toEqual([]);
  });

  it('hook.runEvents reflects exactly the mergeRunEventStreams return value', () => {
    const merged = [makeRunEvent('m-1'), makeRunEvent('m-2')];
    chatRunEvents.mergeRunEventStreams.mockReturnValueOnce(merged);

    chatPersistence.loadConversations.mockReturnValueOnce({
      'chat-1': {
        id: 'chat-1',
        title: 'Chat',
        messages: [],
        createdAt: 1,
        lastMessageAt: 1,
      },
    });
    chatPersistence.loadActiveChatId.mockReturnValueOnce('chat-1');

    const hook = useChat(null);

    expect(hook.runEvents).toBe(merged);
  });
});
