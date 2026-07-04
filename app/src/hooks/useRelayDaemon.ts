/**
 * useRelayDaemon — React hook that owns the lifecycle of one
 * relay-WS adapter.
 *
 * Architecture: status-driven reconnect reducer + timer effect. URL + bearer
 * come from a `RelayBinding`.
 *
 *   - `relay_replay_unavailable`: the chat-screen consumer wants a
 *     transient signal (mode chip amber flash) but no banner. The
 *     hook surfaces `replayUnavailableAt` — a `Date.now()` ms
 *     timestamp that flips on every event, so the UI can render an
 *     "amber for 3s" effect by comparing against now. Cleared on
 *     successful reconnect.
 *
 *   - lastSeq plumbing: the hook tracks the highest `seq` seen on
 *     incoming events so a reconnect's `relay_attach` envelope
 *     resumes from the right point. The reducer reads it from a
 *     ref so the connection effect doesn't re-fire on every event.
 *
 * The reconnect ladder is [1s, 2s, 4s, 8s, 16s, 30s] with cap 6. A future PR
 * may make it more mobile-network-specific if real phone testing asks for it.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type ConnectionStatus,
  type LocalDaemonBinding,
  type RequestOptions,
  type SessionEvent,
  type SessionResponse,
} from '@/lib/local-daemon-binding';
import { type AttachResult, createRelayDaemonBinding } from '@/lib/relay-daemon-binding';
import { shouldNudgeReconnect, subscribeReconnectNudges } from '@/lib/reconnect-nudge';
import { parseSessionSnapshot, type DaemonSessionSnapshot } from '@/lib/daemon-snapshot';
import type { LiveDaemonBinding } from '@/lib/local-daemon-sandbox-client';
import type { RelayBinding } from '@/types';
import { isTranscriptMutationEvent } from '@push/lib/session-transcript-events';

const EVENT_LOG_CAP = 50;

/** Relay reconnect backoff ladder. */
export const RELAY_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
export const RELAY_RECONNECT_MAX_ATTEMPTS = 6;

const CLIENT_INITIATED_CLOSE_CODE = 1000;

type ReconnectAction =
  | { type: 'STATUS_OPEN' }
  | { type: 'STATUS_DROPPED'; cap: number; schedule: readonly number[]; now: number }
  | { type: 'MANUAL_RESET' };

export interface ReconnectInfo {
  attempts: number;
  nextAttemptAt: number | null;
  exhausted: boolean;
  maxAttempts: number;
}

export interface UseRelayDaemonResult {
  status: ConnectionStatus;
  events: SessionEvent[];
  request: <T = unknown>(opts: RequestOptions) => Promise<SessionResponse<T>>;
  /**
   * Live tool-dispatch binding bound to the long-lived relay WS this
   * hook owns. Mirror of `UseLocalDaemonResult.liveBinding` — null
   * until the WS reaches `open` for the first time; chat-layer
   * dispatch reuses the same `request` for every `sandbox_*` tool
   * call instead of opening a transient WS per call.
   */
  liveBinding: LiveDaemonBinding | null;
  /** Force-close and recreate the binding. Resets backoff. */
  reconnect: () => void;
  reconnectInfo: ReconnectInfo;
  /**
   * `Date.now()` ms when the relay last emitted
   * `relay_replay_unavailable`. Initial value is `null`; flips to a
   * fresh timestamp on every event. The chat-screen mode chip
   * compares this against now to render a brief amber flash.
   * Cleared on successful reconnect — old replay-unavailable signals
   * shouldn't lingering after the user has re-attached cleanly.
   */
  replayUnavailableAt: number | null;
  /**
   * Lifecycle of the targeted `attach_session` issued when the bundle
   * carries `targetSessionId` + `targetAttachToken` (PR #686). `idle`
   * for bundles with no target. `attaching` from WS-open until the
   * daemon ack arrives; flips to `attached` on success or
   * `attach_failed` on error. `attachError` carries the daemon error
   * code/message when failed so a banner can surface the cause
   * (`SESSION_NOT_FOUND` / `INVALID_TOKEN` / etc.) without forcing
   * a re-pair.
   */
  attachStatus: 'idle' | 'attaching' | 'attached' | 'attach_failed';
  attachError: { code: string; message: string } | null;
  /**
   * Conversation history fetched from the daemon's `state.messages`
   * after `attach_session` succeeds. Null until hydration completes;
   * one-shot — the hook does not re-fetch on subsequent reconnects.
   * `DaemonChatBody` projects this into `ChatMessage[]` and seeds the
   * conversation. Hydration failure is non-fatal: this stays null,
   * the chat works as a fresh Remote chat, but a console warn surfaces
   * the cause for ops triage.
   */
  hydratedMessages: DaemonHydratedMessage[] | null;
  /**
   * Live session state from the daemon's `get_session_snapshot`, fetched once on
   * attach alongside the transcript. Carries what the event stream already
   * passed before this client attached — most importantly a `pendingApproval`
   * the session is blocked on. Null until hydration completes (or on failure —
   * non-fatal, logged). `RelayChatScreen` installs the approval into the queue;
   * `state`/`branch`/`model` are available for display. One-shot per target.
   */
  sessionSnapshot: DaemonSessionSnapshot | null;
}

