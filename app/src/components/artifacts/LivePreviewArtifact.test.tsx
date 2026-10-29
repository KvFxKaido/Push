import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtifactRecord } from '@push/lib/artifacts/types';
import { LivePreviewArtifact } from './LivePreviewArtifact';

function record(): Extract<ArtifactRecord, { kind: 'live-preview' }> {
  return {
    id: 'a-1',
    title: 'Vite dev server',
    kind: 'live-preview',
    status: 'ready',
    updatedAt: 0,
    scope: { repoFullName: 'KvFxKaido/Push', branch: 'main' },
    author: { surface: 'web', role: 'orchestrator', createdAt: 0 },
    sandboxId: 'sb-123',
    port: 5173,
    previewToken: 'tok-abc',
    expiresAt: Date.UTC(2026, 4, 7, 12, 0, 0),
    startCommand: 'npm run dev',
  };
}

describe('LivePreviewArtifact', () => {
  it('renders the coming-soon stub and the captured metadata', () => {
    const html = renderToStaticMarkup(<LivePreviewArtifact record={record()} />);
    expect(html).toContain('Live preview coming soon');
    expect(html).toContain('sb-123');
    expect(html).toContain('5173');
    expect(html).toContain('npm run dev');
  });

  it('formats the expiry timestamp as ISO', () => {
    const html = renderToStaticMarkup(<LivePreviewArtifact record={record()} />);
    expect(html).toContain('2026-05-07T12:00:00.000Z');
  });

  it('omits the start command row when none was captured', () => {
    const r = { ...record(), startCommand: undefined };
    const html = renderToStaticMarkup(<LivePreviewArtifact record={r} />);
    expect(html).not.toContain('Start');
  });
});
