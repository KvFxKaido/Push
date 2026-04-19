import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, RunEventInput } from '@/types';
import type { RunJournalEntry } from '@/lib/run-journal';

// --- Hand-rolled React harness ---
// Matches the pattern used in useQueuedFollowUps.test.ts. useEffect is a
// no-op here because the journal-load effect is async and the harness
// cannot model React's scheduling; the appendRunEvent branches are fully
// synchronous so they are covered without the effect running.
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
}));

// --- Module mocks ---
// Keep each mock small and focused. shouldPersistRunEvent is the pivot
// that decides which branch of appendRunEvent runs; tests override it
// per case with .mockReturnValueOnce.
const chatRunEvents = vi.hoisted(() => ({
  shouldPersistRunEvent: vi.fn(() => true),
  trimRunEvents: vi.fn(<T>(events: T[]) => events),
}));
const runJournal = vi.hoisted(() => ({
  appendJournalEvent: vi.fn((entry, event) => ({
    ...(entry as { events: unknown[] }),
    events: [...(entry as { events: unknown[] }).events, event],
  })),
  recordDelegationOutcome: vi.fn((entry) => entry),
  saveJournalEntry: vi.fn(async () => {}),
  loadJournalEntriesForChat: vi.fn(async () => []),
}));
const chatRuntimeState = vi.hoisted(() => ({
  setConversationRunEvents: vi.fn((conv, runEvents) => ({
    ...(conv as Conversation),
    runState: {
      ...((conv as Conversation).runState ?? {}),
      runEvents,
    },
  })),
}));
const chatPersistence = vi.hoisted(() => ({
  createId: vi.fn(() => 'gen-id'),
}));

vi.mock('@/lib/chat-run-events', () => chatRunEvents);
vi.mock('@/lib/run-journal', () => runJournal);
vi.mock('@/lib/chat-runtime-state', () => chatRuntimeState);
vi.mock('./chat-persistence', () => chatPersistence);

const { useRunEventStream } = await import('./useRunEventStream');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  chatRunEvents.shouldPersistRunEvent.mockReset();
  chatRunEvents.shouldPersistRunEvent.mockReturnValue(true);
  chatRunEvents.trimRunEvents.mockReset();
  chatRunEvents.trimRunEvents.mockImplementation((events) => events);
  runJournal.appendJournalEvent.mockReset();
  runJournal.appendJournalEvent.mockImplementation((entry, event) => ({
    ...(entry as { events: unknown[] }),
    events: [...(entry as { events: unknown[] }).events, event],
  }));
  runJournal.recordDelegationOutcome.mockReset();
  runJournal.recordDelegationOutcome.mockImplementation((entry) => entry);
  runJournal.saveJournalEntry.mockReset();
  runJournal.saveJournalEntry.mockResolvedValue(undefined);
  chatRuntimeState.setConversationRunEvents.mockReset();
  chatRuntimeState.setConversationRunEvents.mockImplementation((conv, runEvents) => ({
    ...(conv as Conversation),
    runState: {
      ...((conv as Conversation).runState ?? {}),
      runEvents,
    },
  }));
  chatPersistence.createId.mockReset();
  chatPersistence.createId.mockReturnValue('gen-id');
});

function makeConversation(id: string): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    createdAt: 1,
    lastMessageAt: 1,
  };
}

interface HarnessState {
  conversations: Record<string, Conversation>;
  dirty: Set<string>;
  mounted: boolean;
  updateCalls: number;
  journalEntry: RunJournalEntry | null;
}

function useHarness(
  options: {
    activeChatId?: string;
    activePersistedRunEventCount?: number;
    conversations?: Record<string, Conversation>;
    mounted?: boolean;
    initialJournalEntry?: RunJournalEntry | null;
  } = {},
) {
  const state: HarnessState = {
    conversations: options.conversations ?? { 'chat-1': makeConversation('chat-1') },
    dirty: new Set<string>(),
    mounted: options.mounted ?? true,
    updateCalls: 0,
    journalEntry: options.initialJournalEntry ?? null,
  };

  const updateConversations = (
    updater:
      | Record<string, Conversation>
      | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
  ) => {
    state.updateCalls += 1;
    state.conversations = typeof updater === 'function' ? updater(state.conversations) : updater;
  };

  const runJournalEntryRef = {
    get current() {
      return state.journalEntry;
    },
    set current(value: RunJournalEntry | null) {
      state.journalEntry = value;
    },
  } as React.MutableRefObject<RunJournalEntry | null>;

  const hook = useRunEventStream({
    activeChatId: options.activeChatId ?? 'chat-1',
    activePersistedRunEventCount: options.activePersistedRunEventCount ?? 0,
    runJournalEntryRef,
    updateConversations,
    dirtyConversationIdsRef: { current: state.dirty } as React.MutableRefObject<Set<string>>,
    isMountedRef: { current: state.mounted } as React.MutableRefObject<boolean>,
  });

  return { hook, state };
}

function makeJournalEntry(): RunJournalEntry {
  return {
    id: 'journal-1',
    runId: 'run-1',
    chatId: 'chat-1',
    provider: 'openai',
    model: 'gpt-4',
    startedAt: 1,
    phase: 'idle',
    round: 0,
    status: 'in_progress',
    baseMessageCount: 0,
    events: [],
  } as unknown as RunJournalEntry;
}

