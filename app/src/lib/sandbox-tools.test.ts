/**
 * Tests for browser tool validation, detection, and execution in sandbox-tools.ts.
 *
 * Covers:
 * - sandbox_browser_screenshot validation (valid URLs, invalid schemes, missing URLs, feature flag)
 * - sandbox_browser_extract validation (valid URLs, instruction, invalid URLs, feature flag)
 * - Tool detection from fenced JSON and bare JSON
 * - Tool execution (mocked sandbox-client calls)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks must be set up before importing the module under test ----

// Use vi.hoisted() so these variables are available inside the hoisted vi.mock() factories.
const {
  mockBrowserToolEnabled,
  mockBrowserScreenshotInSandbox,
  mockBrowserExtractInSandbox,
  mockRecordWriteFileMetric,
  mockRecordReadFileMetric,
  mockFileLedger,
} = vi.hoisted(() => ({
  mockBrowserToolEnabled: { value: true },
  mockBrowserScreenshotInSandbox: vi.fn(),
  mockBrowserExtractInSandbox: vi.fn(),
  mockRecordWriteFileMetric: vi.fn(),
  mockRecordReadFileMetric: vi.fn(),
  mockFileLedger: {
    checkWriteAllowed: vi.fn().mockReturnValue({ allowed: true }),
    recordRead: vi.fn(),
    recordCreation: vi.fn(),
    recordAutoExpandAttempt: vi.fn(),
    recordAutoExpandSuccess: vi.fn(),
    getStaleWarning: vi.fn().mockReturnValue(null),
  },
}));

// Mock the feature-flags module so we can control browserToolEnabled per test.
vi.mock('./feature-flags', () => ({
  get browserToolEnabled() {
    return mockBrowserToolEnabled.value;
  },
}));

// Mock sandbox-client so no real HTTP calls are made.
vi.mock('./sandbox-client', () => ({
  execInSandbox: vi.fn(),
  readFromSandbox: vi.fn(),
  writeToSandbox: vi.fn(),
  getSandboxDiff: vi.fn(),
  listDirectory: vi.fn(),
  downloadFromSandbox: vi.fn(),
  browserScreenshotInSandbox: (...args: unknown[]) => mockBrowserScreenshotInSandbox(...args),
  browserExtractInSandbox: (...args: unknown[]) => mockBrowserExtractInSandbox(...args),
}));

// Mock auditor-agent (needed by sandbox_prepare_commit, not used in browser tests).
vi.mock('./auditor-agent', () => ({
  runAuditor: vi.fn(),
}));

// Mock browser-metrics (the execution code calls recordBrowserMetric).
vi.mock('./browser-metrics', () => ({
  recordBrowserMetric: vi.fn(),
}));

vi.mock('./edit-metrics', () => ({
  recordWriteFileMetric: (...args: unknown[]) => mockRecordWriteFileMetric(...args),
  recordReadFileMetric: (...args: unknown[]) => mockRecordReadFileMetric(...args),
}));

vi.mock('./file-awareness-ledger', async () => {
  const actual = await vi.importActual<typeof import('./file-awareness-ledger')>('./file-awareness-ledger');
  return {
    fileLedger: mockFileLedger,
    extractSignatures: actual.extractSignatures,
  };
});

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
  detectSandboxToolCall,
  executeSandboxToolCall,
} from './sandbox-tools';
import * as sandboxClient from './sandbox-client';
import { extractSignatures } from './file-awareness-ledger';

// ---------------------------------------------------------------------------
// 1. Tool validation -- sandbox_browser_screenshot
// ---------------------------------------------------------------------------

describe('validateSandboxToolCall -- sandbox_browser_screenshot', () => {
  beforeEach(() => {
    mockBrowserToolEnabled.value = true;
  });

  it('accepts a valid https URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: { url: 'https://example.com' },
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_screenshot');
    if (result!.tool === 'sandbox_browser_screenshot') {
      expect(result!.args.url).toBe('https://example.com');
      expect(result!.args.fullPage).toBe(false);
    }
  });

  it('accepts a valid http URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: { url: 'http://example.com/page' },
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_screenshot');
  });

  it('accepts fullPage: true', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: { url: 'https://example.com', fullPage: true },
    });
    expect(result).not.toBeNull();
    if (result!.tool === 'sandbox_browser_screenshot') {
      expect(result!.args.fullPage).toBe(true);
    }
  });

  it('coerces truthy fullPage to boolean', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: { url: 'https://example.com', fullPage: 1 },
    });
    expect(result).not.toBeNull();
    if (result!.tool === 'sandbox_browser_screenshot') {
      expect(result!.args.fullPage).toBe(true);
    }
  });

  it('rejects missing URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: {},
    });
    expect(result).toBeNull();
  });

  it('rejects empty string URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: { url: '' },
    });
    expect(result).toBeNull();
  });

  it('rejects when browserToolEnabled is false', () => {
    mockBrowserToolEnabled.value = false;
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
      args: { url: 'https://example.com' },
    });
    expect(result).toBeNull();
  });

  it('rejects missing args entirely', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_screenshot',
    });
    expect(result).toBeNull();
  });
});

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

// ---------------------------------------------------------------------------
// 2. Tool validation -- sandbox_browser_extract
// ---------------------------------------------------------------------------

describe('validateSandboxToolCall -- sandbox_browser_extract', () => {
  beforeEach(() => {
    mockBrowserToolEnabled.value = true;
  });

  it('accepts a valid https URL without instruction', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_extract',
      args: { url: 'https://example.com' },
    });
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_extract');
    if (result!.tool === 'sandbox_browser_extract') {
      expect(result!.args.url).toBe('https://example.com');
      expect(result!.args.instruction).toBeUndefined();
    }
  });

  it('accepts a valid URL with an instruction', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_extract',
      args: { url: 'https://example.com/docs', instruction: 'Get the pricing table' },
    });
    expect(result).not.toBeNull();
    if (result!.tool === 'sandbox_browser_extract') {
      expect(result!.args.instruction).toBe('Get the pricing table');
    }
  });

  it('accepts http URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_extract',
      args: { url: 'http://docs.example.com/api' },
    });
    expect(result).not.toBeNull();
  });

  it('rejects missing URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_extract',
      args: { instruction: 'some instruction' },
    });
    expect(result).toBeNull();
  });

  it('rejects empty string URL', () => {
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_extract',
      args: { url: '' },
    });
    expect(result).toBeNull();
  });

  it('rejects when browserToolEnabled is false', () => {
    mockBrowserToolEnabled.value = false;
    const result = validateSandboxToolCall({
      tool: 'sandbox_browser_extract',
      args: { url: 'https://example.com' },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Tool detection -- fenced and bare JSON
// ---------------------------------------------------------------------------

describe('detectSandboxToolCall -- browser tools', () => {
  beforeEach(() => {
    mockBrowserToolEnabled.value = true;
  });

  it('detects sandbox_browser_screenshot in fenced JSON', () => {
    const text = 'Let me take a screenshot.\n```json\n{"tool": "sandbox_browser_screenshot", "args": {"url": "https://example.com"}}\n```';
    const result = detectSandboxToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_screenshot');
    if (result!.tool === 'sandbox_browser_screenshot') {
      expect(result!.args.url).toBe('https://example.com');
    }
  });

  it('detects sandbox_browser_extract in fenced JSON', () => {
    const text = '```json\n{"tool": "sandbox_browser_extract", "args": {"url": "https://docs.example.com", "instruction": "Get the API reference"}}\n```';
    const result = detectSandboxToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_extract');
    if (result!.tool === 'sandbox_browser_extract') {
      expect(result!.args.url).toBe('https://docs.example.com');
      expect(result!.args.instruction).toBe('Get the API reference');
    }
  });

  it('detects sandbox_browser_screenshot in bare JSON (no fences)', () => {
    const text = 'Here is the tool call: {"tool": "sandbox_browser_screenshot", "args": {"url": "https://example.com", "fullPage": true}}';
    const result = detectSandboxToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_screenshot');
    if (result!.tool === 'sandbox_browser_screenshot') {
      expect(result!.args.fullPage).toBe(true);
    }
  });

  it('detects sandbox_browser_extract in bare JSON', () => {
    const text = '{"tool": "sandbox_browser_extract", "args": {"url": "https://example.com"}}';
    const result = detectSandboxToolCall(text);
    expect(result).not.toBeNull();
    expect(result!.tool).toBe('sandbox_browser_extract');
  });

  it('returns null for browser tools when feature flag is off', () => {
    mockBrowserToolEnabled.value = false;
    const text = '```json\n{"tool": "sandbox_browser_screenshot", "args": {"url": "https://example.com"}}\n```';
    const result = detectSandboxToolCall(text);
    expect(result).toBeNull();
  });

  it('returns null when URL is missing from args', () => {
    const text = '```json\n{"tool": "sandbox_browser_screenshot", "args": {}}\n```';
    const result = detectSandboxToolCall(text);
    expect(result).toBeNull();
  });

  it('handles nested JSON in args correctly', () => {
    const text = '{"tool": "sandbox_browser_screenshot", "args": {"url": "https://example.com/path?q=1&r=2"}}';
    const result = detectSandboxToolCall(text);
    expect(result).not.toBeNull();
    if (result!.tool === 'sandbox_browser_screenshot') {
      expect(result!.args.url).toBe('https://example.com/path?q=1&r=2');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Tool execution -- sandbox_browser_screenshot
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- sandbox_browser_screenshot', () => {
  beforeEach(() => {
    mockBrowserToolEnabled.value = true;
    mockBrowserScreenshotInSandbox.mockReset();
    mockBrowserExtractInSandbox.mockReset();
  });

  it('returns error when no sandboxId is provided', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://example.com', fullPage: false } },
      '',
    );
    expect(result.text).toContain('No active sandbox');
  });

  it('returns error when browserToolEnabled is false', async () => {
    mockBrowserToolEnabled.value = false;
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://example.com', fullPage: false } },
      'sb-123',
    );
    expect(result.text).toContain('Browser tools are disabled');
  });

  it('rejects non-http URL at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'ftp://example.com/file', fullPage: false } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('rejects javascript: scheme at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'javascript:alert(1)', fullPage: false } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('rejects data: scheme at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'data:text/html,hello', fullPage: false } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('rejects file: scheme at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'file:///etc/passwd', fullPage: false } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('returns error card when sandbox client reports known error code', async () => {
    // Use a known error code from the BROWSER_ERROR_MESSAGES map
    mockBrowserScreenshotInSandbox.mockResolvedValue({
      ok: false,
      error: 'NAVIGATION_TIMEOUT',
      details: 'Page did not load within 30s',
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://slow-site.com', fullPage: false } },
      'sb-123',
    );
    // NAVIGATION_TIMEOUT maps to "The page took too long to load"
    expect(result.text).toContain('The page took too long to load');
    expect(result.card).toBeDefined();
    expect(result.card!.type).toBe('browser-screenshot');
  });

  it('returns fallback error for unknown error codes', async () => {
    mockBrowserScreenshotInSandbox.mockResolvedValue({
      ok: false,
      error: 'SOME_UNKNOWN_CODE',
      details: 'unusual details',
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://slow-site.com', fullPage: false } },
      'sb-123',
    );
    // Unknown code falls back to "Something went wrong"
    expect(result.text).toContain('Something went wrong');
    expect(result.text).toContain('unusual details');
  });

  it('returns error when response is missing image data', async () => {
    mockBrowserScreenshotInSandbox.mockResolvedValue({
      ok: true,
      title: 'Example',
      final_url: 'https://example.com',
      status_code: 200,
      // missing image_base64 and mime_type
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://example.com', fullPage: false } },
      'sb-123',
    );
    expect(result.text).toContain('missing image data');
  });

  it('returns card with correct shape on success', async () => {
    mockBrowserScreenshotInSandbox.mockResolvedValue({
      ok: true,
      title: 'Example Domain',
      final_url: 'https://example.com/',
      status_code: 200,
      mime_type: 'image/png',
      image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAUA',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://example.com', fullPage: false } },
      'sb-123',
    );

    expect(result.text).toContain('sandbox_browser_screenshot');
    expect(result.text).toContain('https://example.com');
    expect(result.text).toContain('Example Domain');
    expect(result.card).toBeDefined();
    expect(result.card!.type).toBe('browser-screenshot');

    const data = result.card!.data as import('@/types').BrowserScreenshotCardData;
    expect(data.url).toBe('https://example.com');
    expect(data.finalUrl).toBe('https://example.com/');
    expect(data.title).toBe('Example Domain');
    expect(data.statusCode).toBe(200);
    expect(data.mimeType).toBe('image/png');
    expect(data.imageBase64).toBe('iVBORw0KGgoAAAANSUhEUgAAAAUA');
    expect(data.truncated).toBe(false);
  });

  it('passes fullPage, sandboxId, and onRetries callback to the client', async () => {
    mockBrowserScreenshotInSandbox.mockResolvedValue({
      ok: true,
      title: 'Full Page',
      final_url: 'https://example.com',
      status_code: 200,
      mime_type: 'image/png',
      image_base64: 'abc',
      truncated: false,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://example.com', fullPage: true } },
      'sb-456',
    );

    // The 4th argument is the onRetries callback function
    expect(mockBrowserScreenshotInSandbox).toHaveBeenCalledWith(
      'sb-456', 'https://example.com', true, expect.any(Function),
    );
  });

  it('handles null status_code', async () => {
    mockBrowserScreenshotInSandbox.mockResolvedValue({
      ok: true,
      title: 'Test',
      final_url: 'https://example.com',
      status_code: null,
      mime_type: 'image/png',
      image_base64: 'data',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_screenshot', args: { url: 'https://example.com', fullPage: false } },
      'sb-123',
    );

    expect(result.text).toContain('Status: n/a');
    const data = result.card!.data as import('@/types').BrowserScreenshotCardData;
    expect(data.statusCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Tool execution -- sandbox_browser_extract
// ---------------------------------------------------------------------------

describe('executeSandboxToolCall -- sandbox_browser_extract', () => {
  beforeEach(() => {
    mockBrowserToolEnabled.value = true;
    mockBrowserScreenshotInSandbox.mockReset();
    mockBrowserExtractInSandbox.mockReset();
  });

  it('returns error when no sandboxId is provided', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      '',
    );
    expect(result.text).toContain('No active sandbox');
  });

  it('returns error when browserToolEnabled is false', async () => {
    mockBrowserToolEnabled.value = false;
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-123',
    );
    expect(result.text).toContain('Browser tools are disabled');
  });

  it('rejects non-http URL at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'ftp://files.example.com/data' } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('rejects javascript: scheme at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'javascript:void(0)' } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('rejects data: scheme at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'data:text/plain,hello' } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('rejects file: scheme at execution time', async () => {
    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'file:///etc/hosts' } },
      'sb-123',
    );
    expect(result.text).toContain('requires an absolute http(s) URL');
  });

  it('returns error card when sandbox client reports known error code', async () => {
    // Use a known error code from the BROWSER_ERROR_MESSAGES map
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: false,
      error: 'SESSION_CREATE_FAILED',
      details: 'Could not connect',
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-123',
    );
    // SESSION_CREATE_FAILED maps to "Couldn't start a browser session -- try again"
    expect(result.text).toContain("start a browser session");
    expect(result.card).toBeDefined();
    expect(result.card!.type).toBe('browser-extract');
  });

  it('returns fallback error for unknown error codes', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: false,
      error: 'WEIRD_ERROR',
      details: 'some detail',
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-123',
    );
    expect(result.text).toContain('Something went wrong');
    expect(result.text).toContain('some detail');
  });

  it('returns error when content is empty', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'Empty Page',
      final_url: 'https://example.com',
      status_code: 200,
      content: '',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-123',
    );
    expect(result.text).toContain('returned no content');
  });

  it('returns card with correct shape on success', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'API Docs',
      final_url: 'https://docs.example.com/api',
      status_code: 200,
      content: '# API Reference\n\nWelcome to the API docs.',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://docs.example.com/api', instruction: 'Get API reference' } },
      'sb-123',
    );

    expect(result.text).toContain('sandbox_browser_extract');
    expect(result.text).toContain('API Docs');
    expect(result.card).toBeDefined();
    expect(result.card!.type).toBe('browser-extract');

    const data = result.card!.data as import('@/types').BrowserExtractCardData;
    expect(data.url).toBe('https://docs.example.com/api');
    expect(data.finalUrl).toBe('https://docs.example.com/api');
    expect(data.title).toBe('API Docs');
    expect(data.statusCode).toBe(200);
    expect(data.instruction).toBe('Get API reference');
    expect(data.content).toContain('API Reference');
    expect(data.truncated).toBe(false);
  });

  it('passes instruction, sandboxId, and onRetries callback to the client', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'Test',
      final_url: 'https://example.com',
      status_code: 200,
      content: 'some content',
      truncated: false,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com', instruction: 'Find pricing info' } },
      'sb-789',
    );

    // The 4th argument is the onRetries callback function
    expect(mockBrowserExtractInSandbox).toHaveBeenCalledWith(
      'sb-789', 'https://example.com', 'Find pricing info', expect.any(Function),
    );
  });

  it('passes empty string instruction when not provided', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'Test',
      final_url: 'https://example.com',
      status_code: 200,
      content: 'some content',
      truncated: false,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-789',
    );

    // The execution trims the instruction, so undefined becomes ''
    // The 4th argument is the onRetries callback function
    expect(mockBrowserExtractInSandbox).toHaveBeenCalledWith(
      'sb-789', 'https://example.com', '', expect.any(Function),
    );
  });

  it('omits instruction from card data when empty', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'Test',
      final_url: 'https://example.com',
      status_code: 200,
      content: 'some content',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-789',
    );

    const data = result.card!.data as import('@/types').BrowserExtractCardData;
    expect(data.instruction).toBeUndefined();
  });

  it('handles null status_code', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'Test',
      final_url: 'https://example.com',
      status_code: null,
      content: 'content',
      truncated: false,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-123',
    );

    expect(result.text).toContain('Status: n/a');
    const data = result.card!.data as import('@/types').BrowserExtractCardData;
    expect(data.statusCode).toBeNull();
  });

  it('reports truncation correctly', async () => {
    mockBrowserExtractInSandbox.mockResolvedValue({
      ok: true,
      title: 'Long Page',
      final_url: 'https://example.com',
      status_code: 200,
      content: 'truncated content...',
      truncated: true,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_browser_extract', args: { url: 'https://example.com' } },
      'sb-123',
    );

    expect(result.text).toContain('Content truncated: yes');
    const data = result.card!.data as import('@/types').BrowserExtractCardData;
    expect(data.truncated).toBe(true);
  });
});

describe('executeSandboxToolCall -- stale write handling', () => {
  beforeEach(() => {
    mockBrowserToolEnabled.value = true;
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
    mockBrowserToolEnabled.value = true;
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
    mockBrowserToolEnabled.value = true;
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
// 8. Edit Guard Tests -- File Awareness Ledger Integration
// ---------------------------------------------------------------------------

describe('Edit Guard -- File Awareness Ledger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowserToolEnabled.value = true;
    mockFileLedger.checkWriteAllowed.mockReset();
    mockFileLedger.recordRead.mockReset();
    mockFileLedger.recordCreation.mockReset();
    mockFileLedger.recordAutoExpandAttempt.mockReset();
    mockFileLedger.recordAutoExpandSuccess.mockReset();
    mockFileLedger.getStaleWarning.mockReset();
    mockFileLedger.checkWriteAllowed.mockReturnValue({ allowed: true });
    mockFileLedger.getStaleWarning.mockReturnValue(null);
  });

  it('blocks write when file has never been read', async () => {
    mockFileLedger.checkWriteAllowed.mockReturnValue({
      allowed: false,
      reason: 'File "test.txt" has not been read yet. Use sandbox_read_file to read it before writing.',
    });

    // Auto-read should fail (file doesn't exist)
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      error: 'No such file or directory',
      content: '',
      version: '',
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/test.txt', content: 'hello' } },
      'sb-123',
    );

    expect(mockFileLedger.checkWriteAllowed).toHaveBeenCalledWith('/workspace/test.txt');
    expect(mockFileLedger.recordAutoExpandAttempt).toHaveBeenCalled();
  });

  it('allows write after successful auto-expand', async () => {
    // First guard check fails
    mockFileLedger.checkWriteAllowed
      .mockReturnValueOnce({
        allowed: false,
        reason: 'File "test.txt" has not been read yet.',
      })
      // Second check (after auto-expand) succeeds
      .mockReturnValueOnce({ allowed: true });

    // Auto-read succeeds
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'existing content',
      version: 'v1',
      truncated: false,
    });

    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      version: 'v2',
    });

    // Mock git status check
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M test.txt',
      stderr: '',
      exitCode: 0,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/test.txt', content: 'new content' } },
      'sb-123',
    );

    expect(mockFileLedger.recordAutoExpandAttempt).toHaveBeenCalled();
    expect(mockFileLedger.recordAutoExpandSuccess).toHaveBeenCalled();
    expect(mockFileLedger.recordRead).toHaveBeenCalledWith('/workspace/test.txt', {
      truncated: false,
      totalLines: 1,
    });
    expect(result.text).toContain('Wrote /workspace/test.txt');
  });

  it('allows new file creation when auto-expand detects ENOENT', async () => {
    mockFileLedger.checkWriteAllowed.mockReturnValue({
      allowed: false,
      reason: 'File "newfile.txt" has not been read yet.',
    });

    // Auto-read fails with "no such file"
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      error: 'cat: /workspace/newfile.txt: No such file or directory',
      content: '',
      version: '',
    });

    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      version: 'v1',
    });

    // Mock git status check
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'A newfile.txt',
      stderr: '',
      exitCode: 0,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/newfile.txt', content: 'new content' } },
      'sb-123',
    );

    expect(mockFileLedger.recordAutoExpandAttempt).toHaveBeenCalled();
    expect(mockFileLedger.recordAutoExpandSuccess).toHaveBeenCalled();
    expect(mockFileLedger.recordCreation).toHaveBeenCalledWith('/workspace/newfile.txt');
    expect(result.text).toContain('Wrote /workspace/newfile.txt');
  });

  it('blocks write when auto-expand succeeds but file is still partially read', async () => {
    // Both guard checks fail (file too large, truncated)
    mockFileLedger.checkWriteAllowed.mockReturnValue({
      allowed: false,
      reason: 'File "large.txt" was only partially read.',
    });

    // Auto-read succeeds but is truncated
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'partial content...',
      version: 'v1',
      truncated: true,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/large.txt', content: 'new content' } },
      'sb-123',
    );

    expect(mockFileLedger.recordAutoExpandAttempt).toHaveBeenCalled();
    expect(mockFileLedger.recordRead).toHaveBeenCalled();
    expect(result.text).toContain('Edit guard');
    expect(result.text).toContain('too large to fully load');
  });

  it('treats empty file content as valid during auto-expand', async () => {
    // First guard check fails
    mockFileLedger.checkWriteAllowed
      .mockReturnValueOnce({
        allowed: false,
        reason: 'File "empty.txt" has not been read yet.',
      })
      // Second check (after auto-expand) succeeds
      .mockReturnValueOnce({ allowed: true });

    // Auto-read succeeds with empty content
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: '',
      version: 'v1',
      truncated: false,
    });

    vi.mocked(sandboxClient.writeToSandbox).mockResolvedValue({
      ok: true,
      version: 'v2',
    });

    // Mock git status check
    vi.mocked(sandboxClient.execInSandbox).mockResolvedValue({
      stdout: 'M empty.txt',
      stderr: '',
      exitCode: 0,
    });

    const result = await executeSandboxToolCall(
      { tool: 'sandbox_write_file', args: { path: '/workspace/empty.txt', content: 'new content' } },
      'sb-123',
    );

    expect(mockFileLedger.recordAutoExpandSuccess).toHaveBeenCalled();
    expect(result.text).toContain('Wrote /workspace/empty.txt');
  });
});

// ---------------------------------------------------------------------------
// 9. Signature Extraction Tests
// ---------------------------------------------------------------------------

describe('extractSignatures', () => {
  it('extracts JavaScript function signatures', () => {
    const content = `
      export function foo() {}
      async function bar() {}
      function baz() {}
    `;
    const result = extractSignatures(content);
    expect(result).toContain('function foo');
    expect(result).toContain('function bar');
    expect(result).toContain('function baz');
  });

  it('extracts TypeScript class and interface signatures', () => {
    const content = `
      export class MyClass {}
      interface IFoo {}
      export type Alias = string;
    `;
    const result = extractSignatures(content);
    expect(result).toContain('class MyClass');
    expect(result).toContain('interface IFoo');
    expect(result).toContain('type Alias');
  });

  it('extracts Python function and class signatures', () => {
    const content = `
      def hello():
          pass
      class MyPyClass:
          pass
    `;
    const result = extractSignatures(content);
    expect(result).toContain('def hello');
    expect(result).toContain('class MyPyClass');
  });

  it('deduplicates signatures using a Set', () => {
    const content = `
      function foo() {}
      function foo() {}
      function bar() {}
    `;
    const result = extractSignatures(content);
    expect(result).toBeDefined();
    // Count occurrences of 'function foo' in result - should only appear once
    const matches = result?.match(/function foo/g);
    expect(matches).toHaveLength(1);
  });

  it('returns null when no signatures are found', () => {
    const content = 'const x = 1; const y = 2;';
    const result = extractSignatures(content);
    expect(result).toBeNull();
  });

  it('caps output at 8 signatures', () => {
    const content = `
      function a() {}
      function b() {}
      function c() {}
      function d() {}
      function e() {}
      function f() {}
      function g() {}
      function h() {}
      function i() {}
      function j() {}
    `;
    const result = extractSignatures(content);
    expect(result).toContain('+2 more');
  });
});

// ---------------------------------------------------------------------------
// 10. Read File Tests -- Range Read Recording
// ---------------------------------------------------------------------------

describe('sandbox_read_file -- File Awareness Ledger Recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileLedger.recordRead.mockReset();
  });

  it('records full file read when no range is specified', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'line 1\nline 2\nline 3',
      version: 'v1',
      truncated: false,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/test.txt' } },
      'sb-123',
    );

    expect(mockFileLedger.recordRead).toHaveBeenCalledWith('/workspace/test.txt', {
      startLine: undefined,
      endLine: undefined,
      truncated: false,
      totalLines: 3,
    });
  });

  it('records open-ended range starting at line 1 as full read when not truncated', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'line 1\nline 2\nline 3',
      version: 'v1',
      truncated: false,
      start_line: 1,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/test.txt', start_line: 1 } },
      'sb-123',
    );

    // Should record as full read (no startLine/endLine) since start=1 and not truncated
    expect(mockFileLedger.recordRead).toHaveBeenCalledWith('/workspace/test.txt', {
      startLine: undefined,
      endLine: undefined,
      truncated: false,
      totalLines: 3,
    });
  });

  it('records open-ended range starting at line 1 as partial read when truncated', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'line 1\nline 2\nline 3',
      version: 'v1',
      truncated: true,
      start_line: 1,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/test.txt', start_line: 1 } },
      'sb-123',
    );

    // Should record as partial read since truncated
    expect(mockFileLedger.recordRead).toHaveBeenCalledWith('/workspace/test.txt', {
      startLine: 1,
      endLine: 3,
      truncated: true,
      totalLines: 3,
    });
  });

  it('records specific line range as partial read', async () => {
    vi.mocked(sandboxClient.readFromSandbox).mockResolvedValue({
      content: 'line 10\nline 11\nline 12',
      version: 'v1',
      truncated: false,
      start_line: 10,
      end_line: 12,
    });

    await executeSandboxToolCall(
      { tool: 'sandbox_read_file', args: { path: '/workspace/test.txt', start_line: 10, end_line: 12 } },
      'sb-123',
    );

    expect(mockFileLedger.recordRead).toHaveBeenCalledWith('/workspace/test.txt', {
      startLine: 10,
      endLine: 12,
      truncated: false,
      totalLines: 3,
    });
  });
});
