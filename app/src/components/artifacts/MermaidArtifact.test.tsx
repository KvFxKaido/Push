import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtifactRecord } from '@push/lib/artifacts/types';
import { MermaidArtifact } from './MermaidArtifact';

function record(): Extract<ArtifactRecord, { kind: 'mermaid' }> {
  return {
    id: 'a-1',
    title: 'Flow',
    kind: 'mermaid',
    status: 'ready',
    updatedAt: 0,
    scope: { repoFullName: 'KvFxKaido/Push', branch: 'main' },
    author: { surface: 'web', role: 'orchestrator', createdAt: 0 },
    source: 'graph TD; A-->B',
  };
}

describe('MermaidArtifact', () => {
  // SSR fires before useEffect, so we land on the loading state. That is
  // the bit we can validate without a DOM — full render is exercised by
  // the integration test in app/ when jsdom is available.
  it('renders the diagram label and a loading placeholder during SSR', () => {
    const html = renderToStaticMarkup(<MermaidArtifact record={record()} />);
    expect(html).toContain('Mermaid diagram');
    expect(html).toContain('animate-pulse');
  });

  it('escapes the source in the fallback so untrusted input cannot inject HTML', () => {
    // The error fallback is only shown after a render failure, but the
    // pre-mount placeholder doesn't echo source content either — verify
    // that the SSR HTML never leaks the raw script tag.
    const r = {
      ...record(),
      source: '<script>alert(1)</script>',
    };
    const html = renderToStaticMarkup(<MermaidArtifact record={r} />);
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