describe('useRunEventStream — appendRunEvent routing', () => {
  it('routes ephemeral events to liveRunEventsByChat without persisting or journaling', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(false);
    const { hook, state } = useHarness();
    const event: RunEventInput = { type: 'assistant.status', round: 1 } as RunEventInput;

    hook.appendRunEvent('chat-1', event);

    // The live branch routes through trimRunEvents exactly once with a
    // single-element array containing the stamped event (id + timestamp
    // layered on top of the input). Asserting on the trim call is the
    // most direct observation: replaceLiveRunEvents is private and the
    // fake-React harness does not re-render, so reading liveRunEventsByChat
    // via a second useHarness call would allocate fresh state cells.
    expect(chatRunEvents.trimRunEvents).toHaveBeenCalledTimes(1);
    const trimArg = chatRunEvents.trimRunEvents.mock.calls[0][0] as Array<{
      id: string;
      timestamp: number;
      type: string;
      round: number;
    }>;
    expect(trimArg).toHaveLength(1);
    expect(trimArg[0]).toMatchObject({ type: 'assistant.status', round: 1 });
    // And the non-live branches stayed quiet.
    expect(chatRuntimeState.setConversationRunEvents).not.toHaveBeenCalled();
    expect(runJournal.appendJournalEvent).not.toHaveBeenCalled();
    expect(runJournal.saveJournalEntry).not.toHaveBeenCalled();
    expect(state.updateCalls).toBe(0);
    expect(state.dirty.size).toBe(0);
  });

  it('applies trimRunEvents to the accumulated live stream on every append', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(false);
    const { hook } = useHarness();

    hook.appendRunEvent('chat-1', { type: 'assistant.status', round: 1 } as RunEventInput);
    hook.appendRunEvent('chat-1', { type: 'assistant.status', round: 2 } as RunEventInput);

    expect(chatRunEvents.trimRunEvents).toHaveBeenCalledTimes(2);
    // Second call receives the concat of the first stored event + new one.
    const secondArg = chatRunEvents.trimRunEvents.mock.calls[1][0] as unknown[];
    expect(secondArg).toHaveLength(2);
  });

  it('persists persistable events to the active conversation and marks it dirty', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(true);
    const { hook, state } = useHarness();

    hook.appendRunEvent('chat-1', { type: 'assistant.turn_start', round: 1 } as RunEventInput);

    expect(state.updateCalls).toBe(1);
    expect(state.dirty.has('chat-1')).toBe(true);
    expect(chatRuntimeState.setConversationRunEvents).toHaveBeenCalledTimes(1);
    expect(state.conversations['chat-1'].runState?.runEvents).toHaveLength(1);
  });

  it('when no journal entry is present, persistable events do not invoke journal primitives', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(true);
    const { hook } = useHarness({ initialJournalEntry: null });

    hook.appendRunEvent('chat-1', { type: 'assistant.turn_start', round: 1 } as RunEventInput);

    expect(runJournal.appendJournalEvent).not.toHaveBeenCalled();
    expect(runJournal.saveJournalEntry).not.toHaveBeenCalled();
    expect(runJournal.recordDelegationOutcome).not.toHaveBeenCalled();
  });

  it('when a journal entry is active, persistable events append to the journal and save it', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(true);
    const entry = makeJournalEntry();
    const { hook, state } = useHarness({ initialJournalEntry: entry });

    hook.appendRunEvent('chat-1', { type: 'assistant.turn_start', round: 1 } as RunEventInput);

    expect(runJournal.appendJournalEvent).toHaveBeenCalledTimes(1);
    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
    // The ref was updated (appendJournalEvent's return threaded back in).
    expect(state.journalEntry).not.toBe(entry);
    expect((state.journalEntry as { events: unknown[] }).events).toHaveLength(1);
    // Conversation still gets persisted (both branches fire when
    // shouldPersist is true and a journal exists).
    expect(state.updateCalls).toBe(1);
  });

  it('subagent.completed with delegationOutcome threads through recordDelegationOutcome', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(true);
    const { hook } = useHarness({ initialJournalEntry: makeJournalEntry() });
    const outcome = { status: 'success', evidence: [] };

    hook.appendRunEvent('chat-1', {
      type: 'subagent.completed',
      round: 1,
      delegationOutcome: outcome,
    } as unknown as RunEventInput);

    expect(runJournal.recordDelegationOutcome).toHaveBeenCalledTimes(1);
    expect(runJournal.recordDelegationOutcome.mock.calls[0][1]).toEqual(outcome);
  });

  it('subagent.completed without a delegationOutcome skips recordDelegationOutcome', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(true);
    const { hook } = useHarness({ initialJournalEntry: makeJournalEntry() });

    hook.appendRunEvent('chat-1', {
      type: 'subagent.completed',
      round: 1,
    } as unknown as RunEventInput);

    expect(runJournal.appendJournalEvent).toHaveBeenCalledTimes(1);
    expect(runJournal.recordDelegationOutcome).not.toHaveBeenCalled();
  });

  it('stamps id and timestamp onto every event via the createId + Date.now pipeline', () => {
    chatRunEvents.shouldPersistRunEvent.mockReturnValue(false);
    chatPersistence.createId.mockReturnValueOnce('stamped-1');
    const { hook } = useHarness();

    hook.appendRunEvent('chat-1', { type: 'assistant.status', round: 1 } as RunEventInput);

    const trimArg = chatRunEvents.trimRunEvents.mock.calls[0][0] as Array<{
      id: string;
      timestamp: number;
    }>;
    expect(trimArg[0].id).toBe('stamped-1');
    expect(typeof trimArg[0].timestamp).toBe('number');
  });
});
