import { describe, expect, it, vi, beforeEach } from 'vitest';

// Control the native FS seam directly: resolveNativeFs returns our fake backend
// (or null) so the dispatcher's `if (nativeFs)` forks are exercised without a
// real device/plugin. Everything else in sandbox-tools loads for real.
const fakeBackend = vi.hoisted(() => ({
  dir: '/data/clone',
  readFile: vi.fn(async () => ({ content: 'file body', truncated: false, totalLines: 1 })),
  writeFile: vi.fn(async () => ({ ok: true, bytesWritten: 9 })),
  listDir: vi.fn(async () => ({
    entries: [{ name: 'a.ts', type: 'file' as const, size: 3 }],
    truncated: false,
  })),
  search: vi.fn(async () => ({
    lines: ['/workspace/a.ts:1:file body'],
    truncated: false,
  })),
  diff: vi.fn(async () => ({
    diff: 'diff --git a/a.ts b/a.ts\n+file body\n',
    truncated: false,
    git_status: ' M a.ts',
  })),
}));
const fakeNativeGit = vi.hoisted(() => ({
  currentBranch: vi.fn(),
  upstreamRef: vi.fn(),
  remoteUrl: vi.fn(),
  headSha: vi.fn(),
  status: vi.fn(),
  revParse: vi.fn(),
  mergeBase: vi.fn(),
  logPatch: vi.fn(),
  createBranch: vi.fn(),
  switchBranch: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  fetch: vi.fn(),
}));
const nativeFs = vi.hoisted(() => ({
  resolveNativeFs: vi.fn((): typeof fakeBackend | null => fakeBackend),
}));

vi.mock('./native-fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./native-fs')>()),
  resolveNativeFs: nativeFs.resolveNativeFs,
}));

vi.mock('./native-git/plugin', () => ({
  NativeGit: fakeNativeGit,
}));

import { executeSandboxToolCall } from './sandbox-tools';

const scope = { repoFullName: 'owner/repo', branch: 'main' };

async function lineHash(line: string): Promise<string> {
  const bytes = new TextEncoder().encode(line.trim());
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 7);
}

