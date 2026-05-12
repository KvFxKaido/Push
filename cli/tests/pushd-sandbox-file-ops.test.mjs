/**
 * pushd-sandbox-file-ops.test.mjs — Coverage for the daemon-side
 * file-op request handlers added in PR 3c.3: `sandbox_read_file`,
 * `sandbox_write_file`, `sandbox_list_dir`, `sandbox_diff`. Drives
 * `handleRequest` directly (Unix-socket-compatible signature) so the
 * dispatcher path is exercised alongside the per-handler logic.
 *
 * Each test runs against an isolated temp dir so writes don't leak
 * into the repo. `process.chdir()` lands the daemon there for the
 * duration of the test — `resolveDaemonPath` reads `process.cwd()`,
 * so this is the standard hook.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from '../pushd.ts';
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

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-fileops-'));
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('sandbox_read_file', () => {
  it('reads a file relative to the daemon cwd', async () => {
    await fs.writeFile(path.join(tmpRoot, 'hello.txt'), 'first\nsecond\nthird\n', 'utf8');
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: 'hello.txt' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.type, 'sandbox_read_file');
    assert.equal(res.payload.content, 'first\nsecond\nthird\n');
    assert.equal(res.payload.truncated, false);
    assert.equal(res.payload.totalLines, 4); // trailing newline → 4 split entries
  });

  it('strips a /workspace/ prefix and re-roots at the daemon cwd', async () => {
    // Cloud sandboxes are conventionally rooted at /workspace. Models
    // trained on the cloud surface emit paths like /workspace/src/foo.ts.
    // The daemon re-roots these to its own cwd so the model doesn't
    // have to know whether it's talking to cloud or local-pc.
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'src', 'foo.ts'), 'export const x = 1;\n', 'utf8');
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: '/workspace/src/foo.ts' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.match(res.payload.content, /export const x = 1/);
  });

  it('respects startLine and endLine when both are provided', async () => {
    await fs.writeFile(path.join(tmpRoot, 'lines.txt'), 'a\nb\nc\nd\ne\n', 'utf8');
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: 'lines.txt', startLine: 2, endLine: 4 }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.content, 'b\nc\nd');
    assert.equal(res.payload.totalLines, 6);
  });

  it('rejects an empty path with INVALID_REQUEST', async () => {
    const res = await handleRequest(makeRequest('sandbox_read_file', {}), NOOP_EMIT);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_REQUEST');
  });

  it('surfaces ENOENT for a missing file (ok=true, error in payload)', async () => {
    // Missing-file is a normal result the model needs to see, not an
    // RPC-layer failure. ok=true; payload.error/code carry the detail.
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: 'nope.txt' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.code, 'ENOENT');
    assert.ok(res.payload.error);
  });

  it('refuses sensitive paths at the daemon boundary (Kilo PR #515)', async () => {
    // Defense in depth: even if a stolen bearer bypasses the web-side
    // isSensitivePath check, the daemon refuses these reads.
    await fs.writeFile(path.join(tmpRoot, '.env'), 'SECRET=hunter2\n', 'utf8');
    const res = await handleRequest(makeRequest('sandbox_read_file', { path: '.env' }), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.payload.code, 'SENSITIVE_PATH');
    assert.equal(res.payload.content, '');
    assert.match(res.payload.error, /sensitive/);
  });

  it('refuses absolute paths into ~/.ssh at the daemon boundary', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: '/home/whoever/.ssh/id_ed25519' }),
      NOOP_EMIT,
    );
    assert.equal(res.payload.code, 'SENSITIVE_PATH');
  });

  it('refuses relative paths that escape the workspace root (Copilot PR #516)', async () => {
    // `../outside` resolves to a sibling of the daemon cwd. Even
    // though the user paired the daemon (consenting to local FS
    // access), pairing is bound to cwd — the model shouldn't be able
    // to slip out via path traversal.
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: '../outside.txt' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.code, 'PATH_OUTSIDE_WORKSPACE');
    assert.match(res.payload.error, /escapes workspace root/);
  });

  it('sanitizes ENOENT messages to omit the resolved host path', async () => {
    // Node's default err.message for ENOENT includes the resolved
    // absolute path. The handler should return a generic message
    // plus the model's ORIGINAL requested path — not the host path
    // (which leaks user/dir info into the chat).
    const res = await handleRequest(
      makeRequest('sandbox_read_file', { path: 'absent.txt' }),
      NOOP_EMIT,
    );
    assert.equal(res.payload.code, 'ENOENT');
    assert.match(res.payload.error, /No such file or directory.*absent\.txt/);
    // tmpRoot is the host path the resolved absolute would expose —
    // it MUST NOT be in the error.
    assert.ok(
      !res.payload.error.includes(tmpRoot),
      `error must not include host path; got: ${res.payload.error}`,
    );
  });

  it('honors line range on a file larger than the whole-file byte cap (Codex P2)', async () => {
    // Build a 1.5MB file: each line is "xxxxx...x" (1024 bytes including
    // newline). 1500 lines * 1024 = 1.5MB > SANDBOX_FILE_MAX_BYTES (1MB).
    // Without the streaming fix, a range read of lines 1490–1495 would
    // return the first 1MB truncated instead of the requested lines.
    const linePayload = `${'x'.repeat(1023)}\n`;
    const lines = [];
    for (let i = 1; i <= 1500; i++) {
      // Distinct prefix on the last 10 lines so we can verify which
      // window the handler returned.
      lines.push(i >= 1490 ? `line${i}_${'x'.repeat(1015)}\n` : linePayload);
    }
    await fs.writeFile(path.join(tmpRoot, 'big.txt'), lines.join(''), 'utf8');
    const res = await handleRequest(
      makeRequest('sandbox_read_file', {
        path: 'big.txt',
        startLine: 1490,
        endLine: 1495,
      }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.truncated, false);
    assert.match(res.payload.content, /^line1490_/);
    assert.match(res.payload.content, /\nline1495_/);
    // totalLines should be the exact file line count
    assert.equal(res.payload.totalLines, 1501); // 1500 lines + trailing newline split
  });
});

describe('sandbox_write_file', () => {
  it('writes a new file under the daemon cwd', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_write_file', { path: 'wrote.txt', content: 'payload-3c3' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.bytesWritten, 'payload-3c3'.length);
    const onDisk = await fs.readFile(path.join(tmpRoot, 'wrote.txt'), 'utf8');
    assert.equal(onDisk, 'payload-3c3');
  });

  it('creates intermediate directories as needed', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_write_file', { path: 'deep/nested/path.txt', content: 'ok' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.ok, true);
    const onDisk = await fs.readFile(path.join(tmpRoot, 'deep', 'nested', 'path.txt'), 'utf8');
    assert.equal(onDisk, 'ok');
  });

  it('rejects when path or content is missing', async () => {
    const noPath = await handleRequest(
      makeRequest('sandbox_write_file', { content: 'x' }),
      NOOP_EMIT,
    );
    assert.equal(noPath.ok, false);
    assert.equal(noPath.error.code, 'INVALID_REQUEST');

    const noContent = await handleRequest(
      makeRequest('sandbox_write_file', { path: 'x.txt' }),
      NOOP_EMIT,
    );
    assert.equal(noContent.ok, false);
    assert.equal(noContent.error.code, 'INVALID_REQUEST');
  });

  it('accepts an empty-string content (zero-byte file)', async () => {
    // An empty string is a legitimate file content — different from
    // a missing content field. Don't conflate them in the guard.
    const res = await handleRequest(
      makeRequest('sandbox_write_file', { path: 'empty.txt', content: '' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.ok, true);
    assert.equal(res.payload.bytesWritten, 0);
  });

  it('refuses sensitive paths at the daemon boundary', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_write_file', { path: '.env', content: 'STOLEN_KEY=...' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.equal(res.payload.ok, false);
    assert.match(res.payload.error, /sensitive/);
    // And no file was written.
    await assert.rejects(
      fs.access(path.join(tmpRoot, '.env')),
      /ENOENT/,
      'daemon must NOT have written the sensitive file',
    );
  });
});

describe('sandbox_list_dir', () => {
  it('lists the daemon cwd when no path is given', async () => {
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), '1', 'utf8');
    await fs.mkdir(path.join(tmpRoot, 'subdir'));
    const res = await handleRequest(makeRequest('sandbox_list_dir', {}), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.type, 'sandbox_list_dir');
    const names = res.payload.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['a.txt', 'subdir']);
    const file = res.payload.entries.find((e) => e.name === 'a.txt');
    assert.equal(file.type, 'file');
    assert.equal(file.size, 1);
    const dir = res.payload.entries.find((e) => e.name === 'subdir');
    assert.equal(dir.type, 'directory');
  });

  it('lists a relative subdir', async () => {
    await fs.mkdir(path.join(tmpRoot, 'sub'));
    await fs.writeFile(path.join(tmpRoot, 'sub', 'inside.txt'), 'x', 'utf8');
    const res = await handleRequest(makeRequest('sandbox_list_dir', { path: 'sub' }), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.payload.entries.map((e) => e.name),
      ['inside.txt'],
    );
  });

  it('returns a soft error for a missing directory', async () => {
    const res = await handleRequest(makeRequest('sandbox_list_dir', { path: 'nope' }), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.ok(res.payload.error);
    assert.deepEqual(res.payload.entries, []);
  });

  it('refuses sensitive paths at the daemon boundary', async () => {
    const res = await handleRequest(
      makeRequest('sandbox_list_dir', { path: '/home/whoever/.ssh' }),
      NOOP_EMIT,
    );
    assert.equal(res.ok, true);
    assert.match(res.payload.error, /sensitive/);
    assert.deepEqual(res.payload.entries, []);
  });
});

describe('sandbox_diff', () => {
  it('returns empty diff and empty status for a non-git cwd', async () => {
    // No git init in tmpRoot — `git diff HEAD` will fail. Handler
    // returns a soft error in `error` but ok=true at the RPC layer.
    const res = await handleRequest(makeRequest('sandbox_diff', {}), NOOP_EMIT);
    assert.equal(res.ok, true);
    assert.equal(res.type, 'sandbox_diff');
    // Either error is set, or diff is empty — both acceptable for a
    // non-git cwd. We only assert the envelope shape.
    assert.equal(typeof res.payload.diff, 'string');
    assert.equal(typeof res.payload.truncated, 'boolean');
  });

  it('falls back to the empty tree in a freshly-init repo (Gemini PR #515)', async () => {
    // Initialize a repo but make no commits. Without the fallback,
    // `git diff HEAD` errors and the model gets a confusing git
    // message; with it, we diff against the empty tree and the staged/
    // unstaged adds show up as additions.
    const { runCommandInResolvedShell } = await import('../shell.js');
    await runCommandInResolvedShell('git init --initial-branch=main', { cwd: tmpRoot });
    await runCommandInResolvedShell(
      'git config user.email test@test && git config user.name test',
      { cwd: tmpRoot },
    );
    await fs.writeFile(path.join(tmpRoot, 'new.txt'), 'fresh content\n', 'utf8');
    await runCommandInResolvedShell('git add new.txt', { cwd: tmpRoot });

    const res = await handleRequest(makeRequest('sandbox_diff', {}), NOOP_EMIT);
    assert.equal(res.ok, true);
    // No `error` field — diff vs empty tree succeeded.
    assert.equal(res.payload.error, undefined);
    // The new file should appear as an add in the diff.
    assert.match(res.payload.diff, /diff --git/);
    assert.match(res.payload.diff, /\+fresh content/);
  });
});
