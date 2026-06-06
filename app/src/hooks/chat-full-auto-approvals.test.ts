import { describe, expect, it } from 'vitest';
import type { ChatCard, ChatMessage, Conversation } from '@/types';
import { selectPendingCommitApprovals } from './chat-full-auto-approvals';

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
