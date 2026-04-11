/**
 * run-journal.test.ts
 *
 * Tests for the run journal module (Track B, Phase 2).
 *
 * Pure mutation functions are tested directly. IndexedDB persistence
 * is tested via the mock provided by the app-db module.
 */

import { describe, expect, it } from 'vitest';
import type { DelegationOutcome, RunEvent } from '@/types';
import {
  appendJournalEvent,
  createJournalEntry,
  finalizeJournalEntry,
  markJournalCheckpoint,
  recordDelegationOutcome,
  updateJournalPhase,
  type RunJournalEntry,
} from './run-journal';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RunJournalEntry> = {}): RunJournalEntry {
  return createJournalEntry({
    runId: 'run-1',
    chatId: 'chat-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    baseMessageCount: 2,
    startedAt: 1000,
    ...overrides,
  });
}

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: 'evt-1',
    timestamp: 2000,
    type: 'assistant.turn_end',
    round: 0,
    outcome: 'completed',
    ...overrides,
  } as RunEvent;
}

function makeDelegationOutcome(overrides: Partial<DelegationOutcome> = {}): DelegationOutcome {
  return {
    agent: 'coder',
    status: 'complete',
    summary: 'Implemented the requested change.',
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: null,
    rounds: 2,
    checkpoints: 0,
    elapsedMs: 2500,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run-journal', () => {
  // ─── createJournalEntry ───────────────────────────────────────────────

  it('creates a journal entry with correct initial values', () => {
    const entry = makeEntry();

    expect(entry.runId).toBe('run-1');
    expect(entry.chatId).toBe('chat-1');
    expect(entry.provider).toBe('anthropic');
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.startedAt).toBe(1000);
    expect(entry.endedAt).toBeNull();
    expect(entry.lastPhase).toBe('starting');
    expect(entry.totalRounds).toBe(0);
    expect(entry.outcome).toBeNull();
    expect(entry.failureReason).toBeNull();
    expect(entry.events).toEqual([]);
    expect(entry.hadCheckpoint).toBe(false);
    expect(entry.baseMessageCount).toBe(2);
    expect(entry.verificationState).toBeNull();
  });

  // ─── appendJournalEvent ──────────────────────────────────────────────

  it('appends events to the journal entry', () => {
    const entry = makeEntry();
    const event = makeEvent();

    const updated = appendJournalEvent(entry, event);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]).toBe(event);
    // Original is not mutated
    expect(entry.events).toHaveLength(0);
  });

  it('trims oldest events when exceeding max (200)', () => {
    let entry = makeEntry();

    // Append 205 events
    for (let i = 0; i < 205; i++) {
      entry = appendJournalEvent(entry, makeEvent({ id: `evt-${i}`, timestamp: 1000 + i }));
    }

    expect(entry.events).toHaveLength(200);
    // First event should be evt-5 (0-4 were trimmed)
    expect(entry.events[0].id).toBe('evt-5');
    expect(entry.events[199].id).toBe('evt-204');
  });

  // ─── updateJournalPhase ──────────────────────────────────────────────

  it('updates phase and tracks max round count', () => {
    const entry = makeEntry();

    const r0 = updateJournalPhase(entry, 'streaming_llm', 0);
    expect(r0.lastPhase).toBe('streaming_llm');
    expect(r0.totalRounds).toBe(1);

    const r1 = updateJournalPhase(r0, 'executing_tools', 0);
    expect(r1.lastPhase).toBe('executing_tools');
    expect(r1.totalRounds).toBe(1); // same round, no increase

    const r2 = updateJournalPhase(r1, 'streaming_llm', 1);
    expect(r2.lastPhase).toBe('streaming_llm');
    expect(r2.totalRounds).toBe(2);
  });

  it('never decreases totalRounds', () => {
    let entry = makeEntry();
    entry = updateJournalPhase(entry, 'streaming_llm', 5);
    expect(entry.totalRounds).toBe(6);

    // Calling with a lower round doesn't decrease
    entry = updateJournalPhase(entry, 'executing_tools', 2);
    expect(entry.totalRounds).toBe(6);
  });

  // ─── finalizeJournalEntry ────────────────────────────────────────────

  it('finalizes with completed outcome', () => {
    const entry = makeEntry();
    const finalized = finalizeJournalEntry(entry, 'completed');

    expect(finalized.outcome).toBe('completed');
    expect(finalized.lastPhase).toBe('completed');
    expect(finalized.endedAt).toBeGreaterThan(0);
    expect(finalized.failureReason).toBeNull();
  });

  it('finalizes with aborted outcome', () => {
    const entry = makeEntry();
    const finalized = finalizeJournalEntry(entry, 'aborted');

    expect(finalized.outcome).toBe('aborted');
    expect(finalized.lastPhase).toBe('aborted');
    expect(finalized.endedAt).toBeGreaterThan(0);
  });

  it('finalizes with failed outcome and reason', () => {
    const entry = makeEntry();
    const finalized = finalizeJournalEntry(entry, 'failed', 'network_error');

    expect(finalized.outcome).toBe('failed');
    expect(finalized.lastPhase).toBe('failed');
    expect(finalized.failureReason).toBe('network_error');
    expect(finalized.endedAt).toBeGreaterThan(0);
  });

  // ─── markJournalCheckpoint ───────────────────────────────────────────

  it('marks checkpoint state', () => {
    const entry = makeEntry();
    expect(entry.hadCheckpoint).toBe(false);

    const marked = markJournalCheckpoint(entry, true);
    expect(marked.hadCheckpoint).toBe(true);

    const unmarked = markJournalCheckpoint(marked, false);
    expect(unmarked.hadCheckpoint).toBe(false);
  });

  it('records the latest structured delegation outcome', () => {
    const entry = makeEntry();
    const outcome = makeDelegationOutcome();

    const updated = recordDelegationOutcome(entry, outcome);

    expect(updated.delegationOutcome).toEqual(outcome);
    expect(entry.delegationOutcome).toBeNull();
  });

  // ─── Immutability ────────────────────────────────────────────────────

  it('all mutations return new objects without modifying originals', () => {
    const original = makeEntry();
    const event = makeEvent();

    const afterAppend = appendJournalEvent(original, event);
    const afterPhase = updateJournalPhase(original, 'streaming_llm', 0);
    const afterFinalize = finalizeJournalEntry(original, 'completed');
    const afterCheckpoint = markJournalCheckpoint(original, true);
    const afterDelegationOutcome = recordDelegationOutcome(original, makeDelegationOutcome());

    // Original is unchanged
    expect(original.events).toHaveLength(0);
    expect(original.lastPhase).toBe('starting');
    expect(original.outcome).toBeNull();
    expect(original.hadCheckpoint).toBe(false);

    // Each mutation produced a distinct object
    expect(afterAppend).not.toBe(original);
    expect(afterPhase).not.toBe(original);
    expect(afterFinalize).not.toBe(original);
    expect(afterCheckpoint).not.toBe(original);
    expect(afterDelegationOutcome).not.toBe(original);
  });

  // ─── Full lifecycle replay ───────────────────────────────────────────

  it('replays a full run lifecycle through journal mutations', () => {
    let entry = createJournalEntry({
      runId: 'run-lifecycle',
      chatId: 'chat-lifecycle',
      provider: 'zen',
      model: 'claude-sonnet-4-6',
      baseMessageCount: 4,
      startedAt: 5000,
    });

    // Round 0
    entry = updateJournalPhase(entry, 'streaming_llm', 0);
    entry = appendJournalEvent(
      entry,
      makeEvent({
        id: 'e1',
        type: 'assistant.turn_end',
        round: 0,
        outcome: 'continued',
      }),
    );
    entry = updateJournalPhase(entry, 'executing_tools', 0);

    // Delegation
    entry = updateJournalPhase(entry, 'delegating_coder', 0);
    entry = appendJournalEvent(
      entry,
      makeEvent({
        id: 'e2',
        type: 'subagent.started',
        timestamp: 5500,
      } as Partial<RunEvent>),
    );
    entry = appendJournalEvent(
      entry,
      makeEvent({
        id: 'e3',
        type: 'subagent.completed',
        timestamp: 6000,
      } as Partial<RunEvent>),
    );

    // Round 1
    entry = updateJournalPhase(entry, 'streaming_llm', 1);
    entry = appendJournalEvent(
      entry,
      makeEvent({
        id: 'e4',
        type: 'assistant.turn_end',
        round: 1,
        outcome: 'completed',
      }),
    );

    // Checkpoint was active
    entry = markJournalCheckpoint(entry, true);

    // Finalize
    entry = finalizeJournalEntry(entry, 'completed');

    expect(entry.runId).toBe('run-lifecycle');
    expect(entry.totalRounds).toBe(2);
    expect(entry.events).toHaveLength(4);
    expect(entry.outcome).toBe('completed');
    expect(entry.lastPhase).toBe('completed');
    expect(entry.hadCheckpoint).toBe(true);
    expect(entry.endedAt).toBeGreaterThan(entry.startedAt);
  });
});
