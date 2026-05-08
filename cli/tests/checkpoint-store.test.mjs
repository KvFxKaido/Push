import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createCheckpoint,
  deleteCheckpoint,
  getCheckpointRoot,
  listCheckpoints,
  loadCheckpoint,
  validateCheckpointName,
} from '../checkpoint-store.ts';

const exec = promisify(execFileCb);

let workspace;

async function git(args) {
  await exec('git', args, { cwd: workspace });
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-checkpoint-'));
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@push.local']);
  await git(['config', 'user.name', 'Push Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'init']);
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('validateCheckpointName', () => {
  it('accepts simple names', () => {
    assert.equal(validateCheckpointName('foo'), 'foo');
    assert.equal(validateCheckpointName('foo-bar.baz_2'), 'foo-bar.baz_2');
  });

  it('rejects path traversal and empty names', () => {
    assert.throws(() => validateCheckpointName('..'));
    assert.throws(() => validateCheckpointName('foo/bar'));
    assert.throws(() => validateCheckpointName(''));
    assert.throws(() => validateCheckpointName('-leading-hyphen'));
  });
});

describe('createCheckpoint', () => {
  it('snapshots changed and untracked files but skips clean ones', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'one\nedit\n');
    await fs.writeFile(path.join(workspace, 'untracked.txt'), 'fresh\n');
    await fs.writeFile(path.join(workspace, 'unchanged.txt'), '');
    await git(['add', 'unchanged.txt']);
    await git(['commit', '-m', 'add unchanged']);

    const meta = await createCheckpoint({
      workspaceRoot: workspace,
      name: 'snap1',
      sessionId: 'sess_test_abcdef',
      provider: 'openrouter',
      model: 'test/model',
    });

    assert.equal(meta.name, 'snap1');
    assert.deepEqual(meta.files.sort(), ['a.txt', 'untracked.txt']);
    assert.equal(meta.fileCount, 2);
    assert.equal(meta.provider, 'openrouter');
    assert.equal(meta.model, 'test/model');
    assert.ok(meta.head, 'should record HEAD sha');

    const snapped = await fs.readFile(
      path.join(getCheckpointRoot(workspace), 'snap1', 'files', 'a.txt'),
      'utf8',
    );
    assert.equal(snapped, 'one\nedit\n');
  });

  it('refuses to overwrite an existing checkpoint with the same name', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'dup',
      sessionId: 'sess_test_abcdef',
    });
    await assert.rejects(
      createCheckpoint({
        workspaceRoot: workspace,
        name: 'dup',
        sessionId: 'sess_test_abcdef',
      }),
      /already exists/,
    );
  });

  it('auto-generates a timestamp name when none is provided', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    const meta = await createCheckpoint({
      workspaceRoot: workspace,
      sessionId: 'sess_test_abcdef',
    });
    assert.match(meta.name, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  });

  it('appends .push/checkpoints/ to .gitignore (and is idempotent)', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'gi1',
      sessionId: 'sess_test_abcdef',
    });
    let gi = await fs.readFile(path.join(workspace, '.gitignore'), 'utf8');
    assert.match(gi, /\.push\/checkpoints\//);
    // Second create should not duplicate the entry.
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit2\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'gi2',
      sessionId: 'sess_test_abcdef',
    });
    gi = await fs.readFile(path.join(workspace, '.gitignore'), 'utf8');
    const matches = gi.match(/\.push\/checkpoints\//g) || [];
    assert.equal(matches.length, 1, 'should only have one entry after multiple creates');
  });
});

describe('listCheckpoints', () => {
  it('returns metadata sorted newest-first', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'older',
      sessionId: 'sess_test_abcdef',
    });
    // Force a measurably-later createdAt — at least 10ms.
    await new Promise((r) => setTimeout(r, 15));
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit2\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'newer',
      sessionId: 'sess_test_abcdef',
    });

    const items = await listCheckpoints(workspace);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, 'newer');
    assert.equal(items[1].name, 'older');
  });

  it('returns [] when no checkpoint dir exists', async () => {
    const items = await listCheckpoints(workspace);
    assert.deepEqual(items, []);
  });
});

describe('loadCheckpoint', () => {
  it('restores file contents from the snapshot', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'snapshot\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'r1',
      sessionId: 'sess_test_abcdef',
    });
    // Mutate after snapshot.
    await fs.writeFile(path.join(workspace, 'a.txt'), 'after\n');

    const result = await loadCheckpoint(workspace, 'r1');
    assert.deepEqual(result.restoredFiles, ['a.txt']);
    const after = await fs.readFile(path.join(workspace, 'a.txt'), 'utf8');
    assert.equal(after, 'snapshot\n');
  });
});

describe('deleteCheckpoint', () => {
  it('removes the checkpoint directory', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'del-me',
      sessionId: 'sess_test_abcdef',
    });
    await deleteCheckpoint(workspace, 'del-me');
    const items = await listCheckpoints(workspace);
    assert.equal(items.length, 0);
  });
});
