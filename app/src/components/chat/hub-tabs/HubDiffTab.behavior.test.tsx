import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactState = vi.hoisted(() => ({
  cells: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>,
  index: 0,
  refIndex: 0,
}));

const dependencies = vi.hoisted(() => ({
  getSandboxDiff: vi.fn(),
  nativeFs: null as null | { diff: ReturnType<typeof vi.fn> },
}));

vi.mock('react', () => ({
  useState: (seed: unknown) => {
    const i = reactState.index++;
    if (!reactState.cells[i]) {
      reactState.cells[i] = {
        value: typeof seed === 'function' ? (seed as () => unknown)() : seed,
      };
    }
    const cell = reactState.cells[i];
    return [
      cell.value,
      (next: unknown) => {
        cell.value =
          typeof next === 'function' ? (next as (previous: unknown) => unknown)(cell.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = reactState.refIndex++;
    if (!reactState.refs[i]) reactState.refs[i] = { current: initial };
    return reactState.refs[i];
  },
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => void | (() => void)) => reactState.effects.push(effect),
  useMemo: (factory: () => unknown) => factory(),
}));

vi.mock('@/lib/sandbox-client', () => ({
  getSandboxDiff: dependencies.getSandboxDiff,
}));

vi.mock('@/lib/native-fs', () => ({
  nativeFsScopeFrom: (repoFullName?: string, branch?: string) =>
    repoFullName && branch ? { repoFullName, branch } : undefined,
  resolveNativeFs: () => dependencies.nativeFs,
}));

const { HubDiffTab } = await import('./HubDiffTab');

type HubDiffTabProps = Parameters<typeof HubDiffTab>[0];

function mountTab(overrides: Partial<HubDiffTabProps> = {}) {
  reactState.index = 0;
  reactState.refIndex = 0;
  reactState.effects = [];

  const props: HubDiffTabProps = {
    ensureSandbox: vi.fn(async () => 'sbx-1'),
    repoFullName: 'owner/repo',
    currentBranch: 'main',
    diffData: null,
    diffLoading: false,
    diffError: null,
    diffLabel: 'main',
    diffMode: 'working-tree',
    jumpTarget: null,
    onDiffUpdate: vi.fn(),
    onDiffLoadingChange: vi.fn(),
    ...overrides,
  };

  HubDiffTab(props);
  return { props, initialLoadEffect: reactState.effects[0] };
}

beforeEach(() => {
  reactState.cells = [];
  reactState.refs = [];
  reactState.effects = [];
  reactState.index = 0;
  reactState.refIndex = 0;
  dependencies.nativeFs = null;
  dependencies.getSandboxDiff.mockReset();
  dependencies.getSandboxDiff.mockResolvedValue({
    diff: '',
    truncated: false,
  });
});

describe('HubDiffTab initial load', () => {
  it('warms and reads the working-tree diff when the tab mounts', async () => {
    const { props, initialLoadEffect } = mountTab();

    initialLoadEffect();

    await vi.waitFor(() => {
      expect(props.ensureSandbox).toHaveBeenCalledTimes(1);
      expect(dependencies.getSandboxDiff).toHaveBeenCalledWith('sbx-1');
      expect(props.onDiffUpdate).toHaveBeenCalledWith(
        {
          diff: '',
          filesChanged: 0,
          additions: 0,
          deletions: 0,
          truncated: false,
        },
        null,
      );
    });
  });

  it('reserves the load before warming so duplicate effects cannot start twice', async () => {
    let release!: (id: string) => void;
    const ensureSandbox = vi.fn(() => new Promise<string | null>((resolve) => (release = resolve)));
    const { initialLoadEffect } = mountTab({ ensureSandbox });

    initialLoadEffect();
    initialLoadEffect();
    expect(ensureSandbox).toHaveBeenCalledTimes(1);

    release('sbx-1');
    await vi.waitFor(() => expect(dependencies.getSandboxDiff).toHaveBeenCalledTimes(1));
  });

  it('does not auto-load an externally supplied review snapshot', () => {
    const ensureSandbox = vi.fn(async () => 'sbx-1');
    const { initialLoadEffect } = mountTab({
      ensureSandbox,
      diffMode: 'review-github',
    });

    initialLoadEffect();

    expect(ensureSandbox).not.toHaveBeenCalled();
    expect(dependencies.getSandboxDiff).not.toHaveBeenCalled();
  });

  it('reads and sanitizes the native clone without warming a cloud workspace', async () => {
    const nativeDiff = vi.fn(async () => ({
      diff:
        'diff --git a/a.ts b/a.ts\n+file body\n' +
        'diff --git a/.env b/.env\n+API_KEY=super-secret-value\n',
      truncated: false,
      git_status: ' M a.ts\n?? .env',
    }));
    const ensureSandbox = vi.fn(async () => 'sbx-1');
    const onDiffUpdate = vi.fn();
    const { initialLoadEffect } = mountTab({ ensureSandbox, onDiffUpdate });
    // Resolve at action time: the clone may become ready after the tab render
    // but before its first effect runs.
    dependencies.nativeFs = { diff: nativeDiff };

    initialLoadEffect();

    await vi.waitFor(() => expect(onDiffUpdate).toHaveBeenCalledTimes(1));
    const data = onDiffUpdate.mock.calls[0][0];
    expect(nativeDiff).toHaveBeenCalledTimes(1);
    expect(ensureSandbox).not.toHaveBeenCalled();
    expect(dependencies.getSandboxDiff).not.toHaveBeenCalled();
    expect(data.diff).toContain('diff --git a/a.ts b/a.ts');
    expect(data.diff).toContain('1 sensitive file diff hidden');
    expect(data.diff).not.toContain('super-secret-value');
  });

  it('shows the honest workspace-start failure when warming is unavailable', async () => {
    const onDiffUpdate = vi.fn();
    const { initialLoadEffect } = mountTab({
      ensureSandbox: vi.fn(async () => null),
      onDiffUpdate,
    });

    initialLoadEffect();

    await vi.waitFor(() => {
      expect(onDiffUpdate).toHaveBeenCalledWith(
        null,
        'Workspace could not start. Try again in a moment.',
      );
    });
    expect(dependencies.getSandboxDiff).not.toHaveBeenCalled();
  });

  it('keeps infrastructure detail out of a diff-read failure', async () => {
    dependencies.getSandboxDiff.mockRejectedValue(new Error('Sandbox transport exploded'));
    const onDiffUpdate = vi.fn();
    const { initialLoadEffect } = mountTab({ onDiffUpdate });

    initialLoadEffect();

    await vi.waitFor(() => {
      expect(onDiffUpdate).toHaveBeenCalledWith(null, "Couldn't read workspace changes.");
    });
  });
});
