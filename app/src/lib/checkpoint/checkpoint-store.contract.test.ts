import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the auto-back primitives so the remote adapter's mapping is observable
// without a real sandbox.
vi.mock('../sandbox-auto-back', () => ({ backUpWorkingTree: vi.fn() }));
vi.mock('../sandbox-auto-back-restore', () => ({
  detectAutoBackRestore: vi.fn(),
  applyAutoBackRestore: vi.fn(),
}));
// Both stores must invalidate the derived client caches after a whole-tree
// restore; mock the invalidator so the remote adapter's call is observable.
vi.mock('../sandbox-edit-ops', () => ({ invalidateWorkspaceSnapshots: vi.fn(() => 0) }));

import { backUpWorkingTree } from '../sandbox-auto-back';
import { detectAutoBackRestore, applyAutoBackRestore } from '../sandbox-auto-back-restore';
import { invalidateWorkspaceSnapshots } from '../sandbox-edit-ops';
import { remoteDraftRefCheckpointStore } from './remote-draft-ref-store';
import { createNativeJgitCheckpointStore } from './native-jgit-store';
import { selectCheckpointStore, type CheckpointStore } from './checkpoint-store';

const mockBackUp = vi.mocked(backUpWorkingTree);
const mockDetect = vi.mocked(detectAutoBackRestore);
const mockApply = vi.mocked(applyAutoBackRestore);
const mockInvalidate = vi.mocked(invalidateWorkspaceSnapshots);

beforeEach(() => vi.clearAllMocks());

const REPO = 'owner/repo';
// Native store with no real deps invoked — used for shape/selector checks only.
const native = createNativeJgitCheckpointStore({ log: () => {} });

describe('CheckpointStore interface conformance', () => {
  const stores: CheckpointStore[] = [remoteDraftRefCheckpointStore, native];
  it('both stores expose kind + capture/detectRestore/restore/list/drop/clear', () => {
    for (const store of stores) {
      expect(typeof store.kind).toBe('string');
      expect(typeof store.capture).toBe('function');
      expect(typeof store.detectRestore).toBe('function');
      expect(typeof store.restore).toBe('function');
      expect(typeof store.list).toBe('function');
      expect(typeof store.drop).toBe('function');
      expect(typeof store.clear).toBe('function');
    }
    expect(remoteDraftRefCheckpointStore.kind).toBe('remote-draft-ref');
    expect(native.kind).toBe('native-jgit');
  });

  it('the remote store reports drop/clear as unsupported (on-device-only mitigation)', async () => {
    const scope = { repoFullName: REPO, branch: 'b' };
    expect(await remoteDraftRefCheckpointStore.drop({ ...scope, checkpointId: 'x' })).toEqual({
      status: 'unsupported',
    });
    expect(await remoteDraftRefCheckpointStore.clear(scope)).toEqual({ status: 'unsupported' });
    expect(await remoteDraftRefCheckpointStore.clear(scope, { allLanes: true })).toEqual({
      status: 'unsupported',
    });
  });
});

describe('RemoteDraftRefCheckpointStore.capture mapping', () => {
  const input = { repoFullName: REPO, sandboxId: 'sb', branch: 'feat/x' };

  it('decodes priorToken into the auto-back (tree, head) pin', async () => {
    mockBackUp.mockResolvedValue({ status: 'clean' });
    await remoteDraftRefCheckpointStore.capture({ ...input, priorToken: 'tree-1:head-1' });
    expect(mockBackUp).toHaveBeenCalledWith('sb', 'feat/x', {
      lastBackedTree: 'tree-1',
      lastBackedHead: 'head-1',
    });
  });

  it('passes an undefined pin when there is no prior token', async () => {
    mockBackUp.mockResolvedValue({ status: 'clean' });
    await remoteDraftRefCheckpointStore.capture(input);
    expect(mockBackUp).toHaveBeenCalledWith('sb', 'feat/x', {
      lastBackedTree: undefined,
      lastBackedHead: undefined,
    });
  });

  it('maps backed-up → captured and round-trips the dedup token as tree:head', async () => {
    mockBackUp.mockResolvedValue({
      status: 'backed-up',
      ref: 'draft/auto/feat/x',
      sha: 's',
      tree: 'T',
      head: 'H',
    });
    expect(await remoteDraftRefCheckpointStore.capture(input)).toEqual({
      status: 'captured',
      dedupToken: 'T:H',
    });
  });

  it('maps unchanged → unchanged with the token', async () => {
    mockBackUp.mockResolvedValue({
      status: 'unchanged',
      ref: 'r',
      sha: 's',
      tree: 'T',
      head: 'none',
    });
    expect(await remoteDraftRefCheckpointStore.capture(input)).toEqual({
      status: 'unchanged',
      dedupToken: 'T:none',
    });
  });

  it('maps clean / skipped / blocked / failed through', async () => {
    mockBackUp.mockResolvedValueOnce({ status: 'clean' });
    expect(await remoteDraftRefCheckpointStore.capture(input)).toEqual({ status: 'clean' });
    mockBackUp.mockResolvedValueOnce({ status: 'skipped', reason: 'no_branch' });
    expect(await remoteDraftRefCheckpointStore.capture(input)).toEqual({
      status: 'skipped',
      reason: 'no_branch',
    });
    mockBackUp.mockResolvedValueOnce({ status: 'blocked', reason: 'secret' });
    expect(await remoteDraftRefCheckpointStore.capture(input)).toEqual({
      status: 'blocked',
      reason: 'secret',
    });
    mockBackUp.mockResolvedValueOnce({ status: 'failed', reason: 'boom' });
    expect(await remoteDraftRefCheckpointStore.capture(input)).toEqual({
      status: 'failed',
      reason: 'boom',
    });
  });

  it('treats a malformed prior token as no pin', async () => {
    mockBackUp.mockResolvedValue({ status: 'clean' });
    await remoteDraftRefCheckpointStore.capture({ ...input, priorToken: 'garbage-no-colon' });
    expect(mockBackUp).toHaveBeenCalledWith('sb', 'feat/x', {
      lastBackedTree: undefined,
      lastBackedHead: undefined,
    });
  });
});

