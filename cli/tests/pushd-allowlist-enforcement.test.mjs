/**
 * pushd-allowlist-enforcement.test.mjs — Integration coverage for the
 * Phase 3 allowlist as actually enforced by the daemon's file-op
 * handlers. Verifies that an explicit allowlist tightens the path
 * surface beyond the implicit-cwd default:
 *   - paths inside an allowed root are accepted
 *   - paths outside every allowed root are refused with PATH_OUTSIDE_WORKSPACE
 *   - sandbox_exec's cwd is gated by the same allowlist
 *   - removing every entry restores the implicit-cwd default
 *
 * Companion to `pushd-allowlist.test.mjs` (which covers the storage
 * module in isolation). This file confirms the wiring through
 * `resolveAndAuthorize` actually lands on the request results.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from '../pushd.ts';
import { addAllowedPath, removeAllowedPath } from '../pushd-allowlist.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';

const NOOP_EMIT = () => {};

function makeRequest(type, payload = {}) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'request',
    requestId: `req_test_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    sessionId: null,
    payload,
  };
}

let originalCwd;
let tmpRoot;
let allowlistTmpDir;
let originalAllowlistEnv;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-allowlist-enf-'));
  allowlistTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-allowlist-cfg-'));
  originalAllowlistEnv = process.env.PUSHD_ALLOWLIST_PATH;
  process.env.PUSHD_ALLOWLIST_PATH = path.join(allowlistTmpDir, 'pushd.allowlist');
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalAllowlistEnv === undefined) delete process.env.PUSHD_ALLOWLIST_PATH;
  else process.env.PUSHD_ALLOWLIST_PATH = originalAllowlistEnv;
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  await fs.rm(allowlistTmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('allowlist enforcement (file-op handlers)', () => {
  it('with no explicit allowlist, cwd-relative reads succeed (implicit-default)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'hi', 'utf8');
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: 'hello.txt' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.content, 'hi');
  });

  it('with an explicit allowlist that includes cwd, cwd-relative reads still succeed', async () => {
    await addAllowedPath(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'hi', 'utf8');
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: 'hello.txt' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.content, 'hi');
  });

  it('with an explicit allowlist excluding cwd, an absolute path under cwd is refused', async () => {
    // Allowlist is set to a sibling dir. The daemon's cwd is NOT in
    // the allowlist (the implicit default doesn't auto-include cwd
    // once any explicit entry exists). An absolute read into cwd
    // should be refused.
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-other-'));
    try {
      await addAllowedPath(otherDir);
      await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'hi', 'utf8');
      const res = await handleRequest(
        makeRequest('sandbox_read_file', { path: path.join(tmpRoot, 'hello.txt') }),
        NOOP_EMIT,
      );
      assert.equal(res.ok, true);
      // Soft error envelope rather than RPC-level failure — same
      // shape callers already handle for PATH_OUTSIDE_WORKSPACE.
      assert.equal(res.payload.content, '');
      assert.match(res.payload.error || '', /path escapes workspace root|PATH_OUTSIDE_WORKSPACE/);
      assert.equal(res.payload.code, 'PATH_OUTSIDE_WORKSPACE');
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('allows absolute paths into an explicitly-allowed root', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-other-'));
    try {
      await addAllowedPath(otherDir);
      const target = path.join(otherDir, 'data.txt');
      await fs.writeFile(target, 'allowed-content', 'utf8');
      const res = await handleRequest(
        makeRequest('sandbox_read_file', { path: target }),
        NOOP_EMIT,
      );
      assert.equal(res.ok, true);
      assert.equal(res.payload.content, 'allowed-content');
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('refuses sandbox_exec when its cwd is outside every allowed root', async () => {
    // Pin the allowlist to a directory that ISN'T the daemon's cwd
    // and that isn't the requested cwd. The exec should be refused
    // with PATH_NOT_ALLOWED before the child process is even spawned.
    const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-allowed-'));
    const disallowedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-disallowed-'));
    try {
      await addAllowedPath(allowedDir);
      const res = await handleRequest(
        makeRequest('sandbox_exec', { command: 'echo hi', cwd: disallowedDir }),
        NOOP_EMIT,
      );
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'PATH_NOT_ALLOWED');
    } finally {
      await fs.rm(allowedDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(disallowedDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('permits sandbox_exec when its cwd falls under an allowed root', async () => {
    const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-allowed-'));
    try {
      await addAllowedPath(allowedDir);
      const res = await handleRequest(
        makeRequest('sandbox_exec', { command: 'echo allowed', cwd: allowedDir }),
        NOOP_EMIT,
      );
      assert.equal(res.ok, true);
      assert.equal(res.payload.exitCode, 0);
      assert.match(res.payload.stdout, /allowed/);
    } finally {
      await fs.rm(allowedDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('falls back to the implicit-cwd default after the last allowlist entry is removed', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-other-'));
    try {
      await addAllowedPath(otherDir);
      await removeAllowedPath(otherDir);
      // With the explicit allowlist now empty, the implicit-cwd
      // default re-engages. cwd-relative reads work again.
      await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'hi', 'utf8');
      const res = await handleRequest(
        makeRequest('sandbox_read_file', { path: 'hello.txt' }),
        NOOP_EMIT,
      );
      assert.equal(res.ok, true);
      assert.equal(res.payload.content, 'hi');
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
