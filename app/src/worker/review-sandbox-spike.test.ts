import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './worker-middleware';

// Mock the sandbox module wholesale so the test never loads the CF Sandbox SDK;
// the spike only depends on `dispatchSandboxRouteInternal`.
vi.mock('./worker-cf-sandbox', () => ({
  dispatchSandboxRouteInternal: vi.fn(),
}));

import { dispatchSandboxRouteInternal } from './worker-cf-sandbox';
import { runReviewSandboxReachabilitySpike } from './review-sandbox-spike';

const dispatchMock = vi.mocked(dispatchSandboxRouteInternal);

function captureLogs() {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* non-JSON log, ignore */
      }
    }
  });
  return events;
}

const INPUT = {
  env: {} as Env,
  repoFullName: 'acme/widget',
  headRef: 'feature/x',
  githubToken: 'ghs_tok',
  isCrossFork: false,
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('runReviewSandboxReachabilitySpike', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs create -> exec -> cleanup via the internal entry and reports checkoutLanded', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonResponse(200, { sandbox_id: 'sb_1', owner_token: 'ot_1' }))
      .mockResolvedValueOnce(jsonResponse(200, { exit_code: 0, stdout: '/workspace/a.ts\n' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const events = captureLogs();
    await runReviewSandboxReachabilitySpike(INPUT);

    expect(dispatchMock.mock.calls.map((c) => c[1])).toEqual(['create', 'exec', 'cleanup']);
    expect(dispatchMock.mock.calls[0][2]).toMatchObject({
      repo: 'acme/widget',
      branch: 'feature/x',
      github_token: 'ghs_tok',
    });
    // exec + cleanup present the minted owner token.
    expect(dispatchMock.mock.calls[1][2]).toMatchObject({
      sandbox_id: 'sb_1',
      owner_token: 'ot_1',
    });
    expect(dispatchMock.mock.calls[2][2]).toMatchObject({
      sandbox_id: 'sb_1',
      owner_token: 'ot_1',
    });

    expect(events.find((e) => e.event === 'review_sandbox_spike_done')).toMatchObject({
      reachable: true,
      createOk: true,
      searchOk: true,
      checkoutLanded: true,
      cleanupOk: true,
    });
  });

  it('reports checkoutLanded:false when the grep finds nothing (empty workspace / cross-fork)', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonResponse(200, { sandbox_id: 'sb_1', owner_token: 'ot_1' }))
      // exec succeeds (exit 0 via `|| true`) but stdout is empty — nothing checked out.
      .mockResolvedValueOnce(jsonResponse(200, { exit_code: 0, stdout: '' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const events = captureLogs();
    await runReviewSandboxReachabilitySpike({ ...INPUT, isCrossFork: true });

    // The HTTP/transport leg is fine, but the headline signal correctly says the
    // checkout did not land — which is the whole point of the cross-fork unknown.
    expect(events.find((e) => e.event === 'review_sandbox_spike_done')).toMatchObject({
      searchOk: true,
      checkoutLanded: false,
      isCrossFork: true,
    });
  });

  it('stops after a failed create and never provisions exec/cleanup', async () => {
    dispatchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'CF_NOT_CONFIGURED' }));

    const events = captureLogs();
    await runReviewSandboxReachabilitySpike(INPUT);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.event === 'review_sandbox_spike_done')).toMatchObject({
      reachable: false,
      checkoutLanded: false,
    });
  });

  it('still tears down the sandbox when the search leg throws', async () => {
    dispatchMock
      .mockResolvedValueOnce(jsonResponse(200, { sandbox_id: 'sb_1', owner_token: 'ot_1' }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const events = captureLogs();
    await runReviewSandboxReachabilitySpike(INPUT);

    expect(dispatchMock.mock.calls.map((c) => c[1])).toEqual(['create', 'exec', 'cleanup']);
    expect(events.find((e) => e.event === 'review_sandbox_spike_done')).toMatchObject({
      createOk: true,
      searchOk: false,
      cleanupOk: true,
    });
  });

  it('never throws even when create rejects outright', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('binding missing'));
    const events = captureLogs();
    await expect(runReviewSandboxReachabilitySpike(INPUT)).resolves.toBeUndefined();
    expect(events.find((e) => e.event === 'review_sandbox_spike_create')).toMatchObject({
      ok: false,
    });
  });
});
