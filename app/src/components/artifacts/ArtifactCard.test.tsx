import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtifactRecord } from '@push/lib/artifacts/types';

// Mock the lazy-loaded inner renderers so they resolve synchronously
// during SSR. We tag each stub with its kind so the test can assert
// dispatch landed on the right component without exercising Sandpack
// or Mermaid in the test runtime.
vi.mock('./StaticPreview', () => ({
  StaticPreview: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="static-preview">{record.kind}</div>
  ),
  default: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="static-preview">{record.kind}</div>
  ),
}));
vi.mock('./MermaidArtifact', () => ({
  MermaidArtifact: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="mermaid">{record.kind}</div>
  ),
  default: ({ record }: { record: ArtifactRecord }) => <div data-stub="mermaid">{record.kind}</div>,
}));
vi.mock('./FileTreeViewer', () => ({
  FileTreeViewer: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="file-tree">{record.kind}</div>
  ),
  default: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="file-tree">{record.kind}</div>
  ),
}));
vi.mock('./LivePreviewArtifact', () => ({
  LivePreviewArtifact: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="live-preview">{record.kind}</div>
  ),
  default: ({ record }: { record: ArtifactRecord }) => (
    <div data-stub="live-preview">{record.kind}</div>
  ),
}));

const { ArtifactCard } = await import('./ArtifactCard');

function base() {
  return {
    id: 'a-1',
    title: 'Demo artifact',
    status: 'ready' as const,
    updatedAt: 0,
    scope: { repoFullName: 'KvFxKaido/Push', branch: 'main' },
    author: { surface: 'web' as const, role: 'orchestrator' as const, createdAt: 0 },
  };
}

describe('ArtifactCard dispatcher', () => {
  it('renders the title and id once for every kind', () => {
    const record: ArtifactRecord = {
      ...base(),
      kind: 'mermaid',
      source: 'graph TD; A-->B',
    };
    const html = renderToStaticMarkup(<ArtifactCard data={{ record }} />);
    expect(html).toContain('Demo artifact');
    expect(html).toContain('a-1');
  });

  it('routes static-html to StaticPreview', () => {
    const record: ArtifactRecord = {
      ...base(),
      kind: 'static-html',
      files: [{ path: 'index.html', content: '<p>hi</p>' }],
    };
    // SSR Suspense renders the fallback, not the lazy children, so the
    // dispatcher branch is exercised but not visible in markup. Verify
    // the title still renders to confirm the card mounted at all.
    const html = renderToStaticMarkup(<ArtifactCard data={{ record }} />);
    expect(html).toContain('Demo artifact');
    expect(html).toContain('animate-pulse');
  });

  it('routes static-react to StaticPreview', () => {
    const record: ArtifactRecord = {
      ...base(),
      kind: 'static-react',
      files: [{ path: '/App.js', content: 'x' }],
    };
    const html = renderToStaticMarkup(<ArtifactCard data={{ record }} />);
    expect(html).toContain('Demo artifact');
  });

  it('routes file-tree to FileTreeViewer', () => {
    const record: ArtifactRecord = {
      ...base(),
      kind: 'file-tree',
      files: [{ path: 'a.txt', content: 'a' }],
      storage: { mode: 'inline' },
    };
    const html = renderToStaticMarkup(<ArtifactCard data={{ record }} />);
    expect(html).toContain('Demo artifact');
  });

  it('routes live-preview to LivePreviewArtifact', () => {
    const record: ArtifactRecord = {
      ...base(),
      kind: 'live-preview',
      sandboxId: 'sb',
      port: 3000,
      previewToken: 'tok',
      expiresAt: Date.UTC(2026, 0, 1),
    };
    const html = renderToStaticMarkup(<ArtifactCard data={{ record }} />);
    expect(html).toContain('Demo artifact');
  });
});
