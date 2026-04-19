import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { RunJournalEntry } from '@/lib/run-journal';
import type { VerificationRuntimeState } from '@/types';

// --- Hand-rolled React harness ---
// Same pattern as the other hook tests in this file; useRunEngine has no
// useState / useEffect, only useRef + useCallback, so the harness does
// not need to simulate React's scheduling.
type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

// --- Module mocks ---
const runEngineLib = vi.hoisted(() => ({
  IDLE_RUN_STATE: { kind: 'idle', phase: 'idle', round: 0 },
  runEngineReducer: vi.fn((_prev, event) => ({
    kind: 'running',
    phase: `phase-for-${(event as { type: string }).type}`,
    round: 1,
  })),
}));
const runJournal = vi.hoisted(() => ({
  createJournalEntry: vi.fn((seed) => ({
    ...(seed as object),
    phase: 'idle',
    round: 0,
    status: 'in_progress',
    events: [],
  })),
  finalizeJournalEntry: vi.fn((entry, status, reason) => ({
    ...(entry as object),
    status,
    ...(reason ? { reason } : {}),
  })),
  pruneJournalEntries: vi.fn(async () => {}),
  saveJournalEntry: vi.fn(async () => {}),
  updateJournalPhase: vi.fn((entry, phase, round) => ({ ...(entry as object), phase, round })),
  updateJournalVerificationState: vi.fn((entry, verificationState) => ({
    ...(entry as object),
    verificationState,
  })),
}));

vi.mock('@/lib/run-engine', async () => {
  const real = await vi.importActual<typeof import('@/lib/run-engine')>('@/lib/run-engine');
  return {
    ...real,
    IDLE_RUN_STATE: runEngineLib.IDLE_RUN_STATE,
    runEngineReducer: runEngineLib.runEngineReducer,
  };
});
vi.mock('@/lib/run-journal', async () => {
  const real = await vi.importActual<typeof import('@/lib/run-journal')>('@/lib/run-journal');
  return {
    ...real,
    createJournalEntry: runJournal.createJournalEntry,
    finalizeJournalEntry: runJournal.finalizeJournalEntry,
    pruneJournalEntries: runJournal.pruneJournalEntries,
    saveJournalEntry: runJournal.saveJournalEntry,
    updateJournalPhase: runJournal.updateJournalPhase,
    updateJournalVerificationState: runJournal.updateJournalVerificationState,
  };
});

const { useRunEngine } = await import('./useRunEngine');

beforeEach(() => {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  runEngineLib.runEngineReducer.mockClear();
  runEngineLib.runEngineReducer.mockImplementation((_prev, event) => ({
    kind: 'running',
    phase: `phase-for-${(event as { type: string }).type}`,
    round: 1,
  }));
  Object.values(runJournal).forEach((fn) => {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as { mockClear: () => void }).mockClear();
    }
  });
});

function makeVerificationState(): VerificationRuntimeState {
  return { chatId: 'chat-1' } as unknown as VerificationRuntimeState;
}

function primeJournal(entry: RunJournalEntry | null) {
  // Drive a RUN_STARTED first to populate the journal ref, or inject
  // directly via the ref. Simplest: invoke useRunEngine, then set the
  // returned ref's current value.
  return entry;
}

function useHarness() {
  const getVerificationStateForChat = vi.fn(() => makeVerificationState());
  const hook = useRunEngine({ getVerificationStateForChat });
  return { hook, getVerificationStateForChat };
}

function runStartedEvent(): RunEngineEvent {
  return {
    type: 'RUN_STARTED',
    timestamp: 1,
    runId: 'run-1',
    chatId: 'chat-1',
    provider: 'openai',
    model: 'gpt-4',
    baseMessageCount: 0,
  } as unknown as RunEngineEvent;
}

