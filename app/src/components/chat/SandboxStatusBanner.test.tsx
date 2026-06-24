import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SandboxStatusChip } from './SandboxStatusBanner';

const noop = vi.fn();

// The red top-of-chat SandboxStatusBanner was removed; the compact chip is the
// only surviving sandbox-status surface (error now lives in its tooltip).
describe('SandboxStatusChip', () => {
  it('renders a compact ambient status for non-ready states', () => {
    const html = renderToStaticMarkup(
      <SandboxStatusChip status="reconnecting" error={null} onOpenWorkspaceHub={noop} />,
    );

    expect(html).toContain('Reconnecting');
    expect(html).toContain('Open workspace');
  });

  it('stays hidden when the sandbox is ready', () => {
    const html = renderToStaticMarkup(
      <SandboxStatusChip status="ready" error={null} onOpenWorkspaceHub={noop} />,
    );

    expect(html).toBe('');
  });
});
