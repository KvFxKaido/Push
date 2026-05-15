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
import { useMemo } from 'react';

import { RelayModeChip } from '@/components/RelayModeChip';
import { DaemonChatBody } from '@/components/daemon/DaemonChatBody';
import { useApprovalQueue } from '@/hooks/useApprovalQueue';
import { useRelayDaemon } from '@/hooks/useRelayDaemon';
import { clearPairedRemote } from '@/lib/relay-storage';
import { buildLocalPcWorkspaceContext } from '@/lib/workspace-context';
import type { RelayBinding } from '@/types';

interface RelayChatScreenProps {
  binding: RelayBinding;
  /** Non-destructive exit back to the app shell. Pairing remains stored. */
  onLeave: () => void;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
}

export function RelayChatScreen({ binding, onLeave, onUnpair }: RelayChatScreenProps) {
  const approvals = useApprovalQueue();
  const { status, reconnect, reconnectInfo, request, liveBinding, replayUnavailableAt } =
    useRelayDaemon(binding, {
      onEvent: approvals.handleDaemonEvent,
    });

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
    />
  );
}
