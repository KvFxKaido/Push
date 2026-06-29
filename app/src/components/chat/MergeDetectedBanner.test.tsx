import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MergeDetectedBannerView } from './MergeDetectedBanner';

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

describe('MergeDetectedBanner', () => {
  it('continues the chat via mergeBranchInUI with merge-detected provenance', () => {
    const mergeBranchInUI = vi.fn();
    const onContinue = vi.fn(() => {
      void mergeBranchInUI('develop', {
        from: 'feature/merged',
        prNumber: 42,
        source: 'merge_detected',
      });
    });
    const element = MergeDetectedBannerView({
      branch: 'feature/merged',
      defaultBranch: 'main',
      baseBranch: 'develop',
      pr: {
        number: 42,
        title: 'Ship it',
        url: 'https://github.test/pr/42',
        mergedAt: '2026-06-12T00:00:00Z',
        baseBranch: 'develop',
        headSha: 'sha-merged',
      },
      onContinue,
      onDismiss: vi.fn(),
    });

    findButtonByText(element, 'Continue on develop').props.onClick();

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(mergeBranchInUI).toHaveBeenCalledWith('develop', {
      from: 'feature/merged',
      prNumber: 42,
      source: 'merge_detected',
    });
  });
});
