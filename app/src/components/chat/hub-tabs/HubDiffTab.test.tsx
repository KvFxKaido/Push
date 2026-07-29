import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HubDiffTab } from './HubDiffTab';

describe('HubDiffTab', () => {
  it('does not claim the working tree is clean before its initial diff load', () => {
    const html = renderToStaticMarkup(
      <HubDiffTab
        ensureSandbox={vi.fn(async () => 'sbx-1')}
        diffData={null}
        diffLoading={false}
        diffError={null}
        diffLabel="main"
        diffMode="working-tree"
        jumpTarget={null}
        onDiffUpdate={vi.fn()}
        onDiffLoadingChange={vi.fn()}
      />,
    );

    expect(html).not.toContain('No working tree changes.');
    expect(html).toContain('Loading diff...');
    expect(html).not.toContain('Start a workspace to view diff.');
    expect(html).not.toContain('Start workspace');
  });
});

describe('HubDiffTab sanitized-only diffs', () => {
  it('does not report a clean tree when every change was a hidden sensitive file', () => {
    // What sanitizeNativeDiff returns when `.env` is the only change: the file
    // blocks are gone and a bare note remains, which parses to zero files.
    const html = renderToStaticMarkup(
      <HubDiffTab
        ensureSandbox={vi.fn(async () => 'sbx-1')}
        diffData={{
          diff: '[1 sensitive file diff hidden]',
          filesChanged: 0,
          additions: 0,
          deletions: 0,
          truncated: false,
        }}
        diffLoading={false}
        diffError={null}
        diffLabel="main"
        diffMode="working-tree"
        jumpTarget={null}
        onDiffUpdate={vi.fn()}
        onDiffLoadingChange={vi.fn()}
      />,
    );

    expect(html).not.toContain('No working tree changes.');
    expect(html).toContain('1 sensitive file diff hidden');
  });

  it('still reports a clean tree for a genuinely empty diff', () => {
    const html = renderToStaticMarkup(
      <HubDiffTab
        ensureSandbox={vi.fn(async () => 'sbx-1')}
        diffData={{ diff: '', filesChanged: 0, additions: 0, deletions: 0, truncated: false }}
        diffLoading={false}
        diffError={null}
        diffLabel="main"
        diffMode="working-tree"
        jumpTarget={null}
        onDiffUpdate={vi.fn()}
        onDiffLoadingChange={vi.fn()}
      />,
    );

    expect(html).toContain('No working tree changes.');
  });
});
