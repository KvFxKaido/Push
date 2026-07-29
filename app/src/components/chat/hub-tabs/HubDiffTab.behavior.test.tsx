import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactState = vi.hoisted(() => ({
  cells: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>,
  index: 0,
  refIndex: 0,
}));

const dependencies = vi.hoisted(() => ({
  getSandboxDiff: vi.fn(),
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

const { HubDiffTab } = await import('./HubDiffTab');

type HubDiffTabProps = Parameters<typeof HubDiffTab>[0];

function createTabHarness(initial: Partial<HubDiffTabProps> = {}) {
  let activeGeneration = initial.diffGeneration ?? 0;
  const stable = {
    ensureSandbox: vi.fn(async () => 'sbx-1'),
    onDiffUpdate: vi.fn(),
    onDiffLoadingChange: vi.fn(),
  };
  let props: HubDiffTabProps = {
    ...stable,
    diffGeneration: activeGeneration,
    diffData: null,
    diffLoading: false,
    diffError: null,
    diffLabel: 'main',
    diffMode: 'working-tree',
    jumpTarget: null,
    ...initial,
  };

  const render = (overrides: Partial<HubDiffTabProps> = {}) => {
    if (overrides.diffGeneration !== undefined) activeGeneration = overrides.diffGeneration;
    props = { ...props, ...overrides };
    reactState.index = 0;
    reactState.refIndex = 0;
    reactState.effects = [];

    HubDiffTab(props);
    return {
      props,
      // Effect order in the component: initial load, then jump target.
      initialLoadEffect: reactState.effects[0],
    };
  };

  return { render, stable };
}

beforeEach(() => {
  reactState.cells = [];
  reactState.refs = [];
  reactState.effects = [];
  reactState.index = 0;
  reactState.refIndex = 0;
  dependencies.getSandboxDiff.mockReset();
  dependencies.getSandboxDiff.mockResolvedValue({
    diff: '',
    truncated: false,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HubDiffTab initial load', () => {
  it('warms and reads the working-tree diff when the tab mounts', async () => {
    const harness = createTabHarness();
    const { initialLoadEffect } = harness.render();

    initialLoadEffect();

    await vi.waitFor(() => {
      expect(harness.stable.ensureSandbox).toHaveBeenCalledTimes(1);
      expect(dependencies.getSandboxDiff).toHaveBeenCalledWith('sbx-1');
      expect(harness.stable.onDiffUpdate).toHaveBeenCalledWith(
        0,
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
    const harness = createTabHarness({ ensureSandbox });
    const { initialLoadEffect } = harness.render();

    initialLoadEffect();
    initialLoadEffect();
    expect(ensureSandbox).toHaveBeenCalledTimes(1);

    release('sbx-1');
    await vi.waitFor(() => expect(dependencies.getSandboxDiff).toHaveBeenCalledTimes(1));
  });

  it('does not auto-load an externally supplied review snapshot', () => {
    const ensureSandbox = vi.fn(async () => 'sbx-1');
    const harness = createTabHarness({ ensureSandbox, diffMode: 'review-github' });

    harness.render().initialLoadEffect();

    expect(ensureSandbox).not.toHaveBeenCalled();
    expect(dependencies.getSandboxDiff).not.toHaveBeenCalled();
  });

  it('shows the honest workspace-start failure when warming is unavailable', async () => {
    const harness = createTabHarness({
      ensureSandbox: vi.fn(async () => null),
    });

    harness.render().initialLoadEffect();

    await vi.waitFor(() => {
      expect(harness.stable.onDiffUpdate).toHaveBeenCalledWith(
        0,
        null,
        'Workspace could not start. Try again in a moment.',
      );
    });
    expect(dependencies.getSandboxDiff).not.toHaveBeenCalled();
  });

  it('keeps infrastructure detail out of a diff-read failure', async () => {
    dependencies.getSandboxDiff.mockRejectedValue(new Error('Sandbox transport exploded'));
    const harness = createTabHarness();

    harness.render().initialLoadEffect();

    await vi.waitFor(() => {
      expect(harness.stable.onDiffUpdate).toHaveBeenCalledWith(
        0,
        null,
        "Couldn't read workspace changes.",
      );
    });
  });
});

describe('HubDiffTab diff generation', () => {
  it('retries the current A generation after an A→B→A load reservation settles', async () => {
    let releaseFirstRead: (value: { diff: string; truncated: boolean }) => void = () => {};
    dependencies.getSandboxDiff
      .mockReturnValueOnce(
        new Promise<{ diff: string; truncated: boolean }>((resolve) => {
          releaseFirstRead = resolve;
        }),
      )
      .mockResolvedValueOnce({
        diff: 'diff --git a/current.ts b/current.ts\n',
        truncated: false,
      });
    const harness = createTabHarness();

    harness.render({ diffGeneration: 0 }).initialLoadEffect();
    await vi.waitFor(() => expect(dependencies.getSandboxDiff).toHaveBeenCalledTimes(1));
    harness.stable.onDiffUpdate.mockClear();
    harness.stable.onDiffLoadingChange.mockClear();

    harness.render({ diffGeneration: 1 }).initialLoadEffect();
    harness.render({ diffGeneration: 2 }).initialLoadEffect();
    releaseFirstRead({ diff: 'diff --git a/stale.ts b/stale.ts\n', truncated: false });
    await vi.waitFor(() => {
      expect(harness.stable.onDiffUpdate).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ diff: 'diff --git a/stale.ts b/stale.ts\n' }),
        null,
      );
    });
    harness.stable.onDiffUpdate.mockClear();
    harness.stable.onDiffLoadingChange.mockClear();

    // The old `useWarmAction` reservation releases itself on settlement. Its
    // observable warming=false transition lets the current generation retry;
    // the sheet separately generation-guards these callbacks.
    harness.render({ diffGeneration: 2 }).initialLoadEffect();
    await vi.waitFor(() => {
      expect(dependencies.getSandboxDiff).toHaveBeenCalledTimes(2);
      expect(harness.stable.onDiffUpdate).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ diff: 'diff --git a/current.ts b/current.ts\n' }),
        null,
      );
      expect(harness.stable.onDiffLoadingChange).toHaveBeenLastCalledWith(2, false);
    });
  });
});
