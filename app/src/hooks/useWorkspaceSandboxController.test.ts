import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveRepo, WorkspaceSession } from '@/types';
import type { WorkspaceStateEvent } from '@push/lib/workspace-state';

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

describe('useWorkspaceSandboxController workspace-state adapter', () => {
  const entry = (x: string, y: string, path: string) => ({ x, y, path, raw: `${x}${y} ${path}` });

  function gitInfo(entries: ReturnType<typeof entry>[]) {
    return {
      branch: 'main',
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      copied: [],
      conflicted: [],
      untracked: [],
      ahead: 0,
      behind: 0,
      detached: false,
      hasUpstream: true,
      statusLine: '',
      staged: 0,
      unstaged: 0,
      entries,
    };
  }

  // Drives the ready path directly (renderController hard-codes idle). Returns
  // the hook result so the caller can read the reduced view after flushing.
  function renderAdapter(args: {
    sandboxId: string;
    entries: ReturnType<typeof entry>[];
    headSha: string;
    onWorkspaceStateEvent: (event: WorkspaceStateEvent) => void;
    protectMain?: boolean;
  }) {
    reactState.refIndex = 0;
    reactState.stateIndex = 0;
    reactState.effects = [];
    gitSession.getActiveGitBackend.mockReturnValue({
      status: vi.fn(async () => gitInfo(args.entries)),
      headSha: vi.fn(async () => args.headSha),
    });

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const result = useWorkspaceSandboxController({
      workspaceSession: session('main'),
      workspaceRepo: repo('main'),
      isScratch: false,
      sandbox: { sandboxId: args.sandboxId, status: 'ready', start: vi.fn(), stop: vi.fn() },
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
      setEnsureSandbox: vi.fn(),
      setSandboxId: vi.fn(),
      setWorkspaceSessionId: vi.fn(),
      skipBranchTeardownRef: { current: false },
      protectMain: args.protectMain ?? true,
      onWorkspaceStateEvent: args.onWorkspaceStateEvent,
    });
    for (const effect of reactState.effects) effect();
    return result;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('emits a snapshot on the first status read and exposes the reduced view', async () => {
    const events: WorkspaceStateEvent[] = [];
    renderAdapter({
      sandboxId: 'sb-1',
      entries: [entry('M', ' ', 'lib/a.ts')],
      headSha: 'sha1',
      onWorkspaceStateEvent: (e) => events.push(e),
    });
    await flush();

    expect(events).toHaveLength(1);
    const snap = events[0];
    if (snap.type !== 'workspace.state_snapshot') throw new Error('expected a snapshot');
    expect(snap.workspaceId).toBe('sb-1');
    expect(snap.rev).toBe(0);
    expect(snap.state.activeBranch).toBe('main');
    expect(snap.state.headSha).toBe('sha1');
    expect(snap.state.protectMain).toBe(true);
    expect(snap.state.sandboxReady).toBe(true);
    expect(snap.state.dirtyFiles).toEqual([{ path: 'lib/a.ts', status: 'modified' }]);

    const result = renderAdapter({
      sandboxId: 'sb-1',
      entries: [entry('M', ' ', 'lib/a.ts')],
      headSha: 'sha1',
      onWorkspaceStateEvent: () => {},
    });
    expect(result.workspaceStateView?.rev).toBe(0);
    expect(result.workspaceStateView?.workspaceId).toBe('sb-1');
  });

  it('emits a delta (not a second snapshot) when the same sandbox churns', async () => {
    const events: WorkspaceStateEvent[] = [];
    const push = (e: WorkspaceStateEvent) => events.push(e);

    renderAdapter({ sandboxId: 'sb-1', entries: [], headSha: 'sha1', onWorkspaceStateEvent: push });
    await flush();
    // Same sandbox, but a file appeared: clear the fetch guard (ref index 0 =
    // sandboxStateFetchedFor) so the ready effect re-fetches on the next render.
    reactState.refs = reactState.refs.map((r, i) => (i === 0 ? { current: null } : r));
    renderAdapter({
      sandboxId: 'sb-1',
      entries: [entry('A', ' ', 'b.ts')],
      headSha: 'sha1',
      onWorkspaceStateEvent: push,
    });
    await flush();

    expect(events[0].type).toBe('workspace.state_snapshot');
    const delta = events[1];
    if (delta.type !== 'workspace.state_delta') throw new Error('expected a delta');
    expect(delta.baseRev).toBe(0);
    expect(delta.rev).toBe(1);
    expect(delta.ops).toEqual([{ op: 'dirty_add', file: { path: 'b.ts', status: 'added' } }]);
  });

  it('resyncWorkspaceState re-forwards the current snapshot without advancing rev', async () => {
    const events: WorkspaceStateEvent[] = [];
    const result = renderAdapter({
      sandboxId: 'sb-1',
      entries: [entry('M', ' ', 'a.ts')],
      headSha: 'sha1',
      onWorkspaceStateEvent: (e) => events.push(e),
    });
    await flush();
    expect(events).toHaveLength(1); // opening snapshot

    // Simulates a chat switch: the same producer re-emits its current state so a
    // fresh (per-chat) sink can anchor. Rev must not advance.
    result.resyncWorkspaceState();
    expect(events).toHaveLength(2);
    const resync = events[1];
    if (resync.type !== 'workspace.state_snapshot') throw new Error('expected a snapshot');
    expect(resync.rev).toBe(0);
    expect(resync.state.dirtyFiles).toEqual([{ path: 'a.ts', status: 'modified' }]);
  });

  it('emits a set_protect_main delta when Protect Main toggles mid-sandbox', async () => {
    const events: WorkspaceStateEvent[] = [];
    const push = (e: WorkspaceStateEvent) => events.push(e);

    renderAdapter({
      sandboxId: 'sb-1',
      entries: [],
      headSha: 'sha1',
      protectMain: false,
      onWorkspaceStateEvent: push,
    });
    await flush();
    const opener = events[0];
    if (opener.type !== 'workspace.state_snapshot') throw new Error('expected a snapshot');
    expect(opener.state.protectMain).toBe(false);

    // Same sandbox, no git churn — just flip the guard. The ready effect won't
    // re-fetch (fetched once per id), so only the protectMain effect can emit.
    renderAdapter({
      sandboxId: 'sb-1',
      entries: [],
      headSha: 'sha1',
      protectMain: true,
      onWorkspaceStateEvent: push,
    });

    const delta = events.find((e) => e.type === 'workspace.state_delta');
    if (!delta || delta.type !== 'workspace.state_delta') throw new Error('expected a delta');
    expect(delta.baseRev).toBe(0);
    expect(delta.rev).toBe(1);
    expect(delta.ops).toEqual([{ op: 'set_protect_main', protectMain: true }]);
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
