import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { setConversationRunEvents } from '@/lib/chat-runtime-state';
import { shouldPersistRunEvent, trimRunEvents } from '@/lib/chat-run-events';
import {
  appendJournalEvent,
  loadJournalEntriesForChat,
  recordDelegationOutcome,
  saveJournalEntry,
  type RunJournalEntry,
} from '@/lib/run-journal';
import type { Conversation, RunEvent, RunEventInput } from '@/types';
import { createId } from './chat-persistence';

export interface UseRunEventStreamParams {
  activeChatId: string;
  activePersistedRunEventCount: number;
  runJournalEntryRef: React.MutableRefObject<RunJournalEntry | null>;
  updateConversations: (
    updater:
      | Record<string, Conversation>
      | ((prev: Record<string, Conversation>) => Record<string, Conversation>),
  ) => void;
  dirtyConversationIdsRef: React.MutableRefObject<Set<string>>;
  isMountedRef: React.MutableRefObject<boolean>;
}

export interface UseRunEventStreamResult {
  liveRunEventsByChat: Record<string, RunEvent[]>;
  journalRunEventsByChat: Record<string, RunEvent[]>;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
}

// Owns the run-event coordinators split across useChat: the live stream
// (trimmed, ephemeral), the journal stream (loaded lazily per chat), and
// the appendRunEvent routing that decides whether an event is live-only,
// persisted to the conversation, or additionally appended to the
// in-progress journal entry.
//
// `replaceLiveRunEvents` and `liveRunEventsByChatRef` are deliberately
// private: every mutation of live events routes through appendRunEvent,
// which is the only sanctioned entry point. Exposing the ref or the
// bulk-replace would create a second mutation path that bypasses the
// "trim + persist-routing" contract.
//
// `runJournalEntryRef` flows in as a param today because the run-engine
// cluster is not yet extracted. When Phase 3's useRunEngine lands, it
// will own that ref and hand it to this hook, keeping the seam explicit.
export function useRunEventStream({
  activeChatId,
  activePersistedRunEventCount,
  runJournalEntryRef,
  updateConversations,
  dirtyConversationIdsRef,
  isMountedRef,
}: UseRunEventStreamParams): UseRunEventStreamResult {
  const [liveRunEventsByChat, setLiveRunEventsByChat] = useState<Record<string, RunEvent[]>>({});
  const [journalRunEventsByChat, setJournalRunEventsByChat] = useState<Record<string, RunEvent[]>>(
    {},
  );

  // Ref kept current inside replaceLiveRunEvents (updated *before*
  // setState), so a render-time sync line would be redundant -- and would
  // trigger react-hooks/refs. Same shape as useQueuedFollowUps.
  const liveRunEventsByChatRef = useRef<Record<string, RunEvent[]>>({});

  const replaceLiveRunEvents = useCallback(
    (next: Record<string, RunEvent[]>) => {
      liveRunEventsByChatRef.current = next;
      if (isMountedRef.current) {
        setLiveRunEventsByChat(next);
      }
    },
    [isMountedRef],
  );

  const appendRunEvent = useCallback(
    (chatId: string, event: RunEventInput) => {
      const nextEvent: RunEvent = {
        id: createId(),
        timestamp: Date.now(),
        ...event,
      };

      // Track B: append persisted events to the in-progress journal
      // entry when one exists. `shouldPersistRunEvent` gates the branch
      // so ephemeral events (status chatter, etc.) never hit the journal.
      if (shouldPersistRunEvent(event) && runJournalEntryRef.current) {
        runJournalEntryRef.current = appendJournalEvent(runJournalEntryRef.current, nextEvent);
        if (event.type === 'subagent.completed' && event.delegationOutcome) {
          runJournalEntryRef.current = recordDelegationOutcome(
            runJournalEntryRef.current,
            event.delegationOutcome,
          );
        }
        void saveJournalEntry(runJournalEntryRef.current);
      }

      if (!shouldPersistRunEvent(event)) {
        replaceLiveRunEvents({
          ...liveRunEventsByChatRef.current,
          [chatId]: trimRunEvents([...(liveRunEventsByChatRef.current[chatId] || []), nextEvent]),
        });
        return;
      }

      updateConversations((prev) => {
        const conversation = prev[chatId];
        if (!conversation) return prev;
        const runEvents = conversation.runState?.runEvents || [];
        dirtyConversationIdsRef.current.add(chatId);
        return {
          ...prev,
          [chatId]: setConversationRunEvents(conversation, [...runEvents, nextEvent]),
        };
      });
    },
    [replaceLiveRunEvents, runJournalEntryRef, updateConversations, dirtyConversationIdsRef],
  );

  // Journal-load effect. When the active chat has no persisted runEvents
  // yet, lazily load the latest journal entry's events so the UI can
  // replay the most recent run after a page reload before the
  // conversation's runState is rebuilt. When persisted events exist the
  // journal slot is never read (useChat's runEvents useMemo short-circuits
  // persisted ?? journal ?? []), so no clear is needed -- the stale slot
  // is inert until this chat's count returns to zero, at which point the
  // load branch below refreshes it.
  useEffect(() => {
    if (!activeChatId) return;
    if (activePersistedRunEventCount > 0) return;

    let cancelled = false;
    void loadJournalEntriesForChat(activeChatId)
      .then((entries) => {
        if (cancelled) return;
        const latestEvents = entries[0]?.events ?? [];
        setJournalRunEventsByChat((prev) => {
          if (latestEvents.length === 0) {
            if (!prev[activeChatId]) return prev;
            const next = { ...prev };
            delete next[activeChatId];
            return next;
          }
          const existing = prev[activeChatId];
          if (
            existing?.length === latestEvents.length &&
            existing[existing.length - 1]?.id === latestEvents[latestEvents.length - 1]?.id
          ) {
            return prev;
          }
          return {
            ...prev,
            [activeChatId]: latestEvents,
          };
        });
      })
      .catch(() => {
        // Journal fallback is best-effort only.
      });

    return () => {
      cancelled = true;
    };
  }, [activeChatId, activePersistedRunEventCount]);

  return {
    liveRunEventsByChat,
    journalRunEventsByChat,
    appendRunEvent,
  };
}
