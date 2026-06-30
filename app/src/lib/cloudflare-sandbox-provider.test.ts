import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudflareSandboxProvider, mapCfErrorCode } from './cloudflare-sandbox-provider';

describe('mapCfErrorCode', () => {
  it('maps 413 / SNAPSHOT_TOO_LARGE to a distinct code (not UNKNOWN)', () => {
    // The whole point of the graceful guard: callers can special-case "too
    // large" instead of seeing a generic failure.
    expect(mapCfErrorCode('SNAPSHOT_TOO_LARGE', 413)).toBe('SNAPSHOT_TOO_LARGE');
    // The HTTP status alone is enough, even without the body code.
    expect(mapCfErrorCode(undefined, 413)).toBe('SNAPSHOT_TOO_LARGE');
  });

  it('preserves the existing status/code mappings', () => {
    expect(mapCfErrorCode(undefined, 503)).toBe('NOT_CONFIGURED');
    expect(mapCfErrorCode(undefined, 501)).toBe('SNAPSHOT_FAILED');
    expect(mapCfErrorCode(undefined, 404)).toBe('NOT_FOUND');
    expect(mapCfErrorCode(undefined, 403)).toBe('AUTH_FAILURE');
    expect(mapCfErrorCode('TIMEOUT', 500)).toBe('TIMEOUT');
    expect(mapCfErrorCode('SNAPSHOT_NOT_SUPPORTED', 500)).toBe('SNAPSHOT_FAILED');
  });

  it('falls back to UNKNOWN for unrecognized codes', () => {
    expect(mapCfErrorCode('SOMETHING_NEW', 500)).toBe('UNKNOWN');
    expect(mapCfErrorCode(undefined, 500)).toBe('UNKNOWN');
  });
});

describe('CloudflareSandboxProvider background execution', () => {
  function stubFetch(responseBody: unknown, ok = true, status = 200) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return {
        ok,
        status,
        text: async () => JSON.stringify(responseBody),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advertises the backgroundExec capability', () => {
    const provider = new CloudflareSandboxProvider();
    expect(provider.capabilities.backgroundExec).toBe(true);
  });

  it('includes the repo default branch in create requests', async () => {
    const calls = stubFetch({
      sandbox_id: 'sb-cf',
      owner_token: 'owner-token',
      status: 'ready',
    });
    const provider = new CloudflareSandboxProvider();

    const session = await provider.create({
      repo: 'owner/repo',
      branch: 'develop',
      defaultBranch: 'develop',
    });

    expect(session.sandboxId).toBe('sb-cf');
    expect(calls[0].url).toContain('/api/sandbox-cf/create');
    expect(calls[0].body).toMatchObject({
      repo: 'owner/repo',
      branch: 'develop',
      default_branch: 'develop',
    });
  });

  it('execBackground posts exec-start and maps the handle', async () => {
    const calls = stubFetch({
      process_id: 'proc_9',
      status: 'running',
      running: true,
      started_at: '2026-06-04T02:00:00.000Z',
    });
    const provider = new CloudflareSandboxProvider();

    const handle = await provider.execBackground('sb1', 'npm install', {
      workdir: '/workspace',
      timeoutMs: 600_000,
    });

    expect(handle).toEqual({
      processId: 'proc_9',
      status: 'running',
      running: true,
      startedAt: '2026-06-04T02:00:00.000Z',
    });
    expect(calls[0].url).toContain('/api/sandbox-cf/exec-start');
    expect(calls[0].body).toMatchObject({
      sandbox_id: 'sb1',
      command: 'npm install',
      workdir: '/workspace',
      timeout_ms: 600_000,
    });
  });

  it('execStatus maps snake_case status fields', async () => {
    stubFetch({
      process_id: 'proc_9',
      status: 'completed',
      running: false,
      exit_code: 0,
      started_at: '2026-06-04T02:00:00.000Z',
      ended_at: '2026-06-04T02:00:30.000Z',
    });
    const provider = new CloudflareSandboxProvider();

    const status = await provider.execStatus('sb1', 'proc_9');

    expect(status).toEqual({
      processId: 'proc_9',
      status: 'completed',
      running: false,
      exitCode: 0,
      startedAt: '2026-06-04T02:00:00.000Z',
      endedAt: '2026-06-04T02:00:30.000Z',
    });
  });

  it('execLogs forwards cursors and maps the resumable slice', async () => {
    const calls = stubFetch({
      process_id: 'proc_9',
      stdout: 'tail\n',
      stderr: '',
      next_cursor_stdout: 42,
      next_cursor_stderr: 0,
      truncated: false,
    });
    const provider = new CloudflareSandboxProvider();

    const logs = await provider.execLogs('sb1', 'proc_9', { cursorStdout: 37 });

    expect(logs).toEqual({
      processId: 'proc_9',
      stdout: 'tail\n',
      stderr: '',
      nextCursorStdout: 42,
      nextCursorStderr: 0,
      truncated: false,
    });
    expect(calls[0].body).toMatchObject({ process_id: 'proc_9', cursor_stdout: 37 });
  });

  it('execInterrupt posts exec-kill with the signal', async () => {
    const calls = stubFetch({ ok: true });
    const provider = new CloudflareSandboxProvider();

    await provider.execInterrupt('sb1', 'proc_9', 'SIGTERM');

    expect(calls[0].url).toContain('/api/sandbox-cf/exec-kill');
    expect(calls[0].body).toMatchObject({ process_id: 'proc_9', signal: 'SIGTERM' });
  });
});
