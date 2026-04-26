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
import type { MigrationGuard } from '@/lib/chat-message';

export function useBranchForkGuard(
  conversations: Record<string, Conversation>,
  sortedChatIds: readonly string[],
) {
  const skipAutoCreateRef = useRef<MigrationGuard | null>(null);

  // Releases `skipAutoCreateRef` only when the migration is observable in
  // the rendered state: the migrated conversation has the new branch AND
  // the filter accepts it under the new currentBranch. More honest than a
  // microtask/timer clear because it waits for ACTUAL state convergence —
  // a stuck guard surfaces as "auto-switch suppressed" rather than silently
  // re-introducing the auto-create bug. See slice 2 design D2.
  useEffect(() => {
    const guard = skipAutoCreateRef.current;
    if (!guard) return;
    const conv = conversations[guard.chatId];
    if (conv?.branch === guard.toBranch && sortedChatIds.includes(guard.chatId)) {
      skipAutoCreateRef.current = null;
    }
  }, [conversations, sortedChatIds]);

  return skipAutoCreateRef;
}
