import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./github-auth', () => ({
  getGitHubAuthHeaders: vi.fn(() => ({ Authorization: 'Bearer TEST_TOKEN' })),
}));

vi.mock('./sensitive-data-guard', () => ({
  formatSensitivePathToolError: vi.fn((path: string) => `sensitive:${path}`),
  isSensitivePath: vi.fn(() => false),
  redactSensitiveText: vi.fn((text: string) => text),
}));

const getGitHubToolBackendMock = vi.fn();
const executeGitHubToolViaWorkerMock = vi.fn();
const fetchRepoBranchesViaWorkerMock = vi.fn();
const supportsWorkerGitHubToolMock = vi.fn();

vi.mock('./github-tool-transport', () => ({
  getGitHubToolBackend: () => getGitHubToolBackendMock(),
  executeGitHubToolViaWorker: (...args: unknown[]) => executeGitHubToolViaWorkerMock(...args),
  fetchRepoBranchesViaWorker: (...args: unknown[]) => fetchRepoBranchesViaWorkerMock(...args),
  supportsWorkerGitHubTool: (name: string) => supportsWorkerGitHubToolMock(name),
}));

const executeGitHubCoreToolMock = vi.fn();
const fetchRepoBranchesDataMock = vi.fn();

vi.mock('@push/lib/github-tool-core', () => ({
  executeGitHubCoreTool: (...args: unknown[]) => executeGitHubCoreToolMock(...args),
  fetchRepoBranchesData: (...args: unknown[]) => fetchRepoBranchesDataMock(...args),
}));

import {
  decodeGitHubBase64Utf8,
  executeGitHubToolWithFallback,
  executeToolCall,
  fetchRepoBranches,
  githubFetch,
} from './github-tool-executor';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useRealTimers();
  getGitHubToolBackendMock.mockReturnValue('legacy');
  executeGitHubToolViaWorkerMock.mockReset();
  fetchRepoBranchesViaWorkerMock.mockReset();
  supportsWorkerGitHubToolMock
    .mockReset()
    .mockImplementation((name: string) =>
      [
        'fetch_pr',
        'list_prs',
        'list_commits',
        'read_file',
        'grep_file',
        'list_directory',
        'list_branches',
      ].includes(name),
    );
  executeGitHubCoreToolMock.mockReset();
  fetchRepoBranchesDataMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// decodeGitHubBase64Utf8
// ---------------------------------------------------------------------------

describe('decodeGitHubBase64Utf8', () => {
  it('decodes a UTF-8 base64 payload (matching GitHub content API)', () => {
    // "Hello, 世界" encoded as base64.
    const encoded = Buffer.from('Hello, 世界', 'utf8').toString('base64');
    expect(decodeGitHubBase64Utf8(encoded)).toBe('Hello, 世界');
  });

  it('ignores line wrapping (GitHub splits base64 at 60 chars)', () => {
    const wrapped = Buffer.from('a'.repeat(120), 'utf8').toString('base64');
    const withBreaks = `${wrapped.slice(0, 40)}\n${wrapped.slice(40)}`;
    expect(decodeGitHubBase64Utf8(withBreaks)).toBe('a'.repeat(120));
  });
});

// ---------------------------------------------------------------------------
// githubFetch (retry/backoff wrapper)
// ---------------------------------------------------------------------------

describe('githubFetch — retry/backoff', () => {
  // githubFetch logs rate-limit/retry diagnostics via console.log; silence
  // them so the vitest output only surfaces real failures.
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a successful response without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await githubFetch('https://api.github.com/foo');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-retryable 4xx (e.g. 404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await githubFetch('https://api.github.com/foo');
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 until it succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const promise = githubFetch('https://api.github.com/foo');
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on 429', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const promise = githubFetch('https://api.github.com/foo');
    // Retry-After says 2 → 2 + 1s buffer = 3s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_200);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('wraps a timed-out fetch in a helpful Error message', async () => {
    vi.useFakeTimers();
    const abortError = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);
    const promise = githubFetch('https://api.github.com/foo').catch((err) => err);
    await vi.runAllTimersAsync();
    const err = (await promise) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/GitHub API timed out after/);
  });
});

// ---------------------------------------------------------------------------
// fetchRepoBranches — Worker vs local fallback
// ---------------------------------------------------------------------------

