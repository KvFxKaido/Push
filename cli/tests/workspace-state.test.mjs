import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWorkspaceDelta,
  createWorkspaceStateProducer,
  diffWorkspaceState,
  dirtyStatusFromEntry,
  gitStatusInfoToWorkspaceState,
  reduceWorkspaceStateEvent,
} from '../../lib/workspace-state.ts';

function baseState(overrides = {}) {
  return {
    activeBranch: 'main',
    headSha: 'sha0',
    ahead: 0,
    behind: 0,
    dirtyFiles: [],
    protectMain: true,
    sandboxReady: true,
    ...overrides,
  };
}

describe('workspace-state — diff/apply', () => {
  it('emits no ops for equivalent states', () => {
    assert.deepEqual(diffWorkspaceState(baseState(), baseState()), []);
  });

  it('moves branch and head together as one set_branch op', () => {
    const ops = diffWorkspaceState(
      baseState(),
      baseState({ activeBranch: 'feat/x', headSha: 'sha1' }),
    );
    assert.deepEqual(ops, [{ op: 'set_branch', activeBranch: 'feat/x', headSha: 'sha1' }]);
  });

  it('emits set_head alone when only the commit advances on the same branch', () => {
    const ops = diffWorkspaceState(baseState(), baseState({ headSha: 'sha1' }));
    assert.deepEqual(ops, [{ op: 'set_head', headSha: 'sha1' }]);
  });

  it('collapses a full dirty-tree wipe to a single dirty_clear', () => {
    const prev = baseState({ dirtyFiles: [{ path: 'a.ts', status: 'modified' }] });
    const ops = diffWorkspaceState(prev, baseState({ dirtyFiles: [] }));
    assert.deepEqual(ops, [{ op: 'dirty_clear' }]);
  });

  it('emits targeted add/remove for incremental dirty-tree churn', () => {
    const prev = baseState({ dirtyFiles: [{ path: 'a.ts', status: 'modified' }] });
    const next = baseState({
      dirtyFiles: [
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'added' },
      ],
    });
    assert.deepEqual(diffWorkspaceState(prev, next), [
      { op: 'dirty_add', file: { path: 'b.ts', status: 'added' } },
    ]);
  });

  it('round-trips: applying diff(a, b) onto a yields b', () => {
    const a = baseState({ dirtyFiles: [{ path: 'a.ts', status: 'modified' }] });
    const b = baseState({
      activeBranch: 'feat/y',
      headSha: 'sha9',
      ahead: 2,
      behind: 1,
      dirtyFiles: [{ path: 'b.ts', status: 'added' }],
      protectMain: false,
      sandboxReady: false,
    });
    assert.deepEqual(applyWorkspaceDelta(a, diffWorkspaceState(a, b)), b);
  });

  it('does not mutate the input state', () => {
    const a = baseState({ dirtyFiles: [{ path: 'a.ts', status: 'modified' }] });
    const snapshot = JSON.stringify(a);
    applyWorkspaceDelta(a, [{ op: 'dirty_clear' }]);
    assert.equal(JSON.stringify(a), snapshot);
  });
});

