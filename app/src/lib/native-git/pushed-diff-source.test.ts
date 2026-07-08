import { describe, expect, it, vi } from 'vitest';
import { computePushedDiffFromSource } from '@push/lib/git/pushed-diff';
import type { NativeGitPlugin } from './definitions';
import { pushedDiffSourceFromNativePlugin } from './pushed-diff-source';

function fakePlugin(overrides: Partial<NativeGitPlugin> = {}): NativeGitPlugin {
  return {
    currentBranch: vi.fn(async () => ({ branch: 'feature/native' })),
    revParse: vi.fn(async ({ ref }: { ref: string }) => ({
      sha: ref === 'refs/remotes/origin/feature/native' ? 'base123' : null,
    })),
    mergeBase: vi.fn(async () => ({ sha: 'merge123' })),
    logPatch: vi.fn(async () => ({ patch: 'PATCHES' })),
    ...overrides,
  } as unknown as NativeGitPlugin;
}

describe('pushedDiffSourceFromNativePlugin', () => {
  it('feeds computePushedDiffFromSource with native plugin primitives', async () => {
    const plugin = fakePlugin();
    const diff = await computePushedDiffFromSource(
      pushedDiffSourceFromNativePlugin(plugin, '/data/clone'),
    );
    expect(diff).toBe('PATCHES');
    // Fully qualified so a local `refs/heads/origin/feature/native` decoy can't
    // shadow the remote-tracking ref and collapse the audited base.
    expect(plugin.revParse).toHaveBeenCalledWith({
      dir: '/data/clone',
      ref: 'refs/remotes/origin/feature/native',
    });
    expect(plugin.logPatch).toHaveBeenCalledWith({
      dir: '/data/clone',
      range: 'refs/remotes/origin/feature/native..HEAD',
    });
  });

  it('forks off the default branch remote ref for a new native branch (no origin/HEAD needed)', async () => {
    // The #2 fix: JGit clones omit refs/remotes/origin/HEAD, so a new-branch
    // push must fork off the known default branch instead of whole-history.
    const plugin = fakePlugin({
      revParse: vi.fn(async ({ ref }: { ref: string }) => ({
        sha: ref === 'refs/remotes/origin/main' ? 'mainsha' : null,
      })),
      mergeBase: vi.fn(async () => ({ sha: 'forkpt' })),
    });
    await computePushedDiffFromSource(pushedDiffSourceFromNativePlugin(plugin, '/data/clone'), {
      defaultBranch: 'main',
    });
    expect(plugin.mergeBase).toHaveBeenCalledWith({
      dir: '/data/clone',
      a: 'refs/remotes/origin/main',
      b: 'HEAD',
    });
    expect(plugin.logPatch).toHaveBeenCalledWith({
      dir: '/data/clone',
      range: 'forkpt..HEAD',
    });
  });

  it('falls back to refs/remotes/origin/HEAD merge-base when no default branch is given', async () => {
    const plugin = fakePlugin({
      revParse: vi.fn(async ({ ref }: { ref: string }) => ({
        sha: ref === 'refs/remotes/origin/HEAD' ? 'originhead123' : null,
      })),
      mergeBase: vi.fn(async () => ({ sha: 'merge123' })),
    });
    await computePushedDiffFromSource(pushedDiffSourceFromNativePlugin(plugin, '/data/clone'));
    expect(plugin.mergeBase).toHaveBeenCalledWith({
      dir: '/data/clone',
      a: 'refs/remotes/origin/HEAD',
      b: 'HEAD',
    });
    expect(plugin.logPatch).toHaveBeenCalledWith({
      dir: '/data/clone',
      range: 'merge123..HEAD',
    });
  });

  it('logs a structured error and returns null when a plugin read throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const plugin = fakePlugin({
      logPatch: vi.fn(async () => {
        throw new Error('bridge exploded');
      }),
    });
    const source = pushedDiffSourceFromNativePlugin(plugin, '/data/clone');
    await expect(source.logPatch('a..b')).resolves.toBeNull();
    // A caught throw (infra failure) must be observable — otherwise a push that
    // shipped unscanned is indistinguishable from an empty push.
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('native_pushed_diff_read_failed');
    expect(logged).toContain('logPatch');
    errSpy.mockRestore();
  });
});
