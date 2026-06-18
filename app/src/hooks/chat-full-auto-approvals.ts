/**
 * Full Auto commit-approval watcher.
 *
 * In Full Auto mode there is no human present to tap "Approve" on the
 * `commit-review` card that `prepare_push` emits after a SAFE Auditor
 * verdict (Gate-at-Push Move A — a push-kind card; legacy commit-kind cards
 * auto-approve the same way). Left alone, that card sits pending forever
 * (and, before
 * the transcript hoist, invisibly so). This watcher detects each freshly
 * created pending commit-review card and dispatches the *same*
 * `commit-approve` action a human tap would — reusing the vetted commit +
 * push path in `chat-card-actions.ts` (Protect Main guard, branch-sync
 * check, CI auto-fetch) instead of introducing a second commit code path
 * with its own divergent guards.
 *
 * `ask_user` is handled separately and earlier, in the runtime
 * (`web-tool-execution-runtime.ts`): in Full Auto it never reaches a card
 * at all. Only commit-review needs a card-level auto-tap because the
 * Auditor SAFE gate is a real safety check that always produces the card,
 * even in Full Auto.
 *
 * Auto-approval is deliberately scoped to the active chat: `handleCardAction`
 * itself resolves `chatId` from the focused conversation, so dispatching for a
 * background chat would commit against the wrong context. It also only ever
 * approves a commit that became pending *after* Full Auto was already active
 * (see `planAutoApprovals`), so toggling modes can't retroactively push a
 * commit the user left unapproved under Supervised/Autonomous.
 *
 * This is the owning coordinator for the behavior — kept out of
 * `useChat.ts` (which is `max-lines`-guarded) per the "name the
 * coordinator's home first" rule.
 */

import { useEffect, useRef } from 'react';
import type { CardAction, Conversation } from '@/types';
import { getApprovalMode } from '@/lib/approval-mode';

export interface PendingCommitApproval {
  messageId: string;
  /** Index into the message's `cards` array — the action must target it. */
  cardIndex: number;
  commitMessage: string;
}

/**
 * Pure scan: every commit-review card in `conv` still in its initial
 * `pending` state. Only `pending` qualifies — `error`, `approved`,
 * `pushing`, `committed` are all downstream of a tap already made, and
 * re-tapping would double-commit. Index is the card's position in its
 * message's `cards` array so the dispatched action lands on the right card.
 */
export function selectPendingCommitApprovals(conv: Conversation): PendingCommitApproval[] {
  const pending: PendingCommitApproval[] = [];
  for (const message of conv.messages) {
    const cards = message.cards;
    if (!cards) continue;
    cards.forEach((card, cardIndex) => {
      if (card.type === 'commit-review' && card.data.status === 'pending') {
        pending.push({ messageId: message.id, cardIndex, commitMessage: card.data.commitMessage });
      }
    });
  }
  return pending;
}

interface FullAutoCommitApprovalArgs {
  conversations: Record<string, Conversation>;
  activeChatId: string | null;
  handleCardAction: (action: CardAction) => void | Promise<void>;
}

export interface AutoApprovalPlan {
  /** Cards to auto-approve now (dispatch `commit-approve`). */
  approve: PendingCommitApproval[];
  /** Cards to record as seen without approving (so a later mode switch can't
   * retroactively push them). Always a superset of `approve`. */
  handled: PendingCommitApproval[];
}

/**
 * Decide what to do with the pending commit-review cards visible this tick.
 *
 * A card is auto-approvable only when it became pending *after* Full Auto was
 * already active for a chat we were already watching. On the first sight of a
 * chat — mount, chat switch, or reload — and under any stricter mode, every
 * pending card is treated as pre-existing: marked handled so flipping into
 * Full Auto later can't retroactively approve it, but never approved itself.
 * This closes the "switch to Full Auto and an old unapproved commit gets
 * pushed" hole (Codex P1 on PR #801).
 */
export function planAutoApprovals(
  pending: PendingCommitApproval[],
  opts: {
    isFullAuto: boolean;
    firstSightOfChat: boolean;
    isAlreadyHandled: (card: PendingCommitApproval) => boolean;
  },
): AutoApprovalPlan {
  const approve: PendingCommitApproval[] = [];
  const handled: PendingCommitApproval[] = [];
  const autoApprovable = opts.isFullAuto && !opts.firstSightOfChat;
  for (const card of pending) {
    if (opts.isAlreadyHandled(card)) continue;
    handled.push(card);
    if (autoApprovable) approve.push(card);
  }
  return { approve, handled };
}

export function useFullAutoCommitApproval({
  conversations,
  activeChatId,
  handleCardAction,
}: FullAutoCommitApprovalArgs): void {
  // Cards we've already acted on (approved OR marked pre-existing), keyed
  // `chatId:messageId:cardIndex`. We add keys *before* dispatching, so a
  // synchronous state update can never double-commit.
  const handledRef = useRef<Set<string>>(new Set());
  // Chats we've observed at least once. The first observation of a chat seeds
  // its already-pending cards as pre-existing rather than approving them.
  const seenChatsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeChatId) return;
    const conv = conversations[activeChatId];
    if (!conv) return;

    const keyOf = (card: PendingCommitApproval) =>
      `${activeChatId}:${card.messageId}:${card.cardIndex}`;
    const firstSightOfChat = !seenChatsRef.current.has(activeChatId);
    seenChatsRef.current.add(activeChatId);

    const { approve, handled } = planAutoApprovals(selectPendingCommitApprovals(conv), {
      isFullAuto: getApprovalMode() === 'full-auto',
      firstSightOfChat,
      isAlreadyHandled: (card) => handledRef.current.has(keyOf(card)),
    });

    // Record everything we're acting on before any dispatch.
    for (const card of handled) handledRef.current.add(keyOf(card));

    for (const { messageId, cardIndex, commitMessage } of approve) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'full_auto_commit_auto_approved',
          chatId: activeChatId,
          messageId,
          cardIndex,
        }),
      );
      void handleCardAction({ type: 'commit-approve', messageId, cardIndex, commitMessage });
    }
  }, [conversations, activeChatId, handleCardAction]);
}