describe('useRunEngine — reducer invariant', () => {
  it('runs the reducer with (prevState, event) before every journal side effect', () => {
    const { hook } = useHarness();
    const event = { type: 'ACCUMULATED_UPDATED', timestamp: 1 } as unknown as RunEngineEvent;

    hook.emitRunEngineEvent(event);

    expect(runEngineLib.runEngineReducer).toHaveBeenCalledTimes(1);
    const [prevState, passedEvent] = runEngineLib.runEngineReducer.mock.calls[0] as [
      unknown,
      unknown,
    ];
    expect(prevState).toEqual(runEngineLib.IDLE_RUN_STATE);
    expect(passedEvent).toBe(event);
  });

  it('ACCUMULATED_UPDATED runs the reducer but leaves every journal primitive silent', () => {
    const { hook } = useHarness();

    hook.emitRunEngineEvent({ type: 'ACCUMULATED_UPDATED', timestamp: 1 } as RunEngineEvent);

    expect(runEngineLib.runEngineReducer).toHaveBeenCalledTimes(1);
    expect(runJournal.createJournalEntry).not.toHaveBeenCalled();
    expect(runJournal.updateJournalPhase).not.toHaveBeenCalled();
    expect(runJournal.finalizeJournalEntry).not.toHaveBeenCalled();
    expect(runJournal.saveJournalEntry).not.toHaveBeenCalled();
  });
});

describe('useRunEngine — RUN_STARTED', () => {
  it('creates the journal entry, seeds verification state, and persists', () => {
    const { hook, getVerificationStateForChat } = useHarness();
    const verification = makeVerificationState();
    getVerificationStateForChat.mockReturnValueOnce(verification);

    hook.emitRunEngineEvent(runStartedEvent());

    expect(runJournal.createJournalEntry).toHaveBeenCalledTimes(1);
    expect(runJournal.createJournalEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        chatId: 'chat-1',
        provider: 'openai',
        model: 'gpt-4',
        baseMessageCount: 0,
        startedAt: 1,
      }),
    );
    expect(getVerificationStateForChat).toHaveBeenCalledWith('chat-1');
    expect(runJournal.updateJournalVerificationState).toHaveBeenCalledTimes(1);
    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
    expect(hook.runJournalEntryRef.current).not.toBeNull();
  });
});

describe('useRunEngine — ROUND_STARTED', () => {
  it('updates the journal phase + round and persists when a journal entry exists', () => {
    const { hook } = useHarness();
    hook.emitRunEngineEvent(runStartedEvent());
    runJournal.saveJournalEntry.mockClear();
    runJournal.updateJournalPhase.mockClear();

    hook.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: 2, round: 3 } as RunEngineEvent);

    expect(runJournal.updateJournalPhase).toHaveBeenCalledTimes(1);
    const [, phase, round] = runJournal.updateJournalPhase.mock.calls[0];
    // engineState.phase comes from the mocked reducer's return value.
    expect(phase).toBe('phase-for-ROUND_STARTED');
    expect(round).toBe(3);
    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no journal entry is active', () => {
    const { hook } = useHarness();

    hook.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: 1, round: 1 } as RunEngineEvent);

    expect(runJournal.updateJournalPhase).not.toHaveBeenCalled();
    expect(runJournal.saveJournalEntry).not.toHaveBeenCalled();
  });
});

