import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SandboxStatusBanner, SandboxStatusChip } from './SandboxStatusBanner';

const noop = vi.fn();

const baseBannerProps = {
  error: null,
  hasMessages: true,
  isStreaming: false,
  sandboxId: 'sbx-1',
  isInScratchWorkspace: false,
  onStart: noop,
  onRetry: noop,
  onNewSandbox: noop,
};

describe('SandboxStatusBanner', () => {
  it('keeps ambient sandbox states out of the top banner lane', () => {
    for (const status of ['idle', 'creating', 'reconnecting', 'ready'] as const) {
      const html = renderToStaticMarkup(
        <SandboxStatusBanner {...baseBannerProps} status={status} />,
      );

      expect(html).toBe('');
    }
  });

  it('keeps error as an actionable banner', () => {
    const html = renderToStaticMarkup(
      <SandboxStatusBanner {...baseBannerProps} status="error" error="connection refused" />,
    );

    expect(html).toContain('Sandbox unreachable');
    expect(html).toContain('Retry');
    expect(html).toContain('Restart runtime');
  });
});

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
