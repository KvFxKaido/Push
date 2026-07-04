/**
 * useCommittedDaemonTurns — accumulate finished daemon-dispatched turns so
 * they stay visible across sends.
 *
 * `useDaemonMessageDispatch`'s `pendingUserMessage` and
 * `useRemoteTurnProjection`'s `remoteTurnMessage` each hold exactly one
 * turn — the current one. The moment a new send starts, both get replaced
 * with the new turn's pair, and the previous one would vanish from the
 * transcript entirely (it never touched `useChat`'s `messages` — that's the
 * whole point of dispatching through the daemon). It only reappears once
 * the daemon session is reattached-to and `hydratedMessages` refetches
 * real history. Codex P2 on #1325: within one continuous connection, that's
 * a visible regression for a second send in the same sitting.
 *
 * `commit` graduates a settled pair here before that replacement can drop
 * it; `reset` clears it on a session/target change (a stale turn must not
 * bleed into a different session's transcript). Kept as its own hook (not
 * inline state in `DaemonChatBody`) because `react-hooks/set-state-in-effect`
 * flags a same-scope effect calling its own component's state setter, even
 * through a wrapper — the existing `clearApprovals`/`clearRunState`/
 * `resetRemoteTurn` calls in `RelayChatScreen` pass exactly because they're
 * opaque calls into a different hook's closure, not local state.
 */
import { useCallback, useState } from 'react';

import type { ChatMessage } from '@/types';

export interface CommittedDaemonTurnsHandle {
  /** Finished daemon-dispatched turns, oldest first — [user, assistant, user, assistant, ...]. */
  committedTurns: ChatMessage[];
  /** Graduate a settled [user, assistant] pair. Idempotent per assistant message id. */
  commit: (user: ChatMessage, assistant: ChatMessage) => void;
  /** Drop everything (a session/target change). Idempotent. */
  reset: () => void;
}

/** Pure + exported for testing: append a turn, deduped by the assistant
 *  message's id (a re-fired commit for the same settled turn is a no-op). */
export function appendDaemonTurn(
  prev: ChatMessage[],
  user: ChatMessage,
  assistant: ChatMessage,
): ChatMessage[] {
  return prev.some((m) => m.id === assistant.id) ? prev : [...prev, user, assistant];
}

export function useCommittedDaemonTurns(): CommittedDaemonTurnsHandle {
  const [committedTurns, setCommittedTurns] = useState<ChatMessage[]>([]);

  const commit = useCallback((user: ChatMessage, assistant: ChatMessage) => {
    setCommittedTurns((prev) => appendDaemonTurn(prev, user, assistant));
  }, []);

  const reset = useCallback(() => {
    setCommittedTurns((prev) => (prev.length > 0 ? [] : prev));
  }, []);

  return { committedTurns, commit, reset };
}
