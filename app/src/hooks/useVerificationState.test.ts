import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, VerificationRuntimeState, WorkspaceContext } from '@/types';
import type { VerificationPolicy } from '@/lib/verification-policy';

// --- Hand-rolled React harness ---
type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

// --- Module mocks ---
const verificationPolicy = vi.hoisted(() => ({
  getDefaultVerificationPolicy: vi.fn(() => ({ kind: 'default' }) as unknown as VerificationPolicy),
  resolveVerificationPolicy: vi.fn(
    (policy) => (policy ?? { kind: 'default' }) as unknown as VerificationPolicy,
  ),
}));
const verificationRuntime = vi.hoisted(() => ({
  hydrateVerificationRuntimeState: vi.fn(
    (policy, state) =>
      ({
        policy,
        ...(state ? { hydrated: true, previous: state } : { hydrated: true }),
      }) as unknown as VerificationRuntimeState,
  ),
}));
const chatRuntimeState = vi.hoisted(() => ({
  setConversationVerificationState: vi.fn((conv, verificationState) => ({
    ...(conv as Conversation),
    runState: {
      ...((conv as Conversation).runState ?? {}),
      verificationState,
    },
  })),
}));

vi.mock('@/lib/verification-policy', () => verificationPolicy);
vi.mock('@/lib/verification-runtime', () => verificationRuntime);
vi.mock('@/lib/chat-runtime-state', () => chatRuntimeState);

const { useVerificationState } = await import('./useVerificationState');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  verificationPolicy.getDefaultVerificationPolicy.mockClear();
  verificationPolicy.getDefaultVerificationPolicy.mockReturnValue({
    kind: 'default',
  } as unknown as VerificationPolicy);
  verificationPolicy.resolveVerificationPolicy.mockClear();
  verificationPolicy.resolveVerificationPolicy.mockImplementation(
    (policy) => (policy ?? { kind: 'default' }) as unknown as VerificationPolicy,
  );
  verificationRuntime.hydrateVerificationRuntimeState.mockClear();
  verificationRuntime.hydrateVerificationRuntimeState.mockImplementation(
    (policy, state) =>
      ({
        policy,
        ...(state ? { hydrated: true, previous: state } : { hydrated: true }),
      }) as unknown as VerificationRuntimeState,
  );
  chatRuntimeState.setConversationVerificationState.mockClear();
});

function makeConversation(id: string, verificationPolicyValue?: VerificationPolicy): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
    ...(verificationPolicyValue ? { verificationPolicy: verificationPolicyValue } : {}),
  };
}

interface HarnessState {
  conversations: Record<string, Conversation>;
  dirty: Set<string>;
  updateCalls: number;
}

function useHarness(
  options: {
    activeChatId?: string;
    activeConversationVerificationPolicy?: VerificationPolicy;
    conversations?: Record<string, Conversation>;
  } = {},
) {
  const state: HarnessState = {
    conversations: options.conversations ?? { 'chat-1': makeConversation('chat-1') },
    dirty: new Set<string>(),
    updateCalls: 0,
  };

  const updateConversations = (
    updater:
      | Record<string, Conversation>
      | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
  ) => {
    state.updateCalls += 1;
    state.conversations = typeof updater === 'function' ? updater(state.conversations) : updater;
  };

  const activeChatIdRef = {
    current: options.activeChatId ?? 'chat-1',
  } as React.MutableRefObject<string>;
  const conversationsRef = {
    current: state.conversations,
  } as React.MutableRefObject<Record<string, Conversation>>;

  const hook = useVerificationState({
    activeChatId: options.activeChatId ?? 'chat-1',
    activeConversationVerificationPolicy: options.activeConversationVerificationPolicy,
    activeChatIdRef,
    conversationsRef,
    updateConversations,
    dirtyConversationIdsRef: { current: state.dirty } as React.MutableRefObject<Set<string>>,
  });

  return { hook, state, conversationsRef };
}

describe('useVerificationState — getVerificationPolicyForChat', () => {
  it('returns the default policy when chatId is null', () => {
    const { hook } = useHarness();

    const policy = hook.getVerificationPolicyForChat(null);

    expect(verificationPolicy.getDefaultVerificationPolicy).toHaveBeenCalledTimes(1);
    expect(verificationPolicy.resolveVerificationPolicy).not.toHaveBeenCalled();
    expect(policy).toEqual({ kind: 'default' });
  });

  it('resolves the conversation policy when chatId is present', () => {
    const customPolicy = { kind: 'strict' } as unknown as VerificationPolicy;
    const { hook } = useHarness({
      conversations: { 'chat-1': makeConversation('chat-1', customPolicy) },
    });

    hook.getVerificationPolicyForChat('chat-1');

    expect(verificationPolicy.resolveVerificationPolicy).toHaveBeenCalledWith(customPolicy);
  });
});

