import { describe, expect, it, vi } from 'vitest';
import { computePushedDiffFromSource } from '@push/lib/git/pushed-diff';
import type { NativeGitPlugin } from './definitions';
import { pushedDiffSourceFromNativePlugin } from './pushed-diff-source';

function fakePlugin(overrides: Partial<NativeGitPlugin> = {}): NativeGitPlugin {
  return {
    currentBranch: vi.fn(async () => ({ branch: 'feature/native' })),
    revParse: vi.fn(async ({ ref }: { ref: string }) => ({
      sha: ref === 'origin/feature/native' ? 'base123' : null,
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
    expect(plugin.revParse).toHaveBeenCalledWith({
      dir: '/data/clone',
      ref: 'origin/feature/native',
    });
    expect(plugin.logPatch).toHaveBeenCalledWith({
      dir: '/data/clone',
      range: 'origin/feature/native..HEAD',
    });
  });

  it('falls back to origin/HEAD merge-base for a new native branch', async () => {
    const plugin = fakePlugin({
      revParse: vi.fn(async ({ ref }: { ref: string }) => ({
        sha: ref === 'origin/HEAD' ? 'originhead123' : null,
      })),
      mergeBase: vi.fn(async () => ({ sha: 'merge123' })),
    });
    await computePushedDiffFromSource(pushedDiffSourceFromNativePlugin(plugin, '/data/clone'));
    expect(plugin.mergeBase).toHaveBeenCalledWith({
      dir: '/data/clone',
      a: 'origin/HEAD',
      b: 'HEAD',
    });
    expect(plugin.logPatch).toHaveBeenCalledWith({
      dir: '/data/clone',
      range: 'merge123..HEAD',
    });
  });
});
