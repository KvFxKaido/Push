import { describe, expect, it, vi } from 'vitest';
import { PushGit } from '@push/lib/git/push-git';
import { NativeGitBackend } from './native-git-backend';
import type { NativeGitPlugin } from './native-git/definitions';

/** A NativeGitPlugin mock with overridable methods (sensible passing defaults). */
function fakePlugin(overrides: Partial<NativeGitPlugin> = {}): NativeGitPlugin {
  return {
    clone: vi.fn(async () => ({ ok: true })),
    currentBranch: vi.fn(async () => ({ branch: 'main' })),
    upstreamRef: vi.fn(async () => ({ ref: 'origin/main' })),
    remoteUrl: vi.fn(async () => ({ url: 'https://github.com/owner/repo.git' })),
    headSha: vi.fn(async () => ({ sha: 'abc1234' })),
    status: vi.fn(async () => ({ porcelain: '## main...origin/main\n' })),
    diff: vi.fn(async () => ({ diff: '', truncated: false })),
    createBranch: vi.fn(async () => ({ ok: true })),
    switchBranch: vi.fn(async () => ({ ok: true })),
    commit: vi.fn(async () => ({ ok: true })),
    push: vi.fn(async () => ({ ok: true })),
    fetch: vi.fn(async () => ({ ok: true })),
    readFile: vi.fn(async () => ({ content: '', truncated: false })),
    writeFile: vi.fn(async () => ({ ok: true })),
    listDir: vi.fn(async () => ({ entries: [], truncated: false })),
    commitWorkingTree: vi.fn(async () => ({ committed: true, commitId: 'c1' })),
    archiveCommit: vi.fn(async () => ({ archiveBase64: 'A' })),
    listCheckpoints: vi.fn(async () => ({ checkpoints: [] })),
    pruneCheckpoints: vi.fn(async () => ({ pruned: 0 })),
    dropCheckpoint: vi.fn(async () => ({ dropped: true })),
    clearCheckpoints: vi.fn(async () => ({ cleared: true })),
    listManifest: vi.fn(async () => ({ manifest: {} })),
    commitDelta: vi.fn(async () => ({ committed: true, commitId: 'c1', treeId: 't1' })),
    ...overrides,
  };
}

const DIR = '/data/repos/owner-repo';

