import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CardAction, CommitReviewCardData } from '@/types';
import { CommitReviewCard } from './CommitReviewCard';

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
}

function findButtonByText(node: ReactNode, text: string): ReactElement<{ onClick: () => void }> {
  if (isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) {
    if (node.type === 'button' && textContent(node).includes(text) && node.props.onClick) {
      return node as ReactElement<{ onClick: () => void }>;
    }
    const children = node.props.children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      try {
        return findButtonByText(child, text);
      } catch {
        // Continue searching siblings.
      }
    }
  }
  throw new Error(`Button not found: ${text}`);
}

function committedCard(overrides: Partial<CommitReviewCardData> = {}): CommitReviewCardData {
  return {
    diff: { diff: '', filesChanged: 1, additions: 1, deletions: 0, truncated: false },
    auditVerdict: { verdict: 'safe', summary: 'safe', risks: [], filesReviewed: 1 },
    commitMessage: 'feat: ship it',
    status: 'committed',
    committedBranch: 'feature/work',
    defaultBranch: 'main',
    ...overrides,
  };
}

describe('CommitReviewCard branch chips', () => {
  it('renders switch-to-default and fork chips for non-default branch commits', () => {
    const html = renderToStaticMarkup(
      <CommitReviewCard data={committedCard()} messageId="m1" cardIndex={0} />,
    );

    expect(html).toContain('Switch to main');
    expect(html).toContain('New branch from here');
  });

  it('emits card actions for the post-commit chips', () => {
    const onAction = vi.fn<(action: CardAction) => void>();
    const element = CommitReviewCard({
      data: committedCard(),
      messageId: 'm1',
      cardIndex: 0,
      onAction,
    });

    findButtonByText(element, 'Switch to main').props.onClick();
    findButtonByText(element, 'New branch from here').props.onClick();

    expect(onAction).toHaveBeenNthCalledWith(1, {
      type: 'commit-switch-default',
      messageId: 'm1',
      cardIndex: 0,
      targetBranch: 'main',
    });
    expect(onAction).toHaveBeenNthCalledWith(2, {
      type: 'commit-fork-from-here',
      messageId: 'm1',
      cardIndex: 0,
      fromBranch: 'feature/work',
    });
  });

  it('hides the switch chip for default-branch commits', () => {
    const html = renderToStaticMarkup(
      <CommitReviewCard
        data={committedCard({ committedBranch: 'main', defaultBranch: 'main' })}
        messageId="m1"
        cardIndex={0}
      />,
    );

    expect(html).not.toContain('Switch to main');
    expect(html).toContain('New branch from here');
  });
});

describe('CommitReviewCard push-kind (Gate-at-Push)', () => {
  const pendingCard = (overrides: Partial<CommitReviewCardData> = {}): CommitReviewCardData => ({
    kind: 'push',
    diff: {
      diff: 'diff --git a/x b/x',
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
    },
    auditVerdict: { verdict: 'safe', summary: 'safe', risks: [], filesReviewed: 1 },
    commitMessage: '',
    status: 'pending',
    ...overrides,
  });

  it('keeps Approve enabled on a push-kind card with no commit message', () => {
    const html = renderToStaticMarkup(
      <CommitReviewCard data={pendingCard()} messageId="m1" cardIndex={0} />,
    );
    // P1: an empty message must NOT disable the action (push commits already
    // exist), and there is no commit-message editor for push-kind. Match the
    // real `disabled=""` attribute, not the Tailwind `disabled:` class variants.
    expect(html).toContain('Approve');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Enter commit message...');
    expect(html).not.toContain('Commit message');
  });

  it('still disables actions on a commit-kind card with an empty message (control)', () => {
    const html = renderToStaticMarkup(
      <CommitReviewCard
        data={pendingCard({ kind: 'commit', commitMessage: '' })}
        messageId="m1"
        cardIndex={0}
      />,
    );
    expect(html).toContain('disabled=""');
  });
});
