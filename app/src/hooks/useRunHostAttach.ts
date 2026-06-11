/**
 * useRunHostAttach.ts — Durable Runs Phase 3 attach/viewer coordinator.
 *
 * Owns the reopened-client lifecycle against the RunHost ledger:
 *
 *   - **Probe on open** — when a chat with a repo+branch scope becomes idle
 *     in this tab, ask the host whether its run lived on (adopted), is
 *     waiting (adoptable / paused at a gate), or finished server-side.
 *   - **Snapshot hydration** — fold the host's stored `RunCheckpointV1` into
 *     the local conversation: the transcript is complete across the gap, and
 *     the next send replays it (the wire history seeds from the
 *     conversation). The hydration anchor is the client's own last mirrored
 *     V1 checkpoint; after each hydration the host copy becomes the new
 *     anchor (`saveCheckpointV1`), so re-hydration is idempotent across
 *     remounts.
 *   - **Cursor-follow** — while the run is detached (adopted/adoptable) the
 *     hook polls `/run/attach` with the `savedAt` cursor; each fresher
 *     checkpoint appends the new rounds. Polls are read-only — they never
 *     heartbeat, so watching never resurrects the run.
 *   - **Controls** — approve/deny the paused gate (the host relaunches the
 *     loop with the decision), stop, and pull-back-local (hydrate → release
 *     → continue in-page via a reclaim note).
 *
 * Mounted from `useChatCheckpoint` (the checkpoint/resume lifecycle owner)
 * so it shares the same conversation-mutation and send seams the legacy
 * resume path uses. Fire-and-forget discipline: nothing here throws into
 * React, and every behavior-changing branch logs symmetrically
 * (`run_host_attach_hydrated` ↔ `_hydration_skipped`,
 * `run_host_attach_control_failed`, `run_host_attach_pulled_local`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  RUN_HOST_ATTACH_POLL_INTERVAL_MS,
  isCompleteScope,
  type RunHostScope,
  type RunLifecycleState,
} from '@push/lib/run-host-adoption';
import type { RunCheckpointV1 } from '@push/lib/run-checkpoint';
import type { Conversation } from '@/types';
import {
  fetchRunHostAttach,
  planTranscriptHydration,
  releaseRunHostRun,
  stopRunHostRun,
  submitRunHostApproval,
} from '@/lib/run-host-attach';
import { loadCheckpointV1, saveCheckpointV1 } from '@/lib/checkpoint-store';
import { clearRunCheckpoint } from '@/lib/checkpoint-manager';
import { isRunActive, type RunEngineState } from '@/lib/run-engine';

/** Marker on the user turn that pulls a hosted run back to this device. The
 * transcript above it already contains the server-side work (hydrated before
 * release), so the model continues rather than reconciling. */
export const RUN_RECLAIMED_NOTE =
  '[RUN_RECLAIMED] The user returned and pulled this run back to their device. The transcript ' +
  'above includes everything completed server-side while they were away. Continue the task from ' +
  'where it leaves off — normal interactive tools and approvals apply again.';

export interface HostRunAttachment {
  runId: string;
  state: RunLifecycleState;
  round: number;
  midFlight: boolean;
  pausedForApproval: {
    approvalId: string;
    kind: string;
    tool?: string;
    title?: string;
    summary?: string;
  } | null;
  lastError?: string;
  /** A control action is in flight — the banner disables its buttons. */
  busy: boolean;
}

export interface RunHostAttachHandle {
  hostRun: HostRunAttachment | null;
  approveHostGate: () => void;
  denyHostGate: () => void;
  stopHostRun: () => void;
  pullHostRunLocal: () => void;
  dismissHostRun: () => void;
}

