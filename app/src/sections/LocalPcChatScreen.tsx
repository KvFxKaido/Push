/**
 * LocalPcChatScreen — chat surface for a paired `kind: 'local-pc'`
 * workspace session.
 *
 * Thin wrapper around `DaemonChatBody`: mounts `useLocalDaemon` for
 * the loopback long-lived WS, renders the `LocalPcModeChip` in the
 * header, clears the paired-device record on unpair. Everything
 * else (chat round loop, compose box, reconnect banner, approval
 * prompt, picker, layout) lives in DaemonChatBody so this screen
 * and `RelayChatScreen` can't drift.
 *
 * Phase 2.i factored the shared shell out; before that the two
 * screens were 95% identical clones.
 */
import { MonitorOff } from 'lucide-react';
import { useMemo } from 'react';

import { LocalPcModeChip } from '@/components/LocalPcModeChip';
import { DaemonChatBody } from '@/components/daemon/DaemonChatBody';
import { useApprovalQueue } from '@/hooks/useApprovalQueue';
import { useLocalDaemon } from '@/hooks/useLocalDaemon';
import { clearPairedDevice } from '@/lib/local-pc-storage';
import { buildLocalPcWorkspaceContext } from '@/lib/workspace-context';
import type { LocalPcBinding } from '@/types';

interface LocalPcChatScreenProps {
  binding: LocalPcBinding;
  /** Called after the user unpairs — caller ends the workspace session. */
  onUnpair: () => void;
}

export function LocalPcChatScreen({ binding, onUnpair }: LocalPcChatScreenProps) {
  // Approval queue is owned at the screen so we can wire its
  // `handleDaemonEvent` into the daemon hook's `onEvent` callback
  // below. Rules-of-Hooks: we have to call the daemon hook at the
  // same level as `useApprovalQueue`, so neither can live inside
  // DaemonChatBody.
  const approvals = useApprovalQueue();
  const { status, reconnect, reconnectInfo, request, liveBinding } = useLocalDaemon(binding, {
    onEvent: approvals.handleDaemonEvent,
  });

  const workspaceContext = useMemo(
    () => ({
      description: buildLocalPcWorkspaceContext(),
      includeGitHubTools: false,
      mode: 'local-pc' as const,
    }),
    [],
  );

  const handleUnpair = async () => {
    await clearPairedDevice();
    onUnpair();
  };

  return (
    <DaemonChatBody
      mode="local-pc"
      daemonLabel="local daemon"
      workspaceContext={workspaceContext}
      modeChip={<LocalPcModeChip port={binding.port} status={status} />}
      unpairIcon={MonitorOff}
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
