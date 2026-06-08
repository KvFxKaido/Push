/**
 * RelayChatScreen — chat surface for a paired `kind: 'relay'`
 * workspace session.
 *
 * Thin wrapper around `DaemonChatBody`: mounts `useRelayDaemon` for
 * the Worker-relay long-lived WS, renders the `RelayModeChip` (which
 * flashes amber on `replayUnavailableAt`), clears the paired-remote
 * record on unpair. Everything else (chat round loop, compose box,
 * reconnect banner, approval prompt, picker, layout) lives in
 * DaemonChatBody so this screen and `LocalPcChatScreen` can't drift.
 *
 * Phase 2.i factored the shared shell out; before that this screen
 * was a 95% clone of the local-PC version.
 */
import { Globe } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';

import { RelayModeChip } from '@/components/RelayModeChip';
import { DaemonChatBody } from '@/components/daemon/DaemonChatBody';
import { useApprovalQueue } from '@/hooks/useApprovalQueue';
import { useDaemonRunState } from '@/hooks/useDaemonRunState';
import { useRelayDaemon } from '@/hooks/useRelayDaemon';
import type { SessionEvent } from '@/lib/local-daemon-binding';
import { clearPairedRemote } from '@/lib/relay-storage';
import { buildLocalPcWorkspaceContext } from '@/lib/workspace-context';
import type { RelayBinding, WorkspaceScreenAuthProps } from '@/types';

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
}

export function RelayChatScreen({
  binding,
  onLeave,
  onUnpair,
  auth,
  onDisconnect,
}: RelayChatScreenProps) {
  const approvals = useApprovalQueue();
  const runState = useDaemonRunState();
  // Fan the live event stream to both consumers: approvals (drop on
  // approval_received) and run-state (clear on run_complete). Destructure the
  // (stable) handlers so the memo deps don't ride the per-render hook objects.
  const handleApprovalEvent = approvals.handleDaemonEvent;
  const handleRunStateEvent = runState.handleDaemonEvent;
  const handleEvent = useCallback(
    (event: SessionEvent) => {
      handleApprovalEvent(event);
      handleRunStateEvent(event);
    },
    [handleApprovalEvent, handleRunStateEvent],
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

  // Hydrate the state the event stream already passed before this client
  // attached: an approval the session is blocked on, and a foreground run it's
  // mid-turn on. The approval enqueue dedupes by id; run-state hydration primes
  // the busy indicator + remote Stop until a run_complete (or local takeover).
  const { hydrateSnapshotApproval } = approvals;
  const { hydrateSnapshotRunState } = runState;
  useEffect(() => {
    if (!sessionSnapshot) return;
    hydrateSnapshotApproval(sessionSnapshot.pendingApproval, sessionSnapshot.session.sessionId);
    hydrateSnapshotRunState(sessionSnapshot);
  }, [sessionSnapshot, hydrateSnapshotApproval, hydrateSnapshotRunState]);

  const workspaceContext = useMemo(
    () => ({
      description: buildLocalPcWorkspaceContext({ transport: 'relay' }),
      includeGitHubTools: false,
      mode: 'relay' as const,
    }),
    [],
  );

  const handleUnpair = async () => {
    await clearPairedRemote();
    onUnpair();
  };

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
      auth={auth}
      onDisconnect={onDisconnect}
      attachStatus={attachStatus}
      attachError={attachError}
      hydratedMessages={hydratedMessages}
      reattachedRun={runState.reattachedRun}
      onClearReattachedRun={runState.clear}
    />
  );
}