describe('useVerificationState — getVerificationStateForChat', () => {
  it('hydrates from persisted runState when nothing is cached yet', () => {
    const persistedState = { status: 'idle' } as unknown as VerificationRuntimeState;
    const { hook } = useHarness({
      conversations: {
        'chat-1': {
          ...makeConversation('chat-1'),
          runState: { verificationState: persistedState },
        },
      },
    });

    hook.getVerificationStateForChat('chat-1');

    expect(verificationRuntime.hydrateVerificationRuntimeState).toHaveBeenCalledTimes(1);
    const [, stateArg] = verificationRuntime.hydrateVerificationRuntimeState.mock.calls[0];
    expect(stateArg).toBe(persistedState);
  });

  it('returns fresh hydrated state on second call, feeding the cached value back in', () => {
    // The current implementation always calls hydrate, even on cache hit,
    // so policy changes propagate. This test pins that contract.
    const { hook } = useHarness();

    hook.getVerificationStateForChat('chat-1');
    const callsAfterFirst = verificationRuntime.hydrateVerificationRuntimeState.mock.calls.length;
    hook.getVerificationStateForChat('chat-1');

    expect(verificationRuntime.hydrateVerificationRuntimeState.mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
    // Second call receives the previously cached value as the second arg.
    const secondCallArgs =
      verificationRuntime.hydrateVerificationRuntimeState.mock.calls[callsAfterFirst];
    expect(secondCallArgs[1]).toEqual(expect.objectContaining({ hydrated: true }));
  });

  it('falls back to undefined when chatId is null (no persisted read)', () => {
    const { hook } = useHarness();

    hook.getVerificationStateForChat(null);

    const [, stateArg] = verificationRuntime.hydrateVerificationRuntimeState.mock.calls[0];
    expect(stateArg).toBeUndefined();
  });
});

describe('useVerificationState — writeVerificationStateForChat', () => {
  it('persists the state to the conversation and marks it dirty', () => {
    const { hook, state } = useHarness();
    const next = { status: 'complete' } as unknown as VerificationRuntimeState;

    hook.writeVerificationStateForChat('chat-1', next);

    expect(state.updateCalls).toBe(1);
    expect(state.dirty.has('chat-1')).toBe(true);
    expect(chatRuntimeState.setConversationVerificationState).toHaveBeenCalledTimes(1);
    expect(state.conversations['chat-1'].runState?.verificationState).toBe(next);
  });

  it('subsequent getVerificationStateForChat reads the cached write (via cache hit)', () => {
    const { hook } = useHarness();
    const written = { status: 'written' } as unknown as VerificationRuntimeState;

    hook.writeVerificationStateForChat('chat-1', written);
    hook.getVerificationStateForChat('chat-1');

    // The latest hydrate call receives the cached value as the second arg
    // (since the ref now holds `written`).
    const lastCall = verificationRuntime.hydrateVerificationRuntimeState.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(written);
  });
});

describe('useVerificationState — workspace setters', () => {
  it('setWorkspaceContext(null) clears the workspace ref', () => {
    const { hook } = useHarness();

    hook.setWorkspaceContext({ mode: 'repo' } as unknown as WorkspaceContext);
    expect(hook.workspaceContextRef.current).not.toBeNull();

    hook.setWorkspaceContext(null);
    expect(hook.workspaceContextRef.current).toBeNull();
  });

  it('setWorkspaceContext stamps the resolved verification policy onto the context', () => {
    const customPolicy = { kind: 'custom' } as unknown as VerificationPolicy;
    verificationPolicy.resolveVerificationPolicy.mockReturnValueOnce(customPolicy);
    const { hook } = useHarness();

    hook.setWorkspaceContext({ mode: 'repo' } as unknown as WorkspaceContext);

    expect(hook.workspaceContextRef.current).toEqual(
      expect.objectContaining({
        mode: 'repo',
        verificationPolicy: customPolicy,
      }),
    );
  });

  it('setWorkspaceContext mirrors the mode onto workspaceModeRef', () => {
    const { hook } = useHarness();

    hook.setWorkspaceContext({ mode: 'scratch' } as unknown as WorkspaceContext);

    expect(hook.workspaceModeRef.current).toBe('scratch');
  });

  it('setWorkspaceMode overrides workspaceModeRef without touching workspaceContextRef', () => {
    const { hook } = useHarness();
    hook.setWorkspaceContext({ mode: 'repo' } as unknown as WorkspaceContext);
    const ctxBefore = hook.workspaceContextRef.current;

    hook.setWorkspaceMode('chat');

    expect(hook.workspaceModeRef.current).toBe('chat');
    expect(hook.workspaceContextRef.current).toBe(ctxBefore);
  });
});
