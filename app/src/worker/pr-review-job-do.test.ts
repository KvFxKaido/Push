/**
 * Lifecycle tests for the PrReviewJob DO. Hand-rolled in-memory SQL mock covers
 * exactly the queries the DO issues (CoderJob's test does the same). The
 * model/GitHub leaf is replaced via `__setPrReviewExecutorOverride`, so these
 * prove dedupe, coalescing, status, and the event log — not the network path.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ReviewResult } from '@push/lib/provider-contract';
import {
  PrReviewJob,
  __setPrReviewExecutorOverride,
  repoGatingEnabled,
  type PrReviewStartInput,
} from './pr-review-job-do';
import type { Env } from './worker-middleware';

interface ReviewRow {
  delivery_id: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_ref: string;
  head_ref: string;
  installation_id: string;
  is_cross_fork: number;
  status: string;
  comments_posted: number | null;
  result_json: string | null;
  error_text: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function createMockCtx() {
  const reviews = new Map<string, ReviewRow>();
  const events: Array<{ seq: number; delivery_id: string; type: string; payload_json: string }> =
    [];
  const pending: Promise<unknown>[] = [];
  let seq = 1;

  function run(sql: string, p: unknown[]): Record<string, unknown>[] {
    if (/^CREATE /i.test(sql) || /^ALTER TABLE/i.test(sql)) return [];
    // ensureResultColumn() probes for result_json; report it present.
    if (/^PRAGMA table_info\(review\)/i.test(sql)) return [{ name: 'result_json' }];
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
      const [prNumber, headSha] = p as [number, string];
      return [...reviews.values()]
        .filter(
          (r) =>
            r.pr_number === prNumber &&
            r.head_sha !== headSha &&
            (r.status === 'queued' || r.status === 'running'),
        )
        .map((r) => ({ delivery_id: r.delivery_id }));
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
        created_at,
      ] = p as [string, string, number, string, string, string, string, number, number];
      reviews.set(delivery_id, {
        delivery_id,
        repo,
        pr_number,
        head_sha,
        base_ref,
        head_ref,
        installation_id,
        is_cross_fork,
        status: 'queued',
        comments_posted: null,
        result_json: null,
        error_text: null,
        created_at,
        started_at: null,
        finished_at: null,
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
      setStatus(p[3] as string, {
        status: 'completed',
        comments_posted: p[0] as number,
        result_json: p[1] as string,
        finished_at: p[2] as number,
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
    throw new Error(`unhandled sql: ${sql}`);
  }

  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const rows = run(sql.trim(), params);
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
    },
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  };
  return { ctx, reviews, events, pending };
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
    const executor = vi.fn(async () => ({ result: RESULT, commentsPosted: 1 }));
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
    __setPrReviewExecutorOverride('d1', async () => ({ result: RESULT, commentsPosted: 1 }));
    __setPrReviewExecutorOverride('d2', async () => ({
      result: { ...RESULT, summary: 'second review' },
      commentsPosted: 0,
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

  it('dedupes a redelivered delivery id', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, {} as Env);
    const executor = vi.fn(async () => ({ result: RESULT, commentsPosted: 0 }));
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
    __setPrReviewExecutorOverride('d2', async () => ({ result: RESULT, commentsPosted: 1 }));

    await do_.fetch(startRequest(startInput({ deliveryId: 'd1', headSha: 'shaA' })));
    await do_.fetch(startRequest(startInput({ deliveryId: 'd2', headSha: 'shaB' })));
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