describe('workspace-state — git status mapping', () => {
  const entry = (x, y, path) => ({ x, y, path, raw: `${x}${y} ${path}` });

  it('maps porcelain columns to dirty statuses (untracked/conflict precedence)', () => {
    assert.equal(dirtyStatusFromEntry(entry('?', '?', 'a')), 'untracked');
    assert.equal(dirtyStatusFromEntry(entry('U', 'U', 'a')), 'conflicted');
    assert.equal(dirtyStatusFromEntry(entry('D', 'D', 'a')), 'conflicted');
    assert.equal(dirtyStatusFromEntry(entry('R', ' ', 'a')), 'renamed');
    assert.equal(dirtyStatusFromEntry(entry('A', ' ', 'a')), 'added');
    assert.equal(dirtyStatusFromEntry(entry(' ', 'D', 'a')), 'deleted');
    assert.equal(dirtyStatusFromEntry(entry(' ', 'M', 'a')), 'modified');
    assert.equal(dirtyStatusFromEntry(entry('M', ' ', 'a')), 'modified');
  });

  function gitInfo(overrides = {}) {
    return {
      branch: 'main',
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      copied: [],
      conflicted: [],
      untracked: [],
      ahead: 0,
      behind: 0,
      detached: false,
      hasUpstream: true,
      statusLine: '',
      staged: 0,
      unstaged: 0,
      entries: [],
      ...overrides,
    };
  }

  it('builds a WorkspaceState with one dirtyFile per porcelain entry', () => {
    const state = gitStatusInfoToWorkspaceState(
      gitInfo({
        branch: 'feat/x',
        ahead: 2,
        behind: 1,
        entries: [entry('M', ' ', 'lib/a.ts'), entry('?', '?', 'app/b.ts')],
      }),
      { headSha: 'sha1', protectMain: true, sandboxReady: true },
    );
    assert.deepEqual(state, {
      activeBranch: 'feat/x',
      headSha: 'sha1',
      ahead: 2,
      behind: 1,
      dirtyFiles: [
        { path: 'lib/a.ts', status: 'modified' },
        { path: 'app/b.ts', status: 'untracked' },
      ],
      protectMain: true,
      sandboxReady: true,
    });
  });

  it('omits ahead/behind when there is no upstream (they are meaningless)', () => {
    const state = gitStatusInfoToWorkspaceState(
      gitInfo({ hasUpstream: false, ahead: 5, behind: 0 }),
      { headSha: 'sha1', protectMain: false, sandboxReady: true },
    );
    assert.equal(state.ahead, undefined);
    assert.equal(state.behind, undefined);
  });

  it('keeps activeBranch non-empty on a detached HEAD', () => {
    const state = gitStatusInfoToWorkspaceState(gitInfo({ branch: '', detached: true }), {
      headSha: 'sha1',
      protectMain: false,
      sandboxReady: true,
    });
    assert.equal(state.activeBranch, 'HEAD');
  });

  it('feeds cleanly through a producer → reducer round-trip on real-shaped input', () => {
    const first = gitStatusInfoToWorkspaceState(gitInfo({ entries: [entry('M', ' ', 'a.ts')] }), {
      headSha: 'sha1',
      protectMain: true,
      sandboxReady: true,
    });
    const producer = createWorkspaceStateProducer('sandbox-1', first);
    let view = reduceWorkspaceStateEvent(null, producer.snapshot()).view;
    assert.equal(view.rev, 0);

    const second = gitStatusInfoToWorkspaceState(
      gitInfo({ entries: [entry('M', ' ', 'a.ts'), entry('A', ' ', 'b.ts')] }),
      { headSha: 'sha2', protectMain: true, sandboxReady: true },
    );
    const delta = producer.update(second);
    view = reduceWorkspaceStateEvent(view, delta).view;
    assert.equal(view.rev, 1);
    assert.deepEqual(view.state, second);
  });
});

describe('workspace-state — producer', () => {
  it('opens at rev 0 and chains baseRev across updates', () => {
    const p = createWorkspaceStateProducer('ws1', baseState());
    assert.deepEqual(p.snapshot(), {
      type: 'workspace.state_snapshot',
      workspaceId: 'ws1',
      rev: 0,
      state: baseState(),
    });

    const d1 = p.update(baseState({ headSha: 'sha1' }));
    assert.equal(d1.rev, 1);
    assert.equal(d1.baseRev, 0);

    const d2 = p.update(baseState({ headSha: 'sha2' }));
    assert.equal(d2.rev, 2);
    assert.equal(d2.baseRev, 1);
  });

  it('returns null (no event) when nothing changed', () => {
    const p = createWorkspaceStateProducer('ws1', baseState());
    assert.equal(p.update(baseState()), null);
  });

  it('reset starts a fresh identity at rev 0', () => {
    const p = createWorkspaceStateProducer('ws1', baseState());
    p.update(baseState({ headSha: 'sha1' }));
    const snap = p.reset('ws2', baseState({ activeBranch: 'dev' }));
    assert.equal(snap.workspaceId, 'ws2');
    assert.equal(snap.rev, 0);
    assert.equal(snap.state.activeBranch, 'dev');
  });
});

