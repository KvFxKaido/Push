/**
 * pushd-allowlist.test.mjs — Coverage for the Phase 3 repo/root
 * allowlist module. Exercises:
 *   - storage round-trip (add/remove/list)
 *   - path validation (rejects relative, `..`, etc.)
 *   - implicit-cwd default behavior when the file doesn't exist
 *   - `isPathAllowed` lexical containment
 *   - file permissions (0600) on the persisted file
 *   - idempotent re-adds (no duplicate entries)
 *
 * Uses a tmp-directory `PUSHD_ALLOWLIST_PATH` env override so each
 * test starts from a clean slate without touching the real
 * ~/.push/run/pushd.allowlist.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  addAllowedPath,
  removeAllowedPath,
  listAllowedPaths,
  snapshotAllowlist,
  isPathAllowed,
  normalizeAllowlistPath,
} from '../pushd-allowlist.ts';

let tmpDir;
let originalEnvPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-allowlist-test-'));
  originalEnvPath = process.env.PUSHD_ALLOWLIST_PATH;
  process.env.PUSHD_ALLOWLIST_PATH = path.join(tmpDir, 'pushd.allowlist');
});

afterEach(async () => {
  if (originalEnvPath === undefined) delete process.env.PUSHD_ALLOWLIST_PATH;
  else process.env.PUSHD_ALLOWLIST_PATH = originalEnvPath;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('normalizeAllowlistPath', () => {
  it('accepts absolute paths and returns the normalized form', () => {
    assert.equal(normalizeAllowlistPath('/foo/bar'), path.resolve('/foo/bar'));
    assert.equal(normalizeAllowlistPath('/foo//bar/'), path.resolve('/foo/bar'));
  });

  it('rejects empty, non-string, and relative paths', () => {
    assert.equal(normalizeAllowlistPath(''), null);
    assert.equal(normalizeAllowlistPath(null), null);
    assert.equal(normalizeAllowlistPath(undefined), null);
    assert.equal(normalizeAllowlistPath('foo/bar'), null);
    assert.equal(normalizeAllowlistPath('./foo'), null);
  });

  it('collapses `..` segments via path.resolve (absolute input)', () => {
    // path.resolve('/foo/..') → '/'. The behaviour is documented but
    // intentional: we accept it (the literal `..` doesn't survive
    // into the stored entry). Enforcement compares against the
    // resolved form so there's no traversal-via-bypass risk.
    assert.equal(normalizeAllowlistPath('/foo/..'), '/');
  });
});

describe('addAllowedPath + listAllowedPaths', () => {
  it('round-trips a single entry', async () => {
    const added = await addAllowedPath('/home/user/proj-a');
    assert.equal(added, true);
    const records = await listAllowedPaths();
    assert.equal(records.length, 1);
    assert.equal(records[0].path, path.resolve('/home/user/proj-a'));
    assert.equal(typeof records[0].addedAt, 'number');
  });

  it('is idempotent — a duplicate add returns false', async () => {
    const first = await addAllowedPath('/home/user/proj-a');
    const second = await addAllowedPath('/home/user/proj-a');
    assert.equal(first, true);
    assert.equal(second, false);
    const records = await listAllowedPaths();
    assert.equal(records.length, 1);
  });

  it('throws on invalid path inputs', async () => {
    await assert.rejects(() => addAllowedPath(''), /Invalid allowlist path/);
    await assert.rejects(() => addAllowedPath('relative/path'), /Invalid allowlist path/);
  });

  it('persists with 0600 file permissions', async () => {
    await addAllowedPath('/home/user/proj-a');
    const stat = await fs.stat(process.env.PUSHD_ALLOWLIST_PATH);
    // POSIX mode mask — the file should be rw for owner only.
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe('removeAllowedPath', () => {
  it('removes an existing entry and returns true', async () => {
    await addAllowedPath('/home/user/proj-a');
    await addAllowedPath('/home/user/proj-b');
    const removed = await removeAllowedPath('/home/user/proj-a');
    assert.equal(removed, true);
    const remaining = await listAllowedPaths();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].path, path.resolve('/home/user/proj-b'));
  });

  it('returns false when the path is not in the allowlist', async () => {
    await addAllowedPath('/home/user/proj-a');
    const removed = await removeAllowedPath('/home/user/proj-elsewhere');
    assert.equal(removed, false);
  });

  it('deletes the file when the last entry is removed (implicit-default re-engages)', async () => {
    await addAllowedPath('/home/user/proj-a');
    await removeAllowedPath('/home/user/proj-a');
    // The file should be gone so snapshotAllowlist falls back to the
    // implicit-cwd default — otherwise removing the last entry would
    // brick the daemon (empty file = "deny everything").
    await assert.rejects(() => fs.stat(process.env.PUSHD_ALLOWLIST_PATH), /ENOENT/);
    const snapshot = await snapshotAllowlist('/some/cwd');
    assert.equal(snapshot.isImplicitDefault, true);
    assert.deepEqual(snapshot.allowed, [path.resolve('/some/cwd')]);
  });
});

describe('snapshotAllowlist', () => {
  it('reports isImplicitDefault and cwd when the file does not exist', async () => {
    const snapshot = await snapshotAllowlist('/tmp/cwd-fixture');
    assert.equal(snapshot.isImplicitDefault, true);
    assert.deepEqual(snapshot.allowed, [path.resolve('/tmp/cwd-fixture')]);
  });

  it('reports explicit entries with isImplicitDefault=false', async () => {
    await addAllowedPath('/home/user/proj-a');
    const snapshot = await snapshotAllowlist('/some/cwd');
    assert.equal(snapshot.isImplicitDefault, false);
    assert.deepEqual(snapshot.allowed, [path.resolve('/home/user/proj-a')]);
  });

  it('does NOT include cwd implicitly once a user-explicit entry exists', async () => {
    // The whole point of the explicit allowlist is that the user
    // opts out of the implicit-cwd default. If they `allow /foo` and
    // their daemon happens to be running in /bar, paths under /bar
    // are NOT auto-allowed.
    await addAllowedPath('/home/user/proj-a');
    const snapshot = await snapshotAllowlist('/different/cwd');
    assert.equal(snapshot.allowed.includes(path.resolve('/different/cwd')), false);
  });
});

describe('isPathAllowed', () => {
  it('allows a path that equals an allowed root', () => {
    const snapshot = { allowed: ['/home/user/proj-a'], isImplicitDefault: false };
    assert.equal(isPathAllowed('/home/user/proj-a', snapshot), true);
  });

  it('allows a path strictly inside an allowed root', () => {
    const snapshot = { allowed: ['/home/user/proj-a'], isImplicitDefault: false };
    assert.equal(isPathAllowed('/home/user/proj-a/src/index.ts', snapshot), true);
  });

  it('rejects a sibling of an allowed root', () => {
    const snapshot = { allowed: ['/home/user/proj-a'], isImplicitDefault: false };
    assert.equal(isPathAllowed('/home/user/proj-b', snapshot), false);
  });

  it('rejects a parent of an allowed root', () => {
    const snapshot = { allowed: ['/home/user/proj-a'], isImplicitDefault: false };
    assert.equal(isPathAllowed('/home/user', snapshot), false);
  });

  it('rejects a relative or empty path', () => {
    const snapshot = { allowed: ['/home/user/proj-a'], isImplicitDefault: false };
    assert.equal(isPathAllowed('relative', snapshot), false);
    assert.equal(isPathAllowed('', snapshot), false);
  });

  it('rejects all paths when the snapshot is empty (explicit deny-all guard)', () => {
    // This branch shouldn't fire in practice — `snapshotAllowlist`
    // collapses an empty explicit file back to implicit-cwd before
    // we get here — but it's the natural deny-by-default safeguard
    // and worth pinning.
    const snapshot = { allowed: [], isImplicitDefault: false };
    assert.equal(isPathAllowed('/home/user/proj-a', snapshot), false);
  });

  it('matches against multiple roots', () => {
    const snapshot = {
      allowed: ['/home/user/proj-a', '/home/user/proj-b'],
      isImplicitDefault: false,
    };
    assert.equal(isPathAllowed('/home/user/proj-a/src', snapshot), true);
    assert.equal(isPathAllowed('/home/user/proj-b/lib', snapshot), true);
    assert.equal(isPathAllowed('/home/user/proj-c', snapshot), false);
  });
});

describe('snapshotAllowlist resilience (Kilo PR #518)', () => {
  it('falls back to implicit-cwd default with a stderr warning when the file is unreadable', async () => {
    // Drop a deliberately-broken file at the configured path. Setting
    // mode 0o000 makes it unreadable as a non-root user, which simulates
    // the EACCES case. If the test runs as root (some CI environments)
    // this is a no-op and the test will fall through the happy path —
    // node:fs honors process credentials, so root would still read it.
    const allowlistPath = process.env.PUSHD_ALLOWLIST_PATH;
    await fs.writeFile(allowlistPath, '{"path":"/foo","addedAt":1}\n', { mode: 0o000 });
    // Capture stderr to verify the warning fires. We can't easily
    // intercept process.stderr.write without a global shim; instead,
    // assert that the snapshot fell back to implicit-default — that's
    // the user-visible side effect we care about. The warning text
    // pins to stderr but is best-effort.
    const { __test__ } = await import('../pushd-allowlist.ts');
    __test__.resetSnapshotErrorGate();
    if (process.getuid && process.getuid() === 0) {
      // Running as root — chmod 0 doesn't prevent reads. Skip the
      // assertion; the test only matters in the EACCES regime.
      return;
    }
    const snapshot = await snapshotAllowlist('/tmp/fixture-cwd');
    assert.equal(snapshot.isImplicitDefault, true);
    assert.deepEqual(snapshot.allowed, [path.resolve('/tmp/fixture-cwd')]);
  });
});

describe('serial mutations under concurrency', () => {
  it('serializes concurrent adds without losing entries', async () => {
    // Fire several adds in parallel; the in-process write queue must
    // serialize them so the resulting file has every entry.
    const paths = ['/r/a', '/r/b', '/r/c', '/r/d', '/r/e'];
    await Promise.all(paths.map((p) => addAllowedPath(p)));
    const records = await listAllowedPaths();
    assert.equal(records.length, paths.length);
    const stored = records.map((r) => r.path).sort();
    assert.deepEqual(stored, paths.map((p) => path.resolve(p)).sort());
  });
});
