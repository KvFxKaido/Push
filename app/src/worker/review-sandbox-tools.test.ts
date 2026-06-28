import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './worker-middleware';

// Mock the runtime deps that `review-sandbox-tools` dynamically imports. Mocking
// `./worker-cf-sandbox` also keeps the CF Sandbox SDK's `cloudflare:`-scheme
// imports off this test's graph (the reason the module uses dynamic import).
const dispatchMock = vi.fn();
vi.mock('./worker-cf-sandbox', () => ({ dispatchSandboxRouteInternal: dispatchMock }));

const handleSearchMock = vi.fn(async () => ({ text: 'SEARCH_RESULT' }));
const handleReadFileMock = vi.fn(async () => ({ text: 'READ_RESULT' }));
const handleListDirMock = vi.fn(async () => ({ text: 'LS_RESULT' }));
vi.mock('@/lib/sandbox-read-only-inspection-handlers', () => ({
  handleSearch: handleSearchMock,
  handleReadFile: handleReadFileMock,
  handleListDir: handleListDirMock,
}));

import {
  REVIEW_SANDBOX_TOOL_NAMES,
  cleanupReviewSandbox,
  executeReadOnlySandboxTool,
  provisionReviewSandbox,
} from './review-sandbox-tools';

const env = {} as Env;
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  dispatchMock.mockReset();
  handleSearchMock.mockClear();
  handleReadFileMock.mockClear();
  handleListDirMock.mockClear();
});

describe('provisionReviewSandbox', () => {
  it('provisions and returns the sandbox when HEAD matches the reviewed commit', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ sandbox_id: 'sb1', owner_token: 'tok1' })) // create
      .mockResolvedValueOnce(jsonRes({ head_sha: 'abc123' })); // diff (verify)
    const sb = await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok');
    expect(sb).toEqual({ sandboxId: 'sb1', ownerToken: 'tok1' });
    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      env,
      'create',
      expect.objectContaining({ repo: 'owner/repo', branch: 'feature', github_token: 'ghtok' }),
    );
  });

  it('tears down and returns null when HEAD drifted (branch advanced post-webhook)', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ sandbox_id: 'sb1', owner_token: 'tok1' }))
      .mockResolvedValueOnce(jsonRes({ head_sha: 'DIFFERENT' }))
      .mockResolvedValueOnce(jsonRes({ ok: true })); // cleanup
    const sb = await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok');
    expect(sb).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith(env, 'cleanup', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
    });
  });

  it('tears down and returns null on an empty workspace (no head_sha — cross-fork/dead ref)', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonRes({ sandbox_id: 'sb1', owner_token: 'tok1' }))
      .mockResolvedValueOnce(jsonRes({})) // diff: no head_sha
      .mockResolvedValueOnce(jsonRes({ ok: true }));
    expect(
      await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok'),
    ).toBeNull();
    expect(dispatchMock).toHaveBeenCalledWith(env, 'cleanup', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
    });
  });

  it('returns null when create fails (no verify, no throw)', async () => {
    dispatchMock.mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500));
    expect(
      await provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok'),
    ).toBeNull();
    expect(dispatchMock).toHaveBeenCalledTimes(1); // create only
  });

  it('never throws when the route transport throws', async () => {
    dispatchMock.mockRejectedValue(new Error('network down'));
    await expect(
      provisionReviewSandbox(env, 'owner/repo', 'feature', 'abc123', 'ghtok'),
    ).resolves.toBeNull();
  });
});

describe('executeReadOnlySandboxTool', () => {
  const sb = { sandboxId: 'sb1', ownerToken: 'tok1' };

  it('routes search/read/ls to the redacting inspection handlers', async () => {
    expect(
      (
        await executeReadOnlySandboxTool(env, sb, {
          tool: 'sandbox_search',
          args: { query: 'x' },
        } as never)
      ).text,
    ).toBe('SEARCH_RESULT');
    expect(handleSearchMock).toHaveBeenCalledTimes(1);
    expect(
      (
        await executeReadOnlySandboxTool(env, sb, {
          tool: 'sandbox_read_file',
          args: { path: 'a.ts' },
        } as never)
      ).text,
    ).toBe('READ_RESULT');
    expect(handleReadFileMock).toHaveBeenCalledTimes(1);
    expect(
      (await executeReadOnlySandboxTool(env, sb, { tool: 'sandbox_list_dir', args: {} } as never))
        .text,
    ).toBe('LS_RESULT');
    expect(handleListDirMock).toHaveBeenCalledTimes(1);
  });

  it('rejects tools outside the read-only set without touching the sandbox', async () => {
    const r = await executeReadOnlySandboxTool(env, sb, {
      tool: 'sandbox_exec',
      args: { command: 'rm -rf /' },
    } as never);
    expect(r.text).toContain('not available in automated PR review');
    expect(r.text).toContain(REVIEW_SANDBOX_TOOL_NAMES);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(handleSearchMock).not.toHaveBeenCalled();
  });
});

describe('cleanupReviewSandbox', () => {
  it('calls the cleanup route with the owner token', async () => {
    dispatchMock.mockResolvedValue(jsonRes({ ok: true }));
    await cleanupReviewSandbox(env, { sandboxId: 'sb1', ownerToken: 'tok1' });
    expect(dispatchMock).toHaveBeenCalledWith(env, 'cleanup', {
      sandbox_id: 'sb1',
      owner_token: 'tok1',
    });
  });

  it('never throws when cleanup fails', async () => {
    dispatchMock.mockRejectedValue(new Error('gone'));
    await expect(
      cleanupReviewSandbox(env, { sandboxId: 'sb1', ownerToken: 'tok1' }),
    ).resolves.toBeUndefined();
  });
});
