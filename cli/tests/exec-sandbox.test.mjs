import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  buildNativeSandboxArgs,
  resolveExecSandboxBackend,
  runCommandInExecSandbox,
} from '../exec-sandbox.ts';

const execFileAsync = promisify(execFile);
const originalSandbox = process.env.PUSH_LOCAL_SANDBOX;
const originalNetwork = process.env.PUSH_NATIVE_SANDBOX_NETWORK;

afterEach(() => {
  if (originalSandbox === undefined) delete process.env.PUSH_LOCAL_SANDBOX;
  else process.env.PUSH_LOCAL_SANDBOX = originalSandbox;
  if (originalNetwork === undefined) delete process.env.PUSH_NATIVE_SANDBOX_NETWORK;
  else process.env.PUSH_NATIVE_SANDBOX_NETWORK = originalNetwork;
});

describe('resolveExecSandboxBackend', () => {
  it('preserves legacy booleans and accepts named backends', () => {
    assert.equal(resolveExecSandboxBackend(true), 'docker');
    assert.equal(resolveExecSandboxBackend(false), 'host');
    assert.equal(resolveExecSandboxBackend('true'), 'docker');
    assert.equal(resolveExecSandboxBackend('false'), 'host');
    assert.equal(resolveExecSandboxBackend('docker'), 'docker');
    assert.equal(resolveExecSandboxBackend('native'), 'native');
    assert.equal(resolveExecSandboxBackend('bwrap'), 'native');
    assert.equal(resolveExecSandboxBackend('host'), 'host');
  });

  it('fails closed on an unknown backend', () => {
    assert.throws(() => resolveExecSandboxBackend('wishful-thinking'), /Invalid/);
  });
});

describe('buildNativeSandboxArgs', () => {
  const shell = { bin: '/bin/bash', argsPrefix: ['-lc'], commandMode: 'argv' };

  it('makes the host read-only, workspace writable, and network isolated', () => {
    const workspaceRoot = path.resolve('/workspace/repo');
    const cwd = path.join(workspaceRoot, 'packages/cli');
    const args = buildNativeSandboxArgs({
      command: 'pnpm test',
      workspaceRoot,
      cwd,
      shell,
    });

    assert.deepEqual(args.slice(0, 6), [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-net',
    ]);
    assert.ok(args.includes('--ro-bind'));
    assert.ok(args.includes('--bind'));
    assert.ok(args.includes(workspaceRoot));
    assert.ok(args.includes(cwd));
    assert.ok(args.includes('/run'), 'host runtime sockets are masked');
    assert.equal(args.at(-1), 'pnpm test');
  });

  it('adds validated external Git metadata as an additional writable mount', () => {
    const workspaceRoot = path.resolve('/workspace/repo');
    const gitCommonDir = path.resolve('/repos/main/.git');
    const args = buildNativeSandboxArgs({
      command: 'git add file.txt',
      workspaceRoot,
      cwd: workspaceRoot,
      shell,
      writableGitMetadataPaths: [gitCommonDir],
    });

    const bindIndex = args.lastIndexOf('--bind');
    assert.deepEqual(args.slice(bindIndex, bindIndex + 3), ['--bind', gitCommonDir, gitCommonDir]);
  });

  it('allows an explicit network opt-in without widening filesystem access', () => {
    const args = buildNativeSandboxArgs({
      command: 'pnpm install',
      workspaceRoot: '/workspace/repo',
      cwd: '/workspace/repo',
      shell,
      networkAccess: true,
    });
    assert.equal(args.includes('--unshare-net'), false);
    assert.ok(args.includes('--ro-bind'));
  });

  it('refuses a cwd outside the writable root', () => {
    assert.throws(
      () =>
        buildNativeSandboxArgs({
          command: 'pwd',
          workspaceRoot: '/workspace/repo',
          cwd: '/workspace/other',
          shell,
        }),
      /escapes workspace root/,
    );
  });
});

const hasBubblewrap =
  process.platform === 'linux' &&
  (await execFileAsync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' })
    .then(() => true)
    .catch(() => false));

describe('native exec sandbox integration', { skip: !hasBubblewrap }, () => {
  it('permits workspace writes and blocks host writes outside the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-native-sandbox-'));
    const deniedPath = `/etc/push-native-sandbox-${process.pid}`;
    process.env.PUSH_LOCAL_SANDBOX = 'native';

    try {
      const command = `touch inside.txt; if touch ${deniedPath} 2>/dev/null; then exit 42; fi`;
      const result = await runCommandInExecSandbox(command, workspace, {
        cwd: workspace,
        env: { ...process.env },
      });
      assert.equal(result.backend, 'native');
      assert.equal(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8'), '');
      await assert.rejects(() => fs.access(deniedPath));
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(deniedPath, { force: true }).catch(() => {});
    }
  });

  it('keeps linked-worktree Git metadata writable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-native-worktree-'));
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'linked');
    process.env.PUSH_LOCAL_SANDBOX = 'native';

    try {
      await fs.mkdir(main);
      await execFileAsync('git', ['init', '-q'], { cwd: main });
      await execFileAsync('git', ['config', 'user.email', 'push@example.test'], { cwd: main });
      await execFileAsync('git', ['config', 'user.name', 'Push Test'], { cwd: main });
      await fs.writeFile(path.join(main, 'tracked.txt'), 'before\n');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: main });
      await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: main });
      await execFileAsync('git', ['worktree', 'add', '-qb', 'native-review', worktree], {
        cwd: main,
      });

      const result = await runCommandInExecSandbox(
        "printf 'after\\n' >> tracked.txt && git add tracked.txt && git commit -qm native",
        worktree,
        { cwd: worktree, env: { ...process.env } },
      );
      assert.equal(result.backend, 'native');
      const subject = await execFileAsync('git', ['log', '-1', '--format=%s'], {
        cwd: worktree,
        encoding: 'utf8',
      });
      assert.equal(subject.stdout.trim(), 'native');

      // The workspace marker is writable. Redirecting it at another checkout
      // must not convince the host-side resolver to grant that checkout's Git
      // metadata write access on the next command.
      await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git')}\n`);
      await assert.rejects(
        () =>
          runCommandInExecSandbox('true', worktree, {
            cwd: worktree,
            env: { ...process.env },
          }),
        /inconsistent linked-worktree metadata/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
