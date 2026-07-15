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
    const args = buildNativeSandboxArgs({
      command: 'pnpm test',
      workspaceRoot: '/workspace/repo',
      cwd: '/workspace/repo/packages/cli',
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
    assert.ok(args.includes('/workspace/repo'));
    assert.ok(args.includes('/workspace/repo/packages/cli'));
    assert.ok(args.includes('/run'), 'host runtime sockets are masked');
    assert.equal(args.at(-1), 'pnpm test');
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
});
