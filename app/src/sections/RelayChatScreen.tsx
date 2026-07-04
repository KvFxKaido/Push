/**
 * RelayChatScreen — chat surface for a paired `kind: 'relay'`
 * workspace session.
 *
 * Thin wrapper around `DaemonChatBody`: mounts `useRelayDaemon` for
 * the Worker-relay long-lived WS, renders the `RelayModeChip` (which
 * flashes amber on `replayUnavailableAt`), clears the paired-remote
 * record on unpair. Everything else (chat round loop, compose box,
 * reconnect banner, approval prompt, picker, layout) lives in
 * DaemonChatBody.
 */
import { Globe } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { RelayModeChip } from '@/components/RelayModeChip';
import { DaemonChatBody } from '@/components/daemon/DaemonChatBody';
import { useApprovalQueue } from '@/hooks/useApprovalQueue';
import { useDaemonMessageDispatch } from '@/hooks/useDaemonMessageDispatch';
import { useDaemonRunState } from '@/hooks/useDaemonRunState';
import { useRemoteTurnProjection } from '@/hooks/useRemoteTurnProjection';
import { useRelayDaemon } from '@/hooks/useRelayDaemon';
import type { SessionEvent } from '@/lib/local-daemon-binding';
import { clearPairedRemote } from '@/lib/relay-storage';
import { buildDaemonWorkspaceContext } from '@/lib/workspace-context';
import type { DaemonCliSession, RelayBinding, WorkspaceScreenAuthProps } from '@/types';

interface RelayChatScreenProps {
  binding: RelayBinding;
  /** Non-destructive exit back to the app shell. Pairing remains stored. */
  onLeave: () => void;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
  /** GitHub auth surface, forwarded to the hub's Settings tab so the
   * user can manage their token / installation from inside a daemon
   * session without unpairing. Daemon sessions don't need GitHub to
   * function, but the Settings tab includes auth management. */
  auth: WorkspaceScreenAuthProps;
  /** Disconnect handler from the app navigation surface. The hub's
   * Settings → Auth section invokes it. */
  onDisconnect: () => void;
  /** Tap-to-resume target switch (App's onResumeRelaySession). The
   * screen does the `grant_session_attach` round-trip itself — it owns
   * the live daemon connection — then hands the {sessionId, bearer}
   * pair up so App swaps the workspace binding. Optional: absent means
   * Connected rows in the drawer stay read-only. */
  onResumeSession?: (targetSessionId: string, targetAttachToken: string) => void;
}

