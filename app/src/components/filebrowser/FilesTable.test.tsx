import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileEntry } from '@/types';
import { FilesTable } from './FilesTable';
import { sortFileEntries } from '@/lib/file-table-sort';

function entry(overrides: Partial<FileEntry>): FileEntry {
  return {
    name: 'file.txt',
    path: `/workspace/${overrides.name ?? 'file.txt'}`,
    type: 'file',
    size: 10,
    ...overrides,
  };
}

const FILES: FileEntry[] = [
  entry({ name: 'zeta.ts', size: 300 }),
  entry({ name: 'src', type: 'directory', size: 0 }),
  entry({ name: 'alpha.md', size: 2048 }),
  entry({ name: 'docs', type: 'directory', size: 0 }),
];

describe('sortFileEntries', () => {
  it('groups directories first and sorts names ascending by default', () => {
    expect(sortFileEntries(FILES, 'name', 'asc').map((f) => f.name)).toEqual([
      'docs',
      'src',
      'alpha.md',
      'zeta.ts',
    ]);
  });

  it('reverses names on descending while keeping directories grouped first', () => {
    expect(sortFileEntries(FILES, 'name', 'desc').map((f) => f.name)).toEqual([
      'src',
      'docs',
      'zeta.ts',
      'alpha.md',
    ]);
  });

  it('sorts files by size but keeps directories in ascending name order', () => {
    // A directory's listed size is meaningless, so size sort must not
    // reorder the directory group — only the files.
    expect(sortFileEntries(FILES, 'size', 'desc').map((f) => f.name)).toEqual([
      'docs',
      'src',
      'alpha.md',
      'zeta.ts',
    ]);
    expect(sortFileEntries(FILES, 'size', 'asc').map((f) => f.name)).toEqual([
      'docs',
      'src',
      'zeta.ts',
      'alpha.md',
    ]);
  });

  it('tie-breaks equal sizes by name so the order is stable', () => {
    const equal = [entry({ name: 'b.txt', size: 5 }), entry({ name: 'a.txt', size: 5 })];
    expect(sortFileEntries(equal, 'size', 'asc').map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('compares names numerically (file2 before file10)', () => {
    const numbered = [entry({ name: 'file10.txt' }), entry({ name: 'file2.txt' })];
    expect(sortFileEntries(numbered, 'name', 'asc').map((f) => f.name)).toEqual([
      'file2.txt',
      'file10.txt',
    ]);
  });
});

describe('FilesTable', () => {
  const noop = vi.fn();

  it('renders sortable column headers with aria-sort on the active column', () => {
    const html = renderToStaticMarkup(
      <FilesTable files={FILES} isRoot onNavigateUp={noop} onTap={noop} onLongPress={noop} />,
    );
    expect(html).toContain('Name');
    expect(html).toContain('Size');
    // Default sort is name ascending; the inactive column reports no sort.
    expect(html).toContain('aria-sort="ascending"');
    expect((html.match(/aria-sort=/g) ?? []).length).toBe(1);
  });

  it('renders directories before files with the size column formatted', () => {
    const html = renderToStaticMarkup(
      <FilesTable files={FILES} isRoot onNavigateUp={noop} onTap={noop} onLongPress={noop} />,
    );
    expect(html.indexOf('docs')).toBeLessThan(html.indexOf('alpha.md'));
    expect(html.indexOf('src')).toBeLessThan(html.indexOf('zeta.ts'));
    // 2048 bytes renders through formatSize, not as a raw byte count.
    expect(html).toMatch(/2(\.0)?\s*KB/i);
  });

  it('shows the navigate-up row only outside the root', () => {
    const atRoot = renderToStaticMarkup(
      <FilesTable files={FILES} isRoot onNavigateUp={noop} onTap={noop} onLongPress={noop} />,
    );
    expect(atRoot).not.toContain('..');

    const nested = renderToStaticMarkup(
      <FilesTable
        files={FILES}
        isRoot={false}
        onNavigateUp={noop}
        onTap={noop}
        onLongPress={noop}
      />,
    );
    expect(nested).toContain('..');
    // The up-row is keyboard-reachable, not click-only (Codex P2 / fugu
    // WARNING on #1408): focusable with an accessible name, like file rows.
    expect(nested).toContain('aria-label="Navigate up"');
    expect(nested).toMatch(
      /aria-label="Navigate up"[^>]*tabindex="0"|tabindex="0"[^>]*aria-label="Navigate up"/,
    );
  });
});
