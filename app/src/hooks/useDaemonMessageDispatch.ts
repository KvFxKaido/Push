/**
 * useDaemonMessageDispatch — send a Remote-surface chat message through the
 * daemon's own round loop instead of the browser's local `streamChat`.
 *
 * `DaemonChatBody` sends through the generic `useChat`, which always
 * generates locally via `getActiveProvider()` — the browser's own provider
 * setting, unrelated to the daemon session's `provider`/`model` the picker
 * shows (`useDaemonSessionModel`). The daemon's `handleSendUserMessage`
 * already runs the full `runAssistantTurn` kernel server-side using the
 * session's own provider and broadcasts every event to all attached clients
 * — the same mechanism `useRemoteTurnProjection` already renders for a
 * TUI-driven turn. This hook is the other half: dispatch the send here, then
 * feed the ack's `runId` into `useDaemonRunState.startRun` so the existing
 * projection renders it identically, regardless of who started it.
 *
 * The assistant side of the turn is covered entirely by
 * `useRemoteTurnProjection` once `startRun` is called — this hook only
 * covers the user's own prompt, which needs no broadcast round-trip since
 * the text is already known locally.
 *
 * Stage 1 scope: text only, matching `useRemoteTurnProjection`'s own
 * "assistant text only" scope — attachments still route through the local
 * `useChat` path (`send_user_message`'s payload has no attachment field).
 */
import { useCallback, useState } from 'react';

import type { RequestOptions, SessionResponse } from '@/lib/local-daemon-binding';
import type { ChatMessage } from '@/types';

function pendingMessageId(nowMs: number): string {
  return `daemon-pending-${nowMs}`;
}

/** Pure + exported for testing: build the optimistic echo bubble. */
export function makePendingUserMessage(text: string, nowMs: number): ChatMessage {
  return {
    id: pendingMessageId(nowMs),
    role: 'user',
    content: text,
    timestamp: nowMs,
    status: 'done',
  };
}

/** Pure + exported for testing: the `runId` from a `send_user_message` ack,
 *  or null if the response wasn't a usable success. */
export function parseSendUserMessageRunId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const runId = (payload as Record<string, unknown>).runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : null;
}

export interface DaemonMessageDispatchHandle {
  /** The user's own message, echoed immediately (no broadcast round-trip
   *  needed — the text is already known). Null once nothing is pending. */
  pendingUserMessage: ChatMessage | null;
  /** True while the `send_user_message` round-trip is in flight (before the
   *  ack lands and `startRun` fires). Distinct from the daemon's own "Running"
   *  state, which starts once the ack's `runId` is being watched. */
  sending: boolean;
  /** Dispatch `text` to the daemon. No-ops on blank text or a missing
   *  session id (mirrors `useChat.sendMessage`'s own empty-text guard). */
  send: (text: string) => Promise<void>;
  /** Set when the last `send` failed — surfaced so the composer can show it.
   *  Cleared at the start of the next `send`. */
  error: string | null;
  /** Drop the pending echo (a fresh snapshot superseded it, or the bound
   *  session changed). Idempotent. */
  reset: () => void;
}

export function useDaemonMessageDispatch(
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>,
  sessionId: string | null,
  attachToken: string | null,
  startRun: (runId: string, sessionId: string) => void,
): DaemonMessageDispatchHandle {
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId) return;
      const nowMs = Date.now();
      setError(null);
      setPendingUserMessage(makePendingUserMessage(trimmed, nowMs));
      setSending(true);
      try {
        const res = await request<unknown>({
          type: 'send_user_message',
          payload: {
            sessionId,
            text: trimmed,
            ...(attachToken ? { attachToken } : {}),
          },
          timeoutMs: 10_000,
        });
        if (!res.ok) throw new Error(res.error?.message || 'send_user_message failed');
        const runId = parseSendUserMessageRunId(res.payload);
        if (runId) startRun(runId, sessionId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'daemon_message_dispatch_failed',
            sessionId,
            error: message,
          }),
        );
        setError(message);
        setPendingUserMessage((prev) =>
          prev && prev.id === pendingMessageId(nowMs) ? { ...prev, status: 'error' } : prev,
        );
      } finally {
        setSending(false);
      }
    },
    [request, sessionId, attachToken, startRun],
  );

  const reset = useCallback(() => {
    setPendingUserMessage((prev) => (prev ? null : prev));
  }, []);

  return { pendingUserMessage, sending, send, error, reset };
}
