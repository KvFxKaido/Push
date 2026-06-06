import { describe, expect, it } from 'vitest';
import type { ChatCard, ChatMessage, Conversation } from '@/types';
import {
  selectPendingCommitApprovals,
  planAutoApprovals,
  type PendingCommitApproval,
} from './chat-full-auto-approvals';

const commitCard = (status: string, commitMessage = 'feat: thing'): ChatCard =>
  ({
    type: 'commit-review',
    data: {
      diff: { diff: '', filesChanged: 1, additions: 1, deletions: 0, truncated: false },
      auditVerdict: { verdict: 'safe', summary: '', risks: [], filesReviewed: 1 },
      commitMessage,
      status,
    },
  }) as ChatCard;

function conv(messages: ChatMessage[]): Conversation {
  return { id: 'c1', title: 'c', messages, createdAt: 1, lastMessageAt: 1 };
}

function msg(id: string, cards?: ChatCard[]): ChatMessage {
  return { id, role: 'assistant', content: '', timestamp: 1, status: 'done', cards };
}

describe('selectPendingCommitApprovals', () => {
  it('selects only pending commit-review cards', () => {
    const out = selectPendingCommitApprovals(
      conv([
        msg('m1', [commitCard('pending', 'feat: a')]),
        msg('m2', [commitCard('committed')]),
        msg('m3', [commitCard('approved')]),
        msg('m4'),
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ messageId: 'm1', cardIndex: 0, commitMessage: 'feat: a' });
  });

  it('preserves the original card index when other cards precede it', () => {
    const out = selectPendingCommitApprovals(
      conv([msg('m1', [{ type: 'file', data: {} } as ChatCard, commitCard('pending')])]),
    );
    expect(out).toEqual([{ messageId: 'm1', cardIndex: 1, commitMessage: 'feat: thing' }]);
  });

  it('does not re-select an already-approved (non-pending) card', () => {
    expect(selectPendingCommitApprovals(conv([msg('m1', [commitCard('error')])]))).toHaveLength(0);
    expect(selectPendingCommitApprovals(conv([msg('m1', [commitCard('pushing')])]))).toHaveLength(
      0,
    );
  });
});

describe('planAutoApprovals', () => {
  const card = (id: string): PendingCommitApproval => ({
    messageId: id,
    cardIndex: 0,
    commitMessage: `feat: ${id}`,
  });
  const none = () => false;

  it('auto-approves a commit that became pending while Full Auto was active', () => {
    const plan = planAutoApprovals([card('m1')], {
      isFullAuto: true,
      firstSightOfChat: false,
      isAlreadyHandled: none,
    });
    expect(plan.approve).toEqual([card('m1')]);
    expect(plan.handled).toEqual([card('m1')]);
  });

  it('seeds pre-existing cards on first sight of a chat without approving them', () => {
    const plan = planAutoApprovals([card('m1')], {
      isFullAuto: true,
      firstSightOfChat: true,
      isAlreadyHandled: none,
    });
    expect(plan.approve).toEqual([]);
    // Still marked handled, so a later tick can't retroactively approve it.
    expect(plan.handled).toEqual([card('m1')]);
  });

  it('marks but never approves pending cards under a stricter mode', () => {
    const plan = planAutoApprovals([card('m1')], {
      isFullAuto: false,
      firstSightOfChat: false,
      isAlreadyHandled: none,
    });
    expect(plan.approve).toEqual([]);
    expect(plan.handled).toEqual([card('m1')]);
  });

  it('skips cards already handled (no double-commit)', () => {
    const plan = planAutoApprovals([card('m1'), card('m2')], {
      isFullAuto: true,
      firstSightOfChat: false,
      isAlreadyHandled: (c) => c.messageId === 'm1',
    });
    expect(plan.approve).toEqual([card('m2')]);
    expect(plan.handled).toEqual([card('m2')]);
  });
});
