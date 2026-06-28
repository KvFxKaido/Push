import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewSandboxReachabilitySpike } from './review-sandbox-spike';

// Captures the structured log lines the spike emits so we can assert on the
// per-leg events without a real sandbox.
function captureLogs() {
  const events: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string') {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* non-JSON log, ignore */
      }
    }
  });
  return { events, spy };
}

const INPUT = {
  origin: 'https://push.example',
  repoFullName: 'acme/widget',
  headRef: 'feature/x',
  githubToken: 'ghs_tok',
  isCrossFork: false,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runReviewSandboxReachabilitySpike', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs create -> exec -> cleanup against absolute-origin routes and reports reachable', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { sandbox_id: 'sb_1', owner_token: 'ot_1' }))
      .mockResolvedValueOnce(jsonResponse(200, { exit_code: 0, stdout: '/workspace/a.ts\n' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { events } = captureLogs();
    await runReviewSandboxReachabilitySpike(INPUT);

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      'https://push.example/api/sandbox-cf/create',
      'https://push.example/api/sandbox-cf/exec',
      'https://push.example/api/sandbox-cf/cleanup',
    ]);

    // Create body carries the head ref + installation token.
    const createBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(createBody).toMatchObject({
      repo: 'acme/widget',
      branch: 'feature/x',
      github_token: 'ghs_tok',
    });
    // Exec + cleanup present the minted owner token.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({
      sandbox_id: 'sb_1',
      owner_token: 'ot_1',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toMatchObject({
      sandbox_id: 'sb_1',
      owner_token: 'ot_1',
    });

    const done = events.find((e) => e.event === 'review_sandbox_spike_done');
    expect(done).toMatchObject({
      reachable: true,
      createOk: true,
      searchOk: true,
      cleanupOk: true,
    });
  });

  it('stops after a failed create and never provisions exec/cleanup', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }));

    const { events } = captureLogs();
    await runReviewSandboxReachabilitySpike(INPUT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.event === 'review_sandbox_spike_create')).toMatchObject({
      ok: false,
      httpStatus: 403,
    });
    expect(events.find((e) => e.event === 'review_sandbox_spike_done')).toMatchObject({
      reachable: false,
      searchOk: false,
    });
  });

  it('still tears down the sandbox when the search leg fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { sandbox_id: 'sb_1', owner_token: 'ot_1' }))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const { events } = captureLogs();
    await runReviewSandboxReachabilitySpike(INPUT);

    // create, exec (rejected), cleanup — cleanup must still run.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://push.example/api/sandbox-cf/create',
      'https://push.example/api/sandbox-cf/exec',
      'https://push.example/api/sandbox-cf/cleanup',
    ]);
    expect(events.find((e) => e.event === 'review_sandbox_spike_done')).toMatchObject({
      createOk: true,
      searchOk: false,
      cleanupOk: true,
    });
  });

  it('never throws even when the create fetch rejects outright', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { events } = captureLogs();
    await expect(runReviewSandboxReachabilitySpike(INPUT)).resolves.toBeUndefined();
    expect(events.find((e) => e.event === 'review_sandbox_spike_create')).toMatchObject({
      ok: false,
    });
  });
});