describe('RemoteDraftRefCheckpointStore restore mapping', () => {
  const scope = { repoFullName: REPO, sandboxId: 'sb', branch: 'b' };

  it('maps available → checkpointId from the backup sha', async () => {
    mockDetect.mockResolvedValue({
      available: true,
      sha: 'abc123',
      summary: '3 files',
      ref: 'draft/auto/feature/x',
    });
    expect(await remoteDraftRefCheckpointStore.detectRestore(scope)).toEqual({
      available: true,
      checkpointId: 'abc123',
      summary: '3 files',
      sourceRef: 'draft/auto/feature/x',
    });
  });

  it('maps unavailable through', async () => {
    mockDetect.mockResolvedValue({ available: false, reason: 'no_ref' });
    expect(await remoteDraftRefCheckpointStore.detectRestore(scope)).toEqual({
      available: false,
      reason: 'no_ref',
    });
  });

  it('maps restore results and forwards the checkpointId as the expected sha', async () => {
    mockApply.mockResolvedValueOnce({ status: 'restored', sha: 'abc123' });
    expect(
      await remoteDraftRefCheckpointStore.restore({ ...scope, checkpointId: 'abc123' }),
    ).toEqual({ status: 'restored', checkpointId: 'abc123' });
    expect(mockApply).toHaveBeenCalledWith('sb', 'b', 'abc123');
    // A successful restore replaced the tree → invalidate the derived caches.
    expect(mockInvalidate).toHaveBeenCalledWith('sb');

    mockInvalidate.mockClear();
    mockApply.mockResolvedValueOnce({ status: 'skipped-dirty' });
    expect(
      await remoteDraftRefCheckpointStore.restore({ ...scope, checkpointId: 'abc123' }),
    ).toEqual({ status: 'skipped-dirty' });
    // Refused before touching the tree → no invalidation.
    expect(mockInvalidate).not.toHaveBeenCalled();

    mockApply.mockResolvedValueOnce({ status: 'failed', reason: 'nope' });
    expect(
      await remoteDraftRefCheckpointStore.restore({ ...scope, checkpointId: 'abc123' }),
    ).toEqual({ status: 'failed', reason: 'nope' });
    // `read-tree -u --reset` may have partially mutated the tree → invalidate
    // even on failure (over-invalidation is cheap; stale caches are a bug).
    expect(mockInvalidate).toHaveBeenCalledWith('sb');
  });

  it('list is a degenerate empty (single draft ref, no history)', async () => {
    expect(await remoteDraftRefCheckpointStore.list({ repoFullName: REPO, branch: 'b' })).toEqual(
      [],
    );
  });
});

describe('selectCheckpointStore', () => {
  const remote = remoteDraftRefCheckpointStore;
  const deps = { nativeStore: native, remoteStore: remote };

  it('picks native only when on the native shell AND the flag is enabled', () => {
    expect(
      selectCheckpointStore({ ...deps, isNative: () => true, nativeEnabled: () => true }),
    ).toBe(native);
  });

  it('falls back to remote on web (not native)', () => {
    expect(
      selectCheckpointStore({ ...deps, isNative: () => false, nativeEnabled: () => true }),
    ).toBe(remote);
  });

  it('falls back to remote on native when the flag is off', () => {
    expect(
      selectCheckpointStore({ ...deps, isNative: () => true, nativeEnabled: () => false }),
    ).toBe(remote);
  });
});
