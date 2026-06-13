import { afterEach, describe, expect, it, vi } from 'vitest';

const sandboxClient = vi.hoisted(() => ({ execInSandbox: vi.fn() }));
const policy = vi.hoisted(() => ({ resolveAutoBranchOnCommitEnabled: vi.fn(() => true) }));

vi.mock('@/lib/sandbox-client', () => sandboxClient);
vi.mock('@push/lib/auto-branch-policy', () => policy);

const {
  ensureCommitTargetBranch,
  deterministicCommitTargetBranchName,
  sanitizeCommitTargetBranchName,
} = await import('./ensure-commit-target-branch');

import type { BranchSwitchPayload } from '@/types';

function forkOk(branch: string) {
  const branchSwitch: BranchSwitchPayload = {
    name: branch,
    kind: 'forked',
    source: 'sandbox_create_branch',
  };
  return { ok: true, branchSwitch };
}

const NOT_FOUND = { exitCode: 0 }; // branchExists → false (no `exit 10`)

afterEach(() => {
  vi.clearAllMocks();
  policy.resolveAutoBranchOnCommitEnabled.mockReturnValue(true);
});

describe('deterministicCommitTargetBranchName', () => {
  it('slugs the commit message under a push/ prefix with a timestamp', () => {
    const date = new Date(2026, 5, 13, 4, 30); // 2026-06-13 04:30
    expect(deterministicCommitTargetBranchName('feat: add the warm switch fix!', date)).toBe(
      'push/add-the-warm-switch-fix-260613-0430',
    );
  });

  it('falls back to a stable slug for an empty message', () => {
    const date = new Date(2026, 0, 1, 0, 0);
    expect(deterministicCommitTargetBranchName('', date)).toBe('push/update-workspace-260101-0000');
  });
});

describe('sanitizeCommitTargetBranchName', () => {
  it('strips a refs/heads/ prefix, lowercases, and collapses junk to hyphens', () => {
    expect(sanitizeCommitTargetBranchName('refs/heads/Feature  Branch!!')).toBe('feature-branch');
  });

  it('preserves a slash in a real namespaced name', () => {
    expect(sanitizeCommitTargetBranchName('Feat/Cool Thing')).toBe('feat/cool-thing');
  });
});

describe('ensureCommitTargetBranch', () => {
  const base = {
    sandboxId: 'sb-1',
    diff: 'diff --git a/x b/x',
    commitMessage: 'feat: thing',
  };

  it('no-ops when HEAD is already off the default branch', async () => {
    const fork = vi.fn();
    const result = await ensureCommitTargetBranch({
      ...base,
      currentBranch: 'feature/x',
      defaultBranch: 'main',
      proposeName: async () => 'nice-name',
      fork,
    });
    expect(result).toEqual({ switched: false });
    expect(fork).not.toHaveBeenCalled();
    expect(sandboxClient.execInSandbox).not.toHaveBeenCalled();
  });

  it('no-ops when the flag is off', async () => {
    policy.resolveAutoBranchOnCommitEnabled.mockReturnValue(false);
    const fork = vi.fn();
    const result = await ensureCommitTargetBranch({
      ...base,
      currentBranch: 'main',
      defaultBranch: 'main',
      proposeName: async () => 'nice-name',
      fork,
    });
    expect(result).toEqual({ switched: false });
    expect(fork).not.toHaveBeenCalled();
  });

  it('forks to the model-proposed name when on the default branch', async () => {
    sandboxClient.execInSandbox.mockResolvedValue(NOT_FOUND);
    const fork = vi.fn(async (branch: string) => forkOk(branch));
    const result = await ensureCommitTargetBranch({
      ...base,
      currentBranch: 'main',
      defaultBranch: 'main',
      proposeName: async () => 'add-warm-switch',
      fork,
    });
    expect(result).toMatchObject({ switched: true, branch: 'add-warm-switch' });
    expect(fork).toHaveBeenCalledWith('add-warm-switch');
  });

  it('falls back to a deterministic name when the proposer fails', async () => {
    sandboxClient.execInSandbox.mockResolvedValue(NOT_FOUND);
    const fork = vi.fn(async (branch: string) => forkOk(branch));
    const result = await ensureCommitTargetBranch({
      ...base,
      currentBranch: 'main',
      defaultBranch: 'main',
      proposeName: async () => {
        throw new Error('provider down');
      },
      fork,
    });
    expect(result.switched).toBe(true);
    if (result.switched) expect(result.branch.startsWith('push/')).toBe(true);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('falls back to the deterministic name when the model name is git-rejected', async () => {
    // The model proposes a name our regex validator accepts but git rejects
    // (e.g. a `.lock` suffix). The first fork fails non-collision; the seam
    // must fall through to the deterministic `push/…` name, not block.
    sandboxClient.execInSandbox.mockResolvedValue(NOT_FOUND);
    const fork = vi.fn(async (branch: string) => {
      if (!branch.startsWith('push/')) {
        return { ok: false, errorMessage: "fatal: 'foo.lock' is not a valid branch name" };
      }
      return forkOk(branch);
    });
    const result = await ensureCommitTargetBranch({
      ...base,
      currentBranch: 'main',
      defaultBranch: 'main',
      proposeName: async () => 'foo.lock',
      fork,
    });
    expect(result.switched).toBe(true);
    if (result.switched) expect(result.branch.startsWith('push/')).toBe(true);
    // model name attempted first, then the deterministic fallback
    expect(fork.mock.calls[0]?.[0]).toBe('foo.lock');
    expect(fork.mock.calls.at(-1)?.[0]?.startsWith('push/')).toBe(true);
  });

  it('suffixes the branch name on collision', async () => {
    // branchExists returns true (exit 10) for the first candidate, false after.
    sandboxClient.execInSandbox
      .mockResolvedValueOnce({ exitCode: 10 })
      .mockResolvedValue(NOT_FOUND);
    const fork = vi.fn(async (branch: string) => forkOk(branch));
    const result = await ensureCommitTargetBranch({
      ...base,
      currentBranch: 'main',
      defaultBranch: 'main',
      proposeName: async () => 'topic',
      fork,
    });
    expect(result).toMatchObject({ switched: true, branch: 'topic-2' });
    expect(fork).toHaveBeenCalledWith('topic-2');
  });
});