export interface RunHostAttachParams {
  activeChatId: string;
  isStreaming: boolean;
  runEngineStateRef: MutableRefObject<RunEngineState>;
  repoRef: MutableRefObject<string | null>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  sendMessageRef: MutableRefObject<((text: string) => Promise<void>) | null>;
}

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...ctx });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function useRunHostAttach({
  activeChatId,
  isStreaming,
  runEngineStateRef,
  repoRef,
  branchInfoRef,
  setConversations,
  dirtyConversationIdsRef,
  sendMessageRef,
}: RunHostAttachParams): RunHostAttachHandle {
  const [hostRun, setHostRun] = useState<HostRunAttachment | null>(null);
  const hostRunRef = useRef<HostRunAttachment | null>(null);
  useEffect(() => {
    hostRunRef.current = hostRun;
  }, [hostRun]);

  /** Attach cursor per chat: the host `savedAt` already hydrated. Keyed by
   * runId too, so a superseding run restarts the cursor. */
  const cursorRef = useRef(new Map<string, { runId: string; savedAt: number }>());
  /** Runs the user dismissed — never re-surfaced this session. */
  const dismissedRef = useRef(new Set<string>());
  /** Serializes hydrations so overlapping polls can't double-append. */
  const hydrateQueueRef = useRef<Promise<void>>(Promise.resolve());
  /** NOT_CONFIGURED latch (the transport's stance): one log, then quiet. */
  const disabledRef = useRef(false);

  const scopeFor = useCallback(
    (chatId: string): RunHostScope | null => {
      const scope = {
        repoFullName: repoRef.current || '',
        branch: branchInfoRef.current?.currentBranch || branchInfoRef.current?.defaultBranch || '',
        chatId,
      };
      return isCompleteScope(scope) ? scope : null;
    },
    [branchInfoRef, repoRef],
  );

  const applyHydration = useCallback(
    (chatId: string, checkpoint: RunCheckpointV1): Promise<void> => {
      const run = async () => {
        const local = await loadCheckpointV1(chatId);
        const anchorCount =
          local && local.runId && local.runId === checkpoint.runId ? local.messages.length : 0;
        setConversations((prev) => {
          const conv = prev[chatId];
          if (!conv) {
            // No local conversation to fold into (e.g. a device that never
            // had this chat). Hydration needs a conversation home; creating
            // one from here is out of scope — log so the gap is visible.
            log('warn', 'run_host_attach_hydration_skipped', {
              chatId,
              reason: 'no_conversation',
            });
            return prev;
          }
          const plan = planTranscriptHydration({
            hostCheckpoint: checkpoint,
            anchorCount,
            localMessageCount: conv.messages.length,
          });
          if (!plan) return prev;
          log('info', 'run_host_attach_hydrated', {
            chatId,
            runId: checkpoint.runId ?? null,
            mode: plan.mode,
            messages: plan.messages.length,
            round: checkpoint.round,
          });
          dirtyConversationIdsRef.current.add(chatId);
          return {
            ...prev,
            [chatId]: {
              ...conv,
              messages:
                plan.mode === 'append' ? [...conv.messages, ...plan.messages] : plan.messages,
              lastMessageAt: Date.now(),
            },
          };
        });
        // The host copy becomes the next hydration anchor — idempotent
        // re-hydration across remounts. Best-effort like every V1 save.
        await saveCheckpointV1(checkpoint).catch(() => {});
      };
      const chained = hydrateQueueRef.current.then(run, run);
      hydrateQueueRef.current = chained;
      return chained;
    },
    [dirtyConversationIdsRef, setConversations],
  );

  /**
   * One probe/poll round: fetch the snapshot at the current cursor, hydrate
   * anything fresher, refresh the banner state. Safe to call repeatedly.
   */
  const syncOnce = useCallback(async (): Promise<void> => {
    const chatId = activeChatId;
    if (!chatId || disabledRef.current) return;
    const scope = scopeFor(chatId);
    if (!scope) return;
    const cursor = cursorRef.current.get(chatId);
    const result = await fetchRunHostAttach(scope, cursor?.savedAt ?? null);
    if (chatId !== activeChatId) return; // chat switched mid-flight
    if (result.kind === 'none') {
      if (result.reason === 'not_configured') disabledRef.current = true;
      setHostRun(null);
      return;
    }
    if (result.kind === 'error') {
      // Transient (offline, deploy) — keep the current banner; the next
      // poll retries. Logged so a persistently failing attach (5xx, parse)
      // is visible in ops rather than an invisible stuck banner.
      log('warn', 'run_host_attach_sync_failed', {
        chatId,
        status: result.status ?? null,
        message: result.message,
      });
      return;
    }
    const snapshot = result.snapshot;
    if (cursor && cursor.runId !== snapshot.runId) {
      // A different run superseded the one we were following — restart the
      // cursor so the new run hydrates from its own anchor.
      cursorRef.current.delete(chatId);
    }
    if (snapshot.state === 'watched' || dismissedRef.current.has(`${chatId}:${snapshot.runId}`)) {
      // `watched` means a live client (possibly this one, mid-handoff) is
      // driving — nothing to view or control here.
      setHostRun(null);
      return;
    }
    if (snapshot.checkpoint) {
      await applyHydration(chatId, snapshot.checkpoint);
      if (snapshot.checkpointSavedAt !== null) {
        cursorRef.current.set(chatId, {
          runId: snapshot.runId,
          savedAt: snapshot.checkpointSavedAt,
        });
      }
    }
    setHostRun((prev) => ({
      runId: snapshot.runId,
      state: snapshot.state,
      round: snapshot.round,
      midFlight: snapshot.midFlight,
      pausedForApproval: snapshot.pausedForApproval ?? null,
      ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}),
      busy: prev?.runId === snapshot.runId ? prev.busy : false,
    }));
  }, [activeChatId, applyHydration, scopeFor]);

  const syncOnceRef = useRef(syncOnce);
  useEffect(() => {
    syncOnceRef.current = syncOnce;
  }, [syncOnce]);

  // Probe when a chat becomes idle in this tab. A locally active run owns
  // the host record through the Phase 2 transport — attach is the
  // away-and-returned path, so it stays out of the way while streaming.
  useEffect(() => {
    if (!activeChatId || isStreaming) return;
    if (isRunActive(runEngineStateRef.current)) return;
    void syncOnceRef.current();
  }, [activeChatId, isStreaming, runEngineStateRef]);

  // Cursor-follow while the run is detached on the host. Read-only polls.
  const followable =
    hostRun !== null && (hostRun.state === 'adopted' || hostRun.state === 'adoptable');
  useEffect(() => {
    if (!followable || isStreaming) return;
    const timer = setInterval(() => {
      if (isRunActive(runEngineStateRef.current)) return;
      void syncOnceRef.current();
    }, RUN_HOST_ATTACH_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [followable, isStreaming, runEngineStateRef]);

  const setBusy = useCallback((busy: boolean) => {
    setHostRun((prev) => (prev ? { ...prev, busy } : prev));
  }, []);

  /** Backstop for the control IIFEs: every body is non-throwing by
   * construction, but a `busy` flag stuck true would dead-lock the banner's
   * buttons — so an unexpected throw resets it and logs instead of
   * disappearing into a void'd promise. */
  const runControl = useCallback(
    (control: string, chatId: string, body: () => Promise<void>) => {
      void body().catch((err: unknown) => {
        log('warn', 'run_host_attach_control_failed', {
          chatId,
          control,
          message: err instanceof Error ? err.message : String(err),
        });
        setBusy(false);
      });
    },
    [setBusy],
  );

  const resolveGate = useCallback(
    (decision: 'approve' | 'deny') => {
      const current = hostRunRef.current;
      const chatId = activeChatId;
      const scope = chatId ? scopeFor(chatId) : null;
      const pending = current?.pausedForApproval;
      if (!current || !pending || !scope || current.busy) return;
      setBusy(true);
      runControl(`approval_${decision}`, chatId, async () => {
        const res = await submitRunHostApproval(scope, current.runId, pending.approvalId, decision);
        if (!res.ok) {
          log('warn', 'run_host_attach_control_failed', {
            chatId,
            runId: current.runId,
            control: `approval_${decision}`,
            status: res.status ?? null,
            message: res.message,
          });
        }
        await syncOnceRef.current();
        setBusy(false);
      });
    },
    [activeChatId, runControl, scopeFor, setBusy],
  );

  const approveHostGate = useCallback(() => resolveGate('approve'), [resolveGate]);
  const denyHostGate = useCallback(() => resolveGate('deny'), [resolveGate]);

  const stopHostRun = useCallback(() => {
    const current = hostRunRef.current;
    const chatId = activeChatId;
    const scope = chatId ? scopeFor(chatId) : null;
    if (!current || !scope || current.busy) return;
    setBusy(true);
    runControl('stop', chatId, async () => {
      const res = await stopRunHostRun(scope, current.runId);
      if (!res.ok) {
        log('warn', 'run_host_attach_control_failed', {
          chatId,
          runId: current.runId,
          control: 'stop',
          status: res.status ?? null,
          message: res.message,
        });
      }
      // The stop keeps the checkpoint — this sync hydrates the final rounds.
      await syncOnceRef.current();
      setBusy(false);
    });
  }, [activeChatId, runControl, scopeFor, setBusy]);

  const pullHostRunLocal = useCallback(() => {
    const current = hostRunRef.current;
    const chatId = activeChatId;
    const scope = chatId ? scopeFor(chatId) : null;
    if (!current || !scope || current.busy) return;
    setBusy(true);
    runControl('pull_back_local', chatId, async () => {
      // Final hydration first — release drops the host's checkpoint.
      await syncOnceRef.current();
      const res = await releaseRunHostRun(scope, current.runId);
      if (!res.ok) {
        // A failed release is not fatal to the pull (the transcript is
        // already local); the record lingers until superseded. Loud anyway.
        log('warn', 'run_host_attach_control_failed', {
          chatId,
          runId: current.runId,
          control: 'release',
          status: res.status ?? null,
          message: res.message,
        });
      }
      // The legacy interrupted-run checkpoint predates the gap the host just
      // filled — clear it so the stale ResumeBanner doesn't double-offer.
      clearRunCheckpoint(chatId);
      dismissedRef.current.add(`${chatId}:${current.runId}`);
      cursorRef.current.delete(chatId);
      setHostRun(null);
      log('info', 'run_host_attach_pulled_local', {
        chatId,
        runId: current.runId,
        fromState: current.state,
        midFlight: current.midFlight,
        continued: current.midFlight && Boolean(sendMessageRef.current),
      });
      if (current.midFlight && sendMessageRef.current) {
        await sendMessageRef.current(RUN_RECLAIMED_NOTE);
      }
    });
  }, [activeChatId, runControl, scopeFor, sendMessageRef, setBusy]);

  const dismissHostRun = useCallback(() => {
    const current = hostRunRef.current;
    const chatId = activeChatId;
    if (!current || !chatId) return;
    dismissedRef.current.add(`${chatId}:${current.runId}`);
    const scope = scopeFor(chatId);
    if (scope && !current.midFlight) {
      // A finished (or stopped/expired) run has been hydrated — dismissing
      // is the cleanup signal; drop the host record + checkpoint.
      void releaseRunHostRun(scope, current.runId).catch(() => {});
      cursorRef.current.delete(chatId);
    }
    setHostRun(null);
  }, [activeChatId, scopeFor]);

  return {
    hostRun,
    approveHostGate,
    denyHostGate,
    stopHostRun,
    pullHostRunLocal,
    dismissHostRun,
  };
}