/** Shape returned by the daemon's `get_session_messages` RPC. */
export interface DaemonHydratedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface UseRelayDaemonOptions {
  reconnectKey?: number;
  onMalformed?: (raw: string, reason: string) => void;
  onEvent?: (event: SessionEvent) => void;
  /** Test seam: override backoff schedule. */
  backoffScheduleMs?: readonly number[];
  /** Test seam: override max-attempts cap. */
  maxReconnectAttempts?: number;
}

export function useRelayDaemon(
  binding: RelayBinding | null,
  options: UseRelayDaemonOptions = {},
): UseRelayDaemonResult {
  const effectiveMaxAttempts = options.maxReconnectAttempts ?? RELAY_RECONNECT_MAX_ATTEMPTS;
  const effectiveBackoffSchedule = options.backoffScheduleMs ?? RELAY_RECONNECT_BACKOFF_MS;

  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({ state: 'connecting' });
  const [wsEvents, setWsEvents] = useState<SessionEvent[]>([]);
  const [localReconnectKey, setLocalReconnectKey] = useState(0);
  const [replayUnavailableAt, setReplayUnavailableAt] = useState<number | null>(null);
  const [attachStatus, setAttachStatus] = useState<
    'idle' | 'attaching' | 'attached' | 'attach_failed'
  >('idle');
  const [attachError, setAttachError] = useState<{ code: string; message: string } | null>(null);
  const [hydratedMessages, setHydratedMessages] = useState<DaemonHydratedMessage[] | null>(null);
  const [sessionSnapshot, setSessionSnapshot] = useState<DaemonSessionSnapshot | null>(null);

  const reconnectReducer = useCallback(
    (prev: ReconnectInfo, action: ReconnectAction): ReconnectInfo => {
      switch (action.type) {
        case 'STATUS_OPEN':
          if (prev.attempts === 0 && !prev.exhausted && prev.nextAttemptAt === null) return prev;
          return {
            attempts: 0,
            nextAttemptAt: null,
            exhausted: false,
            maxAttempts: prev.maxAttempts,
          };
        case 'STATUS_DROPPED': {
          const cap = action.cap;
          if (prev.attempts >= cap) {
            if (prev.exhausted && prev.nextAttemptAt === null && prev.maxAttempts === cap) {
              return prev;
            }
            return { ...prev, nextAttemptAt: null, exhausted: true, maxAttempts: cap };
          }
          const schedule = action.schedule;
          const delayMs =
            schedule[Math.min(prev.attempts, schedule.length - 1)] ?? schedule[schedule.length - 1];
          return {
            attempts: prev.attempts + 1,
            nextAttemptAt: action.now + delayMs,
            exhausted: false,
            maxAttempts: cap,
          };
        }
        case 'MANUAL_RESET':
          return {
            attempts: 0,
            nextAttemptAt: null,
            exhausted: false,
            maxAttempts: prev.maxAttempts,
          };
      }
    },
    [],
  );
  const [reconnectInfo, dispatchReconnect] = useReducer(reconnectReducer, undefined, () => ({
    attempts: 0,
    nextAttemptAt: null,
    exhausted: false,
    maxAttempts: effectiveMaxAttempts,
  }));

  const bindingRef = useRef<LocalDaemonBinding | null>(null);
  const onMalformedRef = useRef(options.onMalformed);
  const onEventRef = useRef(options.onEvent);
  // lastSeq tracks the highest event seq we've seen on this hook
  // instance. The connection effect reads it on each new dial to
  // build the `relay_attach { lastSeq }` envelope — that's what
  // lets the DO replay buffered events instead of starting fresh
  // each reconnect.
  const lastSeqRef = useRef<number | null>(null);
  // Tracks the `targetSessionId` the current `hydratedMessages` belongs
  // to. The connection effect re-runs on every dial — including plain WS
  // reconnects (driven by `effectiveKey`) — but the transcript only goes
  // stale when the *target session* changes. Gating the clear on this ref
  // stops a mobile reconnect from blanking the history for a frame before
  // re-hydration repaints it (the #688 flicker). `undefined` is the
  // "never hydrated" sentinel so a genuine `null` target still clears.
  const hydratedTargetRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    onMalformedRef.current = options.onMalformed;
  }, [options.onMalformed]);
  useEffect(() => {
    onEventRef.current = options.onEvent;
  }, [options.onEvent]);

  const effectiveKey = (options.reconnectKey ?? 0) + localReconnectKey;
  const deploymentUrl = binding?.deploymentUrl ?? null;
  const sessionId = binding?.sessionId ?? null;
  const token = binding?.token ?? null;
  const targetSessionId = binding?.targetSessionId ?? null;
  const targetAttachToken = binding?.targetAttachToken ?? null;
  const hasTarget = targetSessionId !== null && targetAttachToken !== null;

  useEffect(() => {
    if (deploymentUrl === null || sessionId === null || token === null) {
      bindingRef.current = null;
      return;
    }
    // #530 Copilot review: createRelayDaemonBinding can throw
    // synchronously (invalid URL, loopback host without
    // allowAnyHost, etc.). A corrupted IndexedDB record OR a bad
    // bundle that somehow survived the pair flow would otherwise
    // crash the whole chat screen on mount. Wrap and route the
    // throw into a terminal `unreachable` so the ReconnectBanner
    // surfaces a recoverable Retry button.
    //
    // `cancelled` guards every async callback in this effect (attach
    // result + hydration response). A reconnect re-runs the effect,
    // closes the old binding, and would otherwise let in-flight RPC
    // responses on the disposed binding overwrite state on the
    // active one — github-actions review on #687.
    let cancelled = false;
    // Reset attach lifecycle on every new dial. `attaching` reflects
    // the moment we issue `attach_session` over the freshly-opened
    // WS; without a target the state stays `idle` for the binding's
    // lifetime. Defer via `queueMicrotask` so the setters don't run
    // synchronously inside the effect body — the
    // `react-hooks/set-state-in-effect` rule catches direct setState
    // here. Same pattern as the createRelayDaemonBinding throw path
    // a few lines below.
    queueMicrotask(() => {
      if (cancelled) return;
      setAttachStatus(hasTarget ? 'attaching' : 'idle');
      setAttachError(null);
      // Hydration is one-shot *per target session*. Clear it only when
      // the target actually changes (re-pair, unpair) so a stale
      // transcript can't leak into a different session — but NOT on a
      // plain reconnect to the same target, which previously blanked the
      // history for a frame on mobile (#688). The compare+update lives in
      // the microtask so a cancelled dial leaves the ref untouched and a
      // genuine target change that follows still triggers the clear.
      if (hydratedTargetRef.current !== targetSessionId) {
        setHydratedMessages(null);
        setSessionSnapshot(null);
        hydratedTargetRef.current = targetSessionId;
      }
    });
    // Refetch the daemon's user/assistant history and replace the local
    // copy. Called once on attach-complete (initial hydration) and again
    // whenever a transcript-mutation event (`session_revert` /
    // `session_unrevert` / `session_summarize`) tells us the daemon rewrote
    // `state.messages` out from under us — without the refetch the phone keeps
    // rendering the pre-mutation transcript. Reason-tagged so ops can tell an
    // initial-hydration miss from a resync miss.
    const hydrateTranscript = (reason: 'attach' | 'resync') => {
      const handle = bindingRef.current;
      if (!handle || targetSessionId === null || targetAttachToken === null) return;
      // `sessionId` lives in payload AND envelope — the daemon's
      // `handleGetSessionMessages` reads it from `req.payload` (same as
      // `handleAttachSession`); without the payload copy the call returns
      // `INVALID_REQUEST` — Codex P2 on #687.
      void handle
        .request<{ messages: DaemonHydratedMessage[] }>({
          type: 'get_session_messages',
          sessionId: targetSessionId,
          payload: {
            sessionId: targetSessionId,
            attachToken: targetAttachToken,
          },
          timeoutMs: 10_000,
        })
        .then((response) => {
          if (cancelled) return;
          if (response.ok && Array.isArray(response.payload?.messages)) {
            setHydratedMessages(response.payload.messages);
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          // Symmetric structured log so ops can distinguish a hydration miss
          // from an attach miss; the chat surface intentionally stays usable
          // on this path.
          console.warn(
            JSON.stringify({
              level: 'warn',
              event:
                reason === 'resync' ? 'relay_transcript_resync_failed' : 'relay_hydration_failed',
              reason: msg,
            }),
          );
        });
    };

    // Fetch the daemon's live session state once on attach: run/idle, active run,
    // and — the load-bearing bit — any approval the session is blocked on, which
    // the `approval_required` event already emitted before this client attached.
    // Non-fatal like transcript hydration: on failure the snapshot stays null and
    // the chat works, but a reattach to an approval-blocked session won't surface
    // the prompt until the next event. Reason-tagged for ops triage.
    const hydrateSnapshot = (reason: 'attach') => {
      const handle = bindingRef.current;
      if (!handle || targetSessionId === null || targetAttachToken === null) return;
      void handle
        .request<unknown>({
          type: 'get_session_snapshot',
          sessionId: targetSessionId,
          payload: {
            sessionId: targetSessionId,
            attachToken: targetAttachToken,
            recentEventLimit: 1,
          },
          timeoutMs: 10_000,
        })
        .then((response) => {
          if (cancelled) return;
          if (!response.ok) return;
          const parsed = parseSessionSnapshot(response.payload);
          if (parsed) setSessionSnapshot(parsed);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'relay_snapshot_hydration_failed',
              reason: err instanceof Error ? err.message : String(err),
              attachReason: reason,
            }),
          );
        });
    };

    let handle: ReturnType<typeof createRelayDaemonBinding>;
    try {
      handle = createRelayDaemonBinding({
        deploymentUrl,
        sessionId,
        token,
        ...(targetSessionId !== null ? { targetSessionId } : {}),
        ...(targetAttachToken !== null ? { targetAttachToken } : {}),
        lastSeq: lastSeqRef.current,
        onAttachComplete: (result: AttachResult) => {
          if (cancelled) return;
          if (result.ok) {
            setAttachStatus('attached');
            setAttachError(null);
            // Kick off transcript hydration so the phone shows the
            // TUI session's conversation history. Hydration failure
            // is non-fatal: the attach succeeded, the chat surface
            // works, but the user starts from an empty transcript.
            // Logged via console.warn so ops can spot the regression.
            hydrateTranscript('attach');
            // ...and the live session-state snapshot, so a reattach to a
            // mid-run / approval-blocked session renders the right pane.
            hydrateSnapshot('attach');
          } else {
            setAttachStatus('attach_failed');
            setAttachError({ code: result.error.code, message: result.error.message });
            // Attach failed — the target session was revoked, expired, or
            // dropped by the daemon. Since the same-target gate above no
            // longer clears the transcript on every dial, drop it here so
            // the attach-failed banner ("continue with a fresh Remote
            // chat") isn't shown alongside a stale prepended TUI history.
            // Reset the ref too so a later successful reattach re-hydrates.
            setHydratedMessages(null);
            setSessionSnapshot(null);
            hydratedTargetRef.current = undefined;
          }
        },
        onStatus: (next) => {
          setWsStatus(next);
          if (next.state === 'open') {
            // Successful reconnect — drop the lingering replay-
            // unavailable signal so the chip stops flashing amber.
            setReplayUnavailableAt(null);
          }
        },
        onEvent: (event) => {
          if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
            const current = lastSeqRef.current;
            if (current === null || event.seq > current) {
              lastSeqRef.current = event.seq;
            }
          }
          // The daemon rewrote `state.messages` (revert / unrevert /
          // summarize) — our hydrated copy is now stale, so refetch it.
          // Gated on `hasTarget` because untargeted Remote bundles never
          // hydrate a transcript and have nothing to resync.
          if (
            hasTarget &&
            typeof event.type === 'string' &&
            isTranscriptMutationEvent(event.type)
          ) {
            hydrateTranscript('resync');
          }
          setWsEvents((prev) => {
            const next =
              prev.length >= EVENT_LOG_CAP ? prev.slice(prev.length - EVENT_LOG_CAP + 1) : prev;
            return [...next, event];
          });
          try {
            onEventRef.current?.(event);
          } catch {
            // Consumer callbacks must not crash the relay binding.
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onReplayUnavailable: (_reason: string) => {
          // The chat-screen mode chip reads this timestamp to flash
          // amber for ~3s. The relay's reason string is intentionally
          // not surfaced — 2.f scope picked a lightweight signal
          // (chip flash) over a banner, so we drop the reason here.
          // Param signature kept to match the interface contract
          // (PR #530 Kilo review); `_`-prefix satisfies tsc's
          // noUnusedParameters, the eslint-disable handles the
          // `@typescript-eslint/no-unused-vars` rule which doesn't
          // honor the prefix in this repo's config.
          setReplayUnavailableAt(Date.now());
        },
        onMalformed: (raw, reason) => {
          onMalformedRef.current?.(raw, reason);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Defer the setState so it doesn't run synchronously inside
      // the effect body — `react-hooks/set-state-in-effect` flags
      // direct setState here. queueMicrotask lands the status
      // update on the next microtask, indistinguishable from
      // synchronous from the user's POV but satisfies the rule.
      queueMicrotask(() => {
        setWsStatus({ state: 'unreachable', code: 0, reason: message });
      });
      bindingRef.current = null;
      return;
    }
    bindingRef.current = handle;
    return () => {
      cancelled = true;
      bindingRef.current = null;
      handle.close();
    };
  }, [
    deploymentUrl,
    sessionId,
    token,
    targetSessionId,
    targetAttachToken,
    hasTarget,
    effectiveKey,
  ]);

  useEffect(() => {
    if (deploymentUrl === null || sessionId === null || token === null) return;
    if (wsStatus.state === 'connecting') return;
    if (wsStatus.state === 'open') {
      dispatchReconnect({ type: 'STATUS_OPEN' });
      return;
    }
    const isReconnectable =
      wsStatus.state === 'unreachable' ||
      (wsStatus.state === 'closed' && wsStatus.code !== CLIENT_INITIATED_CLOSE_CODE);
    if (!isReconnectable) return;
    dispatchReconnect({
      type: 'STATUS_DROPPED',
      cap: effectiveMaxAttempts,
      schedule: effectiveBackoffSchedule,
      now: Date.now(),
    });
  }, [wsStatus, deploymentUrl, sessionId, token, effectiveMaxAttempts, effectiveBackoffSchedule]);

  const nextAttemptAt = reconnectInfo.nextAttemptAt;
  useEffect(() => {
    if (nextAttemptAt === null) return;
    const remainingMs = Math.max(0, nextAttemptAt - Date.now());
    const timer = setTimeout(() => {
      setLocalReconnectKey((k) => k + 1);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [nextAttemptAt]);

  const status: ConnectionStatus =
    deploymentUrl === null || sessionId === null || token === null
      ? { state: 'closed', code: 0, reason: 'no binding' }
      : wsStatus;
  const events: SessionEvent[] =
    deploymentUrl === null || sessionId === null || token === null ? [] : wsEvents;

  const request = useCallback<UseRelayDaemonResult['request']>(<T>(opts: RequestOptions) => {
    const handle = bindingRef.current;
    if (!handle) {
      return Promise.reject(new Error('relay daemon not connected'));
    }
    return handle.request<T>(opts);
  }, []);

  const liveBinding = useMemo<LiveDaemonBinding | null>(() => {
    if (!binding) return null;
    if (wsStatus.state !== 'open') return null;
    return { params: binding, request };
  }, [binding, wsStatus.state, request]);

  const reconnect = useCallback(() => {
    dispatchReconnect({ type: 'MANUAL_RESET' });
    setLocalReconnectKey((k) => k + 1);
  }, []);

  // Environment "try now" nudge (GOpencode review #3): on network-restore /
  // app-foreground, collapse a pending backoff wait and reconnect now, but only
  // when parked in a dropped/exhausted state. Status read from a ref so
  // listeners bind once per binding rather than per status transition.
  const wsStatusRef = useRef(wsStatus);
  useEffect(() => {
    wsStatusRef.current = wsStatus;
  }, [wsStatus]);
  const nudgeReconnect = useCallback(() => {
    if (!shouldNudgeReconnect(wsStatusRef.current)) return;
    dispatchReconnect({ type: 'MANUAL_RESET' });
    setLocalReconnectKey((k) => k + 1);
    // Empty deps is intentional: this reads `wsStatusRef.current` (the
    // live mutable ref) rather than a captured `wsStatus` snapshot, so
    // the callback must stay referentially stable. Adding `wsStatus` (or
    // anything else) here would re-create it on every status transition,
    // which re-binds the env listeners below — and reading the ref makes
    // those deps unnecessary anyway. Do not add deps.
  }, []);
  useEffect(() => {
    if (deploymentUrl === null || sessionId === null || token === null) return;
    return subscribeReconnectNudges(nudgeReconnect);
  }, [deploymentUrl, sessionId, token, nudgeReconnect]);

  return {
    status,
    events,
    request,
    liveBinding,
    reconnect,
    reconnectInfo,
    replayUnavailableAt,
    attachStatus,
    attachError,
    hydratedMessages,
    sessionSnapshot,
  };
}
