import { describe, it, expect, vi } from 'vitest';
import { createNativeJgitCheckpointStore, CHECKPOINT_ARCHIVE_MAX_BYTES } from './native-jgit-store';
import type { NativeGitPlugin } from '../native-git/definitions';

const REPO = 'owner/repo';
const SCOPE = { repoFullName: REPO, sandboxId: 'sb', branch: 'feat/x' };
const DIR = 'checkpoints/owner_repo/feat_x';

/** Fake exec routed by command content (archive / dirty-check / restore-sync). */
function fakeExec(over: { archive?: string; dirty?: string; sync?: string } = {}) {
  return vi.fn(async (_id: string, command: string) => {
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
const okWrite = vi.fn(async () => ({ ok: true }) as never);

function store(over: Parameters<typeof createNativeJgitCheckpointStore>[0] = {}) {
  return createNativeJgitCheckpointStore({
    plugin: fakePlugin(),
    exec: fakeExec(),
    download: okDownload,
    write: okWrite,
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
    expect(download).toHaveBeenCalledWith('sb', '/tmp/push-checkpoint.tar.gz');
    expect(plugin.commitWorkingTree).toHaveBeenCalledWith(
      expect.objectContaining({ dir: DIR, archiveBase64: 'B64', message: expect.any(String) }),
    );
  });

  it('keys the on-device dir on repoFullName + branch, path-sanitized', async () => {
    const plugin = fakePlugin();
    await store({ plugin }).capture(SCOPE);
    expect(plugin.commitWorkingTree).toHaveBeenCalledWith(expect.objectContaining({ dir: DIR }));
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
    const write = vi.fn(async () => ({ ok: true }) as never);
    const result = await store({ plugin, write }).restore({ ...SCOPE, checkpointId: 'commit-1' });
    expect(result).toEqual({ status: 'restored', checkpointId: 'commit-1' });
    expect(plugin.archiveCommit).toHaveBeenCalledWith({ dir: DIR, commitId: 'commit-1' });
    expect(write).toHaveBeenCalledWith('sb', '/tmp/push-checkpoint-restore.b64', 'ARCHIVE');
  });

  it('refuses a dirty target tree (does not clobber live work)', async () => {
    const result = await store({ exec: fakeExec({ dirty: ' M src/app.ts' }) }).restore({
      ...SCOPE,
      checkpointId: 'c',
    });
    expect(result).toEqual({ status: 'skipped-dirty' });
  });

  it('fails when the checkpoint is missing on-device', async () => {
    const plugin = fakePlugin({ archiveCommit: vi.fn(async () => ({ archiveBase64: null })) });
    const result = await store({ plugin }).restore({ ...SCOPE, checkpointId: 'gone' });
    expect(result.status).toBe('failed');
  });

  it('fails when the sandbox sync does not report OK', async () => {
    const result = await store({ exec: fakeExec({ sync: 'ERR extract' }) }).restore({
      ...SCOPE,
      checkpointId: 'c',
    });
    expect(result.status).toBe('failed');
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
