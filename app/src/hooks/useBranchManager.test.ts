import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveRepo, WorkspaceSession } from '@/types';

const fetchRepoBranches = vi.hoisted(() =>
  vi.fn<(repo: string, limit?: number) => Promise<{ branches: unknown[] }>>(),
);
const executeDeleteBranch = vi.hoisted(() =>
  vi.fn<(repo: string, branch: string) => Promise<unknown>>(),
);
const toast = vi.hoisted(() => ({
  success: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
}));

vi.mock('@/lib/github-tools', () => ({
  fetchRepoBranches: (...args: Parameters<typeof fetchRepoBranches>) => fetchRepoBranches(...args),
  executeDeleteBranch: (...args: Parameters<typeof executeDeleteBranch>) =>
    executeDeleteBranch(...args),
}));

vi.mock('sonner', () => ({ toast }));

// Minimal react mock — each useState slot keeps its own hoisted cell, which
// lets us observe/update state across renders within a single test.
type Cell = { value: unknown };
const reactState = vi.hoisted(() => ({
  cells: [] as Cell[],
  index: 0,
  refs: [] as { current: unknown }[],
  refIndex: 0,
  effects: [] as { fn: () => void | (() => void); deps?: unknown[] }[],
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
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
    reactState.effects.push({ fn, deps });
  },
  useMemo: <T>(fn: () => T) => fn(),
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
}));

const { useBranchManager } = await import('./useBranchManager');

function makeRepo(overrides: Partial<ActiveRepo> = {}): ActiveRepo {
  return {
    id: 1,
    name: 'repo',
    full_name: 'owner/repo',
    default_branch: 'main',
    current_branch: 'feature',
    ...overrides,
  } as ActiveRepo;
}

function repoSession(): WorkspaceSession {
  return { kind: 'repo' } as WorkspaceSession;
}

function resetState() {
  reactState.cells = [];
  reactState.index = 0;
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.effects = [];
}

function render(
  repo: ActiveRepo | null,
  session: WorkspaceSession | null,
): ReturnType<typeof useBranchManager> {
  reactState.index = 0;
  reactState.refIndex = 0;
  reactState.effects = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useBranchManager(repo, session);
}

beforeEach(() => {
  fetchRepoBranches.mockReset();
  executeDeleteBranch.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  resetState();
});

