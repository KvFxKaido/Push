/**
 * Tests for sandbox tool validation, detection, and execution in sandbox-tools.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks must be set up before importing the module under test ----

const {
  mockRecordWriteFileMetric,
  mockRecordReadFileMetric,
} = vi.hoisted(() => ({
  mockRecordWriteFileMetric: vi.fn(),
  mockRecordReadFileMetric: vi.fn(),
}));

// Mock sandbox-client so no real HTTP calls are made.
vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
  readFromSandbox: vi.fn(),
  writeToSandbox: vi.fn(),
  batchWriteToSandbox: vi.fn(),
  getSandboxDiff: vi.fn(),
  listDirectory: vi.fn(),
  downloadFromSandbox: vi.fn(),
}));

// Mock auditor-agent (needed by sandbox_prepare_commit).
vi.mock('./auditor-agent', () => ({
  runAuditor: vi.fn(),
}));

vi.mock('./edit-metrics', () => ({
  recordWriteFileMetric: (...args: unknown[]) => mockRecordWriteFileMetric(...args),
  recordReadFileMetric: (...args: unknown[]) => mockRecordReadFileMetric(...args),
}));

// Mock tool-dispatch for extractBareToolJsonObjects.
// We provide a real implementation since the detection tests rely on it.
vi.mock('./tool-dispatch', async () => {
  const actual = await vi.importActual<typeof import('./tool-dispatch')>('./tool-dispatch');
  return {
    extractBareToolJsonObjects: actual.extractBareToolJsonObjects,
  };
});

import {
  validateSandboxToolCall,
  executeSandboxToolCall,
} from './sandbox-tools';
import * as sandboxClient from './sandbox-client';
import { fileLedger } from './file-awareness-ledger';
import { calculateLineHash } from './hashline';

// ---------------------------------------------------------------------------
// 1. Tool validation
// ---------------------------------------------------------------------------

describe('validateSandboxToolCall -- promote_to_github', () => {
  it('accepts required repo_name and defaults optional fields', () => {
    const result = validateSandboxToolCall({
      tool: 'promote_to_github',
      args: { repo_name: 'my-new-repo' },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('promote_to_github');
    if (result?.tool === 'promote_to_github') {
      expect(result.args.repo_name).toBe('my-new-repo');
      expect(result.args.private).toBeUndefined();
    }
  });

  it('rejects empty repo_name', () => {
    const result = validateSandboxToolCall({
      tool: 'promote_to_github',
      args: { repo_name: '   ' },
    });
    expect(result).toBeNull();
  });
});

describe('validateSandboxToolCall -- sandbox_write_file', () => {
  it('accepts optional expected_version', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_write_file',
      args: {
        path: '/workspace/src/example.ts',
        content: 'export const value = 1;',
        expected_version: 'abc123',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_write_file');
    if (result?.tool === 'sandbox_write_file') {
      expect(result.args.expected_version).toBe('abc123');
    }
  });
});

describe('validateSandboxToolCall -- sandbox_edit_range', () => {
  it('accepts normalized range-edit arguments', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_edit_range',
      args: {
        path: 'src/app.ts',
        start_line: 10,
        end_line: 12,
        content: 'const x = 1;',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_edit_range');
    if (result?.tool === 'sandbox_edit_range') {
      expect(result.args.path).toBe('/workspace/src/app.ts');
      expect(result.args.start_line).toBe(10);
      expect(result.args.end_line).toBe(12);
      expect(result.args.content).toBe('const x = 1;');
    }
  });

  it('rejects invalid ranges', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_edit_range',
      args: {
        path: '/workspace/src/app.ts',
        start_line: 20,
        end_line: 10,
        content: 'const x = 1;',
      },
    });

    expect(result).toBeNull();
  });
});


describe('executeSandboxToolCall -- stale write handling', () => {
  beforeEach(() => {

    mockRecordWriteFileMetric.mockReset();
    mockRecordReadFileMetric.mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
  });

  it('reuses cached file version from read when write omits expected_version', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const x = 1;',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: false,
      code: 'STALE_FILE',
      error: 'Stale file version',
      expected_version: 'v1',
      current_version: 'v2',
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/example.ts' } },
      'sb-123',
    );

    const writeResult = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/example.ts', content: 'export const x = 2;' } },
      'sb-123',
    );

    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/example.ts',
      'export const x = 2;',
      'v1',
    );
    expect(writeResult.text).toContain('Stale write rejected');
    expect(writeResult.text).toContain('Expected version: v1');
    expect(writeResult.text).toContain('Current version: v2');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'stale',
      errorCode: 'STALE_FILE',
      durationMs: expect.any(Number),
    }));
  });
});

describe('executeSandboxToolCall -- read metrics', () => {
  beforeEach(() => {

    mockRecordReadFileMetric.mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
  });

  it('records full-read payload metrics on success', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export const x = 1;',
      truncated: false,
      version: 'v1',
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/example.ts' } },
      'sb-123',
    );

    expect(mockRecordReadFileMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success',
      isRangeRead: false,
      payloadChars: 19,
      truncated: false,
      emptyRange: false,
    }));
  });

  it('records empty range reads for out-of-bounds line windows', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      version: 'v1',
      start_line: 999,
      end_line: 1100,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/example.ts', start_line: 999, end_line: 1100 } },
      'sb-123',
    );

    expect(mockRecordReadFileMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success',
      isRangeRead: true,
      payloadChars: 0,
      truncated: false,
      emptyRange: true,
    }));
  });

  it('records read errors', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'Read failed: no such file',
    } as unknown as sandboxClient.FileReadResult);

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/missing.ts' } },
      'sb-123',
    );

    expect(mockRecordReadFileMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      isRangeRead: false,
      payloadChars: 0,
      errorCode: 'READ_ERROR',
    }));
  });
});

describe('executeSandboxToolCall -- write metrics', () => {
  beforeEach(() => {

    mockRecordWriteFileMetric.mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
  });

  it('records success metrics for sandbox_write_file', async () => {
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 10,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M src/example.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/example.ts', content: 'const x=1;' } },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/example.ts');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success',
      durationMs: expect.any(Number),
    }));
  });

  it('records non-stale error metrics for sandbox_write_file', async () => {
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: false,
      code: 'WRITE_FAILED',
      error: 'disk full',
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/example.ts', content: 'const x=1;' } },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error]');
    expect(mockRecordWriteFileMetric).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error',
      errorCode: 'WRITE_FAILED',
      durationMs: expect.any(Number),
    }));
  });
});

// ---------------------------------------------------------------------------
// 8. Edit guard behaviors
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- edit guard', () => {
  beforeEach(() => {
    mockRecordWriteFileMetric.mockReset();
    mockRecordReadFileMetric.mockReset();
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('blocks write to a file that was never read', async () => {
    // readFromSandbox is called during auto-expand — make it return an error
    // so the auto-expand also fails (not a missing-file error)
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'permission denied',
    } as unknown as sandboxClient.FileReadResult);

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/foo.ts', content: 'new content' } },
      'sb-123',
    );

    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('has not been read yet');
  });

  it('auto-expand allows write after successful auto-read', async () => {
    // File has NOT been read (no ledger entry). The auto-expand will
    // read it, record it, and then the write should succeed.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'existing content\nline 2\n',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 20,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M src/foo.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/foo.ts', content: 'updated content' } },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/foo.ts');
    expect(result.text).not.toContain('Edit guard');
  });

  it('auto-expand allows new-file creation when file does not exist', async () => {
    // Auto-expand read returns a "no such file" error → treated as new file creation
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'cat: /workspace/src/new.ts: No such file or directory',
    } as unknown as sandboxClient.FileReadResult);
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 15,
      new_version: 'v1',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '?? src/new.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/new.ts', content: 'brand new file' } },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/new.ts');
    expect(result.text).not.toContain('Edit guard');
  });

  it('appends signature hints only when read result is truncated', async () => {
    // Non-truncated read — no signature hint
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export function hello() {}\nexport class Foo {}\n',
      truncated: false,
      version: 'v1',
    });

    const fullResult = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/full.ts' } },
      'sb-123',
    );
    expect(fullResult.text).not.toContain('[Truncated content contains:');

    // Truncated read — should get signature hint
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'export function hello() {}\nexport class Foo {}\n',
      truncated: true,
      version: 'v1',
    });

    const truncResult = await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/big.ts' } },
      'sb-123',
    );
    expect(truncResult.text).toContain('[Truncated content contains:');
  });

  it('auto-expand handles empty files correctly (content is empty string)', async () => {
    // Empty file — content is '' which is falsy, but should still be treated
    // as a successful read (the file exists but is empty).
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 10,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M src/empty.ts\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/empty.ts', content: 'new content' } },
      'sb-123',
    );

    // Should succeed — the empty file was read, auto-expand should work
    expect(result.text).toContain('Wrote /workspace/src/empty.ts');
    expect(result.text).not.toContain('Edit guard');
  });

  it('keeps edit guard blocked when chunk hydration remains truncated', async () => {
    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({
        content: 'minified-start',
        truncated: true,
        version: 'v1',
      } as unknown as sandboxClient.FileReadResult)
      .mockResolvedValueOnce({
        content: 'aaaaaaaaaa',
        truncated: true,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/src/big.min.js', content: 'replacement' } },
      'sb-123',
    );

    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('too large to fully load');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('treats stale ledger entries as hard guard blocks until refreshed', async () => {
    const path = '/workspace/src/stale.ts';
    fileLedger.recordCreation(path);
    fileLedger.markStale(path);

    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'permission denied',
    } as unknown as sandboxClient.FileReadResult);

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path, content: 'updated content' } },
      'sb-123',
    );

    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('may have changed since your last read');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });
});

describe('sandbox path normalization', () => {
  it('normalizes relative read paths under /workspace', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_read_file',
      args: { path: 'app/src/lib/sandbox-tools.ts' },
    });
    expect(result).not.toBeNull();
    expect(result).toEqual({
      tool: 'sandbox_read_file',
      args: { path: '/workspace/app/src/lib/sandbox-tools.ts', start_line: undefined, end_line: undefined },
    });
  });

  it('normalizes relative paths in sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'app/worker.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'new line' }] },
          { path: 'app/src/lib/providers.ts', ops: [{ op: 'delete_line', ref: 'def5678' }] },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits[0].path).toBe('/workspace/app/worker.ts');
    expect(result.args.edits[1].path).toBe('/workspace/app/src/lib/providers.ts');
  });

  it('preserves absolute paths in sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: '/workspace/app/worker.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'new line' }] },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits[0].path).toBe('/workspace/app/worker.ts');
  });

  it('filters invalid entries from sandbox_apply_patchset edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 'app/worker.ts', ops: [{ op: 'replace_line', ref: 'abc1234', content: 'new' }] },
          { path: 123, ops: [] }, // invalid: path is not a string
          { path: 'app/lib.ts' }, // invalid: missing ops
          'not-an-object',        // invalid: not an object
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_apply_patchset');
    if (!result || result.tool !== 'sandbox_apply_patchset') {
      throw new Error('Expected sandbox_apply_patchset tool result');
    }
    expect(result.args.edits).toHaveLength(1);
    expect(result.args.edits[0].path).toBe('/workspace/app/worker.ts');
  });

  it('returns null for sandbox_apply_patchset with all invalid edits', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_apply_patchset',
      args: {
        edits: [
          { path: 123, ops: [] },
        ],
      },
    });
    expect(result).toBeNull();
  });

  it('normalizes relative path in sandbox_read_symbols', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_read_symbols',
      args: { path: 'app/src/lib/utils.ts' },
    });
    expect(result).not.toBeNull();
    expect(result?.tool).toBe('sandbox_read_symbols');
    if (!result || result.tool !== 'sandbox_read_symbols') {
      throw new Error('Expected sandbox_read_symbols tool result');
    }
    expect(result.args.path).toBe('/workspace/app/src/lib/utils.ts');
  });

  it('normalizes workspace-prefixed exec workdir', async () => {
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    await executeSandboxToolCall(
      { tool: 'sandbox_exec', args: { command: 'pwd', workdir: 'workspace/app' } },
      'sb-123',
    );

    expect(sandboxClient.execInSandbox).toHaveBeenCalledWith('sb-123', 'pwd', '/workspace/app');
  });
});

describe('sandbox_edit_file large file fallback', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('re-reads truncated files in chunks before applying hashline edits', async () => {
    vi.mocked(sandboxClient.readFromSandbox)
      // Auto-expand guard: initial read (truncated)
      .mockResolvedValueOnce({
        content: 'line 1\nline 2',
        truncated: true,
        version: 'v1',
      })
      // Auto-expand guard: readFullFileByChunks first chunk (fits in one chunk → done)
      // The cached result is reused by the edit logic — no duplicate reads
      .mockResolvedValueOnce({
        content: 'line 1\nline 2\n',
        truncated: false,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      });

    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v2', bytes_written: 20 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: 'diff', stderr: '', exitCode: 0, truncated: false });

    const ref = await calculateLineHash('line 1');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/demo.txt',
          edits: [{ op: 'replace_line', ref, content: 'line one' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/demo.txt');
    // Call 2 is the chunk hydration read with line range (cached result reused for edit logic)
    expect(sandboxClient.readFromSandbox).toHaveBeenNthCalledWith(2, 'sb-123', '/workspace/demo.txt', 1, 400);
    // Verify no duplicate reads — only 2 calls total (guard initial + chunk)
    expect(sandboxClient.readFromSandbox).toHaveBeenCalledTimes(2);
  });

  it('blocks sandbox_edit_file when chunk hydration remains truncated', async () => {
    vi.mocked(sandboxClient.readFromSandbox)
      // Auto-expand guard: initial read (truncated)
      .mockResolvedValueOnce({
        content: 'line 1\nline 2',
        truncated: true,
        version: 'v1',
      })
      // Auto-expand guard: chunk hydration (still truncated)
      .mockResolvedValueOnce({
        content: 'line 1\nline 2',
        truncated: true,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    const ref = await calculateLineHash('line 1');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/demo.txt',
          edits: [{ op: 'replace_line', ref, content: 'line one' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('Edit guard');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Version precedence tests — stale expected_version should not override fresh data
// ---------------------------------------------------------------------------

describe('sandbox_edit_file version precedence', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
  });

  it('uses fresh readResult.version instead of stale caller expected_version', async () => {
    // The fresh read returns version 'v3' (current on-disk version).
    // The caller passes expected_version 'v1' (stale from a previous read).
    // The write should use 'v3', not 'v1'.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'hello world',
      truncated: false,
      version: 'v3',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v4', bytes_written: 11 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    const ref = await calculateLineHash('hello world');

    await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/test.txt',
          edits: [{ op: 'replace_line', ref, content: 'hello universe' }],
          expected_version: 'v1',
        },
      },
      'sb-123',
    );

    // writeToSandbox should be called with 'v3' (fresh), not 'v1' (stale)
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/test.txt',
      'hello universe',
      'v3',
    );
  });

  it('falls back gracefully when readResult has no version', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'hello world',
      truncated: false,
      version: undefined as unknown as string,
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v1', bytes_written: 14 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    const ref = await calculateLineHash('hello world');

    await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/test.txt',
          edits: [{ op: 'replace_line', ref, content: 'hello universe' }],
        },
      },
      'sb-123',
    );

    // writeToSandbox should be called with undefined (no version available)
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/test.txt',
      'hello universe',
      undefined,
    );
  });
});

describe('sandbox_write_file version precedence', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    mockRecordWriteFileMetric.mockReset();
    mockRecordReadFileMetric.mockReset();
  });

  it('prefers cached version over stale caller expected_version', async () => {
    // Step 1: Read the file to populate the version cache with 'v2'
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'original content',
      truncated: false,
      version: 'v2',
    });
    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/src/app.ts' } },
      'sb-123',
    );

    // Step 2: Write with a stale expected_version 'v1'
    // The cache has 'v2' which should take precedence
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v3', bytes_written: 15 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: {
          path: '/workspace/src/app.ts',
          content: 'updated content',
          expected_version: 'v1',
        },
      },
      'sb-123',
    );

    // writeToSandbox should be called with 'v2' (cache), not 'v1' (stale caller)
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/app.ts',
      'updated content',
      'v2',
    );
  });

  it('does not report identical-content warning when version actually changes', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'original content',
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v2', bytes_written: 15 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: {
          path: '/workspace/src/app.ts',
          content: 'updated content',
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Wrote /workspace/src/app.ts');
    expect(result.text).not.toContain('Content is identical to the previous version');
  });

  it('falls back to caller expected_version when cache is empty', async () => {
    // Auto-expand read returns the file (edit guard will trigger this for unread files).
    // The auto-expand read purposely returns NO version so the cache stays empty,
    // forcing the code to fall back to the caller's expected_version.
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'existing content',
      truncated: false,
      version: undefined as unknown as string,
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v2', bytes_written: 15 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    await executeSandboxToolCall(
      {
        tool: 'sandbox_write_file',
        args: {
          path: '/workspace/src/fallback-file.ts',
          content: 'new file content',
          expected_version: 'v1',
        },
      },
      'sb-123',
    );

    // writeToSandbox should use 'v1' (caller) since cache has nothing for this path
    expect(sandboxClient.writeToSandbox).toHaveBeenCalledWith(
      'sb-123',
      '/workspace/src/fallback-file.ts',
      'new file content',
      'v1',
    );
  });
});

// ---------------------------------------------------------------------------
// Symbolic edit guard tests — sandbox_edit_file
// ---------------------------------------------------------------------------

describe('sandbox_edit_file symbolic guard', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('blocks when guard fails and auto-read also fails', async () => {
    // Auto-expand returns an error — guard should block
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      truncated: false,
      error: 'permission denied',
    } as sandboxClient.FileReadResult & { error: string });

    const ref = await calculateLineHash('export function hello() {}');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/src/app.ts',
          edits: [{ op: 'replace_line', ref, content: 'export function hello() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('Edit guard');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('auto-expand populates ledger with symbols and allows edit', async () => {
    // File has a function that the edit touches — auto-expand should discover it
    const fileContent = 'export function hello() {\n  return 0;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v2', bytes_written: 50 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    const ref = await calculateLineHash('export function hello() {');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/src/app.ts',
          edits: [{ op: 'replace_line', ref, content: 'export function hello() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    // Ledger should now have an entry for the file (from auto-expand + recordCreation)
    expect(fileLedger.hasEntry('/workspace/src/app.ts')).toBe(true);
  });

  it('allows symbolic edits after a full read even when symbol extraction found none', async () => {
    const path = '/workspace/src/plain.ts';
    const fileContent = 'const value = 1;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      // Initial explicit full read by the model
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      // Fresh read in sandbox_edit_file Step 1
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v2', bytes_written: 48 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path } },
      'sb-123',
    );

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref, content: 'export function introduced() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/plain.ts');
    expect(result.text).not.toContain('Edit guard');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalled();
  });

  it('surfaces hash mismatch after auto-expand full read when refs are invalid', async () => {
    // Auto-expand reads the file but the symbol being edited isn't found in it
    // The file contains `functionA` but the edit touches `functionB`
    const fileContent = 'export function functionA() {\n  return 0;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    // Edit references a symbol not in the file
    const ref = await calculateLineHash('dummy');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path: '/workspace/src/app.ts',
          edits: [{ op: 'replace_line', ref, content: 'export function functionB() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_file]');
    expect(result.text).toContain('error_type: EDIT_HASH_MISMATCH');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });

  it('softens unknown-symbol guard after full auto-expand and proceeds with warning', async () => {
    const path = '/workspace/src/app.ts';
    const fileContent = 'const value = 1;\n';
    fileLedger.recordRead(path, {
      startLine: 1,
      endLine: 1,
      truncated: false,
      symbols: [{ name: 'known', kind: 'function', lineRange: { start: 1, end: 1 } }],
    });
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      new_version: 'v2',
      bytes_written: 16,
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref, content: 'export function madeUp() { return 1; }' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/app.ts');
    expect(result.text).toContain('Symbol guard warning:');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalled();
  });

  it('auto-retries stale line-qualified refs against latest hashes', async () => {
    const path = '/workspace/src/retry.ts';
    const oldContent = 'const value = 1;\n';
    const latestContent = 'const value = 2;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      // Initial explicit read (to satisfy edit guard).
      .mockResolvedValueOnce({
        content: oldContent,
        truncated: false,
        version: 'v1',
      })
      // sandbox_edit_file Step 1 read.
      .mockResolvedValueOnce({
        content: latestContent,
        truncated: false,
        version: 'v2',
      })
      // Auto-retry re-read.
      .mockResolvedValueOnce({
        content: latestContent,
        truncated: false,
        version: 'v2',
      });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({ ok: true, new_version: 'v3', bytes_written: 18 });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, truncated: false });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path } },
      'sb-123',
    );

    const staleHash = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_file',
        args: {
          path,
          edits: [{ op: 'replace_line', ref: `1:${staleHash}`, content: 'const value = 3;' }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/src/retry.ts');
    expect(result.text).toContain('Auto-retry remapped 1 line-qualified ref');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'const value = 3;\n',
      'v2',
    );
    expect(vi.mocked(sandboxClient.readFromSandbox)).toHaveBeenCalledTimes(3);
  });
});

describe('sandbox_edit_range', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    fileLedger.reset();
  });

  it('compiles line ranges to hashline ops and applies via sandbox_edit_file', async () => {
    const path = '/workspace/demo.txt';
    const fileContent = 'one\ntwo\nthree\n';

    // Range wrapper pre-read + delegated sandbox_edit_file read.
    vi.mocked(sandboxClient.readFromSandbox)
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      });
    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      bytes_written: 13,
      new_version: 'v2',
    });
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      truncated: false,
    });

    // Avoid guard auto-expand to keep this focused on range compilation behavior.
    fileLedger.recordCreation(path);

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_range',
        args: {
          path,
          start_line: 2,
          end_line: 3,
          content: 'dos\ntres',
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('Edited /workspace/demo.txt');
    expect(vi.mocked(sandboxClient.writeToSandbox)).toHaveBeenCalledWith(
      'sb-123',
      path,
      'one\ndos\ntres\n',
      'v1',
    );
  });

  it('returns a tool error for out-of-range line windows', async () => {
    const path = '/workspace/demo.txt';

    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'one\ntwo\n',
      truncated: false,
      version: 'v1',
    });

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_edit_range',
        args: {
          path,
          start_line: 4,
          end_line: 5,
          content: 'x',
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_edit_range]');
    expect(result.text).toContain('Invalid range');
    expect(vi.mocked(sandboxClient.writeToSandbox)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Symbolic edit guard tests — sandbox_apply_patchset
// ---------------------------------------------------------------------------

describe('sandbox_apply_patchset symbolic guard', () => {
  beforeEach(() => {
    vi.mocked(sandboxClient.readFromSandbox).mockReset();
    vi.mocked(sandboxClient.writeToSandbox).mockReset();
    vi.mocked(sandboxClient.execInSandbox).mockReset();
    vi.mocked(sandboxClient.batchWriteToSandbox).mockReset();
    fileLedger.reset();
  });

  it('allows patchset when all files pass guard after auto-expand', async () => {
    const fileContent = 'export function greet() {\n  return "hi";\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [{ path: '/workspace/src/a.ts', ok: true, new_version: 'v2', bytes_written: 50 }],
    });

    const ref = await calculateLineHash('export function greet() {');

    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [{
            path: '/workspace/src/a.ts',
            ops: [{ op: 'replace_line', ref, content: 'export function greet() { return "hello"; }' }],
          }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('patched successfully');
  });

  it('surfaces validation mismatch after auto-expand full read when refs are invalid', async () => {
    // File contains functionA but the edit uses an invalid hash ref.
    const fileContent = 'export function functionA() {\n  return 0;\n}\n';
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });

    const ref = await calculateLineHash('dummy');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [{
            path: '/workspace/src/a.ts',
            ops: [{ op: 'replace_line', ref, content: 'export function functionB() { return 1; }' }],
          }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset]');
    expect(result.text).toContain('Validation failed');
    expect(result.text).toContain('error_type: EDIT_HASH_MISMATCH');
    expect(result.text).toContain('/workspace/src/a.ts');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).not.toHaveBeenCalled();
  });

  it('includes guard warnings when unknown-symbol blocks are softened after full auto-read', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'const value = 1;\n';
    fileLedger.recordRead(path, {
      startLine: 1,
      endLine: 1,
      truncated: false,
      symbols: [{ name: 'known', kind: 'function', lineRange: { start: 1, end: 1 } }],
    });
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: fileContent,
      truncated: false,
      version: 'v1',
    });
    vi.mocked(sandboxClient.batchWriteToSandbox).mockResolvedValue({
      ok: true,
      results: [{ path, ok: true, new_version: 'v2', bytes_written: 16 }],
    });

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [{
            path,
            ops: [{ op: 'replace_line', ref, content: 'export function madeUp() { return 1; }' }],
          }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Result — sandbox_apply_patchset]');
    expect(result.text).toContain('Guard warnings:');
    expect(result.text).toContain(path);
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).toHaveBeenCalled();
  });

  it('blocks patchset when guard auto-expand remains truncated', async () => {
    const line = 'export function greet() {';
    const content = `${line}\n`;

    vi.mocked(sandboxClient.readFromSandbox)
      // Guard auto-read
      .mockResolvedValueOnce({
        content,
        truncated: true,
        version: 'v1',
      })
      // Guard chunk hydration (still truncated)
      .mockResolvedValueOnce({
        content,
        truncated: true,
        version: 'v1',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    const ref = await calculateLineHash(line);
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [{
            path: '/workspace/src/a.ts',
            ops: [{ op: 'replace_line', ref, content: 'export function greet() { return "hello"; }' }],
          }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset]');
    expect(result.text).toContain('too large to fully load safely');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).not.toHaveBeenCalled();
  });

  it('blocks patchset when phase-1 hydration remains truncated after guard pass', async () => {
    const path = '/workspace/src/a.ts';
    const fileContent = 'const value = 1;\n';

    vi.mocked(sandboxClient.readFromSandbox)
      // Pre-read so guard passes without auto-expand
      .mockResolvedValueOnce({
        content: fileContent,
        truncated: false,
        version: 'v1',
      })
      // Phase 1 read in sandbox_apply_patchset
      .mockResolvedValueOnce({
        content: 'const value = 1;',
        truncated: true,
        version: 'v2',
      })
      // Phase 1 chunk hydration (still truncated)
      .mockResolvedValueOnce({
        content: 'const value = 1;',
        truncated: true,
        version: 'v2',
        start_line: 1,
        end_line: 400,
      } as unknown as sandboxClient.FileReadResult);

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path } },
      'sb-123',
    );

    const ref = await calculateLineHash('const value = 1;');
    const result = await executeSandboxToolCall(
      {
        tool: 'sandbox_apply_patchset',
        args: {
          edits: [{
            path,
            ops: [{ op: 'replace_line', ref, content: 'const value = 2;' }],
          }],
        },
      },
      'sb-123',
    );

    expect(result.text).toContain('[Tool Error — sandbox_apply_patchset]');
    expect(result.text).toContain('too large to fully load safely');
    expect(vi.mocked(sandboxClient.batchWriteToSandbox)).not.toHaveBeenCalled();
  });
});
