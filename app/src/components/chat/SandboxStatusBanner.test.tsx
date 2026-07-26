import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SandboxStatusChip } from './SandboxStatusBanner';

const noop = vi.fn();

// The red top-of-chat SandboxStatusBanner was removed; the compact chip keeps
// only the creating and error states until local-first entry absorbs creating.
describe('SandboxStatusChip', () => {
  it('renders the creating state', () => {
    const html = renderToStaticMarkup(
      <SandboxStatusChip status="creating" error={null} onOpenWorkspaceHub={noop} />,
    );

    expect(html).toContain('Starting');
    expect(html).toContain('Open workspace');
  });

  it.each(['ready', 'reconnecting', 'idle'] as const)(
    'stays hidden when status is %s',
    (status) => {
      const html = renderToStaticMarkup(
        <SandboxStatusChip status={status} error={null} onOpenWorkspaceHub={noop} />,
      );

      expect(html).toBe('');
    },
  );

  it('renders the error state', () => {
    const html = renderToStaticMarkup(
      <SandboxStatusChip status="error" error="connection refused" onOpenWorkspaceHub={noop} />,
    );

    expect(html).toContain('Sandbox');
    expect(html).toContain('Open workspace');
  });
});
