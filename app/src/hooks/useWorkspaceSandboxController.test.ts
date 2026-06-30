import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveRepo, WorkspaceSession } from '@/types';

const gitSession = vi.hoisted(() => ({
  getActiveGitBackend: vi.fn(),
}));

vi.mock('@/lib/git-session', () => gitSession);
vi.mock('@/lib/sandbox-client', () => ({
  downloadFromSandbox: vi.fn(),
}));
vi.mock('@/hooks/useSnapshotManager', () => ({
  buildWorkspaceScratchActions: vi.fn(() => null),
}));

type Effect = () => void | (() => void);
type RefCell = { current: unknown };
type StateCell = { value: unknown };

const reactState = vi.hoisted(() => ({
  refs: [] as RefCell[],
  refIndex: 0,
  states: [] as StateCell[],
  stateIndex: 0,
  effects: [] as Effect[],
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: (fn: Effect) => {
    reactState.effects.push(fn);
  },
  useRef: <T>(initial: T) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i] as { current: T };
  },
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.stateIndex++;
    if (!reactState.states[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      reactState.states[i] = { value: seed };
    }
    const cell = reactState.states[i];
    const setter = (value: T | ((prev: T) => T)) => {
      cell.value = typeof value === 'function' ? (value as (prev: T) => T)(cell.value as T) : value;
    };
    return [cell.value as T, setter];
  },
}));

const { useWorkspaceSandboxController } = await import('./useWorkspaceSandboxController');

function repo(branch: string): ActiveRepo {
  return {
    id: 1,
    name: 'Push',
    full_name: 'owner/Push',
    owner: 'owner',
    default_branch: 'main',
    current_branch: branch,
    private: false,
  };
}

function session(branch: string): WorkspaceSession {
  return {
    id: 'workspace-1',
    kind: 'repo',
    repo: repo(branch),
    sandboxId: null,
  };
}

function renderController(
  branch: string,
  stopSandbox: () => Promise<void>,
  skipRef: { current: boolean },
  overrides: {
    sandbox?: {
      sandboxId?: string | null;
      status?: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
      start?: (repo: string, branch?: string) => Promise<string | null>;
    };
    setEnsureSandbox?: (fn: () => Promise<string | null>) => void;
  } = {},
) {
  reactState.refIndex = 0;
  reactState.stateIndex = 0;
  reactState.effects = [];
  const sandboxStart = overrides.sandbox?.start ?? vi.fn(async () => null);
  const setEnsureSandbox = overrides.setEnsureSandbox ?? vi.fn();

  // eslint-disable-next-line react-hooks/rules-of-hooks
  useWorkspaceSandboxController({
    workspaceSession: session(branch),
    workspaceRepo: repo(branch),
    isScratch: false,
    sandbox: {
      sandboxId: overrides.sandbox?.sandboxId ?? null,
      status: overrides.sandbox?.status ?? 'idle',
      start: sandboxStart,
      stop: stopSandbox,
    },
    snapshots: {
      latestSnapshot: null,
      snapshotSaving: false,
      snapshotRestoring: false,
      snapshotRestoreProgress: null,
      markSnapshotActivity: vi.fn(),
      captureSnapshot: vi.fn(async () => false),
      handleRestoreFromSnapshot: vi.fn(async () => {}),
      refreshLatestSnapshot: vi.fn(async () => {}),
    },
    isStreaming: false,
    abortStream: vi.fn(),
    createNewChat: vi.fn(() => 'chat-1'),
    onWorkspaceSessionChange: vi.fn(),
    onEndWorkspace: vi.fn(),
    onDisconnect: vi.fn(),
    setEnsureSandbox,
    setSandboxId: vi.fn(),
    setWorkspaceSessionId: vi.fn(),
    skipBranchTeardownRef: skipRef,
  });

  for (const effect of reactState.effects) effect();

  return { sandboxStart, setEnsureSandbox };
}

beforeEach(() => {
  reactState.refs = [];
  reactState.refIndex = 0;
  reactState.states = [];
  reactState.stateIndex = 0;
  reactState.effects = [];
  gitSession.getActiveGitBackend.mockReset();
});

describe('useWorkspaceSandboxController branch teardown guard', () => {
  it('tears down the sandbox on an ungoverned branch state change', () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };

    renderController('main', stopSandbox, skipRef);
    renderController('feature/warm', stopSandbox, skipRef);

    expect(stopSandbox).toHaveBeenCalledTimes(1);
    expect(skipRef.current).toBe(false);
  });

  it('consumes the skip flag and preserves the sandbox on a governed branch switch', () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };

    renderController('main', stopSandbox, skipRef);
    skipRef.current = true;
    renderController('feature/warm', stopSandbox, skipRef);

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(skipRef.current).toBe(false);
  });

  it('preserves the sandbox when branch-desync reconciliation uses the governed switch path', () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };

    renderController('main', stopSandbox, skipRef);
    skipRef.current = true;
    renderController('feature/desynced', stopSandbox, skipRef);

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(skipRef.current).toBe(false);
  });

  it('preserves the sandbox when carry-chat migration uses the governed switch path', () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };

    renderController('feature/work', stopSandbox, skipRef);
    skipRef.current = true;
    renderController('main', stopSandbox, skipRef);

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(skipRef.current).toBe(false);
  });

  it('preserves the sandbox when merge-detected migration uses the governed switch path', () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };

    renderController('feature/merged', stopSandbox, skipRef);
    skipRef.current = true;
    renderController('main', stopSandbox, skipRef);

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(skipRef.current).toBe(false);
  });

  it('preserves the sandbox when commit-card switch chips use the governed switch path', () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };

    renderController('feature/committed', stopSandbox, skipRef);
    skipRef.current = true;
    renderController('main', stopSandbox, skipRef);

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(skipRef.current).toBe(false);
  });
});

describe('useWorkspaceSandboxController ensureSandbox', () => {
  it('routes an error-state sandbox id through start instead of returning the stale id', async () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };
    const sandboxStart = vi.fn(async () => 'sb-2');
    const setEnsureSandbox = vi.fn();

    renderController('main', stopSandbox, skipRef, {
      sandbox: {
        sandboxId: 'sb-1',
        status: 'error',
        start: sandboxStart,
      },
      setEnsureSandbox,
    });

    const ensureSandbox = setEnsureSandbox.mock.calls.at(-1)?.[0];
    expect(ensureSandbox).toBeTypeOf('function');
    await expect(ensureSandbox()).resolves.toBe('sb-2');
    expect(sandboxStart).toHaveBeenCalledWith('owner/Push', 'main');
  });

  it('keeps returning a ready sandbox id without starting another sandbox', async () => {
    const stopSandbox = vi.fn(async () => {});
    const skipRef = { current: false };
    const sandboxStart = vi.fn(async () => 'sb-2');
    const setEnsureSandbox = vi.fn();

    renderController('main', stopSandbox, skipRef, {
      sandbox: {
        sandboxId: 'sb-1',
        status: 'ready',
        start: sandboxStart,
      },
      setEnsureSandbox,
    });

    const ensureSandbox = setEnsureSandbox.mock.calls.at(-1)?.[0];
    expect(ensureSandbox).toBeTypeOf('function');
    await expect(ensureSandbox()).resolves.toBe('sb-1');
    expect(sandboxStart).not.toHaveBeenCalled();
  });
});
