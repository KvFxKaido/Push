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
  repoGatingEnabled,
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
  status: string;
  comments_posted: number | null;
  posted: number | null;
  result_json: string | null;
  error_text: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  check_run_id: number | null;
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
        posted: null,
        result_json: null,
        error_text: null,
        created_at,
        started_at: null,
        finished_at: null,
        check_run_id: null,
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
  return { ctx, reviews, events, pending, alarms };
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

  it('closes a superseded delivery’s check-run as neutral instead of leaving it hanging', async () => {
    const mock = createMockCtx();
    const do_ = new PrReviewJob(mock.ctx as never, APP_ENV);
    // d1 blocks until aborted; d2 (newer head) supersedes it.
    __setPrReviewExecutorOverride(
      'd1',
      (_input, _env, signal) =>
        new Promise((_resolve, reject) => {
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
      repo: 'octo/repo',
      pr_number: 7,
      head_sha: 'shaX',
      base_ref: 'main',
      head_ref: 'feature/x',
      installation_id: '42',
      is_cross_fork: 0,
      status: 'running',
      comments_posted: null,
      posted: null,
      result_json: null,
      error_text: null,
      created_at: Date.now(),
      started_at: Date.now(),
      finished_at: null,
      check_run_id: null,
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
});
