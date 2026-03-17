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
import { setSandboxOwnerToken, parseEnvironmentProbe, SANDBOX_TS_ARROW_FUNCTION_REGEX } from './sandbox-client';

beforeEach(() => {
  mockFetch.mockReset();
  setSandboxOwnerToken('test-owner-token');
});

afterEach(() => {
  setSandboxOwnerToken(null);
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
        { path: '/workspace/b.txt', ok: false, error: 'Stale file version.', code: 'STALE_FILE', expected_version: 'old', current_version: 'new' },
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
      results: [
        { path: '/workspace/a.txt', ok: true, bytes_written: 5, new_version: 'abc' },
      ],
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { batchWriteToSandbox } = await import('./sandbox-client');
    const result = await batchWriteToSandbox('sb-123', [
      { path: '/workspace/a.txt', content: 'hello', expected_version: 'v1' },
    ], 7);

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
    await expect(
      writeToSandbox('sb-123', '/workspace/test.txt', 'hello'),
    ).rejects.toThrow(/access token missing/i);
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

// ---------------------------------------------------------------------------
// 5. readSymbolsFromSandbox helper
// ---------------------------------------------------------------------------

describe('readSymbolsFromSandbox', () => {
  it('matches arrow assignments without treating function-typed variables as functions', () => {
    const arrowFunctionRegex = new RegExp(SANDBOX_TS_ARROW_FUNCTION_REGEX);

    expect(arrowFunctionRegex.test('const renderRow = (row: Row) => row.id')).toBe(true);
    expect(arrowFunctionRegex.test('export const loadUser: Loader = async () => ({ ok: true })')).toBe(true);
    expect(arrowFunctionRegex.test('const onSelect: (id: string) => void = noop')).toBe(false);
  });

  it('executes the symbol extractor and parses structured output', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
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
    expect(body.command).toContain("python3 -c");
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
      json: () => Promise.resolve({
        stdout: JSON.stringify({ error: 'No such file or directory' }),
        stderr: '',
        exit_code: 0,
        truncated: false,
      }),
    });

    const { readSymbolsFromSandbox } = await import('./sandbox-client');
    await expect(
      readSymbolsFromSandbox('sb-123', '/workspace/src/missing.ts'),
    ).rejects.toThrow('No such file or directory');
  });
});

describe('findReferencesInSandbox', () => {
  it('executes the ripgrep helper and parses structured output', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
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
    const result = await findReferencesInSandbox('sb-123', 'getActiveProvider', '/workspace/src', 30);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/exec');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.command).toContain("python3 -c");
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
      json: () => Promise.resolve({
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
