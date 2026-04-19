import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, QueuedFollowUp } from '@/types';

// Minimal hand-rolled React harness: the project runs the web tests under
// `environment: 'node'`, so useState/useRef/useCallback are stubbed rather
// than run through a real renderer. This matches the pattern already in
// useChat.test.ts; kept local to this file so the stubs don't leak.
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
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

const { useQueuedFollowUps } = await import('./useQueuedFollowUps');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
});

function makeConversation(id: string, queuedFollowUps?: QueuedFollowUp[]): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
    ...(queuedFollowUps ? { runState: { queuedFollowUps } } : {}),
  };
}

interface HarnessState {
  conversations: Record<string, Conversation>;
  dirty: Set<string>;
  mounted: boolean;
  updateCalls: number;
}

// Prefixed `use` so the lint rule `react-hooks/rules-of-hooks` treats
// the enclosing function as a custom hook. It is not a real React
// hook; the useQueuedFollowUps call inside runs under the fake-React
// harness mocked at the top of this file.
function useHarness(
  options: {
    initial?: Record<string, QueuedFollowUp[]>;
    conversations?: Record<string, Conversation>;
    mounted?: boolean;
  } = {},
) {
  const state: HarnessState = {
    conversations: options.conversations ?? { 'chat-1': makeConversation('chat-1') },
    dirty: new Set<string>(),
    mounted: options.mounted ?? true,
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

  const hook = useQueuedFollowUps({
    initial: options.initial ?? {},
    updateConversations,
    dirtyConversationIdsRef: { current: state.dirty } as React.MutableRefObject<Set<string>>,
    isMountedRef: { current: state.mounted } as React.MutableRefObject<boolean>,
  });

  return { hook, state };
}

const followUp = (text: string): QueuedFollowUp => ({ text, queuedAt: 1 });

describe('useQueuedFollowUps — public surface invariants', () => {
  it('enqueue appends the follow-up to the ref and persists via updateConversations', () => {
    const { hook, state } = useHarness();
    const fu = followUp('first');

    hook.enqueue('chat-1', fu);

    expect(hook.queuedFollowUpsRef.current).toEqual({ 'chat-1': [fu] });
    expect(state.updateCalls).toBe(1);
    expect(state.dirty.has('chat-1')).toBe(true);
    expect(state.conversations['chat-1'].runState?.queuedFollowUps).toEqual([fu]);
  });

  it('enqueue preserves FIFO order across multiple calls on the same chat', () => {
    const { hook } = useHarness();
    const a = followUp('a');
    const b = followUp('b');

    hook.enqueue('chat-1', a);
    hook.enqueue('chat-1', b);

    expect(hook.queuedFollowUpsRef.current).toEqual({ 'chat-1': [a, b] });
  });

  it('dequeue returns the next item, shifts the queue, and persists the shrunk state', () => {
    const a = followUp('a');
    const b = followUp('b');
    const { hook, state } = useHarness({
      initial: { 'chat-1': [a, b] },
      conversations: { 'chat-1': makeConversation('chat-1', [a, b]) },
    });

    const popped = hook.dequeue('chat-1');

    expect(popped).toEqual(a);
    expect(hook.queuedFollowUpsRef.current).toEqual({ 'chat-1': [b] });
    expect(state.updateCalls).toBe(1);
    expect(state.conversations['chat-1'].runState?.queuedFollowUps).toEqual([b]);
  });

  it('dequeue on an empty chat returns null and does not persist', () => {
    const { hook, state } = useHarness();

    const popped = hook.dequeue('chat-1');

    expect(popped).toBeNull();
    expect(state.updateCalls).toBe(0);
  });

  it('clear wipes only the target chat and persists just that change', () => {
    const a = followUp('a');
    const b = followUp('b');
    const { hook, state } = useHarness({
      initial: { 'chat-1': [a], 'chat-2': [b] },
      conversations: {
        'chat-1': makeConversation('chat-1', [a]),
        'chat-2': makeConversation('chat-2', [b]),
      },
    });

    hook.clear('chat-1');

    expect(hook.queuedFollowUpsRef.current).toEqual({ 'chat-2': [b] });
    expect(state.updateCalls).toBe(1);
    expect(state.conversations['chat-1'].runState?.queuedFollowUps ?? []).toEqual([]);
    expect(state.conversations['chat-2'].runState?.queuedFollowUps).toEqual([b]);
  });

  it('hydrate replaces the ref from persisted conversations without persisting back', () => {
    const a = followUp('a');
    const { hook, state } = useHarness({
      initial: { 'chat-1': [followUp('stale')] },
    });

    hook.hydrate({ 'chat-1': makeConversation('chat-1', [a]) });

    expect(hook.queuedFollowUpsRef.current).toEqual({ 'chat-1': [a] });
    expect(state.updateCalls).toBe(0);
    expect(state.dirty.size).toBe(0);
  });

  it('mutator only persists for chats whose queue actually changed', () => {
    const a = followUp('a');
    const b = followUp('b');
    const { hook, state } = useHarness({
      initial: { 'chat-1': [a], 'chat-2': [b] },
      conversations: {
        'chat-1': makeConversation('chat-1', [a]),
        'chat-2': makeConversation('chat-2', [b]),
      },
    });

    hook.clear('chat-2');

    expect(state.updateCalls).toBe(1);
    expect(state.dirty.has('chat-2')).toBe(true);
    expect(state.dirty.has('chat-1')).toBe(false);
  });

  it('public mutator skips setState when isMountedRef.current is false but still persists', () => {
    const { hook, state } = useHarness({ mounted: false });
    const fu = followUp('x');

    hook.enqueue('chat-1', fu);

    // Ref always updates (needed so in-flight callbacks read the latest
    // queue even after unmount). Persistence still fires so the data lands
    // in IndexedDB even if the component unmounted mid-run.
    expect(hook.queuedFollowUpsRef.current).toEqual({ 'chat-1': [fu] });
    expect(state.updateCalls).toBe(1);
  });
});
