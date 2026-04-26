/**
 * Conversation-fork migration (slice 2).
 *
 * When a tool emits a `'forked'` branchSwitch (today: sandbox_create_branch
 * only), migrate the active conversation to the new branch instead of letting
 * `useChat` auto-create a fresh one. This is the load-bearing behavior of
 * slice 2.
 *
 * The mechanism (per design doc D2, two council passes):
 * - Set BOTH guards before any state update — in-tab `skipAutoCreateRef` and
 *   cross-tab localStorage marker. Both are needed; neither alone covers
 *   every observation path.
 * - Atomic R12 backfill in one `setConversations` call: stamp existing
 *   messages with the OLD `conv.branch` (preserves provenance), set new
 *   `conv.branch`, append a typed `branch_forked` event.
 * - Trigger workspace branch update via the existing `onBranchSwitch`
 *   callback (which handles `skipBranchTeardownRef` + `setCurrentBranch`).
 * - Cross-tab marker is cleared in a `try/finally` so a crashed write path
 *   still releases observing tabs (in addition to the 5s stale fallback in
 *   `branch-migration-marker.ts`).
 * - The in-tab guard is NOT cleared here — `useChat`'s state-observed effect
 *   releases it once the migration is observable in render state. v2's
 *   `queueMicrotask` clear was rejected by both consultants because
 *   microtasks run before React commits the next render.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BranchSwitchPayload, Conversation } from '@/types';
import type { ChatRuntimeHandlers } from '@/hooks/chat-send';
import { createBranchForkedMessage, type MigrationGuard } from './chat-message';
import { setMigrationMarker, clearMigrationMarker } from './branch-migration-marker';

export interface BranchForkMigrationContext {
  /** Active chat id at resolution time, read from a ref to avoid stale
   *  capture. If null/missing or the conversation no longer exists, the
   *  migration is skipped and only the workspace branch is synced. */
  activeChatIdRef: MutableRefObject<string | null>;
  /** Current branch on the workspace, used as the `from` fallback when the
   *  tool result didn't supply one. */
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  /** In-tab migration guard — set before writes, cleared by useChat's
   *  state-observed effect after the migration is observable. */
  skipAutoCreateRef: MutableRefObject<MigrationGuard | null>;
  /** Conversation state setter. */
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  /** Dirty-tracking set so the next persistence flush picks up the migrated
   *  conversation. */
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  /** Runtime handlers registry. The `onBranchSwitch` callback is invoked
   *  after the conversation update to trigger the workspace's
   *  `setCurrentBranch` + `skipBranchTeardownRef` coordination. */
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
}

/**
 * Apply a branch-switch tool-result payload to the active conversation.
 *
 * For `kind: 'forked'`: migrates the active conversation (or syncs branch
 * silently if no active chat exists). For `kind: 'switched'` or undefined:
 * just triggers the existing `onBranchSwitch` handler — useChat's auto-
 * switch effect handles the rest via its filter + auto-select / auto-create
 * path (existing pre-slice-2 behavior).
 */
export function applyBranchSwitchPayload(
  payload: BranchSwitchPayload,
  ctx: BranchForkMigrationContext,
): void {
  if (payload.kind !== 'forked') {
    // Existing behavior for 'switched' (or any future kind): just sync the
    // workspace branch. useChat's auto-switch effect picks it up.
    ctx.runtimeHandlersRef.current?.onBranchSwitch?.(payload.name);
    return;
  }

  const targetChatId = ctx.activeChatIdRef.current;
  const fromBranch = payload.from ?? ctx.branchInfoRef.current?.currentBranch ?? 'main';

  if (!targetChatId) {
    // No-active-chat fallback: nothing to migrate. Sync the workspace branch
    // silently and let useChat's auto-create produce a fresh chat on the
    // new branch via its existing path.
    ctx.runtimeHandlersRef.current?.onBranchSwitch?.(payload.name);
    return;
  }

  // R10: cross-tab marker. Set BEFORE persistence updates so other tabs
  // observing storage events suppress their own auto-create until this
  // migration settles (or the marker ages out at ~5s).
  setMigrationMarker({
    chatId: targetChatId,
    fromBranch,
    toBranch: payload.name,
  });

  // In-tab guard with target state so useChat's state-observed clear effect
  // can release it once the migration is observable.
  ctx.skipAutoCreateRef.current = { chatId: targetChatId, toBranch: payload.name };

  try {
    // R12: atomic backfill + branch update + event insertion in one
    // setConversations. Existing un-stamped messages get the OLD branch
    // (preserving provenance); new conv.branch becomes the target;
    // branch_forked event is appended to demarcate the transition.
    ctx.setConversations((prev) => {
      const conv = prev[targetChatId];
      if (!conv) return prev;
      const oldBranch = conv.branch;
      const backfilledMessages = conv.messages.map((m) =>
        m.branch === undefined ? { ...m, branch: oldBranch } : m,
      );
      const branchForkedEvent = createBranchForkedMessage({
        from: fromBranch,
        to: payload.name,
        sha: payload.sha,
        source: payload.source,
      });
      return {
        ...prev,
        [targetChatId]: {
          ...conv,
          branch: payload.name,
          messages: [...backfilledMessages, branchForkedEvent],
          lastMessageAt: branchForkedEvent.timestamp,
        },
      };
    });
    ctx.dirtyConversationIdsRef.current.add(targetChatId);

    // Trigger workspace branch update — runs the existing handler
    // (skipBranchTeardownRef + setCurrentBranch).
    ctx.runtimeHandlersRef.current?.onBranchSwitch?.(payload.name);
  } finally {
    // Clear the cross-tab marker after writes settle. The in-tab guard
    // (skipAutoCreateRef) is cleared separately by useChat's state-observed
    // effect once the migration is observable in render state.
    clearMigrationMarker();
  }
}
