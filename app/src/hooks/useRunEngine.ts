import type React from 'react';
import { useCallback, useRef } from 'react';
import {
  IDLE_RUN_STATE,
  runEngineReducer,
  type RunEngineEvent,
  type RunEngineState,
} from '@/lib/run-engine';
import {
  createJournalEntry,
  finalizeJournalEntry,
  pruneJournalEntries,
  saveJournalEntry,
  updateJournalPhase,
  updateJournalVerificationState,
  type RunJournalEntry,
} from '@/lib/run-journal';
import type { VerificationRuntimeState } from '@/types';

export interface UseRunEngineParams {
  getVerificationStateForChat: (chatId: string) => VerificationRuntimeState;
}

export interface UseRunEngineResult {
  runEngineStateRef: React.MutableRefObject<RunEngineState>;
  runJournalEntryRef: React.MutableRefObject<RunJournalEntry | null>;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  persistRunJournal: (entry: RunJournalEntry | null, options?: { prune?: boolean }) => void;
}

// Owns the run-engine coordinator split across useChat: the engine
// reducer's stateful ref (Track A) and the journal lifecycle side
// effects (Track B). emitRunEngineEvent is the single mutation path for
// run state; every caller in sendMessage / abortStream / useAgentDelegation
// / useChatCheckpoint routes through it.
//
// persistRunJournal is intentionally exposed (not internal) because
// sendMessage's tool-start checkpoint marker and useChat's
// persistVerificationState (Phase 4 territory) both call it directly.
// Folding those into emitRunEngineEvent would be a behavior change in
// a high-risk phase -- deferred.
//
// runEngineStateRef and runJournalEntryRef are exposed because seven
// external sites read or mutate them. Hiding the refs would force
// large call-site rewrites for no structural gain.
export function useRunEngine({
  getVerificationStateForChat,
}: UseRunEngineParams): UseRunEngineResult {
  const runEngineStateRef = useRef<RunEngineState>(IDLE_RUN_STATE);
  const runJournalEntryRef = useRef<RunJournalEntry | null>(null);

  const persistRunJournal = useCallback(
    (entry: RunJournalEntry | null, options?: { prune?: boolean }) => {
      if (!entry) return;
      void saveJournalEntry(entry);
      if (options?.prune) {
        void pruneJournalEntries();
      }
    },
    [],
  );

  // Emit a run engine event -- the single mutation path for run state.
  //
  // Track A (reducer) always runs first and is authoritative for engine
  // state. Track B (journal lifecycle) dispatches on event.type:
  //
  //   RUN_STARTED     -> create entry, seed verification state, persist.
  //   ROUND_STARTED   -> update phase from engine state, persist.
  //   LOOP_COMPLETED  -> finalize 'completed', persist w/ prune, null ref.
  //   LOOP_ABORTED    -> finalize 'aborted',  persist w/ prune, null ref.
  //   LOOP_FAILED     -> finalize 'failed' + reason, persist w/ prune, null ref.
  //   ACCUMULATED_UPDATED -> reducer only; journal untouched (hot-path
  //                          optimization -- this event fires on every
  //                          streamed token).
  //   default         -> update phase + round from engine state, persist
  //                      (only when a journal entry exists).
  const emitRunEngineEvent = useCallback(
    (event: RunEngineEvent) => {
      runEngineStateRef.current = runEngineReducer(runEngineStateRef.current, event);

      const engineState = runEngineStateRef.current;
      switch (event.type) {
        case 'RUN_STARTED':
          runJournalEntryRef.current = createJournalEntry({
            runId: event.runId,
            chatId: event.chatId,
            provider: event.provider,
            model: event.model,
            baseMessageCount: event.baseMessageCount,
            startedAt: event.timestamp,
          });
          runJournalEntryRef.current = updateJournalVerificationState(
            runJournalEntryRef.current,
            getVerificationStateForChat(event.chatId),
          );
          persistRunJournal(runJournalEntryRef.current);
          break;

        case 'ROUND_STARTED':
          if (runJournalEntryRef.current) {
            runJournalEntryRef.current = updateJournalPhase(
              runJournalEntryRef.current,
              engineState.phase,
              event.round,
            );
            persistRunJournal(runJournalEntryRef.current);
          }
          break;

        case 'LOOP_COMPLETED':
          if (runJournalEntryRef.current) {
            runJournalEntryRef.current = finalizeJournalEntry(
              runJournalEntryRef.current,
              'completed',
            );
            persistRunJournal(runJournalEntryRef.current, { prune: true });
            runJournalEntryRef.current = null;
          }
          break;

        case 'LOOP_ABORTED':
          if (runJournalEntryRef.current) {
            runJournalEntryRef.current = finalizeJournalEntry(
              runJournalEntryRef.current,
              'aborted',
            );
            persistRunJournal(runJournalEntryRef.current, { prune: true });
            runJournalEntryRef.current = null;
          }
          break;

        case 'LOOP_FAILED':
          if (runJournalEntryRef.current) {
            runJournalEntryRef.current = finalizeJournalEntry(
              runJournalEntryRef.current,
              'failed',
              event.reason,
            );
            persistRunJournal(runJournalEntryRef.current, { prune: true });
            runJournalEntryRef.current = null;
          }
          break;

        case 'ACCUMULATED_UPDATED':
          break;

        default:
          if (runJournalEntryRef.current) {
            runJournalEntryRef.current = updateJournalPhase(
              runJournalEntryRef.current,
              engineState.phase,
              engineState.round,
            );
            persistRunJournal(runJournalEntryRef.current);
          }
          break;
      }
    },
    [getVerificationStateForChat, persistRunJournal],
  );

  return {
    runEngineStateRef,
    runJournalEntryRef,
    emitRunEngineEvent,
    persistRunJournal,
  };
}
