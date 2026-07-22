import { beforeEach, describe, expect, it, vi } from 'vitest';

type Effect = () => void | (() => void);

const reactState = vi.hoisted(() => ({
  effects: [] as Effect[],
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: (fn: Effect) => {
    reactState.effects.push(fn);
  },
  useState: <T>(initial: T) => [initial, vi.fn()],
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/sandbox-client', () => ({ execInSandbox: vi.fn(), writeToSandbox: vi.fn() }));
vi.mock('@/lib/file-awareness-ledger', () => ({ fileLedger: { recordMutation: vi.fn() } }));
vi.mock('@/lib/github-tools', () => ({ fetchProjectInstructions: vi.fn() }));
vi.mock('@/lib/project-instructions-utils', () => ({
  syncProjectInstructionsFromSandbox: vi.fn(),
}));

const { useProjectInstructions } = await import('./useProjectInstructions');

describe('useProjectInstructions session context', () => {
  beforeEach(() => {
    reactState.effects = [];
  });

  it('injects the available auto-back notice into the real repo workspace context', () => {
    const setWorkspaceContext = vi.fn();
    const repo = {
      id: 1,
      name: 'repo',
      full_name: 'owner/repo',
      owner: 'owner',
      private: false,
      default_branch: 'main',
      current_branch: 'feature/x',
    };
    const repoWithActivity = {
      ...repo,
      language: 'TypeScript',
      open_issues_count: 0,
      avatar_url: '',
      pushed_at: '2026-07-21T20:00:00.000Z',
      description: null,
      activity: {
        open_prs: 0,
        recent_commits: 0,
        has_new_activity: false,
        last_synced: null,
      },
    };
    const contextLine =
      'Unpushed work from this chat exists at origin ref draft/auto/feature/x; explicit restore is available.';

    // Production entry point: the hook that owns WorkspaceContext construction.
    // The final argument is the live restore-availability line from
    // useWorkspaceSandboxRestore.
    useProjectInstructions(
      repo,
      [repoWithActivity],
      { id: 'session-1', kind: 'repo', repo, sandboxId: 'sb-1' },
      { sandboxId: 'sb-1', status: 'ready', start: vi.fn() },
      vi.fn(),
      vi.fn(),
      setWorkspaceContext,
      vi.fn(),
      false,
      vi.fn(),
      vi.fn(),
      contextLine,
    );

    // Phase A fetch, Phase B sandbox sync, then the WorkspaceContext builder.
    reactState.effects[2]?.();

    expect(setWorkspaceContext).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'repo',
        description: expect.stringContaining(contextLine),
      }),
    );
  });
});
