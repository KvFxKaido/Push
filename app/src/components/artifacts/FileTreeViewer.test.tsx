import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtifactRecord } from '@push/lib/artifacts/types';
import { FileTreeViewer } from './FileTreeViewer';

function record(): Extract<ArtifactRecord, { kind: 'file-tree' }> {
  return {
    id: 'a-1',
    title: 'Demo',
    kind: 'file-tree',
    status: 'ready',
    updatedAt: 0,
    scope: { repoFullName: 'KvFxKaido/Push', branch: 'main' },
    author: { surface: 'web', role: 'orchestrator', createdAt: 0 },
    storage: { mode: 'inline' },
    files: [
      { path: 'README.md', content: '# Hello' },
      { path: 'src/app.ts', content: 'export const x = 1;' },
    ],
  };
}

describe('FileTreeViewer', () => {
  it('lists every file path and shows the first file content by default', () => {
    const html = renderToStaticMarkup(<FileTreeViewer record={record()} />);
    expect(html).toContain('README.md');
    expect(html).toContain('src/app.ts');
    // First in alphabetic order is README.md
    expect(html).toContain('# Hello');
  });

  it('renders a file count summary', () => {
    const html = renderToStaticMarkup(<FileTreeViewer record={record()} />);
    expect(html).toContain('2 files');
  });

  it('handles a single-file tree with the singular label', () => {
    const single = { ...record(), files: [{ path: 'only.md', content: 'solo' }] };
    const html = renderToStaticMarkup(<FileTreeViewer record={single} />);
    expect(html).toContain('1 file');
    expect(html).not.toContain('1 files');
  });
});
