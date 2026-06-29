/**
 * Unit tests for cli/worktree.ts against a real temp git repo. The worktree
 * lifecycle is git-state-sensitive (disposability hinges on porcelain status +
 * rev-list), so these drive actual git rather than mocking — the same
 * integration style as workspace-identity.test.mjs.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import {
  addWorktree,
  autoWorktreeBranchName,
  isDisposableWorktree,
  listWorktrees,
  removeWorktree,
  resolveGitRoot,
  sanitizeBranchForPath,
  teardownWorktree,
  worktreeDirFor,
  worktreeState,
  WorktreeError,
} from '../worktree.ts';

const execFileAsync = promisify(execFile);

let repoRoot;
let wtBase;

async function git(cwd, ...args) {
  return execFileAsync('git', args, { cwd });
}

before(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-wt-repo-'));
  await git(repoRoot, 'init', '-b', 'main');
  await git(repoRoot, 'config', 'user.email', 'test@example.com');
  await git(repoRoot, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# base\n');
  await git(repoRoot, 'add', '-A');
  await git(repoRoot, 'commit', '-m', 'base');
});

after(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Each test gets its own worktree parent dir so dirs never collide.
  wtBase = await fs.mkdtemp(path.join(os.tmpdir(), 'push-wt-tree-'));
});

describe('pure helpers', () => {
  it('sanitizeBranchForPath collapses unsafe chars and never returns empty', () => {
    assert.equal(sanitizeBranchForPath('push/sandbox-x'), 'push-sandbox-x');
    assert.equal(sanitizeBranchForPath('feat/@weird~name'), 'feat-weird-name');
    assert.equal(sanitizeBranchForPath('///'), 'sandbox');
  });

  it('worktreeDirFor is under ~/.push/worktrees and disambiguates same-basename repos', () => {
    const a = worktreeDirFor('/home/u/proj', 'b');
    const z = worktreeDirFor('/other/proj', 'b');
    assert.ok(a.startsWith(path.join(os.homedir(), '.push', 'worktrees')));
    assert.notEqual(a, z, 'different repo paths must map to different worktree dirs');
    assert.ok(a.endsWith(path.join('b')));
  });

  it('autoWorktreeBranchName is push/sandbox-<stamp>', () => {
    const name = autoWorktreeBranchName(new Date(2026, 5, 21, 8, 9, 5));
    assert.equal(name, 'push/sandbox-20260621-080905');
  });
});

describe('resolveGitRoot', () => {
  it('returns the toplevel inside a repo and null outside', async () => {
    const resolved = await resolveGitRoot(repoRoot);
    assert.equal(await fs.realpath(resolved), await fs.realpath(repoRoot));

    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'push-wt-nonrepo-'));
    try {
      assert.equal(await resolveGitRoot(nonRepo), null);
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });
});

describe('addWorktree', () => {
  it('creates the branch + checks it out in the worktree dir', async () => {
    const dir = path.join(wtBase, 'wt1');
    const handle = await addWorktree({ repoRoot, branch: 'sandbox/one', dir });
    assert.equal(handle.path, dir);
    assert.equal(handle.branch, 'sandbox/one');
    assert.equal(handle.repoRoot, repoRoot);
    assert.match(handle.baseSha, /^[0-9a-f]{40}$/);

    // The worktree HEAD is on the new branch.
    const { stdout } = await git(dir, 'branch', '--show-current');
    assert.equal(stdout.trim(), 'sandbox/one');
  });

  it('throws WorktreeError on an unresolvable base ref', async () => {
    await assert.rejects(
      addWorktree({
        repoRoot,
        branch: 'sandbox/bad',
        baseRef: 'no-such-ref',
        dir: path.join(wtBase, 'bad'),
      }),
      WorktreeError,
    );
  });

  it('throws WorktreeError when the branch already exists', async () => {
    await addWorktree({ repoRoot, branch: 'sandbox/dup', dir: path.join(wtBase, 'dup-a') });
    await assert.rejects(
      addWorktree({ repoRoot, branch: 'sandbox/dup', dir: path.join(wtBase, 'dup-b') }),
      WorktreeError,
    );
  });
});

describe('worktreeState / isDisposableWorktree', () => {
  it('a fresh worktree is disposable (no changes, no commits beyond base)', async () => {
    const handle = await addWorktree({
      repoRoot,
      branch: 'sandbox/clean',
      dir: path.join(wtBase, 'clean'),
    });
    assert.deepEqual(await worktreeState(handle), {
      dirty: false,
      commitsAhead: 0,
      unpushedCommits: null,
    });
    assert.equal(await isDisposableWorktree(handle), true);
  });

  it('uncommitted changes make it non-disposable', async () => {
    const handle = await addWorktree({
      repoRoot,
      branch: 'sandbox/dirty',
      dir: path.join(wtBase, 'dirty'),
    });
    await fs.writeFile(path.join(handle.path, 'scratch.txt'), 'wip\n');
    const state = await worktreeState(handle);
    assert.equal(state.dirty, true);
    assert.equal(await isDisposableWorktree(handle), false);
  });

  it('an unpushed commit beyond base makes it non-disposable even when clean', async () => {
    const handle = await addWorktree({
      repoRoot,
      branch: 'sandbox/committed',
      dir: path.join(wtBase, 'committed'),
    });
    await fs.writeFile(path.join(handle.path, 'feature.txt'), 'done\n');
    await git(handle.path, 'add', '-A');
    await git(handle.path, 'commit', '-m', 'feature work');
    const state = await worktreeState(handle);
    assert.equal(state.dirty, false);
    assert.equal(state.commitsAhead, 1);
    // No remote ref for this branch → unpushed is unknown, treated as at-risk.
    assert.equal(state.unpushedCommits, null);
    assert.equal(await isDisposableWorktree(handle), false);
  });

  it('a clean, fully-pushed branch IS disposable even with commits beyond base (Gap A)', async () => {
    // Give the repo a bare origin so the branch can have a remote ref.
    const originDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-wt-origin-'));
    try {
      await git(originDir, 'init', '--bare', '-b', 'main');
      await git(repoRoot, 'remote', 'add', 'origin', originDir);
      try {
        const handle = await addWorktree({
          repoRoot,
          branch: 'sandbox/pushed',
          dir: path.join(wtBase, 'pushed'),
        });
        await fs.writeFile(path.join(handle.path, 'feature.txt'), 'shipped\n');
        await git(handle.path, 'add', '-A');
        await git(handle.path, 'commit', '-m', 'pushed feature');
        // Push so origin/sandbox/pushed exists and matches HEAD.
        await git(handle.path, 'push', '-u', 'origin', 'sandbox/pushed');

        const state = await worktreeState(handle);
        assert.equal(state.dirty, false);
        assert.equal(state.commitsAhead, 1, 'has a commit beyond base');
        assert.equal(state.unpushedCommits, 0, 'but it is on the remote');
        assert.equal(
          await isDisposableWorktree(handle),
          true,
          'recoverable from remote → reclaimable',
        );

        const outcome = await teardownWorktree(handle);
        assert.equal(outcome.removed, true);
        assert.equal(outcome.branchDeleted, true);
      } finally {
        await git(repoRoot, 'remote', 'remove', 'origin').catch(() => {});
      }
    } finally {
      await fs.rm(originDir, { recursive: true, force: true });
    }
  });
});

describe('teardownWorktree (clean-if-clean)', () => {
  it('removes a disposable worktree and deletes its branch', async () => {
    const handle = await addWorktree({
      repoRoot,
      branch: 'sandbox/td-clean',
      dir: path.join(wtBase, 'td-clean'),
    });
    const outcome = await teardownWorktree(handle);
    assert.equal(outcome.removed, true);
    assert.equal(outcome.kept, false);
    assert.equal(outcome.branchDeleted, true);
    await assert.rejects(fs.stat(handle.path), 'worktree dir should be gone');
    // Branch is gone from the repo.
    const branches = await listWorktrees(repoRoot);
    assert.ok(!branches.some((w) => w.branch === 'sandbox/td-clean'));
  });

  it('keeps a worktree that has uncommitted work, with a reason', async () => {
    const handle = await addWorktree({
      repoRoot,
      branch: 'sandbox/td-dirty',
      dir: path.join(wtBase, 'td-dirty'),
    });
    await fs.writeFile(path.join(handle.path, 'wip.txt'), 'keep me\n');
    const outcome = await teardownWorktree(handle);
    assert.equal(outcome.kept, true);
    assert.equal(outcome.removed, false);
    assert.match(outcome.reason ?? '', /uncommitted|commits/);
    // The dir and the work survive.
    assert.equal((await fs.readFile(path.join(handle.path, 'wip.txt'), 'utf8')).trim(), 'keep me');
    // Cleanup for the suite.
    await removeWorktree(handle, { force: true, deleteBranch: true });
  });
});

describe('listWorktrees', () => {
  it('includes the main worktree and any added ones with branch names', async () => {
    const handle = await addWorktree({
      repoRoot,
      branch: 'sandbox/listed',
      dir: path.join(wtBase, 'listed'),
    });
    const list = await listWorktrees(repoRoot);
    assert.ok(
      list.some((w) => w.branch === 'main'),
      'main worktree present',
    );
    const added = list.find((w) => w.branch === 'sandbox/listed');
    assert.ok(added, 'added worktree present');
    assert.equal(await fs.realpath(added.path), await fs.realpath(handle.path));
    await removeWorktree(handle, { force: true, deleteBranch: true });
  });
});
