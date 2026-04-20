import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FileEntry, WorkspaceScratchActions } from '@/types';
import type { FileBrowserStatus } from '@/hooks/useFileBrowser';

type UseFileBrowserResult = {
  currentPath: string;
  files: FileEntry[];
  status: FileBrowserStatus;
  error: string | null;
  operations: unknown[];
  breadcrumbs: { label: string; path: string }[];
  loadDirectory: () => void;
  navigateTo: () => void;
  navigateUp: () => void;
  uploadFiles: () => void;
  deleteItem: () => void;
  renameItem: () => void;
};

const hookState = vi.hoisted(() => ({
  current: {
    currentPath: '/workspace',
    files: [] as FileEntry[],
    status: 'idle' as FileBrowserStatus,
    error: null as string | null,
    operations: [] as unknown[],
    breadcrumbs: [] as { label: string; path: string }[],
  },
}));

vi.mock('@/hooks/useFileBrowser', () => ({
  useFileBrowser: (): UseFileBrowserResult => ({
    ...hookState.current,
    loadDirectory: vi.fn(),
    navigateTo: vi.fn(),
    navigateUp: vi.fn(),
    uploadFiles: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
  }),
}));

vi.mock('@/lib/sandbox-client', () => ({
  writeToSandbox: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/file-awareness-ledger', () => ({
  fileLedger: { recordMutation: vi.fn() },
}));

vi.mock('@/components/filebrowser/FileActionsSheet', () => ({
  FileActionsSheet: () => null,
}));

vi.mock('@/components/filebrowser/CommitPushSheet', () => ({
  CommitPushSheet: () => null,
}));

vi.mock('@/components/filebrowser/UploadButton', () => ({
  UploadButton: ({ disabled }: { disabled?: boolean }) => (
    <button data-testid="upload-btn" disabled={disabled ?? false} type="button">
      Upload
    </button>
  ),
}));

vi.mock('@/components/filebrowser/FileEditor', () => ({
  FileEditor: ({ file }: { file: FileEntry }) => (
    <div data-testid="file-editor">Editing {file.name}</div>
  ),
}));

const { FileBrowser } = await import('./FileBrowser');

beforeEach(() => {
  hookState.current = {
    currentPath: '/workspace',
    files: [],
    status: 'idle',
    error: null,
    operations: [],
    breadcrumbs: [{ label: 'workspace', path: '/workspace' }],
  };
});

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'README.md',
    path: '/workspace/README.md',
    type: 'file',
    size: 42,
    ...overrides,
  } as FileEntry;
}

describe('FileBrowser', () => {
  it('renders the empty-directory state at the workspace root', () => {
    hookState.current.files = [];

    const html = renderToStaticMarkup(
      <FileBrowser
        sandboxId="sbx-1"
        workspaceLabel="my-repo"
        capabilities={{ canCommitAndPush: true }}
        onBack={vi.fn()}
      />,
    );

    expect(html).toContain('my-repo');
    expect(html).toContain('Empty directory');
    // Commit & push FAB is present when the workspace supports it.
    expect(html).toContain('Commit and push changes');
  });

  it('renders the error state with a retry button', () => {
    hookState.current.status = 'error';
    hookState.current.error = 'network down';

    const html = renderToStaticMarkup(
      <FileBrowser
        sandboxId="sbx-1"
        workspaceLabel="my-repo"
        capabilities={{ canCommitAndPush: false }}
        onBack={vi.fn()}
      />,
    );

    expect(html).toContain('network down');
    expect(html).toContain('Retry');
  });

  it('renders a list of files with directory and file entries', () => {
    hookState.current.files = [
      file({ name: 'src', path: '/workspace/src', type: 'directory' }),
      file({ name: 'README.md', path: '/workspace/README.md', size: 1024 }),
    ];

    const html = renderToStaticMarkup(
      <FileBrowser
        sandboxId="sbx-1"
        workspaceLabel="my-repo"
        capabilities={{ canCommitAndPush: true }}
        onBack={vi.fn()}
      />,
    );

    expect(html).toContain('src');
    expect(html).toContain('README.md');
    // File size is rendered via formatSize.
    expect(html).toMatch(/1\.0\s*KB|1024|1 KB/i);
  });

  it('hides the commit FAB and shows scratch actions when the workspace cannot commit/push', () => {
    hookState.current.files = [];
    const scratchActions: WorkspaceScratchActions = {
      statusText: 'Snapshot saved',
      tone: 'default',
      canSaveSnapshot: true,
      canRestoreSnapshot: true,
      canDownloadWorkspace: true,
      snapshotSaving: false,
      snapshotRestoring: false,
      downloadingWorkspace: false,
      onSaveSnapshot: vi.fn(),
      onRestoreSnapshot: vi.fn(),
      onDownloadWorkspace: vi.fn(),
    };

    const html = renderToStaticMarkup(
      <FileBrowser
        sandboxId="sbx-1"
        workspaceLabel="scratch"
        capabilities={{ canCommitAndPush: false }}
        scratchActions={scratchActions}
        onBack={vi.fn()}
      />,
    );

    expect(html).not.toContain('Commit and push changes');
    expect(html).toContain('Snapshot saved');
    expect(html).toContain('Save');
    expect(html).toContain('Restore');
    expect(html).toContain('Download');
  });

  it('shows breadcrumbs for nested paths', () => {
    hookState.current.currentPath = '/workspace/src/components';
    hookState.current.breadcrumbs = [
      { label: 'workspace', path: '/workspace' },
      { label: 'src', path: '/workspace/src' },
      { label: 'components', path: '/workspace/src/components' },
    ];

    const html = renderToStaticMarkup(
      <FileBrowser
        sandboxId="sbx-1"
        workspaceLabel="my-repo"
        capabilities={{ canCommitAndPush: true }}
        onBack={vi.fn()}
      />,
    );

    expect(html).toContain('my-repo');
    expect(html).toContain('src');
    expect(html).toContain('components');
  });
});