describe('fetchRepoBranches', () => {
  it('uses the Worker transport when the backend is "worker"', async () => {
    getGitHubToolBackendMock.mockReturnValue('worker');
    fetchRepoBranchesViaWorkerMock.mockResolvedValue({
      defaultBranch: 'main',
      branches: [{ name: 'main', protected: false }],
    });
    const result = await fetchRepoBranches('owner/repo', 50);
    expect(fetchRepoBranchesViaWorkerMock).toHaveBeenCalledWith('owner/repo', 50);
    expect(result.defaultBranch).toBe('main');
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].name).toBe('main');
    expect(fetchRepoBranchesDataMock).not.toHaveBeenCalled();
  });

  it('falls back to the local runtime when the Worker throws', async () => {
    getGitHubToolBackendMock.mockReturnValue('worker');
    fetchRepoBranchesViaWorkerMock.mockRejectedValue(new Error('worker down'));
    fetchRepoBranchesDataMock.mockResolvedValue({
      defaultBranch: 'main',
      branches: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fetchRepoBranches('owner/repo');
    expect(fetchRepoBranchesDataMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('list_branches'), 'worker down');
    warn.mockRestore();
  });

  it('goes straight to local when the backend is legacy', async () => {
    fetchRepoBranchesDataMock.mockResolvedValue({ defaultBranch: 'main', branches: [] });
    await fetchRepoBranches('owner/repo', 25);
    expect(fetchRepoBranchesDataMock).toHaveBeenCalledTimes(1);
    expect(fetchRepoBranchesViaWorkerMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeGitHubToolWithFallback
// ---------------------------------------------------------------------------

describe('executeGitHubToolWithFallback', () => {
  const baseCall = { tool: 'fetch_pr', args: { repo: 'owner/repo', number: 1 } } as never;

  it('returns the Worker result on success', async () => {
    getGitHubToolBackendMock.mockReturnValue('worker');
    executeGitHubToolViaWorkerMock.mockResolvedValue({ text: 'worker-result' });
    const result = await executeGitHubToolWithFallback(baseCall, 'owner/repo');
    expect(result).toEqual({ text: 'worker-result' });
    expect(executeGitHubCoreToolMock).not.toHaveBeenCalled();
  });

  it('falls back to the local runtime when the Worker throws', async () => {
    getGitHubToolBackendMock.mockReturnValue('worker');
    executeGitHubToolViaWorkerMock.mockRejectedValue(new Error('worker down'));
    executeGitHubCoreToolMock.mockResolvedValue({ text: 'local-result' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await executeGitHubToolWithFallback(baseCall, 'owner/repo');
    expect(result).toEqual({ text: 'local-result' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('uses the local runtime when the backend is legacy', async () => {
    executeGitHubCoreToolMock.mockResolvedValue({ text: 'local' });
    const result = await executeGitHubToolWithFallback(baseCall, 'owner/repo');
    expect(result).toEqual({ text: 'local' });
    expect(executeGitHubToolViaWorkerMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeToolCall — top-level dispatch
// ---------------------------------------------------------------------------

describe('executeToolCall — dispatch', () => {
  it('routes delegate_coder / delegate_explorer to the tool-dispatch layer', async () => {
    const result = await executeToolCall(
      { tool: 'delegate_coder', args: { repo: 'owner/repo' } } as never,
      'owner/repo',
    );
    expect(result.text).toContain('Handled by tool-dispatch layer');
  });

  it('rejects calls whose repo mismatches the allowed repo', async () => {
    const result = await executeToolCall(
      { tool: 'fetch_pr', args: { repo: 'other/repo' } } as never,
      'owner/repo',
    );
    expect(result.text).toContain('Access denied');
  });

  it('normalizes the repo arg (strips github.com URL and .git suffix)', async () => {
    executeGitHubCoreToolMock.mockResolvedValue({ text: 'ok' });
    await executeToolCall(
      { tool: 'fetch_pr', args: { repo: 'https://github.com/Owner/Repo.git' } } as never,
      'owner/repo',
    );
    expect(executeGitHubCoreToolMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces an Unknown-tool error when the call is not worker-supported', async () => {
    supportsWorkerGitHubToolMock.mockReturnValue(false);
    const result = await executeToolCall(
      { tool: 'not_a_tool', args: { repo: 'owner/repo' } } as never,
      'owner/repo',
    );
    expect(result.text).toContain('Unknown tool');
  });

  it('wraps thrown errors from the local runtime in a [Tool Error] message', async () => {
    executeGitHubCoreToolMock.mockRejectedValue(new Error('kaboom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await executeToolCall(
      { tool: 'fetch_pr', args: { repo: 'owner/repo' } } as never,
      'owner/repo',
    );
    expect(result.text).toBe('[Tool Error] kaboom');
    err.mockRestore();
  });

  it('prefers the Worker when the backend is "worker" and the tool is supported', async () => {
    getGitHubToolBackendMock.mockReturnValue('worker');
    executeGitHubToolViaWorkerMock.mockResolvedValue({ text: 'via-worker' });
    const result = await executeToolCall(
      { tool: 'fetch_pr', args: { repo: 'owner/repo' } } as never,
      'owner/repo',
    );
    expect(result.text).toBe('via-worker');
    expect(executeGitHubCoreToolMock).not.toHaveBeenCalled();
  });

  it('falls back to the legacy path when the Worker rejects', async () => {
    getGitHubToolBackendMock.mockReturnValue('worker');
    executeGitHubToolViaWorkerMock.mockRejectedValue(new Error('down'));
    executeGitHubCoreToolMock.mockResolvedValue({ text: 'legacy-result' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await executeToolCall(
      { tool: 'fetch_pr', args: { repo: 'owner/repo' } } as never,
      'owner/repo',
    );
    expect(result.text).toBe('legacy-result');
    warn.mockRestore();
  });

  it('denies requests with a missing repo arg even in legacy mode', async () => {
    const result = await executeToolCall({ tool: 'fetch_pr', args: {} } as never, 'owner/repo');
    expect(result.text).toContain('Access denied');
  });
});
