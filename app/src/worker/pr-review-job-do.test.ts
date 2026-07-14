/**
 * Lifecycle tests for the PrReviewJob DO. Hand-rolled in-memory SQL mock covers
 * exactly the queries the DO issues (CoderJob's test does the same). The
 * model/GitHub leaf is replaced via `__setPrReviewExecutorOverride`, so these
 * prove dedupe, coalescing, status, and the event log — not the network path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '@push/lib/provider-contract';
import {
  PrReviewJob,
  __setPrReviewExecutorOverride,
  cleanPassCheckStatus,
  verificationNote,
  repoGatingEnabled,
  type PrReviewExecutor,
  type PrReviewStartInput,
} from './pr-review-job-do';
import type { Env } from './worker-middleware';
import {
  createInProgressReviewCheckRun,
  createReviewCheckRun,
  finalizeReviewCheckRun,
} from '@/lib/github-tools';

// Hand back a fake installation token so the DO's check-run path activates;
// without App creds in env it no-ops (which is what every other test relies on).
vi.mock('./worker-infra', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./worker-infra');
  return {
    ...actual,
    generateGitHubAppJWT: vi.fn(async () => 'jwt'),
    exchangeForInstallationToken: vi.fn(async () => ({ token: 'tok' })),
  };
});

// Spy the check-run GitHub calls (keep the rest of github-tools real). A
// monotonic id lets the superseded vs completed checks be told apart.
const { checkRunIdRef } = vi.hoisted(() => ({ checkRunIdRef: { current: 1 } }));
vi.mock('@/lib/github-tools', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/github-tools');
  return {
    ...actual,
    createInProgressReviewCheckRun: vi.fn(async () => checkRunIdRef.current++),
    finalizeReviewCheckRun: vi.fn(async () => {}),
    createReviewCheckRun: vi.fn(async () => {}),
  };
});

interface ReviewRow {
  delivery_id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  installation_id: string;
  is_cross_fork: number;
  origin: string | null;
  status: string;
  comments_posted: number | null;
  posted: number | null;
  result_json: string | null;
  error_text: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  check_run_id: number | null;
  relaunch_count: number;
  pinned_provider: string | null;
  pinned_model: string | null;
}

function createMockCtx() {
  const reviews = new Map<string, ReviewRow>();
  const checkpoints = new Map<string, { state_json: string; round: number; updated_at: number }>();
  const events: Array<{ seq: number; delivery_id: string; type: string; payload_json: string }> =
    [];
  const pending: Promise<unknown>[] = [];
  let seq = 1;

  function run(sql: string, p: unknown[]): Record<string, unknown>[] {
    if (/^CREATE /i.test(sql) || /^ALTER TABLE/i.test(sql)) return [];
    // ensureColumns() probes for the post-v1 columns; report all present so
    // the mock never has to model ALTER.
    if (/^PRAGMA table_info\(review\)/i.test(sql))
      return [
        { name: 'result_json' },
        { name: 'posted' },
        { name: 'check_run_id' },
        { name: 'origin' },
        { name: 'relaunch_count' },
        { name: 'pinned_provider' },
        { name: 'pinned_model' },
      ];
    if (/^INSERT INTO review_checkpoint/i.test(sql)) {
      checkpoints.set(p[0] as string, {
        state_json: p[1] as string,
        round: p[2] as number,
        updated_at: p[3] as number,
      });
      return [];
    }
    if (/^SELECT state_json, round, updated_at FROM review_checkpoint/i.test(sql)) {
      const c = checkpoints.get(p[0] as string);
      return c ? [{ ...c }] : [];
    }
    if (/^UPDATE review_checkpoint SET updated_at/i.test(sql)) {
      const c = checkpoints.get(p[1] as string);
      if (c) c.updated_at = p[0] as number;
      return [];
    }
    if (/^DELETE FROM review_checkpoint/i.test(sql)) {
      checkpoints.delete(p[0] as string);
      return [];
    }
    if (/^UPDATE review SET relaunch_count = relaunch_count \+ 1/i.test(sql)) {
      const r = reviews.get(p[0] as string);
      if (r) r.relaunch_count += 1;
      return [];
    }
    if (/^SELECT status FROM review WHERE delivery_id/i.test(sql)) {
      const r = reviews.get(p[0] as string);
      return r ? [{ status: r.status }] : [];
    }
    if (/^SELECT \* FROM review ORDER BY created_at DESC/i.test(sql)) {
      return [...reviews.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .map((r) => ({ ...r }));
    }
    if (/^SELECT delivery_id FROM review WHERE pr_number/i.test(sql)) {
      const prNumber = p[0] as number;
      // The same-head (latest-wins) coalescing variant drops the `head_sha != ?`
      // filter; detect it from the SQL and bind params accordingly.
      const filtersHead = /head_sha != \?/i.test(sql);
      const headSha = filtersHead ? (p[1] as string) : undefined;
      return [...reviews.values()]
        .filter(
          (r) =>
            r.pr_number === prNumber &&
            (!filtersHead || r.head_sha !== headSha) &&
            (r.status === 'queued' || r.status === 'running'),
        )
        .map((r) => ({ delivery_id: r.delivery_id }));
    }
    // Cross-review memory: latest posted review excluding the given delivery.
    if (/^SELECT delivery_id, head_sha, finished_at, result_json FROM review/i.test(sql)) {
      return [...reviews.values()]
        .filter(
          (r) =>
            r.status === 'completed' &&
            r.posted === 1 &&
            r.result_json !== null &&
            r.delivery_id !== (p[0] as string),
        )
        .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))
        .slice(0, 1)
        .map((r) => ({
          delivery_id: r.delivery_id,
          head_sha: r.head_sha,
          finished_at: r.finished_at,
          result_json: r.result_json,
        }));
    }
    if (/^SELECT \* FROM review WHERE delivery_id/i.test(sql)) {
      const r = reviews.get(p[0] as string);
      return r ? [{ ...r }] : [];
    }
    if (/^INSERT INTO review/i.test(sql)) {
      const [
        delivery_id,
        repo,
        pr_number,
        head_sha,
        base_ref,
        head_ref,
        installation_id,
        is_cross_fork,
        origin,
        created_at,
        pinned_provider,
        pinned_model,
      ] = p as [
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        number,
        string,
        number,
        string | null,
        string | null,
      ];
      reviews.set(delivery_id, {
        delivery_id,
        repo,
        pr_number,
        head_sha,
        base_ref,
        head_ref,
        installation_id,
        is_cross_fork,
        origin,
        status: 'queued',
        comments_posted: null,
        posted: null,
        result_json: null,
        error_text: null,
        created_at,
        started_at: null,
        finished_at: null,
        check_run_id: null,
        relaunch_count: 0,
        pinned_provider: pinned_provider ?? null,
        pinned_model: pinned_model ?? null,
      });
      return [];
    }
    if (/^INSERT INTO event/i.test(sql)) {
      events.push({
        seq: seq++,
        delivery_id: p[0] as string,
        type: p[2] as string,
        payload_json: p[3] as string,
      });
      return [];
    }
    const setStatus = (deliveryId: string, patch: Partial<ReviewRow>) => {
      const r = reviews.get(deliveryId);
      if (r) Object.assign(r, patch);
    };
    if (/^UPDATE review SET status = 'superseded'/i.test(sql)) {
      setStatus(p[1] as string, { status: 'superseded', finished_at: p[0] as number });
      return [];
    }
    if (/^UPDATE review SET status = 'running'/i.test(sql)) {
      setStatus(p[1] as string, { status: 'running', started_at: p[0] as number });
      return [];
    }
    if (/^UPDATE review SET status = 'completed'/i.test(sql)) {
      setStatus(p[4] as string, {
        status: 'completed',
        comments_posted: p[0] as number,
        posted: p[1] as number,
        result_json: p[2] as string,
        finished_at: p[3] as number,
      });
      return [];
    }
    if (/^UPDATE review SET status = 'failed'/i.test(sql)) {
      setStatus(p[2] as string, {
        status: 'failed',
        error_text: p[0] as string,
        finished_at: p[1] as number,
      });
      return [];
    }
    if (/^UPDATE review SET status = 'cancelled'/i.test(sql)) {
      setStatus(p[1] as string, { status: 'cancelled', finished_at: p[0] as number });
      return [];
    }
    if (/^UPDATE review SET pinned_provider = /i.test(sql)) {
      setStatus(p[2] as string, {
        pinned_provider: p[0] as string,
        pinned_model: p[1] as string,
      });
      return [];
    }
    if (/^UPDATE review SET check_run_id = /i.test(sql)) {
      setStatus(p[1] as string, { check_run_id: p[0] as number });
      return [];
    }
    // Orphan sweep: non-terminal rows.
    if (/^SELECT \* FROM review WHERE status IN \('queued','running'\)/i.test(sql)) {
      return [...reviews.values()]
        .filter((r) => r.status === 'queued' || r.status === 'running')
        .map((r) => ({ ...r }));
    }
    if (/^SELECT delivery_id FROM review WHERE status IN \('queued','running'\)/i.test(sql)) {
      return [...reviews.values()]
        .filter((r) => r.status === 'queued' || r.status === 'running')
        .map((r) => ({ delivery_id: r.delivery_id }));
    }
    throw new Error(`unhandled sql: ${sql}`);
  }

  const alarms: number[] = [];
  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const rows = run(sql.trim(), params);
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      setAlarm: async (ts: number) => {
        alarms.push(ts);
      },
      getAlarm: async () => alarms[alarms.length - 1] ?? null,
      deleteAlarm: async () => {},
    },
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  };
  return { ctx, reviews, checkpoints, events, pending, alarms };
}

const RESULT: ReviewResult = {
  summary: 'looks fine',
  comments: [{ file: 'a.ts', severity: 'note', comment: 'nit', line: 3 }],
  filesReviewed: 1,
  totalFiles: 1,
  truncated: false,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  reviewedAt: Date.now(),
};

function startInput(overrides: Partial<PrReviewStartInput> = {}): PrReviewStartInput {
  return {
    deliveryId: 'd1',
    repoFullName: 'octo/repo',
    prNumber: 7,
    headSha: 'shaA',
    baseRef: 'main',
    headRef: 'feature/x',
    installationId: '42',
    isCrossFork: false,
    origin: 'https://push.app',
    ...overrides,
  };
}

function startRequest(input: PrReviewStartInput): Request {
  return new Request('https://do/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

function cancelRequest(deliveryId: string): Request {
  return new Request('https://do/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliveryId }),
  });
}

describe('repoGatingEnabled', () => {
  it('matches case-insensitively, defaults off, and ignores blanks', () => {
    expect(repoGatingEnabled('octo/repo', 'octo/repo')).toBe(true);
    expect(repoGatingEnabled('Octo/Repo', 'octo/repo, other/x')).toBe(true);
    expect(repoGatingEnabled('octo/repo', 'other/x')).toBe(false);
    expect(repoGatingEnabled('octo/repo', undefined)).toBe(false);
    expect(repoGatingEnabled('octo/repo', '')).toBe(false);
  });
});

describe('PrReviewJob', () => {
  it('runs a review to completion and logs lifecycle events', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const executor = vi.fn(async () => ({ result: RESULT, commentsPosted: 1, posted: true }));
    __setPrReviewExecutorOverride('d1', executor);

    const res = await do_.fetch(startRequest(startInput()));
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('queued');

    await Promise.allSettled(mock.pending);

    expect(executor).toHaveBeenCalledOnce();
    expect(mock.reviews.get('d1')).toMatchObject({ status: 'completed', comments_posted: 1 });
    expect(mock.events.map((e) => e.type)).toEqual([
      'review.queued',
      'review.started',
      'review.completed',
    ]);

    const status = await (await do_.fetch(new Request('https://do/status?deliveryId=d1'))).json();
    expect(status).toMatchObject({ status: 'completed', commentsPosted: 1, prNumber: 7 });
  });

  it('persists the full ReviewResult and lists reviews for the PR', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    __setPrReviewExecutorOverride('d2', async () => ({
      result: { ...RESULT, summary: 'second review' },
      commentsPosted: 0,
      posted: true,
    }));

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await Promise.allSettled(mock.pending);
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaB' })));
    await Promise.allSettled(mock.pending);

    // The full result is persisted on the row, not just the comment count.
    expect(JSON.parse(mock.reviews.get('d1')!.result_json!)).toMatchObject({
      summary: 'looks fine',
    });

    const body = (await (await do_.fetch(new Request('https://do/list'))).json()) as {
      reviews: Array<{
        deliveryId: string;
        status: string;
        commentsPosted: number | null;
        result: { summary: string } | null;
      }>;
    };
    expect(body.reviews).toHaveLength(2);
    const byId = Object.fromEntries(body.reviews.map((r) => [r.deliveryId, r]));
    expect(byId.d1).toMatchObject({ status: 'completed', commentsPosted: 1 });
    expect(byId.d1.result?.summary).toBe('looks fine');
    expect(byId.d2.result?.summary).toBe('second review');
  });

  it('feeds the latest posted review into a re-review as priorReview', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const first = vi.fn<PrReviewExecutor>(async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    const second = vi.fn<PrReviewExecutor>(async () => ({
      result: { ...RESULT, summary: 'second review' },
      commentsPosted: 0,
      posted: true,
    }));
    __setPrReviewExecutorOverride('d1', first);
    __setPrReviewExecutorOverride('d2', second);

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await Promise.allSettled(mock.pending);
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaB' })));
    await Promise.allSettled(mock.pending);

    // First review of the PR has no prior.
    expect(first.mock.calls[0][0]).toMatchObject({ deliveryId: 'd1' });
    expect(first.mock.calls[0][0].priorReview).toBeUndefined();

    // Re-review carries the first pass's posted findings + reviewed SHA.
    const secondInput = second.mock.calls[0][0];
    expect(secondInput.priorReview).toMatchObject({
      headSha: 'shaA',
      summary: 'looks fine',
    });
    expect(secondInput.priorReview?.comments).toEqual(RESULT.comments);
  });

  it('skips unposted and corrupt prior rows for cross-review memory', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    // d1 completes but never posts (head advanced) — its findings were never
    // on the PR, so they must not count as a prior review.
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: false,
    }));
    const second = vi.fn<PrReviewExecutor>(async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    __setPrReviewExecutorOverride('d2', second);
    const third = vi.fn<PrReviewExecutor>(async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    __setPrReviewExecutorOverride('d3', third);

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await Promise.allSettled(mock.pending);
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaB' })));
    await Promise.allSettled(mock.pending);
    expect(second.mock.calls[0][0].priorReview).toBeUndefined();

    // A posted row whose result blob is corrupt degrades to no prior, not a throw.
    mock.reviews.get('d2')!.result_json = '{not json';
    await do_.fetch(startRequest(startInput({ deliveryId: 'd3', headSha: 'shaC' })));
    await Promise.allSettled(mock.pending);
    expect(mock.reviews.get('d3')).toMatchObject({ status: 'completed' });
    expect(third.mock.calls[0][0].priorReview).toBeUndefined();
  });

  it('emits gated on review.completed (true when set, false when omitted)', async () => {
    const gatedMock = createMockCtx();
    const gatedDo = new PrReviewJob(gatedMock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
      gated: true,
    }));
    await gatedDo.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(gatedMock.pending);
    const gatedEvent = gatedMock.events.find((e) => e.type === 'review.completed');
    expect(JSON.parse(gatedEvent!.payload_json).gated).toBe(true);

    const plainMock = createMockCtx();
    const plainDo = new PrReviewJob(plainMock.ctx as never, {} as Env);
    // Override omits `gated` — the event should default it to false.
    __setPrReviewExecutorOverride('d2', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    await plainDo.fetch(startRequest(startInput({ deliveryId: 'd2' })));
    await Promise.allSettled(plainMock.pending);
    const plainEvent = plainMock.events.find((e) => e.type === 'review.completed');
    expect(JSON.parse(plainEvent!.payload_json).gated).toBe(false);
  });

  it('dedupes a redelivered delivery id', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const executor = vi.fn(async () => ({ result: RESULT, commentsPosted: 0, posted: true }));
    __setPrReviewExecutorOverride('d1', executor);

    await do_.fetch(startRequest(startInput()));
    await Promise.allSettled(mock.pending);
    const second = await do_.fetch(startRequest(startInput()));

    expect((await second.json()).status).toBe('duplicate');
    expect(executor).toHaveBeenCalledOnce();
  });

  it('supersedes an in-flight review when a newer head SHA arrives', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);

    // First review blocks until its signal aborts.
    let abortedSignal = false;
    __setPrReviewExecutorOverride(
      'd1',
      (_input, _env, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortedSignal = true;
            reject(new Error('aborted'));
          });
        }),
    );
    __setPrReviewExecutorOverride('d2', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaB' })));
    await Promise.allSettled(mock.pending);

    expect(abortedSignal).toBe(true);
    expect(mock.reviews.get('d1')?.status).toBe('superseded');
    expect(mock.reviews.get('d2')).toMatchObject({ status: 'completed', comments_posted: 1 });
  });

  it('does NOT supersede a same-head review by default (two reviews run)', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    __setPrReviewExecutorOverride('d2', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaA' })));
    await Promise.allSettled(mock.pending);

    // Same head, no flag → the first is left alone; both complete.
    expect(mock.reviews.get('d1')?.status).toBe('completed');
    expect(mock.reviews.get('d2')?.status).toBe('completed');
  });

  it('supersedes an in-flight same-head review when supersedeSameHead is set (latest wins)', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);

    let abortedSignal = false;
    __setPrReviewExecutorOverride(
      'd1',
      (_input, _env, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            abortedSignal = true;
            reject(new Error('aborted'));
          });
        }),
    );
    __setPrReviewExecutorOverride('d2', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));

    // d1 is in flight on shaA; d2 re-requests the SAME head with the flag.
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await do_.fetch(
      startRequest(startInput({ deliveryId: 'd2', headSha: 'shaA', supersedeSameHead: true })),
    );
    await Promise.allSettled(mock.pending);

    expect(abortedSignal).toBe(true);
    expect(mock.reviews.get('d1')?.status).toBe('superseded');
    expect(mock.reviews.get('d2')).toMatchObject({ status: 'completed', comments_posted: 1 });
  });

  it('records a failed review with a classified error type', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => {
      throw new Error('github 429 rate limited');
    });

    await do_.fetch(startRequest(startInput()));
    await Promise.allSettled(mock.pending);

    expect(mock.reviews.get('d1')).toMatchObject({ status: 'failed' });
    const failedEvent = mock.events.find((e) => e.type === 'review.failed');
    expect(JSON.parse(failedEvent!.payload_json).errorType).toBe('rate_limit');
  });

  it('rejects a start payload missing required fields', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const res = await do_.fetch(
      startRequest(startInput({ repoFullName: '' as unknown as string })),
    );
    expect(res.status).toBe(400);
  });
});

describe('PrReviewJob cancel', () => {
  it('cancels an in-flight review: aborts the executor and records cancelled', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);

    let abortedSignal = false;
    __setPrReviewExecutorOverride(
      'd1',
      (_input, _env, signal) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => {
            abortedSignal = true;
            reject(new Error('aborted'));
          };
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort);
        }),
    );

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    // The review is now running (runReview's synchronous prefix ran before the
    // start response resolved, so the controller is registered).
    expect(mock.reviews.get('d1')?.status).toBe('running');

    const res = await do_.fetch(cancelRequest('d1'));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
    await Promise.allSettled(mock.pending);

    expect(abortedSignal).toBe(true);
    expect(mock.reviews.get('d1')?.status).toBe('cancelled');
    expect(mock.reviews.get('d1')?.finished_at).not.toBeNull();
    // The cancel event lands, and the executor's post-abort rejection does NOT
    // overwrite the row to 'failed' (the abort catch early-returns on cancelled).
    const types = mock.events.filter((e) => e.delivery_id === 'd1').map((e) => e.type);
    expect(types).toContain('review.cancelled');
    expect(types).not.toContain('review.failed');
  });

  it('returns 404 for an unknown deliveryId', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const res = await do_.fetch(cancelRequest('nope'));
    expect(res.status).toBe(404);
  });

  it('returns 409 when the review already reached a terminal state', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);
    expect(mock.reviews.get('d1')?.status).toBe('completed');

    const res = await do_.fetch(cancelRequest('d1'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('NOT_CANCELLABLE');
    // The terminal row is untouched.
    expect(mock.reviews.get('d1')?.status).toBe('completed');
  });

  it('rejects a cancel with no deliveryId (400)', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const res = await do_.fetch(
      new Request('https://do/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('closes the cancelled review’s check-run as neutral', async () => {
    checkRunIdRef.current = 1;
    vi.mocked(createInProgressReviewCheckRun).mockClear();
    vi.mocked(finalizeReviewCheckRun).mockClear();
    vi.mocked(createReviewCheckRun).mockClear();
    const APP_ENV = { GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: 'key' } as unknown as Env;

    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride(
      'd1',
      (_input, _env, signal) =>
        new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort);
        }),
    );
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await do_.fetch(cancelRequest('d1'));
    await Promise.allSettled(mock.pending);

    // The in-progress run is *patched* to a neutral "Review cancelled" terminal,
    // exactly once, using the real check-run id from the in-progress create (1).
    // runReview's abort catch owns this when a controller is live — handleCancel
    // does NOT post a separate fresh run from the (null-id) pre-update row, so no
    // duplicate "Review cancelled" check is created and the in-progress run never
    // hangs "Reviewing…".
    const cancelledCalls = vi
      .mocked(finalizeReviewCheckRun)
      .mock.calls.filter((c) => c[2] === 'neutral' && /cancel/i.test(c[3].title));
    expect(cancelledCalls).toHaveLength(1);
    expect(cancelledCalls[0]![1]).toBe(1);
    expect(createReviewCheckRun).not.toHaveBeenCalled();
  });

  it('closes the check-run of a cancelled orphan (no live controller) from its row', async () => {
    checkRunIdRef.current = 1;
    vi.mocked(createInProgressReviewCheckRun).mockClear();
    vi.mocked(finalizeReviewCheckRun).mockClear();
    vi.mocked(createReviewCheckRun).mockClear();
    const APP_ENV = { GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: 'key' } as unknown as Env;

    const mock = createMockCtx();
    // A `running` row with no entry in abortControllers (its instance died), so
    // the cancel can't abort anything and must close the check-run itself. Kept
    // fresh (within the orphan grace window) so the first-fetch orphan sweep
    // skips it rather than failing it before the cancel lands.
    mock.reviews.set('orphan', {
      delivery_id: 'orphan',
      relaunch_count: 0,
      pinned_provider: null,
      pinned_model: null,
      repo: 'octo/repo',
      pr_number: 7,
      head_sha: 'shaA',
      base_ref: 'main',
      head_ref: 'feature/x',
      installation_id: '42',
      is_cross_fork: 0,
      origin: 'https://push.example',
      status: 'running',
      comments_posted: null,
      posted: null,
      result_json: null,
      error_text: null,
      created_at: Date.now(),
      started_at: Date.now(),
      finished_at: null,
      check_run_id: 77,
    });
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);

    const res = await do_.fetch(cancelRequest('orphan'));
    expect(res.status).toBe(200);
    await Promise.allSettled(mock.pending);

    expect(mock.reviews.get('orphan')?.status).toBe('cancelled');
    // Patched its persisted in-progress run (id 77) to neutral "Review cancelled".
    const cancelledCalls = vi
      .mocked(finalizeReviewCheckRun)
      .mock.calls.filter((c) => c[2] === 'neutral' && /cancel/i.test(c[3].title));
    expect(cancelledCalls).toHaveLength(1);
    expect(cancelledCalls[0]![1]).toBe(77);
  });
});

describe('PrReviewJob check-run status surface', () => {
  // App creds present → the check-run lifecycle activates (token is mocked).
  const APP_ENV = { GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: 'key' } as unknown as Env;

  beforeEach(() => {
    checkRunIdRef.current = 1;
    vi.mocked(createInProgressReviewCheckRun).mockClear();
    vi.mocked(finalizeReviewCheckRun).mockClear();
    vi.mocked(createReviewCheckRun).mockClear();
  });

  it('opens an in-progress check-run then finalizes it as success on a posted review', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);

    expect(createInProgressReviewCheckRun).toHaveBeenCalledTimes(1);
    expect(createInProgressReviewCheckRun).toHaveBeenCalledWith(
      'octo/repo',
      'shaA',
      expect.anything(),
      expect.anything(),
    );
    // Same run patched in place to a terminal success conclusion.
    const lastFinalize = vi.mocked(finalizeReviewCheckRun).mock.calls.at(-1);
    expect(lastFinalize?.[1]).toBe(1); // the check-run id from the in-progress create
    expect(lastFinalize?.[2]).toBe('success');
  });

  it('finalizes a head-advanced (posted:false) review as a neutral "skipped" check', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: false,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);

    const lastFinalize = vi.mocked(finalizeReviewCheckRun).mock.calls.at(-1);
    expect(lastFinalize?.[2]).toBe('neutral');
    expect(lastFinalize?.[3].title).toMatch(/skipped/i);
  });

  it('finalizes a degraded (fallback) review as neutral "Review incomplete" — never a clean pass', async () => {
    // The #905/#906 regression: a fallback result with zero findings used to
    // post + finalize as success "No blocking findings", green-lighting a
    // review that never happened. Degraded results don't post (the executor
    // returns posted:false) and the check-run must say so.
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: {
        ...RESULT,
        summary: 'Deep review did not produce structured output.',
        comments: [],
        degraded: true,
      },
      commentsPosted: 0,
      posted: false,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);

    const lastFinalize = vi.mocked(finalizeReviewCheckRun).mock.calls.at(-1);
    expect(lastFinalize?.[2]).toBe('neutral');
    expect(lastFinalize?.[3].title).toBe('Review incomplete');
    expect(lastFinalize?.[3].summary).toMatch(/close and reopen/i);
  });

  it('closes a superseded delivery’s check-run as neutral instead of leaving it hanging', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    // d1 blocks until aborted; d2 (newer head) supersedes it.
    __setPrReviewExecutorOverride(
      'd1',
      (_input, _env, signal) =>
        new Promise((_resolve, reject) => {
          // Guard the pre-aborted case: d2's supersede can abort d1 before this
          // executor is even invoked, and addEventListener on an already-aborted
          // signal never fires.
          if (signal.aborted) return reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    __setPrReviewExecutorOverride('d2', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaB' })));
    await Promise.allSettled(mock.pending);

    // The superseded delivery's check is closed neutral — via patch if its
    // in-progress run already existed, else a fresh terminal create (race-safe).
    const neutralPatched = vi
      .mocked(finalizeReviewCheckRun)
      .mock.calls.some((c) => c[2] === 'neutral');
    const neutralCreated = vi
      .mocked(createReviewCheckRun)
      .mock.calls.some((c) => c[2] === 'neutral');
    expect(neutralPatched || neutralCreated).toBe(true);
  });
});

describe('PrReviewJob orphan sweep', () => {
  function seedRow(overrides: Partial<ReviewRow> & { delivery_id: string }): ReviewRow {
    return {
      pinned_provider: null,
      pinned_model: null,
      repo: 'octo/repo',
      pr_number: 7,
      head_sha: 'shaX',
      base_ref: 'main',
      head_ref: 'feature/x',
      installation_id: '42',
      is_cross_fork: 0,
      origin: 'https://push.example',
      status: 'running',
      comments_posted: null,
      posted: null,
      result_json: null,
      error_text: null,
      created_at: Date.now(),
      started_at: Date.now(),
      finished_at: null,
      check_run_id: null,
      relaunch_count: 0,
      ...overrides,
    };
  }

  it('fails a stale running review with no live execution; leaves fresh rows alone', async () => {
    const mock = createMockCtx();
    // Orphan: running, 30m old, no live controller (fresh DO instance).
    mock.reviews.set(
      'orphan',
      seedRow({
        delivery_id: 'orphan',
        status: 'running',
        created_at: Date.now() - 30 * 60_000,
        started_at: Date.now() - 30 * 60_000,
        check_run_id: 99,
      }),
    );
    // Fresh queued row within the grace window — must NOT be swept (could be a
    // delivery whose runReview hasn't registered its controller yet).
    mock.reviews.set(
      'fresh',
      seedRow({ delivery_id: 'fresh', status: 'queued', created_at: Date.now(), started_at: null }),
    );

    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    await do_.fetch(new Request('https://do/list')); // any fetch kicks the first-fetch sweep
    await Promise.allSettled(mock.pending);

    expect(mock.reviews.get('orphan')!.status).toBe('failed');
    expect(mock.reviews.get('fresh')!.status).toBe('queued');
    const ev = mock.events.find((e) => e.delivery_id === 'orphan' && e.type === 'review.failed');
    expect(JSON.parse(ev!.payload_json).errorType).toBe('orphaned');
  });

  it('arms the orphan alarm when a review starts', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);
    expect(mock.alarms.length).toBeGreaterThan(0);
  });

  it('alarm force-fails a live review that exceeds the wall-clock budget', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    let aborted = false;

    __setPrReviewExecutorOverride(
      'stuck',
      (_input, _env, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );

    await do_.fetch(startRequest(startInput({ deliveryId: 'stuck' })));
    await Promise.resolve();
    await Promise.resolve();

    const row = mock.reviews.get('stuck')!;
    row.started_at = Date.now() - 16 * 60_000;

    await do_.alarm();
    await Promise.allSettled(mock.pending);

    expect(aborted).toBe(true);
    expect(mock.reviews.get('stuck')!.status).toBe('failed');
    expect(mock.reviews.get('stuck')!.error_text).toContain('wall-clock budget');
    const ev = mock.events.find((e) => e.delivery_id === 'stuck' && e.type === 'review.failed');
    expect(JSON.parse(ev!.payload_json).errorType).toBe('timeout');
  });

  it('alarm merges grace recheck with live-review deadline, picking the earliest', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);

    // Plant an orphan row within the grace window (no abort controller).
    // Use a distinct PR number so handleStart's coalescing doesn't supersede it.
    mock.reviews.set(
      'orphan',
      seedRow({
        delivery_id: 'orphan',
        pr_number: 99,
        status: 'running',
        created_at: Date.now() - 90_000,
        started_at: Date.now() - 30_000,
      }),
    );

    // A stuck live review with a 15-minute deadline.
    __setPrReviewExecutorOverride(
      'live',
      (_input, _env, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => {});
        }),
    );
    await do_.fetch(startRequest(startInput({ deliveryId: 'live' })));
    await Promise.resolve();
    await Promise.resolve();

    const alarmsBefore = mock.alarms.length;
    await do_.alarm();

    // alarm() should have set exactly one new alarm.
    expect(mock.alarms.length).toBe(alarmsBefore + 1);
    const lastAlarm = mock.alarms[mock.alarms.length - 1];
    // Grace alarm (~2 min) is earlier than live deadline (~15 min) and in the future.
    expect(lastAlarm).toBeGreaterThan(Date.now());
    expect(lastAlarm).toBeLessThan(Date.now() + 3 * 60_000);
    // The orphan is within the grace window so it must not be swept.
    expect(mock.reviews.get('orphan')!.status).toBe('running');
  });
});

// Relaunch-from-checkpoint: the recovery path for the diagnosed failure mode
// (2026-06-11, PR #887) — the runtime reclaims the DO instance ~1–3 min into
// an unwatched review, so from-scratch retries can never converge. Per-round
// checkpoints + watchdog relaunch make progress monotone.
describe('cleanPassCheckStatus (§9a — CI-sourced)', () => {
  it("concludes success only when the head SHA's own CI passed", () => {
    const s = cleanPassCheckStatus({
      ci: 'pass',
      checks: [{ name: 'Test (cli)', conclusion: 'success' }],
    });
    expect(s.conclusion).toBe('success');
    expect(s.title).toBe('No blocking findings — verified (CI green)');
    // The claim is auditable: name the checks it was computed from.
    expect(s.summary).toContain('Test (cli): success');
  });

  it('flags a clean pass sitting on RED CI as neutral, naming the failed checks', () => {
    const s = cleanPassCheckStatus({
      ci: 'fail',
      checks: [
        { name: 'Test (cli)', conclusion: 'failure' },
        { name: 'Lint', conclusion: 'success' },
      ],
    });
    expect(s.conclusion).toBe('neutral');
    expect(s.title).toBe('No blocking findings — CI is failing');
    expect(s.summary).toContain('Test (cli)');
    // "No findings" must never launder a red commit into a green check.
    expect(s.conclusion).not.toBe('success');
  });

  it("keeps 'blocked' meaning OUR outage, not a verdict on the code", () => {
    // The reason `blocked` survived the sandbox era. A no-verdict environment
    // failure must not read as "the code failed" NOR as "the model skipped it" —
    // conflating those accused the model of skipping verification we had denied it,
    // leaving its own narration as the only account of why.
    const s = cleanPassCheckStatus({
      ci: 'blocked',
      blockedReason:
        'CI had not completed for this commit within 300s (still running: Test (cli)).',
      checks: [{ name: 'Test (cli)', conclusion: null }],
    });
    expect(s.conclusion).toBe('neutral');
    expect(s.title).toBe('No blocking findings (CI verdict unavailable)');
    expect(s.summary).toContain('not a verdict on the code');
    // The cause survives to the check run without the model narrating it.
    expect(s.summary).toContain('still running: Test (cli)');
    expect(s.summary).toContain('Test (cli): still running');
  });

  it('degrades to "no detail" when a blocked reason went missing — never to a guess', () => {
    const s = cleanPassCheckStatus({ ci: 'blocked' });
    expect(s.title).toBe('No blocking findings (CI verdict unavailable)');
    expect(s.summary).toContain('(no detail captured)');
  });

  it('distinguishes no-CI-at-all from an unrecorded verification', () => {
    expect(cleanPassCheckStatus({ ci: 'unavailable', checks: [] })).toMatchObject({
      conclusion: 'neutral',
      title: 'No blocking findings (no CI to verify against)',
    });
    // Absent record (pre-§9a rows) must not read as verified.
    expect(cleanPassCheckStatus(undefined)).toMatchObject({
      conclusion: 'neutral',
      title: 'No blocking findings (unverified)',
    });
  });
});

describe('verificationNote', () => {
  it('states the CI verdict in one line for every state', () => {
    expect(verificationNote({ ci: 'pass' })).toContain('CI passed');
    expect(
      verificationNote({
        ci: 'fail',
        checks: [
          { name: 'Test (cli)', conclusion: 'failure' },
          { name: 'Approval gate', conclusion: 'action_required' },
        ],
      }),
    ).toContain('Approval gate');
    expect(verificationNote({ ci: 'blocked', blockedReason: 'deadline' })).toContain('deadline');
    expect(verificationNote({ ci: 'unavailable' })).toContain('no CI');
    expect(verificationNote(undefined)).toContain('not recorded');
  });
});

describe('PrReviewJob verification gate (check-run policy)', () => {
  const APP_ENV = { GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: 'key' } as unknown as Env;

  it('finalizes a clean pass on GREEN CI as success', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: {
        ...RESULT,
        comments: [],
        verification: {
          ci: 'pass' as const,
          checks: [{ name: 'Test (cli)', conclusion: 'success' }],
        },
      },
      commentsPosted: 0,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);

    const lastFinalize = vi.mocked(finalizeReviewCheckRun).mock.calls.at(-1);
    expect(lastFinalize?.[2]).toBe('success');
    expect(lastFinalize?.[3].title).toContain('verified (CI green)');
  });

  it('finalizes a clean pass with NO CI verdict as neutral — never success', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: {
        ...RESULT,
        comments: [],
        verification: { ci: 'blocked' as const, blockedReason: 'CI had not completed' },
      },
      commentsPosted: 0,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);

    const lastFinalize = vi.mocked(finalizeReviewCheckRun).mock.calls.at(-1);
    expect(lastFinalize?.[2]).toBe('neutral');
    expect(lastFinalize?.[3].title).toBe('No blocking findings (CI verdict unavailable)');
  });

  it('reviews WITH findings keep the finding-count check AND disclose the CI verdict', async () => {
    // The hole §9a closed: the clean-pass path disclosed verification and the
    // findings path said nothing at all, so "CI is red" was invisible exactly when
    // the reviewer had ALSO found problems — the case where you most want to know.
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: {
        ...RESULT,
        verification: {
          ci: 'fail' as const,
          checks: [{ name: 'Test (cli)', conclusion: 'failure' }],
        },
      },
      commentsPosted: 1,
      posted: true,
    }));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd1' })));
    await Promise.allSettled(mock.pending);

    const lastFinalize = vi.mocked(finalizeReviewCheckRun).mock.calls.at(-1);
    expect(lastFinalize?.[2]).toBe('success');
    expect(lastFinalize?.[3].title).toBe('1 finding');
    expect(lastFinalize?.[3].summary).toContain('CI FAILED');
    expect(lastFinalize?.[3].summary).toContain('Test (cli)');
  });

  it('onToolProgress touches the checkpoint so long tool runs count as progress', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    let touchedAt = 0;
    __setPrReviewExecutorOverride('tp1', async (_i, _e, _s, hooks) => {
      hooks?.onRoundState?.({
        messages: [],
        nextRound: 1,
        totalToolCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      const before = mock.checkpoints.get('tp1')!.updated_at;
      await new Promise((r) => setTimeout(r, 5));
      hooks?.onToolProgress?.();
      touchedAt = mock.checkpoints.get('tp1')!.updated_at;
      expect(touchedAt).toBeGreaterThan(before);
      return { result: RESULT, commentsPosted: 0, posted: true };
    });
    await do_.fetch(startRequest(startInput({ deliveryId: 'tp1' })));
    await Promise.allSettled(mock.pending);
    expect(touchedAt).toBeGreaterThan(0);
    expect(mock.reviews.get('tp1')!.status).toBe('completed');
  });
});

describe('PrReviewJob relaunch-from-checkpoint', () => {
  function liveRow(overrides: Partial<ReviewRow> & { delivery_id: string }): ReviewRow {
    return {
      repo: 'octo/repo',
      pr_number: 31,
      head_sha: 'shaR',
      base_ref: 'main',
      head_ref: 'feature/r',
      installation_id: '42',
      is_cross_fork: 0,
      origin: 'https://push.example',
      status: 'running',
      comments_posted: null,
      posted: null,
      result_json: null,
      error_text: null,
      created_at: Date.now() - 5 * 60_000,
      started_at: Date.now() - 4 * 60_000,
      finished_at: null,
      check_run_id: 77,
      relaunch_count: 0,
      pinned_provider: null,
      pinned_model: null,
      ...overrides,
    };
  }

  const CKPT_STATE = {
    messages: [{ id: 'deep-review-diff', role: 'user' as const, content: 'diff', timestamp: 1 }],
    nextRound: 3,
    totalToolCalls: 4,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  };

  function plantCheckpoint(
    mock: ReturnType<typeof createMockCtx>,
    deliveryId: string,
    updatedAt = Date.now() - 60_000,
  ) {
    mock.checkpoints.set(deliveryId, {
      state_json: JSON.stringify(CKPT_STATE),
      round: CKPT_STATE.nextRound,
      updated_at: updatedAt,
    });
  }

  it('persists per-round checkpoints during a run and clears them on completion', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    let sizeMidRun = 0;
    __setPrReviewExecutorOverride('ck1', async (_i, _e, _s, hooks) => {
      hooks?.onRoundState?.({ ...CKPT_STATE, nextRound: 1 });
      hooks?.onRoundState?.({ ...CKPT_STATE, nextRound: 2 });
      sizeMidRun = mock.checkpoints.size;
      return { result: RESULT, commentsPosted: 0, posted: true };
    });
    await do_.fetch(startRequest(startInput({ deliveryId: 'ck1' })));
    await Promise.allSettled(mock.pending);

    expect(sizeMidRun).toBe(1); // upserted per round, one row per delivery
    expect(mock.checkpoints.size).toBe(0); // terminal exit cleared it
    expect(mock.reviews.get('ck1')!.status).toBe('completed');
  });

  it('relaunches an orphaned checkpointed review from its last round, same delivery + check-run', async () => {
    const mock = createMockCtx();
    mock.reviews.set('dead', liveRow({ delivery_id: 'dead' }));
    plantCheckpoint(mock, 'dead');

    let seenResume: unknown = null;
    __setPrReviewExecutorOverride('dead', async (_i, _e, _s, hooks) => {
      seenResume = hooks?.resumeState ?? null;
      return { result: RESULT, commentsPosted: 0, posted: true };
    });

    // Fresh instance over the same storage = the post-eviction wake.
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    await do_.alarm();
    await Promise.allSettled(mock.pending);

    expect(seenResume).toMatchObject({ nextRound: 3, totalToolCalls: 4 });
    const row = mock.reviews.get('dead')!;
    expect(row.status).toBe('completed');
    expect(row.relaunch_count).toBe(1);
    expect(row.check_run_id).toBe(77); // reused, not re-created
    expect(
      mock.events.some((e) => e.delivery_id === 'dead' && e.type === 'review.relaunched'),
    ).toBe(true);
    // No from-scratch retry was burned on a relaunchable death.
    expect([...mock.reviews.keys()].some((k) => k.endsWith('.auto-retry'))).toBe(false);
    expect(mock.checkpoints.has('dead')).toBe(false);
  });

  it('pins the resolved provider/model at start and threads it to the executor', async () => {
    // The #909 incident class: config is resolved ONCE per delivery. The pin
    // rides the row + input, so the executor never re-reads live config for
    // a pinned delivery.
    const mock = createMockCtx();
    const env = {
      PR_REVIEW_PROVIDER: 'zen',
      PR_REVIEW_MODEL: 'glm-5.1',
    } as unknown as Env;
    const seen: Array<{ provider?: string; model?: string }> = [];
    __setPrReviewExecutorOverride('pin1', async (i) => {
      seen.push({ provider: i.pinnedProvider, model: i.pinnedModel });
      return { result: RESULT, commentsPosted: 0, posted: true };
    });
    const do_ = new PrReviewJob(mock.ctx as never, env);
    await do_.fetch(startRequest(startInput({ deliveryId: 'pin1' })));
    await Promise.allSettled(mock.pending);

    expect(seen).toEqual([{ provider: 'zen', model: 'glm-5.1' }]);
    expect(mock.reviews.get('pin1')!.pinned_provider).toBe('zen');
    expect(mock.reviews.get('pin1')!.pinned_model).toBe('glm-5.1');
  });

  it('concurrent duplicate deliveries dedupe — the row reservation stays synchronous', async () => {
    // Codex P1 (PR #910): the pin's settings read must not sit between the
    // duplicate check and the insert, or two redeliveries of the same
    // delivery id both pass dedupe and race the unique insert.
    const mock = createMockCtx();
    __setPrReviewExecutorOverride('race1', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const [a, b] = await Promise.all([
      do_.fetch(startRequest(startInput({ deliveryId: 'race1' }))),
      do_.fetch(startRequest(startInput({ deliveryId: 'race1' }))),
    ]);
    await Promise.allSettled(mock.pending);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 202]); // one queued, one duplicate
    expect(mock.reviews.size).toBe(1);
    expect(mock.reviews.get('race1')!.status).toBe('completed');
  });

  it('a supersede landing inside the pin await stands the older start down', async () => {
    // The pin await is the one yield between row reservation and the
    // runReview kick. A newer head SHA superseding the row in that window
    // must not be resurrected to 'running' by the older start's kick.
    const mock = createMockCtx();
    __setPrReviewExecutorOverride('old-sha', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    __setPrReviewExecutorOverride('new-sha', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const [oldRes] = await Promise.all([
      do_.fetch(startRequest(startInput({ deliveryId: 'old-sha', headSha: 'shaOld' }))),
      do_.fetch(startRequest(startInput({ deliveryId: 'new-sha', headSha: 'shaNew' }))),
    ]);
    await Promise.allSettled(mock.pending);

    expect(mock.reviews.get('old-sha')!.status).toBe('superseded');
    expect(oldRes.status).toBe(200); // stood down, not queued
    expect(
      mock.events.some((e) => e.delivery_id === 'old-sha' && e.type === 'review.started'),
    ).toBe(false);
    expect(mock.reviews.get('new-sha')!.status).toBe('completed');
  });

  it('a relaunch keeps the pinned config even when live config changed mid-flight', async () => {
    // Attempt 1 pinned zen/glm-5.1 on the row, then the instance died at a
    // checkpoint. The post-eviction wake runs under DIFFERENT live config —
    // the relaunch must use the pin, not re-resolve (re-resolution killed
    // #909's in-flight review during a model swap).
    const mock = createMockCtx();
    mock.reviews.set(
      'pinned-dead',
      liveRow({
        delivery_id: 'pinned-dead',
        pinned_provider: 'zen',
        pinned_model: 'glm-5.1',
      }),
    );
    plantCheckpoint(mock, 'pinned-dead');

    const seen: Array<{ provider?: string; model?: string }> = [];
    __setPrReviewExecutorOverride('pinned-dead', async (i) => {
      seen.push({ provider: i.pinnedProvider, model: i.pinnedModel });
      return { result: RESULT, commentsPosted: 0, posted: true };
    });

    const swappedEnv = {
      PR_REVIEW_PROVIDER: 'openrouter',
      PR_REVIEW_MODEL: 'anthropic/claude-sonnet-4.6:nitro',
    } as unknown as Env;
    const do_ = new PrReviewJob(mock.ctx as never, swappedEnv);
    await do_.alarm();
    await Promise.allSettled(mock.pending);

    expect(seen).toEqual([{ provider: 'zen', model: 'glm-5.1' }]);
    expect(mock.reviews.get('pinned-dead')!.status).toBe('completed');
  });

  it('relaunch survives repeated deaths — the cap is persisted, not per-instance', async () => {
    const mock = createMockCtx();
    mock.reviews.set('dead', liveRow({ delivery_id: 'dead', relaunch_count: 7 }));
    plantCheckpoint(mock, 'dead');
    __setPrReviewExecutorOverride('dead', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    await do_.alarm();
    await Promise.allSettled(mock.pending);
    expect(mock.reviews.get('dead')!.relaunch_count).toBe(8);
    expect(mock.reviews.get('dead')!.status).toBe('completed');
  });

  it('falls to the terminal orphan path once the relaunch cap is exhausted', async () => {
    const mock = createMockCtx();
    mock.reviews.set(
      'spent',
      liveRow({
        delivery_id: 'spent',
        relaunch_count: 10,
        started_at: Date.now() - 10 * 60_000,
      }),
    );
    plantCheckpoint(mock, 'spent');
    __setPrReviewExecutorOverride('spent.auto-retry', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));

    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    await do_.alarm();
    await Promise.allSettled(mock.pending);

    expect(mock.reviews.get('spent')!.status).toBe('failed');
    expect(mock.checkpoints.has('spent')).toBe(false);
    // Existing semantics preserved: the terminal orphan path still gets its
    // one from-scratch auto-retry.
    expect(mock.reviews.get('spent.auto-retry')).toBeDefined();
  });

  it('anchors the stall timeout on checkpoint progress, not the run start', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    let aborted = false;
    __setPrReviewExecutorOverride(
      'slow',
      (_i, _e, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    await do_.fetch(startRequest(startInput({ deliveryId: 'slow', prNumber: 33 })));
    await Promise.resolve();
    await Promise.resolve();

    // 16 min since start, but a checkpoint landed 1 min ago: still working.
    mock.reviews.get('slow')!.started_at = Date.now() - 16 * 60_000;
    plantCheckpoint(mock, 'slow', Date.now() - 60_000);
    await do_.alarm();
    expect(aborted).toBe(false);
    expect(mock.reviews.get('slow')!.status).toBe('running');

    // No progress for 16 min: stalled — force-fail.
    plantCheckpoint(mock, 'slow', Date.now() - 16 * 60_000);
    await do_.alarm();
    await Promise.allSettled(mock.pending);
    expect(aborted).toBe(true);
    expect(mock.reviews.get('slow')!.status).toBe('failed');
  });

  it('cancel clears the checkpoint so a sweep cannot resurrect a cancelled review', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('c1', (_i, _e, signal, hooks) => {
      hooks?.onRoundState?.({ ...CKPT_STATE, nextRound: 2 });
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });
    await do_.fetch(startRequest(startInput({ deliveryId: 'c1', prNumber: 34 })));
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.checkpoints.has('c1')).toBe(true);

    const res = await do_.fetch(cancelRequest('c1'));
    expect(res.status).toBe(200);
    await Promise.allSettled(mock.pending);
    expect(mock.reviews.get('c1')!.status).toBe('cancelled');
    expect(mock.checkpoints.has('c1')).toBe(false);
    // A later alarm must not relaunch it.
    await do_.alarm();
    await Promise.allSettled(mock.pending);
    expect(mock.reviews.get('c1')!.status).toBe('cancelled');
  });
});

describe('PrReviewJob cross-PR in-flight index', () => {
  it('records the review in the SNAPSHOT_INDEX index on start', async () => {
    const mock = createMockCtx();
    const store = new Map<string, string>();
    const env = {
      SNAPSHOT_INDEX: {
        put: async (k: string, v: string) => {
          store.set(k, v);
        },
        get: async (k: string) => store.get(k) ?? null,
        delete: async (k: string) => {
          store.delete(k);
        },
        list: async ({ prefix }: { prefix: string }) => ({
          keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        }),
      },
    } as unknown as Env;
    const do_ = new PrReviewJob(mock.ctx as never, env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));

    await do_.fetch(startRequest(startInput()));
    await Promise.allSettled(mock.pending);

    const key = 'inflight:pr-review:octo/repo#7#d1';
    expect(store.has(key)).toBe(true);
    expect(JSON.parse(store.get(key)!)).toMatchObject({
      repo: 'octo/repo',
      prNumber: 7,
      deliveryId: 'd1',
      headSha: 'shaA',
    });
  });

  it('start succeeds (202) even when no KV binding is present', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    __setPrReviewExecutorOverride('d1', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));

    const res = await do_.fetch(startRequest(startInput()));
    expect(res.status).toBe(202);
    await Promise.allSettled(mock.pending);
  });
});

describe('PrReviewJob auto-retry', () => {
  const APP_ENV = { GITHUB_APP_ID: 'app', GITHUB_APP_PRIVATE_KEY: 'key' } as unknown as Env;

  function deadRow(overrides: Partial<ReviewRow> & { delivery_id: string }): ReviewRow {
    return {
      pinned_provider: null,
      pinned_model: null,
      repo: 'octo/repo',
      pr_number: 7,
      head_sha: 'shaX',
      base_ref: 'main',
      head_ref: 'feature/x',
      installation_id: '42',
      is_cross_fork: 0,
      origin: 'https://push.example',
      status: 'running',
      comments_posted: null,
      posted: null,
      result_json: null,
      error_text: null,
      created_at: Date.now() - 30 * 60_000,
      started_at: Date.now() - 30 * 60_000,
      finished_at: null,
      check_run_id: null,
      relaunch_count: 0,
      ...overrides,
    };
  }

  async function settle(pending: Promise<unknown>[]): Promise<void> {
    // The retry's runReview (and its index write) are added to `pending` while
    // the sweep itself is settling, so one pass isn't enough.
    for (let i = 0; i < 3; i++) await Promise.allSettled(pending);
  }

  it('re-enqueues a dead first attempt once and completes on the retry', async () => {
    const mock = createMockCtx();
    mock.reviews.set('dead', deadRow({ delivery_id: 'dead', check_run_id: 501 }));
    __setPrReviewExecutorOverride('dead.auto-retry', async () => ({
      result: RESULT,
      commentsPosted: 0,
      posted: true,
    }));

    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    await do_.fetch(new Request('https://do/list')); // kicks the first-fetch sweep
    await settle(mock.pending);

    expect(mock.reviews.get('dead')!.status).toBe('failed');
    const retry = mock.reviews.get('dead.auto-retry');
    expect(retry?.status).toBe('completed');
    expect(retry?.origin).toBe('https://push.example');

    const queued = mock.events.find(
      (e) => e.delivery_id === 'dead.auto-retry' && e.type === 'review.queued',
    );
    expect(JSON.parse(queued!.payload_json)).toMatchObject({ retryOf: 'dead', cause: 'orphaned' });

    // The dead attempt's check-run closes with the retrying notice, not the
    // terminal advice.
    const finalize = vi.mocked(finalizeReviewCheckRun).mock.calls.find((c) => c[1] === 501);
    expect((finalize![3] as { title: string }).title).toBe('Review retrying');
  });

  it('a dead retry is final: terminal advice, no third attempt', async () => {
    const mock = createMockCtx();
    mock.reviews.set(
      'dead.auto-retry',
      deadRow({ delivery_id: 'dead.auto-retry', check_run_id: 502 }),
    );

    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    await do_.fetch(new Request('https://do/list'));
    await settle(mock.pending);

    expect(mock.reviews.get('dead.auto-retry')!.status).toBe('failed');
    expect([...mock.reviews.keys()].some((k) => k.endsWith('.auto-retry.auto-retry'))).toBe(false);

    const finalize = vi.mocked(finalizeReviewCheckRun).mock.calls.find((c) => c[1] === 502);
    const out = finalize![3] as { title: string; summary: string };
    expect(out.title).toBe('Review incomplete');
    expect(out.summary).toContain('close and reopen');
    expect(out.summary).not.toContain('Push a new commit');
  });

  it('retries a live review that stalls past the wall-clock budget', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);

    __setPrReviewExecutorOverride(
      'stalled',
      (_input, _env, signal) =>
        new Promise((_, reject) => {
          // Guard the pre-aborted case: the sweep can abort before this
          // executor is even invoked, and addEventListener on an
          // already-aborted signal never fires.
          if (signal.aborted) return reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    __setPrReviewExecutorOverride('stalled.auto-retry', async () => ({
      result: RESULT,
      commentsPosted: 1,
      posted: true,
    }));

    await do_.fetch(startRequest(startInput({ deliveryId: 'stalled' })));
    await Promise.resolve();
    await Promise.resolve();
    mock.reviews.get('stalled')!.started_at = Date.now() - 16 * 60_000;

    await do_.alarm();
    await vi.waitFor(() => {
      expect(mock.reviews.get('stalled')!.status).toBe('failed');
      expect(mock.reviews.get('stalled.auto-retry')?.status).toBe('completed');
    });
    const queued = mock.events.find(
      (e) => e.delivery_id === 'stalled.auto-retry' && e.type === 'review.queued',
    );
    expect(JSON.parse(queued!.payload_json)).toMatchObject({ cause: 'timeout' });
  });

  it('does not duplicate the retry when the sweep runs twice', async () => {
    const mock = createMockCtx();
    mock.reviews.set('dead', deadRow({ delivery_id: 'dead' }));
    // The retry itself hangs (no override → default executor throws on missing
    // creds and the row fails) — what matters is a second sweep not minting
    // a third row or re-running the retry id.
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    await do_.fetch(new Request('https://do/list'));
    await settle(mock.pending);
    const rowsAfterFirst = mock.reviews.size;

    await do_.alarm(); // second sweep pass
    await settle(mock.pending);

    expect(mock.reviews.size).toBe(rowsAfterFirst);
    const queuedEvents = mock.events.filter(
      (e) => e.delivery_id === 'dead.auto-retry' && e.type === 'review.queued',
    );
    expect(queuedEvents.length).toBe(1);
  });

  it('cancelling a dead original cascades to its running retry', async () => {
    const mock = createMockCtx();
    // The sweep already failed the original and enqueued the retry before the
    // user's cancel landed (the first-fetch sweep races a cancel aimed at a
    // dead row). The cancel must still honor the intent and kill the retry.
    mock.reviews.set('dead', deadRow({ delivery_id: 'dead', status: 'failed' }));
    mock.reviews.set(
      'dead.auto-retry',
      deadRow({
        delivery_id: 'dead.auto-retry',
        status: 'running',
        created_at: Date.now(),
        started_at: Date.now(),
      }),
    );

    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    const res = await do_.fetch(
      new Request('https://do/cancel', {
        method: 'POST',
        body: JSON.stringify({ deliveryId: 'dead' }),
      }),
    );
    await settle(mock.pending);

    expect(res.status).toBe(200);
    expect(mock.reviews.get('dead')!.status).toBe('failed'); // already terminal, untouched
    expect(mock.reviews.get('dead.auto-retry')!.status).toBe('cancelled');
  });

  it('retry ids stay within the cancel route delivery-id charset', () => {
    // Drift pin against DELIVERY_ID_RE in worker-pr-review.ts — a suffix
    // outside that charset makes running retries uncancellable from the UI
    // (the route 400s before reaching the DO).
    expect('f8412450-6486-11f1-93e3-ca04881784b9.auto-retry').toMatch(/^[A-Za-z0-9._-]{1,200}$/);
  });
});
