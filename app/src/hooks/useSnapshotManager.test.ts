import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveRepo, WorkspaceSession } from '@/types';
import type { SandboxStatus } from './useSandbox';

const snapshotLib = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  saveSnapshotToIndexedDB: vi.fn(),
  getLatestSnapshotBlob: vi.fn(),
  getLatestSnapshotMeta: vi.fn(),
  hydrateSnapshot: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  message: vi.fn<(msg: string) => void>(),
}));

vi.mock('@/lib/snapshot-manager', () => snapshotLib);
vi.mock('sonner', () => ({ toast }));

// The hook touches window.confirm and window.setInterval/addEventListener.
// Provide a minimal global window shim for the node test environment.
type WindowLike = {
  confirm: (msg?: string) => boolean;
  addEventListener: (...args: unknown[]) => void;
  removeEventListener: (...args: unknown[]) => void;
  setInterval: (...args: unknown[]) => number;
  clearInterval: (id: number) => void;
};
const windowShim: WindowLike = {
  confirm: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};
vi.stubGlobal('window', windowShim);

type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
}));

vi.mock('react', () => ({
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.cells[i] = { value: seed };
    }
    const cell = reactState.cells[i];
    const setter = (v: T | ((prev: T) => T)) => {
      cell.value = typeof v === 'function' ? (v as (prev: T) => T)(cell.value as T) : v;
    };
    return [cell.value as T, setter];
  },
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

const {
  useSnapshotManager,
  formatSnapshotAge,
  isSnapshotStale,
  snapshotStagePercent,
  buildWorkspaceScratchActions,
  SNAPSHOT_STALE_MS,
} = await import('./useSnapshotManager');

function render(
  opts: {
    session?: WorkspaceSession | null;
    sandbox?: {
      sandboxId: string | null;
      status: SandboxStatus;
      start?: ReturnType<typeof vi.fn>;
    };
    repo?: ActiveRepo | null;
    isStreaming?: boolean;
  } = {},
) {
  reactState.index = 0;
  reactState.refIndex = 0;
  const sandbox = opts.sandbox
    ? {
        sandboxId: opts.sandbox.sandboxId,
        status: opts.sandbox.status,
        start: opts.sandbox.start ?? vi.fn(async () => 'sbx-new'),
      }
    : {
        sandboxId: 'sbx-1' as string | null,
        status: 'ready' as SandboxStatus,
        start: vi.fn(async () => 'sbx-new'),
      };
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSnapshotManager(
    opts.session ?? ({ kind: 'scratch', id: 'session-1' } as WorkspaceSession),
    sandbox,
    opts.repo ?? null,
    opts.isStreaming ?? false,
  );
}

beforeEach(() => {
  // Re-stub after any prior test's afterEach unstubbed globals.
  vi.stubGlobal('window', windowShim);
  Object.values(snapshotLib).forEach((m) => m.mockReset());
  toast.success.mockReset();
  toast.error.mockReset();
  toast.message.mockReset();
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatSnapshotAge', () => {
  it('returns "just now" when under a minute', () => {
    expect(formatSnapshotAge(Date.now() - 30_000)).toBe('just now');
  });
  it('returns minutes-ago for times under an hour', () => {
    expect(formatSnapshotAge(Date.now() - 5 * 60_000)).toBe('5m ago');
  });
  it('returns hours-ago for times under a day', () => {
    expect(formatSnapshotAge(Date.now() - 3 * 60 * 60_000)).toBe('3h ago');
  });
  it('returns days-ago for older times', () => {
    expect(formatSnapshotAge(Date.now() - 2 * 24 * 60 * 60_000)).toBe('2d ago');
  });
});

describe('isSnapshotStale', () => {
  it('reports stale when older than the stale cutoff', () => {
    expect(isSnapshotStale(Date.now() - SNAPSHOT_STALE_MS - 1000)).toBe(true);
  });
  it('reports fresh when well within the cutoff', () => {
    expect(isSnapshotStale(Date.now() - 60_000)).toBe(false);
  });
});

describe('snapshotStagePercent', () => {
  it('maps known stages to expected percentages', () => {
    expect(snapshotStagePercent('uploading')).toBe(20);
    expect(snapshotStagePercent('restoring')).toBe(60);
    expect(snapshotStagePercent('validating')).toBe(85);
    expect(snapshotStagePercent('done')).toBe(100);
  });
  it('returns 0 for unknown stages', () => {
    expect(snapshotStagePercent('bogus' as never)).toBe(0);
  });
});

describe('buildWorkspaceScratchActions', () => {
  const snapshots = {
    latestSnapshot: null,
    snapshotSaving: false,
    snapshotRestoring: false,
    captureSnapshot: vi.fn(),
    handleRestoreFromSnapshot: vi.fn(),
  };

  it('falls back to the empty-state text when no snapshot exists', () => {
    const actions = buildWorkspaceScratchActions({
      snapshots,
      sandboxStatus: 'ready' as SandboxStatus,
      downloadingWorkspace: false,
      onDownloadWorkspace: vi.fn(),
      emptyStateText: 'No snapshot yet',
    });
    expect(actions.statusText).toBe('No snapshot yet');
    expect(actions.tone).toBe('default');
    expect(actions.canSaveSnapshot).toBe(true);
    expect(actions.canRestoreSnapshot).toBe(false);
  });

  it('marks the snapshot stale when older than the cutoff', () => {
    const actions = buildWorkspaceScratchActions({
      snapshots: {
        ...snapshots,
        latestSnapshot: {
          createdAt: Date.now() - SNAPSHOT_STALE_MS - 1000,
        } as never,
      },
      sandboxStatus: 'ready' as SandboxStatus,
      downloadingWorkspace: false,
      onDownloadWorkspace: vi.fn(),
      emptyStateText: '',
    });
    expect(actions.tone).toBe('stale');
    expect(actions.statusText).toContain('stale');
    expect(actions.canRestoreSnapshot).toBe(true);
  });

  it('disables save while saving/restoring or not ready', () => {
    expect(
      buildWorkspaceScratchActions({
        snapshots: { ...snapshots, snapshotSaving: true },
        sandboxStatus: 'ready' as SandboxStatus,
        downloadingWorkspace: false,
        onDownloadWorkspace: vi.fn(),
        emptyStateText: '',
      }).canSaveSnapshot,
    ).toBe(false);
    expect(
      buildWorkspaceScratchActions({
        snapshots,
        sandboxStatus: 'creating' as SandboxStatus,
        downloadingWorkspace: false,
        onDownloadWorkspace: vi.fn(),
        emptyStateText: '',
      }).canSaveSnapshot,
    ).toBe(false);
  });
});

describe('useSnapshotManager.captureSnapshot', () => {
  it('returns false when sandbox is not ready', async () => {
    const mgr = render({
      sandbox: { sandboxId: 'sbx-1', status: 'creating' as SandboxStatus },
    });
    const ok = await mgr.captureSnapshot('manual');
    expect(ok).toBe(false);
    expect(snapshotLib.createSnapshot).not.toHaveBeenCalled();
  });

  it('saves the snapshot, updates latest meta, and toasts on manual success', async () => {
    snapshotLib.createSnapshot.mockResolvedValue(new Blob(['x']));
    snapshotLib.saveSnapshotToIndexedDB.mockResolvedValue(undefined);
    snapshotLib.getLatestSnapshotMeta.mockResolvedValue({
      createdAt: 1000,
    });

    const mgr = render();
    const ok = await mgr.captureSnapshot('manual');
    expect(ok).toBe(true);
    expect(snapshotLib.createSnapshot).toHaveBeenCalledWith('/workspace', 'sbx-1');
    expect(snapshotLib.saveSnapshotToIndexedDB).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Snapshot saved');
  });

  it('toasts on manual failure and stays silent on interval failure', async () => {
    snapshotLib.createSnapshot.mockRejectedValue(new Error('disk full'));

    const mgr = render();
    const manualFail = await mgr.captureSnapshot('manual');
    expect(manualFail).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('disk full');

    toast.error.mockReset();
    snapshotLib.createSnapshot.mockRejectedValue(new Error('disk full'));
    const mgr2 = render();
    const intervalFail = await mgr2.captureSnapshot('interval');
    expect(intervalFail).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('useSnapshotManager.handleRestoreFromSnapshot', () => {
  it('shows an error when no snapshot exists', async () => {
    snapshotLib.getLatestSnapshotBlob.mockResolvedValue(null);
    const mgr = render();
    await mgr.handleRestoreFromSnapshot();
    expect(toast.error).toHaveBeenCalledWith('No snapshot found');
  });

  it('hydrates the snapshot and reports success when the sandbox is already up', async () => {
    snapshotLib.getLatestSnapshotBlob.mockResolvedValue(new Blob(['x']));
    snapshotLib.hydrateSnapshot.mockResolvedValue({
      ok: true,
      restoredFiles: 3,
    });
    // Existing sandbox → window.confirm is invoked.
    const confirmSpy = vi.spyOn(windowShim, 'confirm').mockImplementation(() => true);
    const mgr = render();
    await mgr.handleRestoreFromSnapshot();
    expect(snapshotLib.hydrateSnapshot).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Snapshot restored (3 files)');
    confirmSpy.mockRestore();
  });

  it('aborts when the user dismisses the confirm dialog', async () => {
    snapshotLib.getLatestSnapshotBlob.mockResolvedValue(new Blob(['x']));
    const confirmSpy = vi.spyOn(windowShim, 'confirm').mockImplementation(() => false);
    const mgr = render();
    await mgr.handleRestoreFromSnapshot();
    expect(snapshotLib.hydrateSnapshot).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('starts a fresh scratch sandbox when none is active before restoring', async () => {
    const start = vi.fn(async () => 'sbx-new');
    snapshotLib.getLatestSnapshotBlob.mockResolvedValue(new Blob(['x']));
    snapshotLib.hydrateSnapshot.mockResolvedValue({ ok: true });
    const mgr = render({
      sandbox: { sandboxId: null, status: 'idle' as SandboxStatus, start },
    });
    await mgr.handleRestoreFromSnapshot();
    expect(start).toHaveBeenCalledWith('', 'main');
    expect(snapshotLib.hydrateSnapshot).toHaveBeenCalled();
  });

  it('reports an error when hydrate returns ok:false', async () => {
    snapshotLib.getLatestSnapshotBlob.mockResolvedValue(new Blob(['x']));
    snapshotLib.hydrateSnapshot.mockResolvedValue({
      ok: false,
      error: 'bad tar',
    });
    const confirmSpy = vi.spyOn(windowShim, 'confirm').mockImplementation(() => true);
    const mgr = render();
    await mgr.handleRestoreFromSnapshot();
    expect(toast.error).toHaveBeenCalledWith('bad tar');
    confirmSpy.mockRestore();
  });
});

describe('useSnapshotManager.refreshLatestSnapshot', () => {
  it('stores the fetched meta', async () => {
    snapshotLib.getLatestSnapshotMeta.mockResolvedValue({
      createdAt: 123,
    });
    const mgr = render();
    await mgr.refreshLatestSnapshot();
    expect(reactState.cells[0].value).toEqual({ createdAt: 123 });
  });

  it('resets to null when getLatestSnapshotMeta throws', async () => {
    snapshotLib.getLatestSnapshotMeta.mockRejectedValue(new Error('boom'));
    const mgr = render();
    await mgr.refreshLatestSnapshot();
    expect(reactState.cells[0].value).toBeNull();
  });
});
