import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nextWorkspaceStateEvent, readWorkspaceStateFromGit } from '../workspace-state-emitter.ts';

// A fake `git` that answers a fixed table of arg-joins. Missing keys → null
// (command failed), matching the real GitExec contract.
function fakeGit(table) {
  return async (args) => {
    const key = args.join(' ');
    return key in table ? { stdout: table[key] } : null;
  };
}

const PORCELAIN_CLEAN = '## main...origin/main\n';
const PORCELAIN_DIRTY = '## feat/x...origin/feat/x [ahead 1]\n M lib/a.ts\n?? app/b.ts\n';

describe('workspace-state-emitter — readWorkspaceStateFromGit', () => {
  it('maps a clean tree', async () => {
    const state = await readWorkspaceStateFromGit(
      '/repo',
      { protectMain: true },
      fakeGit({ 'status --porcelain -b': PORCELAIN_CLEAN, 'rev-parse --short HEAD': 'abc1234\n' }),
    );
    assert.equal(state.activeBranch, 'main');
    assert.equal(state.headSha, 'abc1234');
    assert.equal(state.sandboxReady, true);
    assert.equal(state.protectMain, true);
    assert.deepEqual(state.dirtyFiles, []);
  });

  it('maps a dirty tree with ahead tracking', async () => {
    const state = await readWorkspaceStateFromGit(
      '/repo',
      { protectMain: false },
      fakeGit({ 'status --porcelain -b': PORCELAIN_DIRTY, 'rev-parse --short HEAD': 'def5678\n' }),
    );
    assert.equal(state.activeBranch, 'feat/x');
    assert.equal(state.ahead, 1);
    assert.deepEqual(state.dirtyFiles, [
      { path: 'lib/a.ts', status: 'modified' },
      { path: 'app/b.ts', status: 'untracked' },
    ]);
  });

  it('returns null when cwd is not a git repo (status fails)', async () => {
    const state = await readWorkspaceStateFromGit('/tmp', { protectMain: false }, fakeGit({}));
    assert.equal(state, null);
  });

  it('falls back to an unborn placeholder when HEAD has no commits', async () => {
    const state = await readWorkspaceStateFromGit(
      '/repo',
      { protectMain: false },
      fakeGit({ 'status --porcelain -b': '## No commits yet on main\n' }),
    );
    assert.equal(state.headSha, '(unborn)');
  });
});

describe('workspace-state-emitter — nextWorkspaceStateEvent', () => {
  const state = (overrides = {}) => ({
    activeBranch: 'main',
    headSha: 'sha0',
    dirtyFiles: [],
    protectMain: false,
    sandboxReady: true,
    ...overrides,
  });

  it('emits a snapshot and returns a fresh producer', () => {
    const r = nextWorkspaceStateEvent(null, 'sess-1', state(), 'snapshot');
    assert.equal(r.event.type, 'workspace.state_snapshot');
    assert.equal(r.event.workspaceId, 'sess-1');
    assert.equal(r.event.rev, 0);
    assert.ok(r.producer);
  });

  it('degrades a delta with no producer into a snapshot', () => {
    const r = nextWorkspaceStateEvent(null, 'sess-1', state(), 'delta');
    assert.equal(r.event.type, 'workspace.state_snapshot');
  });

  it('emits a delta from an existing producer and chains rev', () => {
    const first = nextWorkspaceStateEvent(null, 'sess-1', state(), 'snapshot');
    const r = nextWorkspaceStateEvent(
      first.producer,
      'sess-1',
      state({ headSha: 'sha1' }),
      'delta',
    );
    assert.equal(r.event.type, 'workspace.state_delta');
    assert.equal(r.event.baseRev, 0);
    assert.equal(r.event.rev, 1);
    assert.deepEqual(r.event.ops, [{ op: 'set_head', headSha: 'sha1' }]);
  });

  it('returns a null event when a delta finds nothing changed', () => {
    const first = nextWorkspaceStateEvent(null, 'sess-1', state(), 'snapshot');
    const r = nextWorkspaceStateEvent(first.producer, 'sess-1', state(), 'delta');
    assert.equal(r.event, null);
    assert.equal(r.producer, first.producer);
  });
});
