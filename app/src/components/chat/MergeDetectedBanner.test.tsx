import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MergeDetectedBanner } from './MergeDetectedBanner';

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
    const element = MergeDetectedBanner({
      branch: 'feature/merged',
      defaultBranch: 'main',
      pr: {
        number: 42,
        title: 'Ship it',
        url: 'https://github.test/pr/42',
        mergedAt: '2026-06-12T00:00:00Z',
        baseBranch: 'main',
        headSha: 'sha-merged',
      },
      mergeBranchInUI,
      onDismiss: vi.fn(),
    });

    findButtonByText(element, 'Continue on main').props.onClick();

    expect(mergeBranchInUI).toHaveBeenCalledWith('main', {
      from: 'feature/merged',
      prNumber: 42,
      source: 'merge_detected',
    });
  });
});
