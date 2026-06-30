/**
 * Tests for sandbox client functions and result types.
 *
 * Covers:
 * - BatchWriteResult shape validation
 * - batchWriteToSandbox sends correct request
 * - writeToSandbox sends correct request
 *
 * All fetch calls are mocked — no real HTTP requests are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  BatchWriteResult,
  BatchWriteResultEntry,
  FileReadResult,
  WriteResult,
} from './sandbox-client';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// We need to set the owner token before each test since the client
// checks for it on every request.
import {
  batchWriteToSandbox,
  clearSandboxEnvironment,
  createSandbox,
  deleteFromSandbox,
  execInSandbox,
  execLongRunningInSandbox,
  getSandboxLifecycleEvents,
  hasInFlightSandboxCalls,
  mapSandboxErrorCode,
  msSinceLastSandboxCall,
  parseEnvironmentProbe,
  pingSandbox,
  SANDBOX_TS_ARROW_FUNCTION_REGEX,
  setSandboxOwnerToken,
  suppressIdleTouch,
  writeToSandbox,
} from './sandbox-client';
import { SANDBOX_USER_TOKEN_ACK_KEY, USER_TOKEN_GATE_MESSAGE } from './sandbox-auth-gate';
import { onWorkspaceMutation } from './sandbox-mutation-signal';

function createStorageMock() {
  const data = new Map<string, string>();

  return {
    data,
    getItem: vi.fn((key: string) => (data.has(key) ? data.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  setSandboxOwnerToken('test-owner-token');
  vi.stubGlobal('window', {
    localStorage: createStorageMock(),
    sessionStorage: createStorageMock(),
  });
});

afterEach(() => {
  setSandboxOwnerToken(null);
  clearSandboxEnvironment('sb-created');
  clearSandboxEnvironment('sb-persisted');
});

// ---------------------------------------------------------------------------
// 1. BatchWriteResult type shape
// ---------------------------------------------------------------------------

describe('BatchWriteResult type shape', () => {
  it('includes all required fields on success', () => {
    const result: BatchWriteResult = {
      ok: true,
      results: [
        { path: '/workspace/a.txt', ok: true, bytes_written: 42, new_version: 'abc123' },
        { path: '/workspace/b.txt', ok: true, bytes_written: 100, new_version: 'def456' },
      ],
    };

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].path).toBe('/workspace/a.txt');
    expect(result.results[0].bytes_written).toBe(42);
  });

  it('includes error fields on partial failure', () => {
    const result: BatchWriteResult = {
      ok: false,
      results: [
        { path: '/workspace/a.txt', ok: true, bytes_written: 42, new_version: 'abc123' },
        {
          path: '/workspace/b.txt',
          ok: false,
          error: 'Stale file version.',
          code: 'STALE_FILE',
          expected_version: 'old',
          current_version: 'new',
        },
      ],
    };

    expect(result.ok).toBe(false);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[1].code).toBe('STALE_FILE');
  });

  it('allows entry-level optional fields to be undefined', () => {
    const entry: BatchWriteResultEntry = { path: '/workspace/test.txt', ok: true };
    expect(entry.bytes_written).toBeUndefined();
    expect(entry.new_version).toBeUndefined();
    expect(entry.error).toBeUndefined();
    expect(entry.code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. batchWriteToSandbox client function
// ---------------------------------------------------------------------------

describe('batchWriteToSandbox', () => {
  it('sends POST to /api/sandbox/batch-write with correct body', async () => {
    const mockResponse: BatchWriteResult = {
      ok: true,
      results: [{ path: '/workspace/a.txt', ok: true, bytes_written: 5, new_version: 'abc' }],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { batchWriteToSandbox } = await import('./sandbox-client');
    const result = await batchWriteToSandbox(
      'sb-123',
      [{ path: '/workspace/a.txt', content: 'hello', expected_version: 'v1' }],
      7,
    );

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/batch-write');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.owner_token).toBe('test-owner-token');
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe('/workspace/a.txt');
    expect(body.files[0].content).toBe('hello');
    expect(body.files[0].expected_version).toBe('v1');
    expect(body.expected_workspace_revision).toBe(7);

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it('throws when owner token is not set', async () => {
    setSandboxOwnerToken(null);

    const { batchWriteToSandbox } = await import('./sandbox-client');
    await expect(
      batchWriteToSandbox('sb-123', [{ path: '/workspace/a.txt', content: 'hello' }]),
    ).rejects.toThrow(/access token missing/i);
  });
});

// ---------------------------------------------------------------------------
// 3. writeToSandbox client function
// ---------------------------------------------------------------------------

describe('writeToSandbox', () => {
  it('sends POST to /api/sandbox/write with correct body', async () => {
    const mockResponse: WriteResult = {
      ok: true,
      bytes_written: 12,
      new_version: 'sha256abc',
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { writeToSandbox } = await import('./sandbox-client');
    const result = await writeToSandbox('sb-123', '/workspace/test.txt', 'hello world!', 'v1', 11);

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/write');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.owner_token).toBe('test-owner-token');
    expect(body.path).toBe('/workspace/test.txt');
    expect(body.content).toBe('hello world!');
    expect(body.expected_version).toBe('v1');
    expect(body.expected_workspace_revision).toBe(11);

    expect(result.ok).toBe(true);
    expect(result.bytes_written).toBe(12);
  });

  it('passes an AbortSignal to fetch for timeout control', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, bytes_written: 5 }),
    });

    const { writeToSandbox } = await import('./sandbox-client');
    await writeToSandbox('sb-123', '/workspace/big.ts', 'x'.repeat(1000));

    const options = mockFetch.mock.calls[0][1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws when owner token is not set', async () => {
    setSandboxOwnerToken(null);

    const { writeToSandbox } = await import('./sandbox-client');
    await expect(writeToSandbox('sb-123', '/workspace/test.txt', 'hello')).rejects.toThrow(
      /access token missing/i,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. readFromSandbox client function
// ---------------------------------------------------------------------------

describe('readFromSandbox', () => {
  it('sends POST to /api/sandbox/read with range arguments and returns truncation metadata', async () => {
    const mockResponse: FileReadResult = {
      content: 'line 1\nline 2\n',
      truncated: true,
      truncated_at_line: 3,
      remaining_bytes: 42,
      version: 'sha256abc',
      start_line: 1,
      end_line: 10,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { readFromSandbox } = await import('./sandbox-client');
    const result = await readFromSandbox('sb-123', '/workspace/test.txt', 1, 10);

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/read');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.owner_token).toBe('test-owner-token');
    expect(body.path).toBe('/workspace/test.txt');
    expect(body.start_line).toBe(1);
    expect(body.end_line).toBe(10);

    expect(result.truncated).toBe(true);
    expect(result.truncated_at_line).toBe(3);
    expect(result.remaining_bytes).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 5. deleteFromSandbox client function
// ---------------------------------------------------------------------------

describe('deleteFromSandbox', () => {
  it('sends delete requests with optional workspace revision and returns the new revision', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, workspace_revision: 12 }),
    });

    const { deleteFromSandbox } = await import('./sandbox-client');
    const revision = await deleteFromSandbox('sb-123', '/workspace/old.txt', 11);

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/delete');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.path).toBe('/workspace/old.txt');
    expect(body.expected_workspace_revision).toBe(11);
    expect(revision).toBe(12);
  });
});

describe('pingSandbox', () => {
  it('sends a lightweight ping request with owner auth and Modal-compatible command fields', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    await expect(pingSandbox('sb-123')).resolves.toBe(true);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/ping');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      sandbox_id: 'sb-123',
      owner_token: 'test-owner-token',
      command: 'true',
      workdir: '/workspace',
    });
  });

  it('accepts Modal exec-command success shape', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: '', stderr: '', exit_code: 0, truncated: false }),
    });

    await expect(pingSandbox('sb-123')).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5b. listDirectory client function
// ---------------------------------------------------------------------------
//
// Both sandbox backends return entries with name/type/size but no `path`.
// listDirectory must derive the absolute path so the FileEntry contract holds —
// otherwise the workspace hub crashes ("Cannot read properties of undefined
// (reading 'split')") the moment a file or folder is opened.

describe('listDirectory', () => {
  it('derives an absolute path for entries that omit it', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          entries: [
            { name: 'src', type: 'directory', size: 0 },
            { name: 'app.ts', type: 'file', size: 42 },
          ],
        }),
    });

    const { listDirectory } = await import('./sandbox-client');
    const entries = await listDirectory('sb-123', '/workspace');

    expect(entries).toEqual([
      { name: 'src', type: 'directory', size: 0, path: '/workspace/src' },
      { name: 'app.ts', type: 'file', size: 42, path: '/workspace/app.ts' },
    ]);
  });

  it('does not double the slash when the directory path has a trailing slash', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ entries: [{ name: 'a.txt', type: 'file', size: 1 }] }),
    });

    const { listDirectory } = await import('./sandbox-client');
    const entries = await listDirectory('sb-123', '/workspace/sub/');

    expect(entries[0].path).toBe('/workspace/sub/a.txt');
  });

  it('derives a path when the backend returns an empty string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ entries: [{ name: 'a.txt', type: 'file', size: 1, path: '' }] }),
    });

    const { listDirectory } = await import('./sandbox-client');
    const entries = await listDirectory('sb-123', '/workspace');

    expect(entries[0].path).toBe('/workspace/a.txt');
  });

  it('preserves an explicit path when the backend already provides one', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          entries: [{ name: 'a.txt', type: 'file', size: 1, path: '/custom/a.txt' }],
        }),
    });

    const { listDirectory } = await import('./sandbox-client');
    const entries = await listDirectory('sb-123', '/workspace');

    expect(entries[0].path).toBe('/custom/a.txt');
  });
});

// ---------------------------------------------------------------------------
// 5. readSymbolsFromSandbox helper
// ---------------------------------------------------------------------------

describe('readSymbolsFromSandbox', () => {
  it('matches arrow assignments without treating function-typed variables as functions', () => {
    const arrowFunctionRegex = new RegExp(SANDBOX_TS_ARROW_FUNCTION_REGEX);

    expect(arrowFunctionRegex.test('const renderRow = (row: Row) => row.id')).toBe(true);
    expect(
      arrowFunctionRegex.test('export const loadUser: Loader = async () => ({ ok: true })'),
    ).toBe(true);
    expect(arrowFunctionRegex.test('const onSelect: (id: string) => void = noop')).toBe(false);
  });

  it('executes the symbol extractor and parses structured output', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: JSON.stringify({
            symbols: [
              {
                name: 'validateToken',
                kind: 'function',
                line: 12,
                signature: 'export function validateToken(token: string)',
              },
            ],
            total_lines: 120,
          }),
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    const result = await readSymbolsFromSandbox('sb-123', '/workspace/src/auth.ts');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/exec');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.command).toContain('python3 -c');
    expect(body.command).toContain('/workspace/src/auth.ts');

    expect(result.totalLines).toBe(120);
    expect(result.symbols).toEqual([
      {
        name: 'validateToken',
        kind: 'function',
        line: 12,
        signature: 'export function validateToken(token: string)',
      },
    ]);
  });

  it('surfaces structured extractor errors', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: JSON.stringify({ error: 'No such file or directory' }),
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    await expect(readSymbolsFromSandbox('sb-123', '/workspace/src/missing.ts')).rejects.toThrow(
      'No such file or directory',
    );
  });

  it('falls back to regex extractor when primary returns non-zero exit code', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Primary python extractor fails (non-zero exit, no retries triggered)
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              stdout: '',
              stderr: 'SyntaxError: invalid syntax',
              exit_code: 1,
              truncated: false,
            }),
        });
      }
      // Regex fallback succeeds
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              symbols: [
                { name: 'greet', kind: 'function', line: 1, signature: 'function greet()' },
              ],
              total_lines: 10,
            }),
            stderr: '',
            exit_code: 0,
            truncated: false,
          }),
      });
    });

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    const result = await readSymbolsFromSandbox('sb-123', '/workspace/src/app.ts');

    expect(callCount).toBe(2);
    expect(result.symbols).toEqual([
      { name: 'greet', kind: 'function', line: 1, signature: 'function greet()' },
    ]);
    expect(result.totalLines).toBe(10);

    // Verify fallback command uses node with shellEscape'd path
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.command).toContain('node -e');
    expect(secondBody.command).toContain('/workspace/src/app.ts');
  });

  it('falls back to regex extractor when primary returns no symbols', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Primary returns empty symbols
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              stdout: JSON.stringify({ symbols: [], total_lines: 50 }),
              stderr: '',
              exit_code: 0,
              truncated: false,
            }),
        });
      }
      // Regex fallback finds something
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              symbols: [{ name: 'Config', kind: 'class', line: 5, signature: 'class Config' }],
              total_lines: 50,
            }),
            stderr: '',
            exit_code: 0,
            truncated: false,
          }),
      });
    });

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    const result = await readSymbolsFromSandbox('sb-123', '/workspace/src/config.ts');

    expect(callCount).toBe(2);
    expect(result.symbols).toEqual([
      { name: 'Config', kind: 'class', line: 5, signature: 'class Config' },
    ]);
  });

  it('returns empty symbols when both extractors fail', async () => {
    mockFetch.mockImplementation(() => {
      // Both primary and fallback return non-zero exit (no retry-inducing errors)
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            stdout: '',
            stderr: 'command failed',
            exit_code: 1,
            truncated: false,
          }),
      });
    });

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    const result = await readSymbolsFromSandbox('sb-123', '/workspace/src/broken.ts');

    expect(result.symbols).toEqual([]);
    expect(result.totalLines).toBe(0);
  });

  it('re-throws non-timeout/signal errors from primary extractor', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    await expect(readSymbolsFromSandbox('sb-123', '/workspace/src/app.ts')).rejects.toThrow(
      'Network failure',
    );
  });
});

describe('fetchSandboxDiff', () => {
  it('captures tracked, staged, and untracked changes from HEAD', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: 'diff --git a/file.ts b/file.ts\n',
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { fetchSandboxDiff } = await import('./sandbox-client');
    const result = await fetchSandboxDiff('sb-123');

    expect(result).toBe('diff --git a/file.ts b/file.ts\n');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/exec');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.command).toContain('git diff --no-ext-diff --binary HEAD');
    expect(body.command).toContain('git ls-files --others --exclude-standard -z');
    expect(body.command).toContain('git diff --no-index --binary -- /dev/null "$path"');
  });

  it('truncates oversized diffs to the checkpoint cap', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: 'x'.repeat(30 * 1024 + 25),
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { fetchSandboxDiff } = await import('./sandbox-client');
    const result = await fetchSandboxDiff('sb-123');

    expect(result.length).toBeLessThanOrEqual(30 * 1024);
    expect(result.endsWith('\n...(diff truncated at 30KB)')).toBe(true);
  });
});

describe('fetchSandboxDiffWithMeta', () => {
  it('honors the exec-layer truncation flag even when stdout is under the byte cap', async () => {
    // Modal caps exec stdout at 10k — below DIFF_MAX_BYTES (30k). A diff cut
    // there arrives under our byte check but must still report truncated:true
    // so the commit-replay guard refuses to replay the incomplete patch.
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: 'x'.repeat(10_000),
          stderr: '',
          exit_code: 0,
          truncated: true,
        }),
    });

    const { fetchSandboxDiffWithMeta } = await import('./sandbox-client');
    const result = await fetchSandboxDiffWithMeta('sb-123');

    expect(result.diff.length).toBe(10_000);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated:false for a complete under-cap diff', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: 'diff --git a/file.ts b/file.ts\n',
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { fetchSandboxDiffWithMeta } = await import('./sandbox-client');
    const result = await fetchSandboxDiffWithMeta('sb-123');

    expect(result.truncated).toBe(false);
  });
});

describe('findReferencesInSandbox', () => {
  it('executes the ripgrep helper and parses structured output', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: JSON.stringify({
            references: [
              {
                file: 'src/lib/auditor-agent.ts',
                line: 14,
                context: "import { getActiveProvider } from './orchestrator'",
                kind: 'import',
              },
              {
                file: 'src/lib/orchestrator.ts',
                line: 156,
                context: 'const provider = getActiveProvider();',
                kind: 'call',
              },
            ],
            truncated: true,
          }),
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { findReferencesInSandbox } = await import('./sandbox-client');
    const result = await findReferencesInSandbox(
      'sb-123',
      'getActiveProvider',
      '/workspace/src',
      30,
    );

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/exec');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.command).toContain('python3 -c');
    expect(body.command).toContain('rg');
    expect(body.command).toContain('getActiveProvider');
    expect(body.command).toContain('/workspace/src');
    expect(body.command).toContain('30');

    expect(result.truncated).toBe(true);
    expect(result.references).toEqual([
      {
        file: 'src/lib/auditor-agent.ts',
        line: 14,
        context: "import { getActiveProvider } from './orchestrator'",
        kind: 'import',
      },
      {
        file: 'src/lib/orchestrator.ts',
        line: 156,
        context: 'const provider = getActiveProvider();',
        kind: 'call',
      },
    ]);
  });

  it('surfaces structured ripgrep helper errors', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          stdout: JSON.stringify({ error: 'rg exited with code 2' }),
          stderr: '',
          exit_code: 0,
          truncated: false,
        }),
    });

    const { findReferencesInSandbox } = await import('./sandbox-client');
    await expect(
      findReferencesInSandbox('sb-123', 'getActiveProvider', '/workspace/src'),
    ).rejects.toThrow('rg exited with code 2');
  });
});

describe('parseEnvironmentProbe', () => {
  it('parses scripts section from environment probe output', () => {
    const stdout = [
      '---VERSIONS---',
      'node:v20.18.1',
      'npm:10.8.2',
      'git:git version 2.39.5',
      'python:Python 3.11.6',
      '---DISK---',
      '45000M',
      '---MARKERS---',
      'package.json',
      'package-lock.json',
      '---SCRIPTS---',
      'test:vitest run',
      'lint:eslint .',
      'typecheck:tsc -b',
      'build:vite build',
      '---END---',
    ].join('\n');

    const env = parseEnvironmentProbe(stdout);
    expect(env).not.toBeNull();
    expect(env!.scripts).toEqual({
      test: 'vitest run',
      lint: 'eslint .',
      typecheck: 'tsc -b',
      build: 'vite build',
    });
    expect(env!.git_available).toBe(true);
    expect(env!.container_ttl).toBe('30m');
    expect(env!.writable_root).toBe('/workspace');
  });

  it('sets git_available to false when git is missing', () => {
    const stdout = [
      '---VERSIONS---',
      'node:v20.18.1',
      'git:MISSING',
      '---DISK---',
      '45000M',
      '---MARKERS---',
      '---END---',
    ].join('\n');

    const env = parseEnvironmentProbe(stdout);
    expect(env).not.toBeNull();
    expect(env!.git_available).toBe(false);
    expect(env!.scripts).toBeUndefined();
  });

  it('omits scripts when no package.json scripts match', () => {
    const stdout = [
      '---VERSIONS---',
      'node:v20.18.1',
      '---DISK---',
      '45000M',
      '---MARKERS---',
      '---SCRIPTS---',
      '---END---',
    ].join('\n');

    const env = parseEnvironmentProbe(stdout);
    expect(env).not.toBeNull();
    expect(env!.scripts).toBeUndefined();
  });
});

describe('sandbox lifecycle events', () => {
  it('sends the repo default branch when creating a sandbox', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sandbox_id: 'sb-created', owner_token: 'owner-token' }),
    });

    const session = await createSandbox('owner/repo', 'develop', undefined, undefined, 'develop');

    expect(session.status).toBe('ready');
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/create');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      repo: 'owner/repo',
      branch: 'develop',
      default_branch: 'develop',
    });
  });

  it('records workspace creation even when readiness metadata exists', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          sandbox_id: 'sb-created',
          owner_token: 'owner-token',
          workspace_revision: 1,
          environment: {
            tools: { node: 'v20.18.1' },
            container_ttl: '30m',
            readiness: {
              package_manager: 'npm',
              dependencies: 'installed',
            },
          },
        }),
    });

    const session = await createSandbox('owner/repo', 'main');

    expect(session.status).toBe('ready');
    expect(getSandboxLifecycleEvents('sb-created')).toEqual([
      expect.objectContaining({ message: 'Workspace created' }),
    ]);
  });

  it('lazy-hydrates persisted lifecycle events on cache miss', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    localStorage.setItem(
      'sandbox_lifecycle_events:sb-persisted',
      JSON.stringify([
        { timestamp: 1234, message: 'Workspace created' },
        { timestamp: 2345, message: 'Workspace state restored from snapshot' },
      ]),
    );

    expect(getSandboxLifecycleEvents('sb-persisted')).toEqual([
      { timestamp: 1234, message: 'Workspace created' },
      { timestamp: 2345, message: 'Workspace state restored from snapshot' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// createSandbox — durable user-token gate (defense in depth)
// ---------------------------------------------------------------------------
//
// useSandbox.start gates durable user-scoped tokens before calling createSandbox,
// but createSandbox is also the chokepoint for non-hook callers (e.g. the Modal
// provider) and is reachable directly. These pin the in-client backstop.

describe('createSandbox — durable user-token gate', () => {
  function setAck(value: boolean) {
    const storage = createStorageMock();
    if (value) storage.setItem(SANDBOX_USER_TOKEN_ACK_KEY, '1');
    vi.stubGlobal('window', { localStorage: storage, sessionStorage: createStorageMock() });
  }

  it('blocks a repo clone with a durable user token when not acknowledged', async () => {
    setAck(false);

    const session = await createSandbox('owner/repo', 'main', 'ghp_durableUserToken');

    expect(session.status).toBe('error');
    expect(session.error).toBe(USER_TOKEN_GATE_MESSAGE);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows a durable user token once acknowledged', async () => {
    setAck(true);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sandbox_id: 'sb-ack', owner_token: 'owner-token' }),
    });

    const session = await createSandbox('owner/repo', 'main', 'ghp_durableUserToken');

    expect(session.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows a scoped App installation token without acknowledgment', async () => {
    setAck(false);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sandbox_id: 'sb-app', owner_token: 'owner-token' }),
    });

    const session = await createSandbox('owner/repo', 'main', 'ghs_installationToken');

    expect(session.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not gate the ephemeral (no-clone) sandbox path', async () => {
    setAck(false);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sandbox_id: 'sb-ephemeral', owner_token: 'owner-token' }),
    });

    const session = await createSandbox('', undefined, '');

    expect(session.status).toBe('ready');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// execInSandbox retry behavior
// ---------------------------------------------------------------------------
//
// A wedged sandbox container (Cloudflare Sandbox SDK gRPC stuck after a heavy
// FS write) doesn't recover on its own. The pre-fix client retried four times
// with 2/4/8/16s backoff before surfacing the failure, hiding wedges for ~12
// minutes behind a "Executing in sandbox..." spinner. These tests pin the new
// behavior: timeout-class errors on `exec` fail immediately. Other endpoints
// still retry — read/write/list are cheap and idempotent.

describe('execInSandbox — timeout retry behavior', () => {
  it('does not retry when the request aborts (client timeout)', async () => {
    mockFetch.mockRejectedValue(new DOMException('aborted', 'AbortError'));

    const { execInSandbox } = await import('./sandbox-client');
    await expect(execInSandbox('sb-1', 'echo hi')).rejects.toThrow(/timed out/i);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the worker returns 504 TIMEOUT', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 504,
      text: () =>
        Promise.resolve(JSON.stringify({ error: 'sandbox exec exceeded', code: 'TIMEOUT' })),
    });

    const { execInSandbox } = await import('./sandbox-client');
    await expect(execInSandbox('sb-1', 'echo hi')).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Workspace mutation signal rooting
// ---------------------------------------------------------------------------

describe('sandbox client workspace mutation signal', () => {
  it('notifies after a marked exec completes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: '', stderr: '', exit_code: 0, truncated: false }),
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await execInSandbox('sb-1', 'touch f', undefined, { markWorkspaceMutated: true });
    } finally {
      off();
    }
    expect(seen).toEqual(['sb-1']);
  });

  it('suppresses marked exec notifications for internal callers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ stdout: '', stderr: '', exit_code: 0, truncated: false }),
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await execInSandbox('sb-1', 'git push origin HEAD', undefined, {
        markWorkspaceMutated: true,
        suppressWorkspaceMutationSignal: true,
      });
    } finally {
      off();
    }
    expect(seen).toEqual([]);
  });

  it('notifies after a successful file write', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, bytes_written: 5, workspace_revision: 2 }),
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      const { writeToSandbox } = await import('./sandbox-client');
      await writeToSandbox('sb-1', '/workspace/a.txt', 'hello');
    } finally {
      off();
    }
    expect(seen).toEqual(['sb-1']);
  });

  // #996 Codex P2: fire on ATTEMPT — a marked exec / write that times out may
  // have mutated server-side, so the signal must survive a throw / `!ok`.
  it('notifies a marked exec even when the exec call throws (timeout)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 504,
      text: () => Promise.resolve(JSON.stringify({ error: 'exec timed out', code: 'TIMEOUT' })),
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await expect(
        execInSandbox('sb-1', 'npm install', undefined, { markWorkspaceMutated: true }),
      ).rejects.toThrow();
    } finally {
      off();
    }
    expect(seen).toEqual(['sb-1']);
  });

  it('does not notify an unmarked exec that throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 504,
      text: () => Promise.resolve(JSON.stringify({ error: 'exec timed out', code: 'TIMEOUT' })),
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await expect(execInSandbox('sb-1', 'ls')).rejects.toThrow();
    } finally {
      off();
    }
    expect(seen).toEqual([]);
  });

  it('does not notify a marked exec when owner-token preflight fails before fetch', async () => {
    setSandboxOwnerToken(null);
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await expect(
        execInSandbox('sb-missing-token', 'touch f', undefined, { markWorkspaceMutated: true }),
      ).rejects.toThrow(/Sandbox access token missing/);
    } finally {
      off();
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('does not notify a marked long-running exec when start preflight fails before fetch', async () => {
    setSandboxOwnerToken(null);
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await expect(
        execLongRunningInSandbox('sb-missing-token', 'touch f', { markWorkspaceMutated: true }),
      ).rejects.toThrow(/Sandbox access token missing/);
    } finally {
      off();
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('notifies a write that reports failure (it may have landed server-side)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'version conflict' }),
    });
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      const { writeToSandbox } = await import('./sandbox-client');
      await writeToSandbox('sb-1', '/workspace/a.txt', 'hello');
    } finally {
      off();
    }
    expect(seen).toEqual(['sb-1']);
  });

  it('does not notify file mutations when owner-token preflight fails before fetch', async () => {
    setSandboxOwnerToken(null);
    const seen: string[] = [];
    const off = onWorkspaceMutation((id) => seen.push(id));
    try {
      await expect(writeToSandbox('sb-missing-token', '/workspace/a.txt', 'hello')).rejects.toThrow(
        /Sandbox access token missing/,
      );
      await expect(
        batchWriteToSandbox('sb-missing-token', [{ path: '/workspace/b.txt', content: 'hello' }]),
      ).rejects.toThrow(/Sandbox access token missing/);
      await expect(deleteFromSandbox('sb-missing-token', '/workspace/c.txt')).rejects.toThrow(
        /Sandbox access token missing/,
      );
    } finally {
      off();
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Idle tracking — the hibernation reaper's view of activity
// ---------------------------------------------------------------------------

describe('idle tracking', () => {
  it('stamps the idle clock when a call fails, not just on success', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('bad request'),
      });
      await expect(execInSandbox('sb-idle', 'true')).rejects.toThrow();
      expect(hasInFlightSandboxCalls()).toBe(false);

      vi.setSystemTime(1_005_000);
      expect(msSinceLastSandboxCall()).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports in-flight calls so the reaper can defer hibernation', async () => {
    let release!: (value: unknown) => void;
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = execInSandbox('sb-inflight', 'true');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasInFlightSandboxCalls()).toBe(true);

    release({
      ok: true,
      json: () => Promise.resolve({ stdout: '', stderr: '', exit_code: 0, truncated: false }),
    });
    await pending;
    expect(hasInFlightSandboxCalls()).toBe(false);
  });

  it('suppressed maintenance calls neither stamp the clock nor count as in flight', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2_000_000);
      // Stamp the clock with a normal (tracked) call.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ stdout: '', stderr: '', exit_code: 0, truncated: false }),
      });
      await execInSandbox('sb-maint', 'true');
      vi.setSystemTime(2_010_000);

      // Suppression is consumed synchronously at sandboxFetch entry, so the
      // pending suppressed call is invisible to the in-flight counter.
      suppressIdleTouch();
      let release!: (value: unknown) => void;
      mockFetch.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const pending = execInSandbox('sb-maint', 'true');
      expect(hasInFlightSandboxCalls()).toBe(false);

      release({
        ok: true,
        json: () => Promise.resolve({ stdout: '', stderr: '', exit_code: 0, truncated: false }),
      });
      await pending;
      // The suppressed call's completion did not stamp the idle clock.
      expect(msSinceLastSandboxCall()).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// execLongRunningInSandbox — start-failure handling (double-execution guard)
// ---------------------------------------------------------------------------

describe('execLongRunningInSandbox — start failures', () => {
  it('falls back to buffered exec only on a definitive 404', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404, text: () => Promise.resolve('no route') })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ stdout: 'buffered ran', stderr: '', exit_code: 0, truncated: false }),
      });

    const result = await execLongRunningInSandbox('sb-modal', 'echo hi');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('buffered ran');
    expect(result.terminalReason).toBeUndefined(); // buffered results carry no provenance
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/sandbox/exec-start');
    expect(mockFetch.mock.calls[1][0]).toBe('/api/sandbox/exec');
  });

  it('does NOT fall back on an ambiguous start failure (possible double execution)', async () => {
    // 504: the worker may have launched the process before the response was
    // lost. Re-running via buffered exec could execute the command twice.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 504,
      text: () => Promise.resolve(JSON.stringify({ error: 'gateway timeout' })),
    });

    const result = await execLongRunningInSandbox('sb-cf', 'deploy.sh');

    expect(result.exitCode).toBe(-1);
    expect(result.terminalReason).toBe('start-unconfirmed');
    expect(result.error).toMatch(/without confirmation/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no buffered retry
  });

  it('never falls back when the abort signal fired during start', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await execLongRunningInSandbox('sb-cf', 'npm test', {
      abortSignal: controller.signal,
    });

    expect(result.exitCode).toBe(124);
    expect(result.terminalReason).toBe('cancelled');
    expect(mockFetch).not.toHaveBeenCalled(); // pre-aborted: nothing starts
  });
});

describe('mapSandboxErrorCode — file-not-found vs sandbox-gone', () => {
  it('maps FILE_NOT_FOUND to a benign tool error, not SANDBOX_UNREACHABLE', () => {
    // Regression: a missing path inside a live sandbox must not be classified
    // as a sandbox loss (which routes to the fatal gone-detector and kills the
    // turn). It stays a recoverable FILE_NOT_FOUND the model can route around.
    expect(mapSandboxErrorCode('FILE_NOT_FOUND')).toBe('FILE_NOT_FOUND');
    expect(mapSandboxErrorCode('FILE_NOT_FOUND')).not.toBe('SANDBOX_UNREACHABLE');
  });

  it('still maps a genuinely-gone sandbox (NOT_FOUND) to SANDBOX_UNREACHABLE', () => {
    expect(mapSandboxErrorCode('NOT_FOUND')).toBe('SANDBOX_UNREACHABLE');
  });
});
