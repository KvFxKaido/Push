import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactState = vi.hoisted(() => ({
  cells: [] as Array<{ value: unknown }>,
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ effect: () => void | (() => void); deps?: unknown[] }>,
  index: 0,
  refIndex: 0,
}));

const hubTabs = vi.hoisted(() => ({
  HubNotesTab: function HubNotesTab() {},
  HubConsoleTab: function HubConsoleTab() {},
  HubFilesTab: function HubFilesTab() {},
  HubDiffTab: function HubDiffTab() {},
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
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    reactState.effects.push({ effect, deps });
  },
  useMemo: (factory: () => unknown) => factory(),
  lazy: () => function LazyComponent() {},
  Suspense: function Suspense() {},
}));

vi.mock('./hub-tabs', () => hubTabs);

const { WorkspaceHubSheet } = await import('./WorkspaceHubSheet');

type WorkspaceHubSheetProps = Parameters<typeof WorkspaceHubSheet>[0];
type HubDiffTabProps = Parameters<typeof import('./hub-tabs')['HubDiffTab']>[0];
type RenderNode = {
  type?: unknown;
  props?: Record<string, unknown> & { children?: unknown };
};

const DIFF_A = {
  diff: 'diff --git a/a.ts b/a.ts\n',
  filesChanged: 1,
  additions: 1,
  deletions: 0,
  truncated: false,
};
const DIFF_A_STALE = {
  diff: 'diff --git a/stale.ts b/stale.ts\n',
  filesChanged: 1,
  additions: 1,
  deletions: 0,
  truncated: false,
};

function visit(node: unknown, predicate: (candidate: RenderNode) => boolean): RenderNode | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = visit(child, predicate);
      if (found) return found;
    }
    return null;
  }
  const candidate = node as RenderNode;
  if (predicate(candidate)) return candidate;
  return visit(candidate.props?.children, predicate);
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent((node as RenderNode).props?.children);
}

function clickTab(tree: unknown, label: 'Files' | 'Diff') {
  const button = visit(
    tree,
    (node) =>
      node.type === 'button' &&
      typeof node.props?.onClick === 'function' &&
      textContent(node.props.children) === label,
  );
  expect(button, `${label} tab button`).not.toBeNull();
  (button?.props?.onClick as () => void)();
}

function currentDiffTab(tree: unknown) {
  const tab = visit(tree, (node) => node.type === hubTabs.HubDiffTab);
  expect(tab, 'mounted HubDiffTab').not.toBeNull();
  return tab?.props as unknown as HubDiffTabProps;
}

function createSheetHarness() {
  let props: WorkspaceHubSheetProps = {
    open: true,
    onOpenChange: vi.fn(),
    messages: [],
    agentEvents: [],
    runEvents: [],
    sandboxId: 'sbx-1',
    sandboxStatus: 'ready',
    sandboxError: null,
    ensureSandbox: vi.fn(async () => 'sbx-1'),
    onStartSandbox: vi.fn(),
    onRetrySandbox: vi.fn(),
    onNewSandbox: vi.fn(),
    reviewProviders: [],
    reviewActiveProvider: 'demo',
    workspaceMode: 'repo',
    capabilities: {
      canManageBranches: false,
      canBrowsePullRequests: false,
      canCommitAndPush: true,
    },
    repoName: 'repo',
    repoFullName: 'owner/repo',
    protectMainEnabled: false,
    showToolActivity: false,
    scratchpadContent: '',
    scratchpadMemories: [],
    activeMemoryId: null,
    onScratchpadContentChange: vi.fn(),
    onScratchpadClear: vi.fn(),
    onScratchpadSaveMemory: vi.fn(),
    onScratchpadLoadMemory: vi.fn(),
    onScratchpadDeleteMemory: vi.fn(),
    todos: [],
    onTodoClear: vi.fn(),
    branchProps: {
      currentBranch: 'feature-a',
      defaultBranch: 'main',
      availableBranches: [],
      branchesLoading: false,
      branchesError: null,
      onSwitchBranch: vi.fn(),
      onRefreshBranches: vi.fn(),
      onShowBranchCreate: vi.fn(),
      onShowBranchFork: vi.fn(),
      onShowMergeFlow: vi.fn(),
      onDeleteBranch: vi.fn(async () => true),
    },
    onFixReviewFinding: vi.fn(),
    pinnedArtifacts: [],
    onUnpinArtifact: vi.fn(),
    onUpdateArtifactLabel: vi.fn(),
  };

  const render = (overrides: Partial<WorkspaceHubSheetProps> = {}) => {
    props = { ...props, ...overrides };
    reactState.index = 0;
    reactState.refIndex = 0;
    reactState.effects = [];
    return WorkspaceHubSheet(props);
  };

  const changeBranch = (tree: unknown, branch: string) => {
    clickTab(tree, 'Files');
    // Commit the tab change first: the production Diff component is genuinely
    // unmounted before the warm branch switch updates the sheet's base.
    render();
    return render({
      branchProps: { ...props.branchProps, currentBranch: branch },
    });
  };

  return { render, changeBranch };
}

beforeEach(() => {
  reactState.cells = [];
  reactState.refs = [];
  reactState.effects = [];
  reactState.index = 0;
  reactState.refIndex = 0;
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorkspaceHubSheet diff base ownership', () => {
  it('invalidates branch A while the Diff tab is unmounted before showing branch B', () => {
    const harness = createSheetHarness();
    let tree = harness.render();
    clickTab(tree, 'Diff');
    tree = harness.render();

    const branchATab = currentDiffTab(tree);
    branchATab.onDiffUpdate?.(branchATab.diffGeneration, DIFF_A, null);
    branchATab.onDiffLoadingChange?.(branchATab.diffGeneration, true);
    tree = harness.render();
    expect(currentDiffTab(tree).diffData).toEqual(DIFF_A);

    tree = harness.changeBranch(tree, 'feature-b');
    clickTab(tree, 'Diff');
    tree = harness.render();

    const branchBTab = currentDiffTab(tree);
    expect(branchBTab.diffGeneration).toBe(1);
    expect(branchBTab.diffData).toBeNull();
    expect(branchBTab.diffError).toBeNull();
    expect(branchBTab.diffLoading).toBe(false);
  });

  it('rejects A1 completion and loading release after A→B→A while A2 owns the flags', () => {
    const harness = createSheetHarness();
    let tree = harness.render();
    clickTab(tree, 'Diff');
    tree = harness.render();
    const branchA1Tab = currentDiffTab(tree);
    expect(branchA1Tab.diffGeneration).toBe(0);

    tree = harness.changeBranch(tree, 'feature-b');
    tree = harness.changeBranch(tree, 'feature-a');
    clickTab(tree, 'Diff');
    tree = harness.render();

    const branchA2Tab = currentDiffTab(tree);
    expect(branchA2Tab.diffGeneration).toBe(2);
    branchA2Tab.onDiffLoadingChange?.(branchA2Tab.diffGeneration, true);

    branchA1Tab.onDiffUpdate?.(branchA1Tab.diffGeneration, DIFF_A_STALE, null);
    branchA1Tab.onDiffLoadingChange?.(branchA1Tab.diffGeneration, false);
    tree = harness.render();

    const currentTab = currentDiffTab(tree);
    expect(currentTab.diffData).toBeNull();
    expect(currentTab.diffLoading).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"hub_diff_discarded_stale"'),
    );
  });
});
