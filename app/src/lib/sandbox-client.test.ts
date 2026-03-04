/**
 * Tests for sandbox client functions and result types.
 *
 * Covers:
 * - BrowserScreenshotResult shape validation
 * - BrowserExtractResult shape validation
 * - browserScreenshotInSandbox sends correct request
 * - browserExtractInSandbox sends correct request
 * - BatchWriteResult shape validation
 * - batchWriteToSandbox sends correct request
 *
 * All fetch calls are mocked — no real HTTP requests are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  BrowserScreenshotResult,
  BrowserExtractResult,
  BatchWriteResult,
  BatchWriteResultEntry,
  WriteResult,
} from './sandbox-client';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// We need to set the owner token before each test since the client
// checks for it on every request.
import { setSandboxOwnerToken } from './sandbox-client';

beforeEach(() => {
  mockFetch.mockReset();
  setSandboxOwnerToken('test-owner-token');
});

afterEach(() => {
  setSandboxOwnerToken(null);
});

// ---------------------------------------------------------------------------
// 1. BrowserScreenshotResult type shape
// ---------------------------------------------------------------------------

describe('BrowserScreenshotResult type shape', () => {
  it('includes all required fields on success', () => {
    const result: BrowserScreenshotResult = {
      ok: true,
      title: 'Example',
      final_url: 'https://example.com/',
      status_code: 200,
      mime_type: 'image/png',
      image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAUA',
      truncated: false,
    };

    expect(result.ok).toBe(true);
    expect(result.title).toBe('Example');
    expect(result.final_url).toBe('https://example.com/');
    expect(result.status_code).toBe(200);
    expect(result.mime_type).toBe('image/png');
    expect(result.image_base64).toBe('iVBORw0KGgoAAAANSUhEUgAAAAUA');
    expect(result.truncated).toBe(false);
  });

  it('allows null status_code', () => {
    const result: BrowserScreenshotResult = {
      ok: true,
      status_code: null,
    };
    expect(result.status_code).toBeNull();
  });

  it('includes error fields on failure', () => {
    const result: BrowserScreenshotResult = {
      ok: false,
      error: 'Navigation failed',
      details: 'Timeout after 30s',
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Navigation failed');
    expect(result.details).toBe('Timeout after 30s');
  });

  it('all optional fields can be undefined', () => {
    const result: BrowserScreenshotResult = { ok: true };
    expect(result.title).toBeUndefined();
    expect(result.final_url).toBeUndefined();
    expect(result.status_code).toBeUndefined();
    expect(result.mime_type).toBeUndefined();
    expect(result.image_base64).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. BrowserExtractResult type shape
// ---------------------------------------------------------------------------

describe('BrowserExtractResult type shape', () => {
  it('includes all required fields on success', () => {
    const result: BrowserExtractResult = {
      ok: true,
      title: 'Docs Page',
      final_url: 'https://docs.example.com/api',
      status_code: 200,
      content: '# API Reference\n\nEndpoints listed here.',
      truncated: false,
    };

    expect(result.ok).toBe(true);
    expect(result.title).toBe('Docs Page');
    expect(result.final_url).toBe('https://docs.example.com/api');
    expect(result.status_code).toBe(200);
    expect(result.content).toContain('API Reference');
    expect(result.truncated).toBe(false);
  });

  it('allows null status_code', () => {
    const result: BrowserExtractResult = {
      ok: true,
      status_code: null,
    };
    expect(result.status_code).toBeNull();
  });

  it('includes error fields on failure', () => {
    const result: BrowserExtractResult = {
      ok: false,
      error: 'Extract failed',
      details: 'Page rendered no content',
    };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Extract failed');
    expect(result.details).toBe('Page rendered no content');
  });

  it('all optional fields can be undefined', () => {
    const result: BrowserExtractResult = { ok: true };
    expect(result.title).toBeUndefined();
    expect(result.final_url).toBeUndefined();
    expect(result.status_code).toBeUndefined();
    expect(result.content).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. browserScreenshotInSandbox client function
// ---------------------------------------------------------------------------

describe('browserScreenshotInSandbox', () => {
  it('sends POST to /api/sandbox/browser-screenshot with correct body', async () => {
    const mockResponse: BrowserScreenshotResult = {
      ok: true,
      title: 'Test Page',
      final_url: 'https://example.com',
      status_code: 200,
      mime_type: 'image/png',
      image_base64: 'abc123',
      truncated: false,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    // Import the function (dynamically to use the mocked fetch)
    const { browserScreenshotInSandbox } = await import('./sandbox-client');
    const result = await browserScreenshotInSandbox('sb-123', 'https://example.com', true);

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/browser-screenshot');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.url).toBe('https://example.com');
    expect(body.full_page).toBe(true);
    expect(body.owner_token).toBe('test-owner-token');

    expect(result.ok).toBe(true);
    expect(result.title).toBe('Test Page');
  });

  it('sends fullPage=false by default', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const { browserScreenshotInSandbox } = await import('./sandbox-client');
    await browserScreenshotInSandbox('sb-123', 'https://example.com');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.full_page).toBe(false);
  });

  it('throws when owner token is not set', async () => {
    setSandboxOwnerToken(null);

    const { browserScreenshotInSandbox } = await import('./sandbox-client');
    await expect(
      browserScreenshotInSandbox('sb-123', 'https://example.com'),
    ).rejects.toThrow(/access token missing/i);
  });
});

// ---------------------------------------------------------------------------
// 4. browserExtractInSandbox client function
// ---------------------------------------------------------------------------

describe('browserExtractInSandbox', () => {
  it('sends POST to /api/sandbox/browser-extract with correct body', async () => {
    const mockResponse: BrowserExtractResult = {
      ok: true,
      title: 'Docs',
      final_url: 'https://docs.example.com',
      status_code: 200,
      content: 'Page content here',
      truncated: false,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { browserExtractInSandbox } = await import('./sandbox-client');
    const result = await browserExtractInSandbox('sb-123', 'https://docs.example.com', 'Get API docs');

    expect(mockFetch).toHaveBeenCalled();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/sandbox/browser-extract');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.sandbox_id).toBe('sb-123');
    expect(body.url).toBe('https://docs.example.com');
    expect(body.instruction).toBe('Get API docs');
    expect(body.owner_token).toBe('test-owner-token');

    expect(result.ok).toBe(true);
    expect(result.content).toBe('Page content here');
  });

  it('sends empty instruction when not provided', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const { browserExtractInSandbox } = await import('./sandbox-client');
    await browserExtractInSandbox('sb-123', 'https://example.com');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.instruction).toBe('');
  });

  it('throws when owner token is not set', async () => {
    setSandboxOwnerToken(null);

    const { browserExtractInSandbox } = await import('./sandbox-client');
    await expect(
      browserExtractInSandbox('sb-123', 'https://example.com'),
    ).rejects.toThrow(/access token missing/i);
  });
});

// ---------------------------------------------------------------------------
// 5. BatchWriteResult type shape
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
// 6. batchWriteToSandbox client function
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
    ]);

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
// 7. writeToSandbox client function
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
    const result = await writeToSandbox('sb-123', '/workspace/test.txt', 'hello world!', 'v1');

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
