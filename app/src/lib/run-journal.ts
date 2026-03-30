/**
 * run-journal.ts
 *
 * Unified local run journal for Track B of the Harness Runtime Evolution Plan.
 *
 * Provides one local persistence model for run lifecycle state: each run gets
 * a single journal entry that captures identity, lifecycle markers, persisted
 * events, and outcome. Resume, console reconstruction, and diagnostics can
 * read from this one shape instead of stitching together multiple ad hoc stores.
 *
 * Design rules:
 *   - One entry per run (keyed by runId), indexed by chatId and startedAt.
 *   - Events are append-only within a run.
 *   - The journal does NOT store every token delta — the live-vs-persisted
 *     split stays. Only lifecycle and persisted events land here.
 *   - Entries are trimmed by age/count to prevent unbounded growth.
 */

import { STORE, put, get, withStore } from './app-db';
import type { RunEvent } from '@/types';
import type { RunEnginePhase } from './run-engine';

// ---------------------------------------------------------------------------
// Journal entry schema
// ---------------------------------------------------------------------------

/**
 * Outcome of a completed run. Mirrors terminal RunEnginePhase values
 * but as a simpler enum for journal queries.
 */
export type RunOutcome = 'completed' | 'aborted' | 'failed';

/**
 * A single run journal entry — the authoritative record of what happened
 * during one sendMessage loop invocation.
 */
export interface RunJournalEntry {
  // --- Identity ---
  runId: string;
  chatId: string;
  provider: string;
  model: string;

  // --- Lifecycle ---
  startedAt: number;
  endedAt: number | null;
  lastPhase: RunEnginePhase;
  totalRounds: number;

  // --- Outcome ---
  outcome: RunOutcome | null;
  failureReason: string | null;

  // --- Events ---
  /** Persisted run events (same shape as ConversationRunState.runEvents). */
  events: RunEvent[];

  // --- Checkpoint snapshot ---
  /** Whether a checkpoint was active when this entry was last updated. */
  hadCheckpoint: boolean;
  /** Base message count at run start (for resume context). */
  baseMessageCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum events per journal entry before trimming oldest. */
const MAX_EVENTS_PER_ENTRY = 200;

/** Maximum journal entries to keep (oldest by startedAt are pruned). */
const MAX_JOURNAL_ENTRIES = 100;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new journal entry for a run that is starting.
 */
export function createJournalEntry(params: {
  runId: string;
  chatId: string;
  provider: string;
  model: string;
  baseMessageCount: number;
  startedAt: number;
}): RunJournalEntry {
  return {
    runId: params.runId,
    chatId: params.chatId,
    provider: params.provider,
    model: params.model,
    startedAt: params.startedAt,
    endedAt: null,
    lastPhase: 'starting',
    totalRounds: 0,
    outcome: null,
    failureReason: null,
    events: [],
    hadCheckpoint: false,
    baseMessageCount: params.baseMessageCount,
  };
}

// ---------------------------------------------------------------------------
// Mutations (pure — return new entry, caller persists)
// ---------------------------------------------------------------------------

/**
 * Append a persisted event to the journal entry.
 * Trims oldest events if the entry exceeds MAX_EVENTS_PER_ENTRY.
 */
export function appendJournalEvent(
  entry: RunJournalEntry,
  event: RunEvent,
): RunJournalEntry {
  const events = [...entry.events, event];
  if (events.length > MAX_EVENTS_PER_ENTRY) {
    events.splice(0, events.length - MAX_EVENTS_PER_ENTRY);
  }
  return { ...entry, events };
}

/**
 * Update the journal entry's lifecycle state.
 */
export function updateJournalPhase(
  entry: RunJournalEntry,
  phase: RunEnginePhase,
  round: number,
): RunJournalEntry {
  return {
    ...entry,
    lastPhase: phase,
    totalRounds: Math.max(entry.totalRounds, round + 1),
  };
}

/**
 * Finalize the journal entry with an outcome.
 */
export function finalizeJournalEntry(
  entry: RunJournalEntry,
  outcome: RunOutcome,
  failureReason?: string,
): RunJournalEntry {
  const terminalPhase: RunEnginePhase =
    outcome === 'completed' ? 'completed'
      : outcome === 'aborted' ? 'aborted'
        : 'failed';

  return {
    ...entry,
    endedAt: Date.now(),
    lastPhase: terminalPhase,
    outcome,
    failureReason: failureReason ?? null,
  };
}

/**
 * Mark whether a checkpoint was active.
 */
export function markJournalCheckpoint(
  entry: RunJournalEntry,
  hadCheckpoint: boolean,
): RunJournalEntry {
  return { ...entry, hadCheckpoint };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save a journal entry to IndexedDB.
 * Fire-and-forget — callers should not await this on the hot path.
 */
export async function saveJournalEntry(entry: RunJournalEntry): Promise<void> {
  try {
    await put(STORE.runJournal, entry);
  } catch (err) {
    console.warn('[RunJournal] Failed to save entry', entry.runId, err);
  }
}

/**
 * Load a journal entry by runId.
 */
export async function loadJournalEntry(runId: string): Promise<RunJournalEntry | undefined> {
  try {
    return await get<RunJournalEntry>(STORE.runJournal, runId);
  } catch (err) {
    console.warn('[RunJournal] Failed to load entry', runId, err);
    return undefined;
  }
}

/**
 * Load all journal entries for a specific chat, ordered by startedAt descending.
 */
export async function loadJournalEntriesForChat(chatId: string): Promise<RunJournalEntry[]> {
  try {
    return await withStore<RunJournalEntry[]>(
      STORE.runJournal,
      'readonly',
      (store) => {
        const index = store.index('chatId');
        return index.getAll(chatId);
      },
    ).then((entries) =>
      entries.sort((a, b) => b.startedAt - a.startedAt),
    );
  } catch (err) {
    console.warn('[RunJournal] Failed to load entries for chat', chatId, err);
    return [];
  }
}

/**
 * Prune old journal entries to keep the store bounded.
 * Keeps the newest MAX_JOURNAL_ENTRIES entries by startedAt.
 */
export async function pruneJournalEntries(): Promise<number> {
  try {
    const allEntries = await withStore<RunJournalEntry[]>(
      STORE.runJournal,
      'readonly',
      (store) => store.getAll(),
    );

    if (allEntries.length <= MAX_JOURNAL_ENTRIES) return 0;

    // Sort oldest first
    allEntries.sort((a, b) => a.startedAt - b.startedAt);
    const toRemove = allEntries.slice(0, allEntries.length - MAX_JOURNAL_ENTRIES);

    await withStore<IDBRequest<number>>(
      STORE.runJournal,
      'readwrite',
      (store) => {
        for (const entry of toRemove) {
          store.delete(entry.runId);
        }
        // Return a dummy request — the transaction completion is what matters
        return store.count();
      },
    );

    return toRemove.length;
  } catch (err) {
    console.warn('[RunJournal] Failed to prune entries', err);
    return 0;
  }
}
