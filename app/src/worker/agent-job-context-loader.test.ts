/**
 * Tests for the ContextLoader (PR 3): walks chatRef.checkpointId hop
 * by hop across CoderJob DOs, returns up to MAX_PRIOR_TURNS completed
 * summaries oldest-first, and degrades gracefully when prior jobs are
 * non-completed, missing, or hit fetch failures.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createWebContextLoader,
  formatPriorTurnsPreamble,
  MAX_PRIOR_TURNS,
  NULL_CONTEXT_LOADER,
  type ContextLoaderEnv,
  type TurnSummaryResponse,
} from './agent-job-context-loader';

interface FakeStub {
  fetch(req: Request): Promise<Response>;
}

function makeEnv(
  snapshots: Record<string, TurnSummaryResponse | null | 'throw'>,
): ContextLoaderEnv {
  return {
    CoderJob: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => {
        const jobId = id.toString();
        const stub: FakeStub = {
          fetch: async () => {
            const snapshot = snapshots[jobId];
            if (snapshot === 'throw') throw new Error('upstream-failure');
            if (snapshot === null || snapshot === undefined) {
              return new Response(JSON.stringify({ error: 'JOB_NOT_FOUND' }), { status: 404 });
            }
            return new Response(JSON.stringify(snapshot), { status: 200 });
          },
        };
        return stub;
      },
    },
  };
}

function completedSnapshot(
  jobId: string,
  priorCheckpointId: string | null = null,
  finishedAt = 1,
): TurnSummaryResponse {
  return {
    jobId,
    status: 'completed',
    task: `task-${jobId}`,
    summary: `summary-${jobId}`,
    finishedAt,
    priorCheckpointId,
  };
}

describe('NULL_CONTEXT_LOADER', () => {
  it('returns an empty array regardless of input', async () => {
    const out = await NULL_CONTEXT_LOADER.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'whatever' },
    });
    expect(out).toEqual([]);
  });
});

describe('createWebContextLoader — walking the chain', () => {
  it('returns [] when chatRef is undefined', async () => {
    const loader = createWebContextLoader({ env: makeEnv({}) });
    const out = await loader.loadPriorTurns({ chatRef: undefined });
    expect(out).toEqual([]);
  });

  it('returns [] when chatRef has no checkpointId', async () => {
    const loader = createWebContextLoader({ env: makeEnv({}) });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b' },
    });
    expect(out).toEqual([]);
  });

  it('returns [] when CoderJob binding is missing on env', async () => {
    const log = vi.fn();
    const loader = createWebContextLoader({ env: {}, log });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-1' },
    });
    expect(out).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/binding missing/i));
  });

  it('walks a single hop when only the first prior is completed', async () => {
    const env = makeEnv({
      'j-1': completedSnapshot('j-1', null, 100),
    });
    const loader = createWebContextLoader({ env });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-1' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      jobId: 'j-1',
      task: 'task-j-1',
      summary: 'summary-j-1',
      finishedAt: 100,
    });
  });

  it('walks the chain up to MAX_PRIOR_TURNS (3) and returns oldest-first', async () => {
    // Chain: j-3 -> j-2 -> j-1 (j-3 is most recent, j-1 is oldest).
    // The new turn carries checkpointId=j-3 so the walk hits j-3, j-2,
    // j-1 in that order; the loader reverses for oldest-first output.
    const env = makeEnv({
      'j-3': completedSnapshot('j-3', 'j-2', 300),
      'j-2': completedSnapshot('j-2', 'j-1', 200),
      'j-1': completedSnapshot('j-1', null, 100),
    });
    const loader = createWebContextLoader({ env });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-3' },
    });
    expect(out.map((t) => t.jobId)).toEqual(['j-1', 'j-2', 'j-3']);
    expect(out).toHaveLength(MAX_PRIOR_TURNS);
  });

  it('honors the maxTurns override (smaller than default)', async () => {
    const env = makeEnv({
      'j-3': completedSnapshot('j-3', 'j-2'),
      'j-2': completedSnapshot('j-2', 'j-1'),
      'j-1': completedSnapshot('j-1', null),
    });
    const loader = createWebContextLoader({ env });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-3' },
      maxTurns: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].jobId).toBe('j-3');
  });

  it('stops at the first non-completed prior job', async () => {
    // Mid-chain failure: j-2 is `failed`, so the walk stops there and
    // only j-3 makes it into the output. j-1 (further back) is never
    // reached even though it is completed.
    const env = makeEnv({
      'j-3': completedSnapshot('j-3', 'j-2'),
      'j-2': {
        jobId: 'j-2',
        status: 'failed',
        task: 'task-j-2',
        summary: null,
        finishedAt: null,
        priorCheckpointId: 'j-1',
      },
      'j-1': completedSnapshot('j-1', null),
    });
    const loader = createWebContextLoader({ env });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-3' },
    });
    expect(out.map((t) => t.jobId)).toEqual(['j-3']);
  });

  it('detects loops in the chain and truncates', async () => {
    // Pathological data: j-2 -> j-1 -> j-2 (cycle). Loop detection
    // stops the walk cleanly rather than spinning until maxTurns.
    const log = vi.fn();
    const env = makeEnv({
      'j-2': completedSnapshot('j-2', 'j-1'),
      'j-1': completedSnapshot('j-1', 'j-2'),
    });
    const loader = createWebContextLoader({ env, log });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-2' },
    });
    expect(out.map((t) => t.jobId)).toEqual(['j-1', 'j-2']);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/loop detected/i));
  });

  it('degrades gracefully on fetch failures (logs + stops walk)', async () => {
    const log = vi.fn();
    const env = makeEnv({
      'j-2': completedSnapshot('j-2', 'j-1'),
      'j-1': 'throw',
    });
    const loader = createWebContextLoader({ env, log });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-2' },
    });
    expect(out.map((t) => t.jobId)).toEqual(['j-2']);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/failed to fetch/i));
  });

  it('degrades gracefully on missing prior job (404)', async () => {
    const log = vi.fn();
    const env = makeEnv({
      'j-1': null,
    });
    const loader = createWebContextLoader({ env, log });
    const out = await loader.loadPriorTurns({
      chatRef: { chatId: 'c', repoFullName: 'r', branch: 'b', checkpointId: 'j-1' },
    });
    expect(out).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no snapshot/i));
  });
});

describe('formatPriorTurnsPreamble', () => {
  it('returns empty string for no summaries', () => {
    expect(formatPriorTurnsPreamble([])).toBe('');
  });

  it('formats each turn with task + outcome lines and a trailing blank', () => {
    const out = formatPriorTurnsPreamble([
      { jobId: 'j-1', task: 'fix bug', summary: 'fixed', finishedAt: 1 },
      { jobId: 'j-2', task: 'add test', summary: 'added', finishedAt: 2 },
    ]);
    expect(out).toContain('Prior turns in this chat (oldest to newest):');
    expect(out).toContain('- Task: fix bug');
    expect(out).toContain('  Outcome: fixed');
    expect(out).toContain('- Task: add test');
    expect(out).toContain('  Outcome: added');
    // Trailing blank so concatenating into a larger preamble doesn't
    // glue the next section onto the last outcome line.
    expect(out.endsWith('\n')).toBe(true);
  });
});
