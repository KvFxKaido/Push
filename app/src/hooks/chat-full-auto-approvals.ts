/**
 * Full Auto commit-approval watcher.
 *
 * In Full Auto mode there is no human present to tap "Approve" on the
 * `commit-review` card that `sandbox_prepare_commit` emits after a SAFE
 * Auditor verdict. Left alone, that card sits pending forever (and, before
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

export function useFullAutoCommitApproval({
  conversations,
  activeChatId,
  handleCardAction,
}: FullAutoCommitApprovalArgs): void {
  // Cards we've already auto-approved, keyed `chatId:messageId:cardIndex`.
  // Guards against re-firing on the card's own pending → approved → committed
  // transitions and on unrelated re-renders. We add the key *before*
  // dispatching, so a synchronous state update can never double-commit.
  const approvedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (getApprovalMode() !== 'full-auto') return;
    if (!activeChatId) return;
    const conv = conversations[activeChatId];
    if (!conv) return;

    for (const { messageId, cardIndex, commitMessage } of selectPendingCommitApprovals(conv)) {
      const key = `${activeChatId}:${messageId}:${cardIndex}`;
      if (approvedRef.current.has(key)) continue;
      approvedRef.current.add(key);

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