beforeEach(() => {
  fakeBackend.readFile.mockClear();
  fakeBackend.writeFile.mockClear();
  fakeBackend.listDir.mockClear();
  fakeBackend.search.mockClear();
  fakeBackend.diff.mockClear();
  nativeFs.resolveNativeFs.mockReturnValue(fakeBackend);

  fakeNativeGit.currentBranch.mockReset().mockResolvedValue({ branch: 'feature/native' });
  fakeNativeGit.upstreamRef.mockReset().mockResolvedValue({ ref: 'origin/feature/native' });
  fakeNativeGit.remoteUrl
    .mockReset()
    .mockResolvedValue({ url: 'https://github.com/owner/repo.git' });
  fakeNativeGit.headSha.mockReset().mockResolvedValue({ sha: 'abc123' });
  fakeNativeGit.status.mockReset().mockResolvedValue({ porcelain: '## feature/native\n' });
  fakeNativeGit.revParse.mockReset().mockImplementation(async ({ ref }: { ref: string }) => ({
    sha:
      ref === 'origin/feature/native'
        ? 'base123'
        : ref === 'origin/HEAD'
          ? 'originhead123'
          : ref === 'feature/native' || ref === 'HEAD'
            ? 'abc123'
            : null,
  }));
  fakeNativeGit.mergeBase.mockReset().mockResolvedValue({ sha: 'mergebase123' });
  fakeNativeGit.logPatch
    .mockReset()
    .mockResolvedValue({ patch: 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+safe\n' });
  fakeNativeGit.createBranch.mockReset().mockResolvedValue({ ok: true });
  fakeNativeGit.switchBranch.mockReset().mockResolvedValue({ ok: true });
  fakeNativeGit.commit.mockReset().mockResolvedValue({ ok: true });
  fakeNativeGit.push.mockReset().mockResolvedValue({ ok: true });
  fakeNativeGit.fetch.mockReset().mockResolvedValue({ ok: true });
});

describe('sandbox-tools native FS routing', () => {
  it('routes sandbox_read_file to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/a.ts' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).toHaveBeenCalledWith('/workspace/a.ts', {
      startLine: undefined,
      endLine: undefined,
    });
    expect(result.text).toContain('[Tool Result — sandbox_read_file]');
    expect(result.text).toContain('file body');
  });

  it('routes sandbox_write_file to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/a.ts', content: 'x' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.writeFile).toHaveBeenCalledWith('/workspace/a.ts', 'x');
    expect(result.text).toContain('[Tool Result — sandbox_write_file]');
    expect(result.text).toContain('9 bytes');
  });

  it('routes sandbox_list_dir to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_list_dir', args: { path: '/workspace' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.listDir).toHaveBeenCalledWith('/workspace');
    expect(result.text).toContain('[Tool Result — sandbox_list_dir]');
    expect(result.text).toContain('a.ts');
  });

  it('routes sandbox_search to the on-device clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_search', args: { query: 'file', path: '/workspace' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.search).toHaveBeenCalledWith('file', '/workspace');
    expect(result.text).toContain('[Tool Result — sandbox_search]');
    expect(result.text).toContain('/workspace/a.ts:1:file body');
  });

  it('routes sandbox_edit_file reads and writes to the on-device clone', async () => {
    fakeBackend.readFile.mockResolvedValueOnce({
      content: 'old line',
      truncated: false,
      totalLines: 1,
    });
    const hash = await lineHash('old line');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/a.ts',
          edits: [{ op: 'replace_line', ref: hash, content: 'new line' }],
        },
      },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile.mock.calls[0]).toEqual([
      '/workspace/a.ts',
      { startLine: undefined, endLine: undefined },
    ]);
    expect(fakeBackend.writeFile).toHaveBeenCalledWith('/workspace/a.ts', 'new line');
    expect(result.text).toContain('[Tool Result — sandbox_edit_file]');
  });

  it('routes sandbox_diff to the on-device clone', async () => {
    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, '', {
      nativeFsScope: scope,
    });
    expect(fakeBackend.diff).toHaveBeenCalled();
    expect(result.text).toContain('[Tool Result — sandbox_diff]');
    expect(result.text).toContain('diff --git');
  });

  it('routes sandbox_create_branch to the on-device git clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_create_branch', args: { name: 'feature/native-2' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeNativeGit.createBranch).toHaveBeenCalledWith({
      dir: '/data/clone',
      name: 'feature/native-2',
      from: undefined,
    });
    expect(result.branchSwitch?.name).toBe('feature/native-2');
  });

  it('routes sandbox_commit to native PushGit without requiring a shell hook', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_commit', args: { message: 'Native commit' } },
      '',
      { nativeFsScope: scope, currentBranch: 'feature/native', defaultBranch: 'main' },
    );
    expect(fakeNativeGit.commit).toHaveBeenCalledWith({
      dir: '/data/clone',
      message: 'Native commit',
      addAll: true,
    });
    expect(result.text).toContain('[Tool Result — sandbox_commit]');
    expect(result.text).toContain('Committed: "Native commit"');
  });

  it('blocks native sandbox_push on secrets found in the pushed patch series', async () => {
    fakeNativeGit.logPatch.mockResolvedValueOnce({
      patch:
        'commit abc123\n' +
        'diff --git a/keys.txt b/keys.txt\n' +
        '+++ b/keys.txt\n' +
        '@@ -0,0 +1 @@\n' +
        '+OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890\n',
    });
    const result = await executeSandboxToolCall({ tool: 'sandbox_push', args: {} }, '', {
      nativeFsScope: scope,
      defaultBranch: 'main',
      currentBranch: 'feature/native',
    });
    expect(result.structuredError?.type).toBe('GIT_GUARD_BLOCKED');
    expect(fakeNativeGit.logPatch).toHaveBeenCalledWith({
      dir: '/data/clone',
      range: 'origin/feature/native..HEAD',
    });
    expect(fakeNativeGit.push).not.toHaveBeenCalled();
    expect(fakeBackend.diff).not.toHaveBeenCalled();
  });

  it('routes sandbox_read_symbols through native file reads', async () => {
    fakeBackend.readFile.mockResolvedValueOnce({
      content: 'export function hello() {}',
      truncated: false,
      totalLines: 1,
    });
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_symbols', args: { path: '/workspace/a.ts' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).toHaveBeenCalledWith('/workspace/a.ts');
    expect(result.text).toContain('[Tool Result — sandbox_read_symbols]');
    expect(result.text).toContain('hello');
  });

  it('refuses sandbox_exec on-device with a typed, non-retryable error', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'echo hi' } },
      '',
      { nativeFsScope: scope },
    );
    expect(result.structuredError?.type).toBe('NATIVE_TOOL_UNSUPPORTED');
    expect(result.structuredError?.retryable).toBe(false);
    expect(fakeBackend.readFile).not.toHaveBeenCalled();
  });

  it('refuses a sensitive path before touching the clone', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/.env' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).not.toHaveBeenCalled();
    expect(result.text.toLowerCase()).toContain('.env');
  });

  it('shows the on-device diff hunks in the edit result instead of the exec fallback', async () => {
    fakeBackend.readFile.mockResolvedValueOnce({
      content: 'old line',
      truncated: false,
      totalLines: 1,
    });
    const hash = await lineHash('old line');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/a.ts',
          edits: [{ op: 'replace_line', ref: hash, content: 'new line' }],
        },
      },
      '',
      { nativeFsScope: scope },
    );
    // The per-file diff comes from the plugin's working-copy diff, not from
    // `git diff` via the (unavailable) shell — so the misleading "No diff
    // hunks" fallback must not fire for a real content change.
    expect(fakeBackend.diff).toHaveBeenCalled();
    expect(result.text).toContain('Diff:');
    expect(result.text).toContain('diff --git a/a.ts b/a.ts');
    expect(result.text).not.toContain('No diff hunks');
  });

  it('skips patchset checks on-device instead of failing them and rolling back', async () => {
    fakeBackend.readFile.mockResolvedValue({
      content: 'old line',
      truncated: false,
      totalLines: 1,
    });
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [{ path: '/workspace/a.ts', start_line: 1, end_line: 1, content: 'new line' }],
          checks: [{ command: 'tsc --noEmit' }],
          rollbackOnFailure: true,
        },
      },
      '',
      { nativeFsScope: scope },
    );
    // The write landed once and was NOT restored: no shell means checks are
    // skipped (with a note), never run through the exit-127 exec stub where
    // they'd read as failed and destroy valid edits.
    const writes = fakeBackend.writeFile.mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(['/workspace/a.ts', 'new line']);
    expect(result.text).toContain('patched successfully');
    expect(result.text).toContain('check(s) skipped');
    expect(result.text).not.toContain('rolled back');
  });

  it('hides sensitive-path blocks from the on-device diff', async () => {
    fakeBackend.diff.mockResolvedValueOnce({
      diff:
        'diff --git a/a.ts b/a.ts\n+file body\n' +
        'diff --git a/.env b/.env\nnew file mode 100644\n+API_KEY=super-secret-value\n',
      truncated: false,
      git_status: ' M a.ts\n?? .env',
    });
    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, '', {
      nativeFsScope: scope,
    });
    expect(result.text).toContain('diff --git a/a.ts b/a.ts');
    expect(result.text).not.toContain('super-secret-value');
    expect(result.text).toContain('1 sensitive file diff hidden');
  });

  it('refuses sandbox_find_references on-device with a typed error', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_find_references', args: { symbol: 'hello' } },
      '',
      { nativeFsScope: scope },
    );
    expect(result.structuredError?.type).toBe('NATIVE_TOOL_UNSUPPORTED');
    expect(result.structuredError?.retryable).toBe(false);
    expect(result.text).toContain('sandbox_search');
  });

  it('maps a capped native read onto cloud-parity truncation metadata', async () => {
    fakeBackend.readFile.mockResolvedValueOnce({
      content: 'one\ntwo',
      truncated: true,
      totalLines: 50,
    });
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/big.ts' } },
      '',
      { nativeFsScope: scope },
    );
    // 2 lines served → truncation begins at line 3; downstream pagination
    // ("use as the next start_line") depends on this field.
    expect(result.text).toContain('truncated_at_line: 3');
  });

  it('reports a truncated native directory listing instead of presenting it as complete', async () => {
    fakeBackend.listDir.mockResolvedValueOnce({
      entries: [{ name: 'a.ts', type: 'file' as const, size: 3 }],
      truncated: true,
    });
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_list_dir', args: { path: '/workspace' } },
      '',
      { nativeFsScope: scope },
    );
    expect(result.text).toContain('[truncated]');
  });

  it('filters sensitive paths out of git_status on the empty-diff branch', async () => {
    fakeBackend.diff.mockResolvedValueOnce({
      diff: '',
      truncated: false,
      git_status: '## main\n M a.ts\n?? .env',
    });
    const result = await executeSandboxToolCall({ tool: 'sandbox_diff', args: {} }, '', {
      nativeFsScope: scope,
    });
    expect(result.text).toContain('M a.ts');
    expect(result.text).not.toContain('.env');
  });

  it('refuses verification tools on-device with a typed error instead of a phantom sandbox call', async () => {
    for (const tool of [
      'sandbox_run_tests',
      'sandbox_check_types',
      'sandbox_verify_workspace',
      'sandbox_show_commit',
      'sandbox_download',
    ] as const) {
      const result = await executeSandboxToolCall(
        { tool, args: {} } as Parameters<typeof executeSandboxToolCall>[0],
        '',
        { nativeFsScope: scope },
      );
      expect(result.structuredError?.type, tool).toBe('NATIVE_TOOL_UNSUPPORTED');
      expect(result.structuredError?.retryable, tool).toBe(false);
    }
  });

  it('refuses sensitive-path writes on the cloud path too (guard lives in the handler)', async () => {
    nativeFs.resolveNativeFs.mockReturnValue(null);
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/.env', content: 'X=1' } },
      'sbx-123',
      {},
    );
    expect(fakeBackend.writeFile).not.toHaveBeenCalled();
    expect(result.text.toLowerCase()).toContain('.env');
    expect(result.text).not.toContain('[Tool Result — sandbox_write_file]');
  });

  it('falls through to the cloud path when no native clone resolves', async () => {
    nativeFs.resolveNativeFs.mockReturnValue(null);
    // sandboxId '' + no binding + no native → the no-sandbox guard fires,
    // proving the dispatcher did NOT take the native fork.
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/a.ts' } },
      '',
      { nativeFsScope: scope },
    );
    expect(fakeBackend.readFile).not.toHaveBeenCalled();
    expect(result.text).toContain('No active sandbox');
  });
});
