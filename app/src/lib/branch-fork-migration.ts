/**
 * Unified branch-change application.
 *
 * Chats are repo-scoped now; branch changes no longer migrate transcripts
 * between per-branch chats. A branch switch result simply warms the workspace
 * follow path, updates the active conversation's mutable branch state, and
 * appends a passive `branch_forked` / `branch_merged` timeline moment for the
 * kinds that warrant one.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BranchSwitchPayload, ChatMessage, Conversation, RunEventInput } from '@/types';
import type { ChatRuntimeHandlers } from '@/hooks/chat-send';
import { createBranchForkedMessage, createBranchMergedMessage } from './chat-message';

export interface BranchForkMigrationContext {
  /** Optional origin chat id/event logger fields shared with broader branch
   *  transition context assembly. The unified path does not emit run events,
   *  but accepting the shared shape avoids caller churn. */
  chatId?: string;
  appendRunEvent?: (chatId: string, event: RunEventInput) => void;
  /** Active chat id at resolution time. The current chat is the one whose
   *  mutable branch state follows sandbox HEAD. */
  activeChatIdRef: MutableRefObject<string | null>;
  /** Current conversation snapshot, used to avoid dirty writes for missing or
   *  already-updated conversations. */
  conversationsRef: MutableRefObject<Record<string, Conversation>>;
  /** Current branch info retained for shared context compatibility. */
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  /** Conversation state setter. */
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  /** Dirty-tracking set so the next persistence flush stores the branch update. */
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  /** Runtime handlers registry. `onBranchSwitch` owns the warm follow
   *  coordination (`skipBranchTeardownRef` + `setCurrentBranch`). */
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
}

export function applyBranchSwitchPayload(
  payload: BranchSwitchPayload,
  ctx: BranchForkMigrationContext,
): void {
  ctx.runtimeHandlersRef.current?.onBranchSwitch?.(payload.name);

  const targetChatId = ctx.activeChatIdRef.current;
  if (!targetChatId) return;

  const targetConv = ctx.conversationsRef.current[targetChatId];
  if (!targetConv || targetConv.branch === payload.name) return;

  // The branch this transitioned *from*. Read the conversation's current branch
  // (the value about to be overwritten) rather than `branchInfoRef`, which the
  // `onBranchSwitch` above may already have advanced to the new branch.
  const fromBranch = payload.from ?? targetConv.branch ?? 'main';

  // Passive timeline moment for the kinds that warrant a divider: `forked` (a
  // branch was created) and `merged` (a PR shipped). A plain `switched` (incl.
  // the desync reconcile) leaves none — matching pre-refactor behavior, where
  // only the heavy path appended a moment.
  const moment: ChatMessage | null =
    payload.kind === 'merged'
      ? createBranchMergedMessage({
          from: fromBranch,
          to: payload.name,
          prNumber: payload.prNumber,
          source: payload.source,
        })
      : payload.kind === 'forked'
        ? createBranchForkedMessage({
            from: fromBranch,
            to: payload.name,
            sha: payload.sha,
            source: payload.source,
          })
        : null;

  ctx.setConversations((prev) => {
    const conv = prev[targetChatId];
    if (!conv || conv.branch === payload.name) return prev;
    return {
      ...prev,
      [targetChatId]: {
        ...conv,
        branch: payload.name,
        ...(moment
          ? { messages: [...conv.messages, moment], lastMessageAt: moment.timestamp }
          : {}),
      },
    };
  });
  ctx.dirtyConversationIdsRef.current.add(targetChatId);
}