describe('workspace-state — reducer (snapshot ground truth, delta disposable)', () => {
  const snapshot = (workspaceId, rev, state) => ({
    type: 'workspace.state_snapshot',
    workspaceId,
    rev,
    state,
  });
  const delta = (workspaceId, rev, baseRev, ops) => ({
    type: 'workspace.state_delta',
    workspaceId,
    rev,
    baseRev,
    ops,
  });

  it('adopts a snapshot unconditionally from a null view', () => {
    const r = reduceWorkspaceStateEvent(null, snapshot('ws1', 0, baseState()));
    assert.equal(r.outcome, 'snapshot_adopted');
    assert.deepEqual(r.view, { workspaceId: 'ws1', rev: 0, state: baseState() });
  });

  it('applies a delta whose baseRev matches the current view', () => {
    const seeded = reduceWorkspaceStateEvent(null, snapshot('ws1', 0, baseState())).view;
    const r = reduceWorkspaceStateEvent(
      seeded,
      delta('ws1', 1, 0, [{ op: 'set_head', headSha: 'sha1' }]),
    );
    assert.equal(r.outcome, 'delta_applied');
    assert.equal(r.view.rev, 1);
    assert.equal(r.view.state.headSha, 'sha1');
  });

  it('drops a delta with no base snapshot and leaves the view null', () => {
    const r = reduceWorkspaceStateEvent(null, delta('ws1', 1, 0, [{ op: 'dirty_clear' }]));
    assert.equal(r.outcome, 'delta_dropped_no_base');
    assert.equal(r.view, null);
  });

  it('drops a delta from a different workspace identity, view unchanged', () => {
    const seeded = reduceWorkspaceStateEvent(null, snapshot('ws1', 0, baseState())).view;
    const r = reduceWorkspaceStateEvent(
      seeded,
      delta('ws2', 1, 0, [{ op: 'set_head', headSha: 'sha1' }]),
    );
    assert.equal(r.outcome, 'delta_dropped_identity');
    assert.deepEqual(r.view, seeded);
  });

  it('drops a delta whose baseRev skips ahead (a gap), view unchanged', () => {
    const seeded = reduceWorkspaceStateEvent(null, snapshot('ws1', 0, baseState())).view;
    // A delta was lost: this one bases on rev 1 but the view is still at rev 0.
    const r = reduceWorkspaceStateEvent(
      seeded,
      delta('ws1', 2, 1, [{ op: 'set_head', headSha: 'sha2' }]),
    );
    assert.equal(r.outcome, 'delta_dropped_gap');
    assert.deepEqual(r.view, seeded);
  });

  it('recovers after a gap once the next snapshot arrives', () => {
    let view = reduceWorkspaceStateEvent(null, snapshot('ws1', 0, baseState())).view;
    // Gap — dropped.
    view = reduceWorkspaceStateEvent(
      view,
      delta('ws1', 2, 1, [{ op: 'set_head', headSha: 'sha2' }]),
    ).view;
    assert.equal(view.rev, 0);
    // Resync snapshot re-anchors the timeline.
    const r = reduceWorkspaceStateEvent(view, snapshot('ws1', 3, baseState({ headSha: 'sha3' })));
    assert.equal(r.outcome, 'snapshot_adopted');
    assert.equal(r.view.rev, 3);
    assert.equal(r.view.state.headSha, 'sha3');
  });
});
