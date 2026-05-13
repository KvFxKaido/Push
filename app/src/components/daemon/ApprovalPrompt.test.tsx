/**
 * ApprovalPrompt.test.tsx — Phase 3 slice 4 coverage. SSR-style
 * renderToStaticMarkup so we don't pull in a DOM testing library
 * (matches the project's existing component-test style; the
 * onDecide callback is exercised by the LocalPcChatScreen test
 * indirectly through the queue wiring).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApprovalPrompt, type PendingApproval } from './ApprovalPrompt';

function makePending(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'apv_test_1',
    sessionId: 'sess_test_1',
    runId: 'run_test_1',
    kind: 'sandbox_exec',
    title: 'Approve sandbox_exec',
    summary: 'rm -rf /tmp/something',
    options: ['approve', 'deny'],
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('ApprovalPrompt', () => {
  it('renders null when there is no pending approval', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt pending={null} queuedBehind={0} onDecide={vi.fn()} />,
    );
    expect(html).toBe('');
  });

  it('renders the title, kind chip, and summary when pending is set', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt
        pending={makePending({
          title: 'Approve a thing',
          kind: 'sandbox_exec',
          summary: 'detail-line',
        })}
        queuedBehind={0}
        onDecide={vi.fn()}
      />,
    );
    expect(html).toContain('Approve a thing');
    expect(html).toContain('sandbox_exec');
    expect(html).toContain('detail-line');
  });

  it('renders Approve and Deny buttons with accessible labels', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt pending={makePending()} queuedBehind={0} onDecide={vi.fn()} />,
    );
    expect(html).toContain('aria-label="Approve"');
    expect(html).toContain('aria-label="Deny"');
  });

  it('surfaces the queue counter when more approvals are pending', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt pending={makePending()} queuedBehind={3} onDecide={vi.fn()} />,
    );
    expect(html).toContain('3 more approvals waiting');
  });

  it('omits the counter when nothing is queued behind the head', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt pending={makePending()} queuedBehind={0} onDecide={vi.fn()} />,
    );
    expect(html).not.toContain('more approvals waiting');
    expect(html).not.toContain('more approval waiting');
  });

  it('uses singular "approval" copy when one approval is queued behind', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt pending={makePending()} queuedBehind={1} onDecide={vi.fn()} />,
    );
    expect(html).toContain('1 more approval waiting');
  });

  it('marks itself as a dialog with an accessible name', () => {
    const html = renderToStaticMarkup(
      <ApprovalPrompt pending={makePending()} queuedBehind={0} onDecide={vi.fn()} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Approval required"');
  });
});