describe('useBranchManager', () => {
  it('derives currentBranch and isOnMain when a repo is active', () => {
    const result = render(
      makeRepo({ current_branch: 'main', default_branch: 'main' }),
      repoSession(),
    );
    expect(result.currentBranch).toBe('main');
    expect(result.isOnMain).toBe(true);
  });

  it('reports isOnMain=false when current_branch differs from default_branch', () => {
    const result = render(
      makeRepo({ current_branch: 'feature/x', default_branch: 'main' }),
      repoSession(),
    );
    expect(result.currentBranch).toBe('feature/x');
    expect(result.isOnMain).toBe(false);
  });

  it('prepends currentBranch to displayBranches when not present in the fetched list', () => {
    const result = render(makeRepo({ current_branch: 'feature/x' }), repoSession());
    // Seed fetched branches by mutating cell 0 (repoBranches).
    reactState.cells[0].value = [{ name: 'main', isDefault: true, isProtected: false }];
    const result2 = render(makeRepo({ current_branch: 'feature/x' }), repoSession());
    expect(result2.displayBranches.map((b) => b.name)).toEqual(['feature/x', 'main']);
    expect(result2.displayBranches[0]).toMatchObject({
      name: 'feature/x',
      isDefault: false,
      isProtected: false,
    });
    expect(result).toBeDefined();
  });

  it('loadRepoBranches populates repoBranches on success', async () => {
    const branches = [
      { name: 'main', isDefault: true, isProtected: true },
      { name: 'dev', isDefault: false, isProtected: false },
    ];
    fetchRepoBranches.mockResolvedValue({ branches });
    const result = render(makeRepo(), repoSession());
    await result.loadRepoBranches('owner/repo');
    expect(fetchRepoBranches).toHaveBeenCalledWith('owner/repo', 500);
    expect(reactState.cells[0].value).toEqual(branches);
    // loading flag was toggled back to false
    expect(reactState.cells[1].value).toBe(false);
  });

  it('loadRepoBranches records the error message on failure', async () => {
    fetchRepoBranches.mockRejectedValue(new Error('boom'));
    const result = render(makeRepo(), repoSession());
    await result.loadRepoBranches('owner/repo');
    expect(reactState.cells[0].value).toEqual([]);
    expect(reactState.cells[2].value).toBe('boom');
  });

  it('handleDeleteBranch refuses to delete the current branch', async () => {
    const result = render(
      makeRepo({ current_branch: 'main', default_branch: 'main' }),
      repoSession(),
    );
    const ok = await result.handleDeleteBranch('main');
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Cannot delete current branch "main"');
    expect(executeDeleteBranch).not.toHaveBeenCalled();
  });

  it('handleDeleteBranch refuses to delete the default branch', async () => {
    const result = render(
      makeRepo({ current_branch: 'feature', default_branch: 'main' }),
      repoSession(),
    );
    const ok = await result.handleDeleteBranch('main');
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Cannot delete default branch "main"');
  });

  it('handleDeleteBranch refuses to delete a protected branch', async () => {
    const result = render(
      makeRepo({ current_branch: 'feature', default_branch: 'main' }),
      repoSession(),
    );
    // Seed displayBranches by stuffing repoBranches cell
    reactState.cells[0].value = [{ name: 'release', isDefault: false, isProtected: true }];
    const result2 = render(
      makeRepo({ current_branch: 'feature', default_branch: 'main' }),
      repoSession(),
    );
    const ok = await result2.handleDeleteBranch('release');
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Cannot delete protected branch "release"');
    expect(result).toBeDefined();
  });

  it('handleDeleteBranch succeeds and reloads branches', async () => {
    executeDeleteBranch.mockResolvedValue(undefined);
    fetchRepoBranches.mockResolvedValue({ branches: [] });
    const result = render(
      makeRepo({ current_branch: 'feature', default_branch: 'main' }),
      repoSession(),
    );
    const ok = await result.handleDeleteBranch('old-branch');
    expect(ok).toBe(true);
    expect(executeDeleteBranch).toHaveBeenCalledWith('owner/repo', 'old-branch');
    expect(toast.success).toHaveBeenCalledWith('Deleted branch "old-branch"');
    expect(fetchRepoBranches).toHaveBeenCalled();
  });

  it('handleDeleteBranch strips the [Tool Error] prefix from error messages', async () => {
    executeDeleteBranch.mockRejectedValue(new Error('[Tool Error] branch gone'));
    const result = render(
      makeRepo({ current_branch: 'feature', default_branch: 'main' }),
      repoSession(),
    );
    const ok = await result.handleDeleteBranch('old-branch');
    expect(ok).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('branch gone');
  });

  it('handleDeleteBranch returns false when no active repo is present', async () => {
    const result = render(null, null);
    const ok = await result.handleDeleteBranch('anything');
    expect(ok).toBe(false);
    expect(executeDeleteBranch).not.toHaveBeenCalled();
  });

  it('handleDeleteBranch returns false for an empty branch name', async () => {
    const result = render(makeRepo(), repoSession());
    const ok = await result.handleDeleteBranch('   ');
    expect(ok).toBe(false);
    expect(executeDeleteBranch).not.toHaveBeenCalled();
  });

  it('the auto-load effect clears branches and aborts when no repo is active', () => {
    render(null, null);
    // Seed some branches so we can watch them get cleared.
    reactState.cells[0].value = [{ name: 'main', isDefault: true, isProtected: false }];
    // Re-render & run the effect.
    render(null, null);
    reactState.effects[0]?.fn();
    expect(reactState.cells[0].value).toEqual([]);
    expect(fetchRepoBranches).not.toHaveBeenCalled();
  });

  it('the auto-load effect fires loadRepoBranches when a repo+session is active', async () => {
    fetchRepoBranches.mockResolvedValue({ branches: [] });
    render(makeRepo(), repoSession());
    const effect = reactState.effects[0];
    expect(effect).toBeDefined();
    await effect?.fn();
    expect(fetchRepoBranches).toHaveBeenCalledWith('owner/repo', 500);
  });
});