describe('NativeGitBackend reads', () => {
  it('maps the plugin reads onto the GitBackend contract', async () => {
    const plugin = fakePlugin();
    const backend = new NativeGitBackend(plugin, { dir: DIR });
    expect(await backend.currentBranch()).toBe('main');
    expect(await backend.upstreamRef()).toBe('origin/main');
    expect(await backend.headSha()).toBe('abc1234');
    expect(plugin.currentBranch).toHaveBeenCalledWith({ dir: DIR });
  });

  it('passes remote + push through to remoteUrl', async () => {
    const plugin = fakePlugin({
      remoteUrl: vi.fn(async () => ({ url: 'git@github.com:o/r.git' })),
    });
    const backend = new NativeGitBackend(plugin, { dir: DIR });
    expect(await backend.remoteUrl('upstream', { push: true })).toBe('git@github.com:o/r.git');
    expect(plugin.remoteUrl).toHaveBeenCalledWith({ dir: DIR, remote: 'upstream', push: true });
  });

  it('parses porcelain status through the canonical parser', async () => {
    const plugin = fakePlugin({
      status: vi.fn(async () => ({ porcelain: '## main...origin/main [ahead 1]\n M file.ts\n' })),
    });
    const backend = new NativeGitBackend(plugin, { dir: DIR });
    const status = await backend.status();
    expect(status?.branch).toBe('main');
    expect(status?.ahead).toBe(1);
    expect(status?.unstaged).toBe(1);
    expect(status?.entries).toHaveLength(1);
  });

  it('returns null when a read throws (bridge/transport error)', async () => {
    const plugin = fakePlugin({
      currentBranch: vi.fn(async () => {
        throw new Error('plugin not available');
      }),
      status: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const backend = new NativeGitBackend(plugin, { dir: DIR });
    expect(await backend.currentBranch()).toBeNull();
    expect(await backend.status()).toBeNull();
  });
});

describe('NativeGitBackend writes', () => {
  it('maps a successful write to ok and a failed write to a non-zero result', async () => {
    const plugin = fakePlugin({
      commit: vi.fn(async () => ({ ok: false, message: 'nothing to commit' })),
    });
    const backend = new NativeGitBackend(plugin, { dir: DIR });
    const ok = await backend.createBranch('feat/x', 'main');
    expect(ok.ok).toBe(true);
    expect(plugin.createBranch).toHaveBeenCalledWith({ dir: DIR, name: 'feat/x', from: 'main' });

    const fail = await backend.commit('m');
    expect(fail.ok).toBe(false);
    expect(fail.stderr).toBe('nothing to commit');
    expect(plugin.commit).toHaveBeenCalledWith({ dir: DIR, message: 'm', addAll: true });
  });

  it('surfaces a thrown bridge error as a failed result (never rejects)', async () => {
    const plugin = fakePlugin({
      push: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const backend = new NativeGitBackend(plugin, { dir: DIR });
    const res = await backend.push();
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe('network down');
    expect(res.error).toBe('network down');
  });

  it('injects the GitHub token transiently into push', async () => {
    const push = vi.fn(async () => ({ ok: true }));
    const backend = new NativeGitBackend(fakePlugin({ push }), {
      dir: DIR,
      getToken: () => 'gho_secret',
    });
    await backend.push({ setUpstream: true, ref: 'feat/x' });
    expect(push).toHaveBeenCalledWith({
      dir: DIR,
      remote: undefined,
      ref: 'feat/x',
      setUpstream: true,
      token: 'gho_secret',
    });
  });
});

describe('NativeGitBackend.switchBranch shallow-clone fallback', () => {
  it('fetches the branch then retries the switch when the first switch fails', async () => {
    const switchBranch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: 'pathspec did not match' })
      .mockResolvedValueOnce({ ok: true });
    const fetch = vi.fn(async () => ({ ok: true }));
    const backend = new NativeGitBackend(fakePlugin({ switchBranch, fetch }), {
      dir: DIR,
      getToken: () => 'gho_t',
    });
    const res = await backend.switchBranch('feat/x');
    expect(res.ok).toBe(true);
    expect(switchBranch).toHaveBeenCalledTimes(2);
    // Fetch the missing branch (depth 1) with the transient token, like the
    // shared backend's depth-1 fallback.
    expect(fetch).toHaveBeenCalledWith({
      dir: DIR,
      remote: 'origin',
      refspec: 'feat/x:refs/remotes/origin/feat/x',
      depth: 1,
      token: 'gho_t',
    });
  });

  it('surfaces the fetch failure when the fallback fetch fails', async () => {
    const switchBranch = vi.fn(async () => ({ ok: false, message: 'no local ref' }));
    const fetch = vi.fn(async () => ({ ok: false, message: 'fetch failed' }));
    const backend = new NativeGitBackend(fakePlugin({ switchBranch, fetch }), { dir: DIR });
    const res = await backend.switchBranch('feat/x');
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe('fetch failed');
    expect(switchBranch).toHaveBeenCalledTimes(1); // no retry once the fetch failed
  });

  it('switches directly without fetching when the branch is already local', async () => {
    const fetch = vi.fn(async () => ({ ok: true }));
    const backend = new NativeGitBackend(fakePlugin({ fetch }), { dir: DIR });
    const res = await backend.switchBranch('feat/x');
    expect(res.ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('NativeGitBackend serialization (shared working-copy lock)', () => {
  it('serializes concurrent writes to the same working copy', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let calls = 0;
    const commit = vi.fn(async (o: { message: string }) => {
      order.push(`start:${o.message}`);
      if (calls++ === 0) await firstGate;
      order.push(`end:${o.message}`);
      return { ok: true };
    });
    // Two backends over the SAME dir share one lock lane (keyed by the dir).
    const a = new NativeGitBackend(fakePlugin({ commit }), { dir: DIR });
    const b = new NativeGitBackend(fakePlugin({ commit }), { dir: DIR });

    const p1 = a.commit('A');
    const p2 = b.commit('B');
    await new Promise((r) => setTimeout(r, 0));
    // A holds the lock (blocked); B must not have started its commit.
    expect(order).toEqual(['start:A']);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });
});

describe('NativeGitBackend + PushGit (gate inside the critical section)', () => {
  it('runs the pre-push gate and the push under one lock, then pushes', async () => {
    const sequence: string[] = [];
    const push = vi.fn(async () => {
      sequence.push('push');
      return { ok: true };
    });
    const backend = new NativeGitBackend(fakePlugin({ push }), { dir: DIR });
    const pg = new PushGit({
      backend,
      prePush: async () => {
        sequence.push('gate');
        return { ok: true };
      },
    });
    const res = await pg.push({ ref: 'feat/x' });
    expect(res.ok).toBe(true);
    expect(sequence).toEqual(['gate', 'push']); // gate runs before the push, in-section
  });

  it('blocks the push when the gate denies', async () => {
    const push = vi.fn(async () => ({ ok: true }));
    const backend = new NativeGitBackend(fakePlugin({ push }), { dir: DIR });
    const pg = new PushGit({
      backend,
      prePush: async () => ({ ok: false, reason: 'secret found' }),
    });
    const res = await pg.push();
    expect(res.ok).toBe(false);
    expect(res.blocked).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });
});
