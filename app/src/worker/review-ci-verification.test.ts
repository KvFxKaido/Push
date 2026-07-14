import { describe, expect, it, vi } from 'vitest';
import type { CheckRunForSha } from '../lib/github-tools';
import { fetchReviewCiVerification } from './review-ci-verification';

const SELF_APP_ID = 2801157; // push-agent
const SELF_CHECK_RUN_ID = 999;

/** The reviewer's own `Push review` check, in_progress on the head SHA for the
 *  entire review — present on every real review that publishes a visible check. */
const SELF: CheckRunForSha = {
  id: SELF_CHECK_RUN_ID,
  name: 'Push review',
  status: 'in_progress',
  conclusion: null,
  appId: SELF_APP_ID,
};

const check = (over: Partial<CheckRunForSha> & { name: string }): CheckRunForSha => ({
  id: Math.abs(over.name.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 100000,
  status: 'completed',
  conclusion: 'success',
  appId: 111,
  ...over,
});

function run(
  runs: CheckRunForSha[] | null | Array<CheckRunForSha[] | null>,
  over: Partial<Parameters<typeof fetchReviewCiVerification>[0]> = {},
) {
  const pages =
    Array.isArray(runs) && Array.isArray(runs[0]) ? (runs as Array<CheckRunForSha[]>) : null;
  let call = 0;
  const fetchCheckRuns = vi.fn(async () => {
    if (pages) return pages[Math.min(call++, pages.length - 1)];
    return runs as CheckRunForSha[] | null;
  });
  return {
    fetchCheckRuns,
    result: fetchReviewCiVerification({
      repoFullName: 'octo/repo',
      headSha: 'sha1',
      token: 't',
      selfCheckRunId: SELF_CHECK_RUN_ID,
      selfAppId: SELF_APP_ID,
      deliveryId: 'd1',
      sleep: async () => {},
      fetchCheckRuns: fetchCheckRuns as never,
      ...over,
    }),
  };
}

describe('fetchReviewCiVerification — self-exclusion', () => {
  it('does NOT wait on its own in-progress check run (Codex, PR #1469)', async () => {
    // The deadlock this design was reviewed into existence to avoid. `runReview`
    // opens the "Push review" check BEFORE the executor starts, so the reviewer is
    // itself a check run on the head SHA, in_progress for the whole review. A
    // verifier that waited for "all check runs" would wait for ITSELF, block to the
    // deadline, and report `blocked` on every review that publishes a check — and
    // the failure would look exactly like the sandbox failure §9a exists to fix.
    const { result } = run([SELF, check({ name: 'Test (cli)', conclusion: 'success' })]);
    await expect(result).resolves.toMatchObject({ ci: 'pass' });
  });

  it('excludes a SECOND check from our own app (a rerun or superseded attempt)', async () => {
    // `selfCheckRunId` names one run. A relaunch can leave another `push-agent`
    // check on the same SHA that the id does not name — hence the app-id filter.
    const stale: CheckRunForSha = {
      id: 1234,
      name: 'Push review',
      status: 'in_progress',
      conclusion: null,
      appId: SELF_APP_ID,
    };
    const { result } = run([SELF, stale, check({ name: 'Test (cli)' })]);
    await expect(result).resolves.toMatchObject({ ci: 'pass' });
  });

  it('never excludes by NAME — a repo can mint a check that collides with ours', async () => {
    // REVIEW_CHECK_NAME is user-visible text. A repo check called "Push review"
    // belongs to a DIFFERENT app, is a real signal, and must count.
    const impostor = check({ name: 'Push review', appId: 42, conclusion: 'failure' });
    const { result } = run([SELF, impostor]);
    await expect(result).resolves.toMatchObject({ ci: 'fail' });
  });

  it('reports unavailable when OUR check is the only one on the commit', async () => {
    // Not `blocked` — nothing was ever going to produce a verdict for us to read.
    const { fetchCheckRuns, result } = run([SELF]);
    await expect(result).resolves.toMatchObject({ ci: 'unavailable' });
    expect(fetchCheckRuns).toHaveBeenCalledTimes(2);
  });

  it('does not race an asynchronously registered CI check into unavailable', async () => {
    const { result } = run([
      [SELF],
      [SELF, check({ name: 'Test (cli)', status: 'in_progress', conclusion: null })],
      [SELF, check({ name: 'Test (cli)', conclusion: 'success' })],
    ] as never);
    await expect(result).resolves.toMatchObject({ ci: 'pass' });
  });
});

describe('fetchReviewCiVerification — aggregation', () => {
  it('fails on any failing conclusion, and names the failed checks', async () => {
    const { result } = run([
      check({ name: 'Lint', conclusion: 'success' }),
      check({ name: 'Test (cli)', conclusion: 'failure' }),
    ]);
    const v = await result;
    expect(v.ci).toBe('fail');
    expect(v.checks?.map((c) => c.name)).toContain('Test (cli)');
  });

  it.each(['failure', 'timed_out', 'action_required'])('treats %s as a failure', async (c) => {
    const { result } = run([check({ name: 'X', conclusion: c })]);
    await expect(result).resolves.toMatchObject({ ci: 'fail' });
  });

  it('short-circuits a failure without waiting out the still-running checks', async () => {
    // Waiting could not change the verdict — the reviewer would burn its whole
    // deadline to arrive at the same `fail`.
    const { fetchCheckRuns, result } = run([
      check({ name: 'Test (cli)', conclusion: 'failure' }),
      check({ name: 'Slow', status: 'in_progress', conclusion: null }),
    ]);
    await expect(result).resolves.toMatchObject({ ci: 'fail' });
    expect(fetchCheckRuns).toHaveBeenCalledTimes(1);
  });

  it('does NOT count skipped/cancelled as a pass', async () => {
    // A repo that cancels CI must not launder a green verification. Nothing here
    // verified anything, so saying `pass` would be a lie.
    const { result } = run([
      check({ name: 'A', conclusion: 'skipped' }),
      check({ name: 'B', conclusion: 'cancelled' }),
    ]);
    const v = await result;
    expect(v.ci).toBe('blocked');
    expect(v.blockedReason).toContain('without a decisive conclusion');
  });

  it('passes when a decisive success sits beside a neutral/skipped check', async () => {
    const { result } = run([
      check({ name: 'Test (cli)', conclusion: 'success' }),
      check({ name: 'Optional', conclusion: 'skipped' }),
    ]);
    await expect(result).resolves.toMatchObject({ ci: 'pass' });
  });
});

describe('fetchReviewCiVerification — polling and terminal conditions', () => {
  it('polls while CI is in flight, then passes once it lands', async () => {
    const { fetchCheckRuns, result } = run([
      [check({ name: 'Test (cli)', status: 'in_progress', conclusion: null })],
      [check({ name: 'Test (cli)', status: 'completed', conclusion: 'success' })],
    ] as never);
    await expect(result).resolves.toMatchObject({ ci: 'pass' });
    expect(fetchCheckRuns).toHaveBeenCalledTimes(2);
  });

  it('blocks if previously observed CI disappears during polling', async () => {
    const { result } = run([
      [check({ name: 'Test (cli)', status: 'in_progress', conclusion: null })],
      [],
    ] as never);
    const v = await result;
    expect(v.ci).toBe('blocked');
    expect(v.blockedReason).toContain('disappeared');
    expect(v.checks?.map((c) => c.name)).toContain('Test (cli)');
  });

  it('blocks at the deadline rather than waiting for CI forever', async () => {
    // CI can queue behind a busy runner pool for longer than a review lives.
    let t = 0;
    const { result } = run([check({ name: 'Test (cli)', status: 'queued', conclusion: null })], {
      now: () => (t += 40_000),
      deadlineMs: 100_000,
    });
    const v = await result;
    expect(v.ci).toBe('blocked');
    expect(v.blockedReason).toContain('Test (cli)');
  });

  it('blocks (never throws, never fabricates a verdict) when GitHub is unreadable', async () => {
    const { result } = run(null);
    const v = await result;
    expect(v.ci).toBe('blocked');
    expect(v.blockedReason).toContain('could not read');
  });

  it('blocks when the check-run reader rejects unexpectedly', async () => {
    const fetchCheckRuns = vi.fn(async () => {
      throw new Error('transport down');
    });
    const v = await fetchReviewCiVerification({
      repoFullName: 'octo/repo',
      headSha: 'sha1',
      token: 't',
      selfCheckRunId: SELF_CHECK_RUN_ID,
      selfAppId: SELF_APP_ID,
      deliveryId: 'd1',
      fetchCheckRuns,
    });
    expect(v.ci).toBe('blocked');
    expect(v.blockedReason).toContain('could not read');
  });

  it('exits the poll loop on abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = run(
      [check({ name: 'Test (cli)', status: 'in_progress', conclusion: null })],
      {
        signal: ac.signal,
      },
    );
    await expect(result).resolves.toMatchObject({ ci: 'blocked' });
  });

  it('observes an abort that lands while the GitHub request is in flight', async () => {
    const ac = new AbortController();
    const fetchCheckRuns = vi.fn(async () => {
      ac.abort();
      return [check({ name: 'Test (cli)', conclusion: 'success' })];
    });
    const v = await fetchReviewCiVerification({
      repoFullName: 'octo/repo',
      headSha: 'sha1',
      token: 't',
      selfCheckRunId: SELF_CHECK_RUN_ID,
      selfAppId: SELF_APP_ID,
      deliveryId: 'd1',
      signal: ac.signal,
      fetchCheckRuns,
    });
    expect(v.ci).toBe('blocked');
    expect(v.blockedReason).toContain('aborted');
  });
});
