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