export function RelayChatScreen({
  binding,
  onLeave,
  onUnpair,
  auth,
  onDisconnect,
  onResumeSession,
}: RelayChatScreenProps) {
  const approvals = useApprovalQueue();
  const runState = useDaemonRunState();
  // Project the live content of a turn the TUI is driving (assistant tokens) so
  // it streams into this client's transcript — see useRemoteTurnProjection.
  const remoteTurn = useRemoteTurnProjection(runState.reattachedRun);
  // Fan the live event stream to all consumers: approvals (drop on
  // approval_received), run-state (clear on run_complete), and the remote-turn
  // projection (accumulate assistant tokens). Destructure the (stable) handlers
  // so the memo deps don't ride the per-render hook objects.
  const handleApprovalEvent = approvals.handleDaemonEvent;
  const handleRunStateEvent = runState.handleDaemonEvent;
  const handleRemoteTurnEvent = remoteTurn.handleDaemonEvent;
  const handleEvent = useCallback(
    (event: SessionEvent) => {
      handleApprovalEvent(event);
      handleRunStateEvent(event);
      handleRemoteTurnEvent(event);
    },
    [handleApprovalEvent, handleRunStateEvent, handleRemoteTurnEvent],
  );
  const {
    status,
    reconnect,
    reconnectInfo,
    request,
    liveBinding,
    replayUnavailableAt,
    attachStatus,
    attachError,
    hydratedMessages,
    sessionSnapshot,
  } = useRelayDaemon(binding, {
    onEvent: handleEvent,
  });

  // The daemon session the phone is actually attached to (not the relay
  // transport's opaque routing key — see resolveRelayTargetSessionId's doc
  // comment). Needed both for tap-to-resume below and to address the
  // messageDispatch send below.
  const targetSessionId = binding.targetSessionId ?? null;

  // Send this screen's own messages through the daemon's round loop instead
  // of generating locally, so the response comes from the session's own
  // provider/model (what the picker shows) and every attached client —
  // including the TUI — sees it stream live. See useDaemonMessageDispatch.
  const messageDispatch = useDaemonMessageDispatch(
    request,
    targetSessionId,
    binding.targetAttachToken ?? null,
    runState.startRun,
  );

  // Hydrate the state the event stream already passed before this client
  // attached: an approval the session is blocked on, and a foreground run it's
  // mid-turn on. The approval enqueue dedupes by id; run-state hydration primes
  // the busy indicator + remote Stop until a run_complete (or local takeover).
  // When the snapshot goes null (target change / attach failure) the old
  // session's state is no longer valid — clear both so a stale prompt or
  // "Running…"/Stop can't act on a session this screen is no longer bound to.
  const { hydrateSnapshotApproval, clear: clearApprovals } = approvals;
  const { hydrateSnapshotRunState, clear: clearRunState } = runState;
  const { reset: resetRemoteTurn } = remoteTurn;
  const { reset: resetMessageDispatch } = messageDispatch;
  useEffect(() => {
    if (!sessionSnapshot) {
      clearApprovals();
      clearRunState();
      resetRemoteTurn();
      resetMessageDispatch();
      return;
    }
    hydrateSnapshotApproval(sessionSnapshot.pendingApproval, sessionSnapshot.session.sessionId);
    hydrateSnapshotRunState(sessionSnapshot);
  }, [
    sessionSnapshot,
    hydrateSnapshotApproval,
    hydrateSnapshotRunState,
    clearApprovals,
    clearRunState,
    resetRemoteTurn,
    resetMessageDispatch,
  ]);

  const workspaceContext = useMemo(
    () => ({
      description: buildDaemonWorkspaceContext(),
      includeGitHubTools: false,
      mode: 'relay' as const,
    }),
    [],
  );

  const handleUnpair = async () => {
    await clearPairedRemote();
    onUnpair();
  };

  // Invalidate an in-flight resume grant once this screen unmounts
  // (user left Remote, unpaired, or a prior switch already re-keyed
  // the screen) — a slow grant must not re-target the workspace after
  // the user moved on (Codex P2 on #1310, in-screen variant).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Tap-to-resume from the drawer's Connected section: ask the daemon
  // for the tapped session's bearer over this screen's own connection,
  // then let App re-target the workspace binding (the screen remounts
  // keyed by target). Failures degrade to a structured log + no-op —
  // the row simply doesn't navigate, matching the "a broken relay must
  // not make the drawer feel broken" posture.
  const handleResumeCliSession = useCallback(
    async (session: DaemonCliSession) => {
      if (!onResumeSession) return;
      if (session.sessionId === targetSessionId) return; // already attached
      try {
        const res = await request<{ attachToken?: unknown }>({
          type: 'grant_session_attach',
          timeoutMs: 10_000,
          payload: { sessionId: session.sessionId },
        });
        if (!mountedRef.current) return; // user left Remote mid-grant
        const token = res?.payload?.attachToken;
        if (typeof token === 'string' && token) {
          onResumeSession(session.sessionId, token);
          return;
        }
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'relay_resume_grant_malformed',
            sessionId: session.sessionId,
          }),
        );
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'relay_resume_grant_failed',
            sessionId: session.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [onResumeSession, targetSessionId, request],
  );

  return (
    <DaemonChatBody
      mode="relay"
      daemonLabel="remote daemon"
      workspaceContext={workspaceContext}
      modeChip={
        <RelayModeChip
          deploymentUrl={binding.deploymentUrl}
          status={status}
          replayUnavailableAt={replayUnavailableAt}
        />
      }
      unpairIcon={Globe}
      onLeave={onLeave}
      onUnpair={handleUnpair}
      status={status}
      reconnect={reconnect}
      reconnectInfo={reconnectInfo}
      liveBinding={liveBinding}
      paramsBinding={binding}
      approvals={approvals}
      request={request}
      sessionAttachToken={binding.targetAttachToken ?? null}
      targetSessionId={targetSessionId}
      auth={auth}
      onDisconnect={onDisconnect}
      attachStatus={attachStatus}
      attachError={attachError}
      hydratedMessages={hydratedMessages}
      reattachedRun={runState.reattachedRun}
      onClearReattachedRun={runState.clear}
      remoteTurnMessage={remoteTurn.remoteMessage}
      messageDispatch={messageDispatch}
      onResumeCliSession={onResumeSession ? handleResumeCliSession : undefined}
    />
  );
}
