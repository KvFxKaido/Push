import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateLineHash, type HashlineOp } from './hashline';

// ---------------------------------------------------------------------------
// Module mocks — keep the sandbox-client and ledger/cache modules deterministic
// so the tests observe only the logic inside sandbox-edit-ops.
// ---------------------------------------------------------------------------

const execInSandboxMock = vi.fn();
const readFromSandboxMock = vi.fn();

vi.mock('./sandbox-client', () => ({
  execInSandbox: (...args: unknown[]) => execInSandboxMock(...args),
  readFromSandbox: (...args: unknown[]) => readFromSandboxMock(...args),
}));

vi.mock('./file-awareness-ledger', () => ({
  fileLedger: {
    markStale: vi.fn(),
    markAllStale: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('./symbol-persistence-ledger', () => ({
  symbolLedger: {
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
  },
}));

// Real sandbox-file-version-cache is fine — it's a module-level Map with its
// own clear helpers that we can call between tests.
import * as versionCache from './sandbox-file-version-cache';
import {
  buildHashlineRetryHints,
  buildPatchsetFailureDetail,
  buildRangeReplaceHashlineOps,
  clearPrefetchedEditFileCache,
  invalidateWorkspaceSnapshots,
  isUnknownSymbolGuardReason,
  parseLineQualifiedRef,
  prefetchedEditFileKey,
  PATCHSET_DETAIL_MAX_CHARS,
  PATCHSET_DETAIL_MAX_FAILURES,
  recordPatchsetStaleConflict,
  refreshSameLineQualifiedRefs,
  runPatchsetDiagnostics,
  runPerEditDiagnostics,
  setPrefetchedEditFile,
  syncReadSnapshot,
  takePrefetchedEditFile,
} from './sandbox-edit-ops';

beforeEach(() => {
  execInSandboxMock.mockReset();
  readFromSandboxMock.mockReset();
  clearPrefetchedEditFileCache();
  versionCache.clearFileVersionCache();
  versionCache.clearSandboxWorkspaceRevision();
});

// ---------------------------------------------------------------------------
// Prefetch cache
// ---------------------------------------------------------------------------

describe('prefetch cache', () => {
  it('namespaces keys by sandboxId + normalized path', () => {
    expect(prefetchedEditFileKey('sb-1', 'a.ts')).toBe('sb-1:/workspace/a.ts');
    expect(prefetchedEditFileKey('sb-1', '/workspace/a.ts')).toBe('sb-1:/workspace/a.ts');
  });

  it('round-trips content and consumes on take (single-shot cache)', () => {
    setPrefetchedEditFile('sb-1', 'a.ts', 'hello', 'v1', 5, false);
    const first = takePrefetchedEditFile('sb-1', 'a.ts');
    expect(first).toMatchObject({ content: 'hello', version: 'v1', workspaceRevision: 5 });
    expect(takePrefetchedEditFile('sb-1', 'a.ts')).toBeNull();
  });

  it('rejects entries past their TTL', () => {
    setPrefetchedEditFile('sb-1', 'a.ts', 'hello');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000);
      expect(takePrefetchedEditFile('sb-1', 'a.ts')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects entries whose workspaceRevision no longer matches the sandbox', () => {
    setPrefetchedEditFile('sb-1', 'a.ts', 'hello', 'v1', 5);
    versionCache.setSandboxWorkspaceRevision('sb-1', 6);
    expect(takePrefetchedEditFile('sb-1', 'a.ts')).toBeNull();
  });

  it('returns the entry when the sandbox revision matches', () => {
    setPrefetchedEditFile('sb-1', 'a.ts', 'hello', 'v1', 5);
    versionCache.setSandboxWorkspaceRevision('sb-1', 5);
    expect(takePrefetchedEditFile('sb-1', 'a.ts')?.content).toBe('hello');
  });

  it('clears only the entries for a given sandboxId', () => {
    setPrefetchedEditFile('sb-1', 'a.ts', 'A');
    setPrefetchedEditFile('sb-2', 'a.ts', 'B');
    clearPrefetchedEditFileCache('sb-1');
    expect(takePrefetchedEditFile('sb-1', 'a.ts')).toBeNull();
    expect(takePrefetchedEditFile('sb-2', 'a.ts')?.content).toBe('B');
  });

  it('clears all entries when called without a sandboxId', () => {
    setPrefetchedEditFile('sb-1', 'a.ts', 'A');
    setPrefetchedEditFile('sb-2', 'a.ts', 'B');
    clearPrefetchedEditFileCache();
    expect(takePrefetchedEditFile('sb-1', 'a.ts')).toBeNull();
    expect(takePrefetchedEditFile('sb-2', 'a.ts')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

describe('isUnknownSymbolGuardReason', () => {
  it('matches the canonical "Read symbol ... before editing." message', () => {
    expect(isUnknownSymbolGuardReason("Read symbol 'foo' before editing.")).toBe(true);
    expect(isUnknownSymbolGuardReason("  Read symbol 'Foo.bar' before editing.  ")).toBe(true);
  });

  it('does not match unrelated guard messages', () => {
    expect(isUnknownSymbolGuardReason('stale snapshot rejected')).toBe(false);
    expect(isUnknownSymbolGuardReason("Read symbol '' before editing")).toBe(false);
  });
});

describe('parseLineQualifiedRef', () => {
  it('parses a valid line-qualified ref and lowercases the hash', () => {
    expect(parseLineQualifiedRef('42:ABC1234')).toEqual({
      lineNo: 42,
      hash: 'abc1234',
      hashLength: 7,
    });
  });

  it('accepts 12-char hashes', () => {
    const parsed = parseLineQualifiedRef('1:abcdef012345');
    expect(parsed?.hashLength).toBe(12);
  });

  it('returns null for bare hashes or malformed refs', () => {
    expect(parseLineQualifiedRef('abc1234')).toBeNull();
    expect(parseLineQualifiedRef('42:')).toBeNull();
    expect(parseLineQualifiedRef('42:zzzz123')).toBeNull();
    expect(parseLineQualifiedRef('0:abc1234')).not.toBeNull(); // line 0 is parseable; caller gates index
  });
});

describe('buildPatchsetFailureDetail', () => {
  it('joins failures with "; "', () => {
    expect(buildPatchsetFailureDetail(['a', 'b', 'c'])).toBe('a; b; c');
  });

  it(`caps at PATCHSET_DETAIL_MAX_FAILURES=${PATCHSET_DETAIL_MAX_FAILURES} and reports overflow`, () => {
    const failures = Array.from({ length: PATCHSET_DETAIL_MAX_FAILURES + 3 }, (_, i) => `f${i}`);
    const detail = buildPatchsetFailureDetail(failures);
    expect(detail.endsWith('(+3 more)')).toBe(true);
  });

  it(`truncates to PATCHSET_DETAIL_MAX_CHARS=${PATCHSET_DETAIL_MAX_CHARS}`, () => {
    const long = Array.from({ length: 12 }, () => 'x'.repeat(200));
    const detail = buildPatchsetFailureDetail(long);
    expect(detail.length).toBeLessThanOrEqual(PATCHSET_DETAIL_MAX_CHARS + 3); // '…' tail
    expect(detail.endsWith('...')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hashline ops
// ---------------------------------------------------------------------------

describe('buildHashlineRetryHints', () => {
  it('suggests a refreshed same-line ref when only the hash drifted', async () => {
    const content = 'alpha\nbeta\ngamma\n';
    const wrongRef = '2:000000a'; // same line, hash drifted
    const hints = await buildHashlineRetryHints(
      content,
      [{ op: 'replace_line', ref: wrongRef, content: 'x' }],
      '/workspace/f.ts',
    );
    expect(hints.some((h) => h.startsWith('Same-line retry for "2:000000a"'))).toBe(true);
    expect(hints.some((h) => h.includes('prefer sandbox_edit_range'))).toBe(true);
  });

  it('disambiguates a bare hash that appears on multiple lines', async () => {
    const dup = 'dupe\ndupe\nother\n';
    const hash = (await calculateLineHash('dupe', 7)).slice(0, 7);
    const hints = await buildHashlineRetryHints(
      dup,
      [{ op: 'replace_line', ref: hash, content: 'x' }],
      '/workspace/f.ts',
    );
    expect(hints[0]).toMatch(/Disambiguate ".+" with a line-qualified ref/);
  });

  it('returns no hints when edits are unambiguous', async () => {
    const content = 'alpha\nbeta\n';
    const aHash = (await calculateLineHash('alpha', 7)).slice(0, 7);
    const hints = await buildHashlineRetryHints(
      content,
      [{ op: 'replace_line', ref: `1:${aHash}`, content: 'x' }],
      '/workspace/f.ts',
    );
    expect(hints).toEqual([]);
  });
});

describe('refreshSameLineQualifiedRefs', () => {
  it('refreshes the hash portion when content is the same but the hash drifted', async () => {
    const content = 'alpha\nbeta\ngamma\n';
    const betaHash = (await calculateLineHash('beta', 7)).slice(0, 7);
    const stale: HashlineOp = { op: 'replace_line', ref: '2:deadbee', content: 'replaced' };
    const result = await refreshSameLineQualifiedRefs(content, [stale]);
    expect(result.refreshedCount).toBe(1);
    expect(result.relocatedCount).toBe(0);
    expect(result.edits[0].ref).toBe(`2:${betaHash}`);
  });

  it('leaves the ref alone when the original content moved to another line (relocated)', async () => {
    const betaHash = (await calculateLineHash('beta', 7)).slice(0, 7);
    const stale: HashlineOp = { op: 'replace_line', ref: `2:${betaHash}`, content: 'x' };
    // File where line 2 now differs but the target hash lives on another line.
    const moved = 'alpha\nalpha\ngamma\nbeta\n';
    const result = await refreshSameLineQualifiedRefs(moved, [stale]);
    expect(result.refreshedCount).toBe(0);
    expect(result.relocatedCount).toBe(1);
    expect(result.edits[0].ref).toBe(`2:${betaHash}`);
  });

  it('passes non-line-qualified refs through untouched', async () => {
    const content = 'alpha\n';
    const stale: HashlineOp = { op: 'replace_line', ref: 'deadbee', content: 'x' };
    const result = await refreshSameLineQualifiedRefs(content, [stale]);
    expect(result.refreshedCount).toBe(0);
    expect(result.edits[0]).toBe(stale);
  });
});

describe('buildRangeReplaceHashlineOps', () => {
  it('emits delete_line ops in descending order for a pure-deletion replacement', async () => {
    const content = 'A\nB\nC\nD\n';
    const { ops } = await buildRangeReplaceHashlineOps(content, 2, 3, '');
    expect(ops).toHaveLength(2);
    expect(ops[0].op).toBe('delete_line');
    expect(ops[1].op).toBe('delete_line');
    expect(ops[0].ref.startsWith('3:')).toBe(true);
    expect(ops[1].ref.startsWith('2:')).toBe(true);
  });

  it('emits a single replace_line for a 1-line replacement', async () => {
    const content = 'A\nB\nC\n';
    const { ops } = await buildRangeReplaceHashlineOps(content, 2, 2, 'NEW');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'replace_line', content: 'NEW' });
    expect(ops[0].ref.startsWith('2:')).toBe(true);
  });

  it('emits delete + replace + insert_after for a multi-line replacement', async () => {
    const content = 'A\nB\nC\nD\n';
    const { ops } = await buildRangeReplaceHashlineOps(content, 2, 3, 'X\nY\nZ');
    // range covers 2..3 (2 old lines) replaced by 3 new lines (X, Y, Z).
    // Expect: delete line 3, replace line 2 with X, insert_after line 2: Y, Z
    expect(ops[0].op).toBe('delete_line');
    expect(ops[0].ref.startsWith('3:')).toBe(true);
    expect(ops[1]).toMatchObject({ op: 'replace_line', content: 'X' });
    expect(ops[2]).toMatchObject({ op: 'insert_after', content: 'Y' });
    expect(ops[3]).toMatchObject({ op: 'insert_after', content: 'Z' });
    // Anchor ref for insert_after matches the original line-2 ref.
    expect(ops[2].ref).toBe(ops[1].ref);
    expect(ops[3].ref).toBe(ops[1].ref);
  });

  it('rejects out-of-range edits', async () => {
    await expect(buildRangeReplaceHashlineOps('A\nB\n', 0, 1, 'x')).rejects.toThrow(
      /Invalid range/,
    );
    await expect(buildRangeReplaceHashlineOps('A\nB\n', 1, 5, 'x')).rejects.toThrow(
      /Invalid range/,
    );
    await expect(buildRangeReplaceHashlineOps('A\nB\n', 2, 1, 'x')).rejects.toThrow(
      /Invalid range/,
    );
  });
});

// ---------------------------------------------------------------------------
// Version sync
// ---------------------------------------------------------------------------

describe('syncReadSnapshot', () => {
  it('records both the sandbox and per-key revision when present', () => {
    syncReadSnapshot('sb-1', 'a.ts', {
      content: '...',
      truncated: false,
      version: 'abc',
      workspace_revision: 7,
    });
    const key = versionCache.fileVersionKey('sb-1', 'a.ts');
    expect(versionCache.getByKey(key)).toBe('abc');
    expect(versionCache.getWorkspaceRevisionByKey(key)).toBe(7);
    expect(versionCache.getSandboxWorkspaceRevision('sb-1')).toBe(7);
  });

  it('deletes the cached version when the result has no version and no error', () => {
    const key = versionCache.fileVersionKey('sb-1', 'a.ts');
    versionCache.setByKey(key, 'old');
    syncReadSnapshot('sb-1', 'a.ts', { content: '', truncated: false });
    expect(versionCache.getByKey(key)).toBeUndefined();
  });

  it('preserves the cached version when the read result carried an error', () => {
    const key = versionCache.fileVersionKey('sb-1', 'a.ts');
    versionCache.setByKey(key, 'old');
    // The presence of an `error` key should suppress the delete.
    syncReadSnapshot('sb-1', 'a.ts', { content: '', truncated: false, error: 'boom' });
    expect(versionCache.getByKey(key)).toBe('old');
  });
});

describe('invalidateWorkspaceSnapshots', () => {
  it('advances the sandbox revision when a number is supplied', () => {
    invalidateWorkspaceSnapshots('sb-1', 9);
    expect(versionCache.getSandboxWorkspaceRevision('sb-1')).toBe(9);
  });

  it('leaves the revision unchanged when called with null', () => {
    versionCache.setSandboxWorkspaceRevision('sb-1', 3);
    invalidateWorkspaceSnapshots('sb-1', null);
    expect(versionCache.getSandboxWorkspaceRevision('sb-1')).toBe(3);
  });
});

describe('recordPatchsetStaleConflict', () => {
  it('caches the current version when one is provided', () => {
    recordPatchsetStaleConflict('sb-1', '/workspace/a.ts', 'vold', 'vnew');
    const key = versionCache.fileVersionKey('sb-1', '/workspace/a.ts');
    expect(versionCache.getByKey(key)).toBe('vnew');
  });

  it('deletes the cached version when no current version is provided', () => {
    const key = versionCache.fileVersionKey('sb-1', '/workspace/a.ts');
    versionCache.setByKey(key, 'stale');
    recordPatchsetStaleConflict('sb-1', '/workspace/a.ts', 'vold', null);
    expect(versionCache.getByKey(key)).toBeUndefined();
  });

  it('returns a deterministic stale-write summary string', () => {
    const msg = recordPatchsetStaleConflict('sb-1', 'a.ts', 'v1', 'v2');
    expect(msg).toBe('a.ts: stale write rejected (expected=v1 current=v2)');
  });

  it('falls back to sentinel values when either version is missing', () => {
    const msg = recordPatchsetStaleConflict('sb-1', 'a.ts');
    expect(msg).toBe('a.ts: stale write rejected (expected=unknown current=missing)');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('runPerEditDiagnostics', () => {
  it('returns null for file types without a supported diagnostic', async () => {
    expect(await runPerEditDiagnostics('sb-1', 'README.md')).toBeNull();
    expect(execInSandboxMock).not.toHaveBeenCalled();
  });

  it('returns null on a clean result (exit 0)', async () => {
    execInSandboxMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false });
    expect(await runPerEditDiagnostics('sb-1', 'a.ts')).toBeNull();
  });

  it('returns null when the command times out (exit 124)', async () => {
    execInSandboxMock.mockResolvedValue({
      exitCode: 124,
      stdout: '',
      stderr: '',
      truncated: false,
    });
    expect(await runPerEditDiagnostics('sb-1', 'a.ts')).toBeNull();
  });

  it('filters MODULE_NOT_FOUND / Cannot find module noise', async () => {
    execInSandboxMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: "Error: Cannot find module 'typescript'",
      truncated: false,
    });
    expect(await runPerEditDiagnostics('sb-1', 'a.ts')).toBeNull();
  });

  it('returns the (truncated) output on a real diagnostic', async () => {
    execInSandboxMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'a.ts:4 - error: Unexpected token',
      truncated: false,
    });
    expect(await runPerEditDiagnostics('sb-1', 'a.ts')).toContain('Unexpected token');
  });

  it('swallows exec errors and returns null', async () => {
    execInSandboxMock.mockRejectedValue(new Error('network dead'));
    expect(await runPerEditDiagnostics('sb-1', 'a.ts')).toBeNull();
  });

  it('uses py_compile for .py files', async () => {
    execInSandboxMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false });
    await runPerEditDiagnostics('sb-1', 'a.py');
    const [, cmd] = execInSandboxMock.mock.calls[0];
    expect(cmd).toContain('python3 -m py_compile');
  });
});

describe('runPatchsetDiagnostics', () => {
  it('returns null when no changed files are supplied', async () => {
    expect(await runPatchsetDiagnostics('sb-1', [])).toBeNull();
    expect(execInSandboxMock).not.toHaveBeenCalled();
  });

  it('returns null when no TypeScript file is touched', async () => {
    expect(await runPatchsetDiagnostics('sb-1', ['a.py', 'b.md'])).toBeNull();
    expect(execInSandboxMock).not.toHaveBeenCalled();
  });

  it('returns null on a clean typecheck', async () => {
    execInSandboxMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', truncated: false });
    expect(await runPatchsetDiagnostics('sb-1', ['a.ts'])).toBeNull();
  });

  it('returns null on a timeout (exit 124)', async () => {
    execInSandboxMock.mockResolvedValue({
      exitCode: 124,
      stdout: '',
      stderr: '',
      truncated: false,
    });
    expect(await runPatchsetDiagnostics('sb-1', ['a.ts'])).toBeNull();
  });

  it('filters diagnostics to lines referencing changed files only', async () => {
    const stdout = [
      'src/a.ts(3,4): error TS2322: nope',
      'src/unrelated.ts(3,4): error TS2322: off-target',
    ].join('\n');
    execInSandboxMock.mockResolvedValue({ exitCode: 2, stdout, stderr: '', truncated: false });
    const result = await runPatchsetDiagnostics('sb-1', ['/workspace/src/a.ts']);
    expect(result).toContain('src/a.ts(3,4)');
    expect(result).not.toContain('unrelated');
  });

  it('returns null when the output references no changed files', async () => {
    execInSandboxMock.mockResolvedValue({
      exitCode: 2,
      stdout: 'node_modules/x/d.ts(1,1): error TS1: noise',
      stderr: '',
      truncated: false,
    });
    expect(await runPatchsetDiagnostics('sb-1', ['a.ts'])).toBeNull();
  });
});