describe('useRunEngine — LOOP_COMPLETED / LOOP_ABORTED / LOOP_FAILED', () => {
  it('LOOP_COMPLETED finalizes with completed, persists with prune, and nulls the ref', () => {
    const { hook } = useHarness();
    hook.emitRunEngineEvent(runStartedEvent());
    runJournal.saveJournalEntry.mockClear();

    hook.emitRunEngineEvent({ type: 'LOOP_COMPLETED', timestamp: 2 } as RunEngineEvent);

    expect(runJournal.finalizeJournalEntry).toHaveBeenCalledTimes(1);
    expect(runJournal.finalizeJournalEntry.mock.calls[0][1]).toBe('completed');
    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
    expect(runJournal.pruneJournalEntries).toHaveBeenCalledTimes(1);
    expect(hook.runJournalEntryRef.current).toBeNull();
  });

  it('LOOP_ABORTED finalizes with aborted, persists with prune, and nulls the ref', () => {
    const { hook } = useHarness();
    hook.emitRunEngineEvent(runStartedEvent());

    hook.emitRunEngineEvent({ type: 'LOOP_ABORTED', timestamp: 2 } as RunEngineEvent);

    expect(runJournal.finalizeJournalEntry.mock.calls[0][1]).toBe('aborted');
    expect(runJournal.pruneJournalEntries).toHaveBeenCalledTimes(1);
    expect(hook.runJournalEntryRef.current).toBeNull();
  });

  it('LOOP_FAILED finalizes with failed + reason, persists with prune, and nulls the ref', () => {
    const { hook } = useHarness();
    hook.emitRunEngineEvent(runStartedEvent());

    hook.emitRunEngineEvent({
      type: 'LOOP_FAILED',
      timestamp: 2,
      reason: 'oom',
    } as unknown as RunEngineEvent);

    const [, status, reason] = runJournal.finalizeJournalEntry.mock.calls[0];
    expect(status).toBe('failed');
    expect(reason).toBe('oom');
    expect(runJournal.pruneJournalEntries).toHaveBeenCalledTimes(1);
    expect(hook.runJournalEntryRef.current).toBeNull();
  });

  it('LOOP_* events are no-ops when there is no active journal entry', () => {
    const { hook } = useHarness();

    hook.emitRunEngineEvent({ type: 'LOOP_COMPLETED', timestamp: 1 } as RunEngineEvent);
    hook.emitRunEngineEvent({ type: 'LOOP_ABORTED', timestamp: 1 } as RunEngineEvent);
    hook.emitRunEngineEvent({
      type: 'LOOP_FAILED',
      timestamp: 1,
      reason: 'x',
    } as unknown as RunEngineEvent);

    expect(runJournal.finalizeJournalEntry).not.toHaveBeenCalled();
    expect(runJournal.pruneJournalEntries).not.toHaveBeenCalled();
  });
});

describe('useRunEngine — default branch', () => {
  it('default events update journal phase + round from engine state when journal exists', () => {
    const { hook } = useHarness();
    hook.emitRunEngineEvent(runStartedEvent());
    runJournal.updateJournalPhase.mockClear();
    runJournal.saveJournalEntry.mockClear();

    hook.emitRunEngineEvent({
      type: 'FOLLOW_UP_QUEUE_CLEARED',
      timestamp: 2,
    } as unknown as RunEngineEvent);

    expect(runJournal.updateJournalPhase).toHaveBeenCalledTimes(1);
    const [, phase, round] = runJournal.updateJournalPhase.mock.calls[0];
    expect(phase).toBe('phase-for-FOLLOW_UP_QUEUE_CLEARED');
    expect(round).toBe(1);
    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
    expect(hook.runJournalEntryRef.current).not.toBeNull();
  });

  it('default events with null journal ref leave primitives silent', () => {
    const { hook } = useHarness();

    hook.emitRunEngineEvent({
      type: 'FOLLOW_UP_QUEUE_CLEARED',
      timestamp: 1,
    } as unknown as RunEngineEvent);

    expect(runJournal.updateJournalPhase).not.toHaveBeenCalled();
    expect(runJournal.saveJournalEntry).not.toHaveBeenCalled();
  });
});

describe('useRunEngine — persistRunJournal', () => {
  it('no-ops when entry is null', () => {
    const { hook } = useHarness();

    hook.persistRunJournal(null);

    expect(runJournal.saveJournalEntry).not.toHaveBeenCalled();
    expect(runJournal.pruneJournalEntries).not.toHaveBeenCalled();
  });

  it('calls saveJournalEntry, skips pruning by default', () => {
    const { hook } = useHarness();
    const entry = primeJournal({ id: 'j-1' } as unknown as RunJournalEntry);

    hook.persistRunJournal(entry);

    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
    expect(runJournal.pruneJournalEntries).not.toHaveBeenCalled();
  });

  it('prunes when options.prune is true', () => {
    const { hook } = useHarness();
    const entry = primeJournal({ id: 'j-1' } as unknown as RunJournalEntry);

    hook.persistRunJournal(entry, { prune: true });

    expect(runJournal.saveJournalEntry).toHaveBeenCalledTimes(1);
    expect(runJournal.pruneJournalEntries).toHaveBeenCalledTimes(1);
  });
});
