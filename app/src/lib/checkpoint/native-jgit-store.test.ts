import { describe, it, expect, vi, beforeEach } from 'vitest';
// A whole-tree restore must invalidate the derived client caches; mock the
// invalidator so we can assert it fires on success and is skipped on refuse/fail.
vi.mock('../sandbox-edit-ops', () => ({ invalidateWorkspaceSnapshots: vi.fn(() => 3) }));
import { createNativeJgitCheckpointStore, CHECKPOINT_ARCHIVE_MAX_BYTES } from './native-jgit-store';
import { invalidateWorkspaceSnapshots } from '../sandbox-edit-ops';
import type { NativeGitPlugin } from '../native-git/definitions';

const mockInvalidate = vi.mocked(invalidateWorkspaceSnapshots);
beforeEach(() => mockInvalidate.mockClear());

const REPO = 'owner/repo';
const SCOPE = { repoFullName: REPO, sandboxId: 'sb', branch: 'feat/x' };
// The lane dir is `checkpoints/<sanitized>-<fnv hash>/<sanitized>-<fnv hash>` —
// the hash is the collision-free key (sanitizing alone collides feat/x ↔ feat_x).
const DIR = expect.stringMatching(/^checkpoints\/owner_repo-[0-9a-f]{8}\/feat_x-[0-9a-f]{8}$/);

/** Fake exec routed by command content (probe / delta / archive / dirty / sync). */
function fakeExec(
  over: {
    archive?: string;
    dirty?: string;
    sync?: string;
    probe?: string | string[];
    delta?: string;
  } = {},
) {
  // `probe` may be a single response or a sequence consumed across calls (the
  // last entry sticks) — lets a test return a changed tree-hash on the 2nd debounce.
  const probeSeq = Array.isArray(over.probe) ? [...over.probe] : null;
  return vi.fn(async (_id: string, command: string) => {
    if (command.includes('write-tree')) {
      const p = probeSeq
        ? ((probeSeq.length > 1 ? probeSeq.shift() : probeSeq[0]) ?? 'ERR')
        : ((over.probe as string | undefined) ?? '');
      return result(p);
    }
    // The delta-capture command is the one that hashes the tree (`hash-object`);
    // check it before `ls-files`, which the full archive command also contains.
    if (command.includes('hash-object'))
      return result(over.delta ?? 'OK 0\n---DEL---\n---MAN---\n');
    if (command.includes('ls-files')) return result(over.archive ?? 'OK 100');
    if (command.includes('git status --porcelain')) return result(over.dirty ?? '');
    if (command.includes('base64 -d')) return result(over.sync ?? 'OK');
    return result('');
  });
  function result(stdout: string) {
    return { stdout, stderr: '', exitCode: 0 } as Awaited<
      ReturnType<typeof import('../sandbox-client').execInSandbox>
    >;
  }
}

function fakePlugin(over: Partial<NativeGitPlugin> = {}): NativeGitPlugin {
  return {
    commitWorkingTree: vi.fn(async () => ({ committed: true, commitId: 'commit-1' })),
    archiveCommit: vi.fn(async () => ({ archiveBase64: 'ARCHIVE' })),
    listCheckpoints: vi.fn(async () => ({ checkpoints: [] })),
    pruneCheckpoints: vi.fn(async () => ({ pruned: 0 })),
    ...over,
  } as unknown as NativeGitPlugin;
}

const okDownload = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
const okUpload = vi.fn(async () => ({ ok: true }) as never);

function store(over: Parameters<typeof createNativeJgitCheckpointStore>[0] = {}) {
  return createNativeJgitCheckpointStore({
    plugin: fakePlugin(),
    exec: fakeExec(),
    download: okDownload,
    upload: okUpload,
    log: () => {},
    ...over,
  });
}

