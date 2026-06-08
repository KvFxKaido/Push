/**
 * useRemoteTurnProjection — render the live content of a turn another surface
 * (the TUI) is driving, on a relay-attached client.
 *
 * The daemon runs the agent turn server-side and **broadcasts** every event to
 * all attached clients (`cli/pushd.ts`: "Run in background — broadcast events to
 * all attached clients"), including the streaming `assistant_token` deltas. The
 * phone receives them but `useChat` only renders the web's *own* turns, so a
 * TUI-initiated turn arrives on the wire and is dropped. This hook projects
 * those broadcast tokens into a single streaming assistant message the
 * `DaemonChatBody` appends as a transcript tail — so you watch the turn stream
 * on your phone.
 *
 * Deliberately a **sibling** of `useChat`, not an injection into it: `useChat`
 * owns the web's own turns and is a guarded file; keeping the remote projection
 * separate (merged only at render time) avoids coupling the two transcript
 * producers.
 *
 * Stage 1 scope: assistant text only. Tool-call/result bubbles, reasoning
 * tokens, and the join-mid-turn prefix (tokens emitted before this client
 * attached aren't in the snapshot) are deferred — same shape as the
 * `hydratedMessages` transcript, which also carries role+content only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionEvent } from '@/lib/local-daemon-binding';
import type { ChatMessage } from '@/types';
import type { ReattachedRun } from './useDaemonRunState';

function remoteMessageId(runId: string): string {
  return `remote-${runId}`;
}

/**
 * Fold one broadcast event into the projected remote-turn message. Pure +
 * exported for testing. `nowMs` stamps the message on creation (an event-time
 * value, injected so tests are deterministic). Returns `prev` unchanged for
 * events that don't belong to `runId` or aren't part of a turn's text stream, so
 * the caller can treat it as an idempotent reducer.
 */
export function projectTurnEvent(
  prev: ChatMessage | null,
  event: SessionEvent,
  runId: string | null,
  nowMs: number,
): ChatMessage | null {
  if (!runId) return prev;
  // Broadcast events carry the run they belong to; ignore anything from a
  // different run (e.g. a sub-agent or a later run).
  if (event.runId && event.runId !== runId) return prev;
  const id = remoteMessageId(runId);

  if (event.type === 'assistant_token') {
    const text = (event.payload as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || text.length === 0) return prev;
    // A token for a different run id starts a fresh message (the prior run's
    // projection is stale), so accumulation never bleeds across runs.
    const base: ChatMessage =
      prev && prev.id === id
        ? prev
        : { id, role: 'assistant', content: '', timestamp: nowMs, status: 'streaming' };
    return { ...base, content: base.content + text, status: 'streaming' };
  }

  if (event.type === 'assistant_done' || event.type === 'run_complete') {
    return prev && prev.id === id ? { ...prev, status: 'done' } : prev;
  }

  return prev;
}

export interface RemoteTurnProjectionHandle {
  /**
   * The projected remote-turn message (streaming or, once finished, `done`).
   * Persists after the run completes — `run_complete` clears `reattachedRun` but
   * the streamed text must NOT vanish from the transcript. The consumer hides it
   * on local takeover; `reset()` drops it on a session/target change.
   */
  remoteMessage: ChatMessage | null;
  /** Wire into the daemon hook's `onEvent` to accumulate the broadcast stream. */
  handleDaemonEvent: (event: SessionEvent) => void;
  /** Drop the projection (the bound session is no longer valid). Idempotent. */
  reset: () => void;
}

/**
 * `reattachedRun` (from `useDaemonRunState`) is the run this client reattached
 * to but didn't start — the only turn we accumulate tokens for. When it's null
 * (the local user is driving, or the run finished) accumulation stops, but the
 * last message stays so a just-completed turn remains visible.
 */
export function useRemoteTurnProjection(
  reattachedRun: ReattachedRun | null,
): RemoteTurnProjectionHandle {
  const [message, setMessage] = useState<ChatMessage | null>(null);
  // Track the active run in a ref so the stable handleDaemonEvent reads the
  // current value without being re-created. Written in an effect (not render) to
  // satisfy the no-ref-writes-during-render rule; the brief render→commit gap is
  // immaterial since reattachedRun itself arrives via snapshot-hydration effects.
  const runIdRef = useRef<string | null>(reattachedRun?.runId ?? null);
  useEffect(() => {
    runIdRef.current = reattachedRun?.runId ?? null;
  }, [reattachedRun?.runId]);

  const handleDaemonEvent = useCallback((event: SessionEvent) => {
    setMessage((prev) => projectTurnEvent(prev, event, runIdRef.current, Date.now()));
  }, []);

  const reset = useCallback(() => {
    setMessage((prev) => (prev ? null : prev));
  }, []);

  return { remoteMessage: message, handleDaemonEvent, reset };
}
