/**
 * Slice 2 conversation-fork migration guard for `useChat`.
 *
 * Owns `skipAutoCreateRef` and the state-observed clear effect that releases
 * it when the migration is observable in render state. Extracted from
 * `useChat.ts` so the hook stays under the configured 1400-line cap and so
 * the guard logic is testable in isolation if needed.
 *
 * The guard is set externally (by `applyBranchSwitchPayload` in
 * `chat-send.ts`) and consumed externally (by `useChat`'s auto-switch effect
 * which early-returns while it's set). This hook only owns the ref's
 * lifetime and the state-observed clear — see slice 2 D2 for the rationale
 * on why a state-observed clear replaces v2's queueMicrotask approach.
 */

import { useEffect, useRef } from 'react';
import type { Conversation } from '@/types';
import { clearMigrationMarker } from '@/lib/branch-migration-marker';
import type { MigrationGuard } from '@/lib/chat-message';

export function useBranchForkGuard(
  conversations: Record<string, Conversation>,
  sortedChatIds: readonly string[],
) {
  const skipAutoCreateRef = useRef<MigrationGuard | null>(null);

  // Releases BOTH the in-tab guard (`skipAutoCreateRef`) AND the cross-tab
  // localStorage marker only when the migration is observable in the rendered
  // state: the migrated conversation has the new branch AND the filter
  // accepts it under the new currentBranch.
  //
  // Why both signals release together: the cross-tab marker used to clear
  // synchronously in `applyBranchSwitchPayload`'s `finally` block, but
  // conversation persistence is async (~3s flushDirty cycle). Other tabs
  // observing the marker getting cleared could then see the workspace's
  // `currentBranch` change before the migrated conversation landed in
  // IndexedDB, reintroducing the exact auto-create / chat-id-steal race the
  // marker was meant to prevent. (Review feedback: Copilot.) Releasing the
  // marker here, alongside the in-tab guard, ties cross-tab observation to
  // ACTUAL render-state convergence in the migrating tab.
  //
  // The 5s stale fallback in branch-migration-marker.ts handles the crashed-
  // migrating-tab case so observers don't freeze if this effect never runs.
  // See slice 2 design D2 + R10.
  useEffect(() => {
    const guard = skipAutoCreateRef.current;
    if (!guard) return;
    const conv = conversations[guard.chatId];
    if (conv?.branch === guard.toBranch && sortedChatIds.includes(guard.chatId)) {
      skipAutoCreateRef.current = null;
      clearMigrationMarker();
    }
  }, [conversations, sortedChatIds]);

  return skipAutoCreateRef;
}
