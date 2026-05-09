import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runCheckpointCommand } from '../checkpoint-command.ts';
import { createCheckpoint } from '../checkpoint-store.ts';

const exec = promisify(execFileCb);

let workspace;

async function git(args) {
  await exec('git', args, { cwd: workspace });
}

function makeRenderer() {
  const calls = [];
  return {
    calls,
    status: (t) => calls.push({ kind: 'status', text: t }),
    warning: (t) => calls.push({ kind: 'warning', text: t }),
    error: (t) => calls.push({ kind: 'error', text: t }),
    // The dispatcher uses bold/dim inline. Wrap them in marker brackets so
    // tests can assert that emphasis is applied to the right tokens
    // without depending on ANSI escape codes.
    bold: (t) => `[B]${t}[/B]`,
    dim: (t) => `[D]${t}[/D]`,
  };
}

const baseCtx = (workspaceRoot) => ({
  workspaceRoot,
  sessionId: 'sess_test_abcdef',
  messages: [],
  provider: 'openrouter',
  model: 'test/model',
});

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-checkpoint-cmd-'));
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

describe('runCheckpointCommand — help', () => {
  it('emits usage as a status when called with no args', async () => {
    const r = makeRenderer();
    await runCheckpointCommand('', baseCtx(workspace), r);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /^Usage:/);
    assert.match(r.calls[0].text, /\/checkpoint create/);
  });
});

describe('runCheckpointCommand — create', () => {
  it('reports success via status with the name in bold', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edited\n');
    const r = makeRenderer();
    await runCheckpointCommand('create snap', baseCtx(workspace), r);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /^Saved checkpoint \[B\]snap\[\/B\]: 1 file\(s\)/);
  });

  it('routes name collisions to the error channel', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await runCheckpointCommand('create dup', baseCtx(workspace), makeRenderer());
    const r = makeRenderer();
    await runCheckpointCommand('create dup', baseCtx(workspace), r);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].kind, 'error');
    assert.match(r.calls[0].text, /already exists/);
  });
});

describe('runCheckpointCommand — list', () => {
  it('returns a friendly hint when there are no checkpoints', async () => {
    const r = makeRenderer();
    await runCheckpointCommand('list', baseCtx(workspace), r);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /No checkpoints/);
  });

  it('emits one status with bolded names and dim metadata', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'first',
      sessionId: 'sess_test_abcdef',
    });
    const r = makeRenderer();
    await runCheckpointCommand('list', baseCtx(workspace), r);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /\[B\]first\[\/B\]/);
    // Branch suffix is dim-wrapped.
    assert.match(r.calls[0].text, /\[D\]@main\[\/D\]/);
  });
});

describe('runCheckpointCommand — load', () => {
  it('warns when no name is given', async () => {
    const r = makeRenderer();
    await runCheckpointCommand('load', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'warning');
    assert.match(r.calls[0].text, /^Usage: \/checkpoint load/);
  });

  it('errors when the named checkpoint does not exist', async () => {
    const r = makeRenderer();
    await runCheckpointCommand('load nope', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'error');
    assert.match(r.calls[0].text, /no checkpoint named "nope"/);
  });

  it('previews without restoring when --force is omitted', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'snap\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'p1',
      sessionId: 'sess_test_abcdef',
    });
    await fs.writeFile(path.join(workspace, 'a.txt'), 'mutated\n');

    const r = makeRenderer();
    await runCheckpointCommand('load p1', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /Would restore 1 file/);
    assert.match(r.calls[0].text, /Re-run with --force/);

    // Disk is unchanged.
    const onDisk = await fs.readFile(path.join(workspace, 'a.txt'), 'utf8');
    assert.equal(onDisk, 'mutated\n');
  });

  it('restores files when --force is passed', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'snap\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'p2',
      sessionId: 'sess_test_abcdef',
    });
    await fs.writeFile(path.join(workspace, 'a.txt'), 'mutated\n');

    const r = makeRenderer();
    await runCheckpointCommand('load p2 --force', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /Restored 1 file/);

    const onDisk = await fs.readFile(path.join(workspace, 'a.txt'), 'utf8');
    assert.equal(onDisk, 'snap\n');
  });
});

describe('runCheckpointCommand — delete', () => {
  it('warns when no name is given', async () => {
    const r = makeRenderer();
    await runCheckpointCommand('delete', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'warning');
    assert.match(r.calls[0].text, /^Usage: \/checkpoint delete/);
  });

  it('reports success after removing the checkpoint', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'edit\n');
    await createCheckpoint({
      workspaceRoot: workspace,
      name: 'd1',
      sessionId: 'sess_test_abcdef',
    });
    const r = makeRenderer();
    await runCheckpointCommand('delete d1', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'status');
    assert.match(r.calls[0].text, /Deleted checkpoint \[B\]d1\[\/B\]/);
  });
});

describe('runCheckpointCommand — unknown', () => {
  it('warns on an unknown subcommand', async () => {
    const r = makeRenderer();
    await runCheckpointCommand('frobnicate', baseCtx(workspace), r);
    assert.equal(r.calls[0].kind, 'warning');
    assert.match(r.calls[0].text, /^Unknown subcommand "frobnicate"/);
  });
});