describe('NativeJgitCheckpointStore.capture', () => {
  it('archives in-sandbox, fetches bytes, and commits to the on-device repo', async () => {
    const plugin = fakePlugin();
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
    const result = await store({ plugin, download }).capture(SCOPE);
    expect(result).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(download).toHaveBeenCalledWith('sb', '/workspace/.push-checkpoint.zip');
    expect(plugin.commitWorkingTree).toHaveBeenCalledWith(
      expect.objectContaining({ dir: DIR, archiveBase64: 'B64', message: expect.any(String) }),
    );
  });

  it('keys the on-device dir on repoFullName + branch, path-sanitized', async () => {
    const plugin = fakePlugin();
    await store({ plugin }).capture(SCOPE);
    expect(plugin.commitWorkingTree).toHaveBeenCalledWith(expect.objectContaining({ dir: DIR }));
  });

  it('gives branches with colliding sanitized forms distinct dirs (Codex P1)', async () => {
    // Both are valid refs that sanitize to the same `feat_x`; the hash must keep
    // their on-device lanes distinct so neither overwrites the other.
    const dirs = new Set<string>();
    for (const branch of ['feat/x', 'feat_x']) {
      const plugin = fakePlugin();
      await store({ plugin }).capture({ repoFullName: REPO, sandboxId: 'sb', branch });
      const mockFn = plugin.commitWorkingTree as ReturnType<typeof vi.fn>;
      dirs.add(mockFn.mock.calls[0][0].dir);
    }
    expect(dirs.size).toBe(2); // no cross-lane overwrite
  });

  it('reports clean when the archive is empty (no working-tree content)', async () => {
    const download = vi.fn();
    const result = await store({ exec: fakeExec({ archive: 'OK 0' }), download }).capture(SCOPE);
    expect(result).toEqual({ status: 'clean' });
    expect(download).not.toHaveBeenCalled(); // short-circuits before transfer
  });

  it('refuses an over-cap archive instead of transferring it', async () => {
    const big = `OK ${CHECKPOINT_ARCHIVE_MAX_BYTES + 1}`;
    const result = await store({ exec: fakeExec({ archive: big }) }).capture(SCOPE);
    expect(result.status).toBe('skipped');
  });

  it('fails on an archive-build error', async () => {
    const result = await store({ exec: fakeExec({ archive: 'ERR tar' }) }).capture(SCOPE);
    expect(result.status).toBe('failed');
  });

  it('probe short-circuits a no-change debounce (no second download)', async () => {
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
    const s = store({ exec: fakeExec({ probe: `OK ${'a'.repeat(40)}` }), download });

    const first = await s.capture(SCOPE);
    expect(first).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(download).toHaveBeenCalledTimes(1);

    const second = await s.capture(SCOPE);
    expect(second).toEqual({ status: 'unchanged', dedupToken: 'commit-1' });
    expect(download).toHaveBeenCalledTimes(1); // archive NOT re-downloaded
  });

  it('re-captures when the working tree changes between debounces', async () => {
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
    const s = store({
      exec: fakeExec({ probe: [`OK ${'a'.repeat(40)}`, `OK ${'b'.repeat(40)}`] }),
      download,
    });

    await s.capture(SCOPE);
    const second = await s.capture(SCOPE);
    expect(second).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(download).toHaveBeenCalledTimes(2); // changed tree → full re-capture
  });

  it('falls through to a full capture when the probe fails (no baseline)', async () => {
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
    const s = store({ exec: fakeExec({ probe: 'ERR write-tree' }), download });

    await s.capture(SCOPE);
    const second = await s.capture(SCOPE);
    // A failed probe never establishes a baseline, so every debounce captures.
    expect(second).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('skips an invalid branch', async () => {
    const result = await store().capture({ ...SCOPE, branch: '-bad' });
    expect(result).toEqual({ status: 'skipped', reason: 'invalid_branch' });
  });

  it('maps a no-op commit to unchanged', async () => {
    const plugin = fakePlugin({
      commitWorkingTree: vi.fn(async () => ({ committed: false, commitId: 'head-sha' })),
    });
    expect(await store({ plugin }).capture(SCOPE)).toEqual({
      status: 'unchanged',
      dedupToken: 'head-sha',
    });
  });

  it('best-effort prunes after a successful capture', async () => {
    const plugin = fakePlugin();
    await store({ plugin }).capture(SCOPE);
    expect(plugin.pruneCheckpoints).toHaveBeenCalledWith(expect.objectContaining({ dir: DIR }));
  });
});

describe('NativeJgitCheckpointStore.restore', () => {
  it('reads the checkpoint tree off-device and syncs it into a clean sandbox', async () => {
    const plugin = fakePlugin();
    const upload = vi.fn(async () => ({ ok: true }) as never);
    const result = await store({ plugin, upload }).restore({ ...SCOPE, checkpointId: 'commit-1' });
    expect(result).toEqual({ status: 'restored', checkpointId: 'commit-1' });
    expect(plugin.archiveCommit).toHaveBeenCalledWith({ dir: DIR, commitId: 'commit-1' });
    expect(upload).toHaveBeenCalledWith('sb', '/workspace/.push-checkpoint-restore.b64', 'ARCHIVE');
    // The whole-tree replace must invalidate the derived caches for this sandbox.
    expect(mockInvalidate).toHaveBeenCalledWith('sb');
  });

  it('refuses a dirty target tree (does not clobber live work)', async () => {
    const result = await store({ exec: fakeExec({ dirty: ' M src/app.ts' }) }).restore({
      ...SCOPE,
      checkpointId: 'c',
    });
    expect(result).toEqual({ status: 'skipped-dirty' });
    // No tree changed → caches must NOT be invalidated.
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('fails when the checkpoint is missing on-device', async () => {
    const plugin = fakePlugin({ archiveCommit: vi.fn(async () => ({ archiveBase64: null })) });
    const result = await store({ plugin }).restore({ ...SCOPE, checkpointId: 'gone' });
    expect(result.status).toBe('failed');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('fails when the sandbox sync does not report OK — but still invalidates', async () => {
    const result = await store({ exec: fakeExec({ sync: 'ERR extract' }) }).restore({
      ...SCOPE,
      checkpointId: 'c',
    });
    expect(result.status).toBe('failed');
    // The destructive sync (clear /workspace + extract) was DISPATCHED, so the
    // tree may be partially mutated — caches must be dropped even on failure, or
    // we'd serve stale versions against a half-cleared tree (Codex).
    expect(mockInvalidate).toHaveBeenCalledWith('sb');
  });

  it('invalidates even when the sync throws (tree may be partially mutated)', async () => {
    const exec = vi.fn(async (_id: string, command: string) => {
      if (command.includes('git status --porcelain')) {
        return { stdout: '', stderr: '', exitCode: 0 } as never;
      }
      throw new Error('connection reset');
    });
    const result = await store({ exec }).restore({ ...SCOPE, checkpointId: 'c' });
    expect(result.status).toBe('failed');
    expect(mockInvalidate).toHaveBeenCalledWith('sb');
  });
});

describe('NativeJgitCheckpointStore.list / detectRestore', () => {
  const records = [
    { commitId: 'c2', message: 'checkpoint 2', timestampMs: 200 },
    { commitId: 'c1', message: 'checkpoint 1', timestampMs: 100 },
  ];

  it('maps plugin commitId → record checkpointId, newest first', async () => {
    const plugin = fakePlugin({ listCheckpoints: vi.fn(async () => ({ checkpoints: records })) });
    expect(await store({ plugin }).list({ repoFullName: REPO, branch: 'feat/x' })).toEqual([
      { checkpointId: 'c2', message: 'checkpoint 2', timestampMs: 200 },
      { checkpointId: 'c1', message: 'checkpoint 1', timestampMs: 100 },
    ]);
  });

  it('detectRestore offers the latest checkpoint', async () => {
    const plugin = fakePlugin({ listCheckpoints: vi.fn(async () => ({ checkpoints: records })) });
    expect(await store({ plugin }).detectRestore(SCOPE)).toEqual({
      available: true,
      checkpointId: 'c2',
      summary: 'checkpoint 2',
    });
  });

  it('detectRestore is unavailable with no checkpoints', async () => {
    expect(await store().detectRestore(SCOPE)).toEqual({
      available: false,
      reason: 'no_checkpoint',
    });
  });
});

describe('NativeJgitCheckpointStore.capture — diff transport (delta path)', () => {
  const HA = 'a'.repeat(40);
  const HA2 = 'c'.repeat(40);
  const HB = 'b'.repeat(40);
  const PROBE = `OK ${'f'.repeat(40)}`;
  const BASE_PATH = '/workspace/.push-checkpoint-base';
  const TMP_DELTA = '/workspace/.push-checkpoint-delta.zip';
  const TMP_ARCHIVE = '/workspace/.push-checkpoint.zip';
  // a.txt changed (HA -> HA2), b.txt unchanged; the sandbox's current manifest.
  const deltaStdout = `OK 50\n---DEL---\n---MAN---\n${HA2} a.txt\n${HB} b.txt\n`;

  /** A plugin whose listManifest returns the base; commitDelta verifies internally. */
  function deltaPlugin(over: Partial<NativeGitPlugin> = {}) {
    return fakePlugin({
      listManifest: vi.fn(async () => ({ manifest: { 'a.txt': HA, 'b.txt': HB } })),
      commitDelta: vi.fn(async () => ({ committed: true, commitId: 'delta-1', treeId: 't1' })),
      ...over,
    });
  }

  it('moves only the changed files via commitDelta when a base manifest exists', async () => {
    const plugin = deltaPlugin();
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'DELTAB64' }) as never);
    const upload = vi.fn(async () => ({ ok: true }) as never);
    const result = await store({
      plugin,
      exec: fakeExec({ probe: PROBE, delta: deltaStdout }),
      download,
      upload,
    }).capture(SCOPE);

    expect(result).toEqual({ status: 'captured', dedupToken: 'delta-1' });
    expect(upload).toHaveBeenCalledWith('sb', BASE_PATH, expect.stringContaining('a.txt'));
    expect(download).toHaveBeenCalledWith('sb', TMP_DELTA);
    // The sandbox's current manifest is handed to commitDelta as the verify target.
    expect(plugin.commitDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: DIR,
        deltaArchiveBase64: 'DELTAB64',
        deletedPaths: [],
        expectedManifest: { 'a.txt': HA2, 'b.txt': HB },
      }),
    );
    expect(plugin.commitWorkingTree).not.toHaveBeenCalled();
  });

  it('falls back to full capture when the device has no base manifest', async () => {
    const plugin = fakePlugin({ listManifest: vi.fn(async () => ({ manifest: {} })) });
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
    const result = await store({ plugin, exec: fakeExec({ probe: PROBE }), download }).capture(
      SCOPE,
    );
    expect(result).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(plugin.commitWorkingTree).toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith('sb', TMP_ARCHIVE);
  });

  it('falls back to full capture when commitDelta refuses to publish (verify failed)', async () => {
    // commitDelta verifies the applied tree against the sandbox manifest before
    // publishing; a mismatch returns committed=false + null commitId (no ref).
    const plugin = deltaPlugin({
      commitDelta: vi.fn(async () => ({ committed: false, commitId: null, treeId: 't1' })),
    });
    const result = await store({
      plugin,
      exec: fakeExec({ probe: PROBE, delta: deltaStdout }),
    }).capture(SCOPE);
    expect(result).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(plugin.commitWorkingTree).toHaveBeenCalled(); // the superseding full capture
  });

  it('reports unchanged when the delta de-dupes to the newest checkpoint', async () => {
    // committed=false WITH a commitId means the applied tree matched the newest.
    const plugin = deltaPlugin({
      commitDelta: vi.fn(async () => ({ committed: false, commitId: 'existing-1', treeId: 't1' })),
    });
    const result = await store({
      plugin,
      exec: fakeExec({ probe: PROBE, delta: deltaStdout }),
    }).capture(SCOPE);
    expect(result).toEqual({ status: 'unchanged', dedupToken: 'existing-1' });
    expect(plugin.commitWorkingTree).not.toHaveBeenCalled();
  });

  it('uses an empty archive (no delta download) when the delta is deletions-only', async () => {
    const plugin = deltaPlugin({
      listManifest: vi.fn(async () => ({ manifest: { 'a.txt': HA, 'gone.txt': HB } })),
    });
    const download = vi.fn(async () => ({ ok: true, fileBase64: 'B64' }) as never);
    const delStdout = `OK 0\n---DEL---\ngone.txt\n---MAN---\n${HA} a.txt\n`;
    const result = await store({
      plugin,
      exec: fakeExec({ probe: PROBE, delta: delStdout }),
      download,
    }).capture(SCOPE);
    expect(result).toEqual({ status: 'captured', dedupToken: 'delta-1' });
    expect(plugin.commitDelta).toHaveBeenCalledWith(
      expect.objectContaining({ deletedPaths: ['gone.txt'] }),
    );
    expect(download).not.toHaveBeenCalled(); // bytes=0 → empty zip, no archive fetch
  });

  it('falls back to full capture when a delta step throws', async () => {
    const plugin = deltaPlugin({
      commitDelta: vi.fn(async () => {
        throw new Error('jgit boom');
      }),
    });
    const result = await store({
      plugin,
      exec: fakeExec({ probe: PROBE, delta: deltaStdout }),
    }).capture(SCOPE);
    expect(result).toEqual({ status: 'captured', dedupToken: 'commit-1' });
    expect(plugin.commitWorkingTree).toHaveBeenCalled();
  });
});
