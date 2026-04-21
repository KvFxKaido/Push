/**
 * End-to-end test for the CoderJob DO. Instantiates the class with a
 * hand-rolled in-memory `DurableObjectState` stub that implements just
 * the SQL + waitUntil + storage surface the DO actually uses.
 *
 * Proves the Phase 1 PR #2 claim: the DO can drive `runCoderAgent`
 * server-side, persist `subagent.started` + `subagent.completed`
 * events to its SQLite event log, and serve them back over SSE with
 * `Last-Event-ID` replay.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { ProviderStreamFn } from '@push/lib/provider-contract';
import type { ChatMessage } from '@/types';
import { CoderJob, __setCoderJobServiceOverrides, type CoderJobStartInput } from './coder-job-do';
import type { CoderJobDetectorAdapter } from './coder-job-detector-adapter';
import type { CoderJobExecutorAdapter } from './coder-job-executor-adapter';
import type { Env } from './worker-middleware';

// ---------------------------------------------------------------------------
// In-memory SQL mock — covers exactly the queries the DO issues.
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  chat_id: string;
  repo: string;
  branch: string;
  sandbox_id: string;
  owner_token: string;
  origin: string;
  status: string;
  input_json: string;
  result_json: string | null;
  error_text: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface EventRow {
  seq: number;
  job_id: string;
  id: string;
  ts: number;
  type: string;
  payload_json: string;
}

function createMockStorage() {
  const jobs = new Map<string, JobRow>();
  const events: EventRow[] = [];
  let nextSeq = 1;

  function exec(
    sql: string,
    ...params: unknown[]
  ): { toArray(): Record<string, unknown>[] } & Iterable<Record<string, unknown>> {
    const rows = execQuery(sql.trim(), params);
    return {
      toArray: () => rows,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  }

  function execQuery(sql: string, params: unknown[]): Record<string, unknown>[] {
    if (/^CREATE TABLE/i.test(sql) || /^CREATE INDEX/i.test(sql)) return [];

    if (/^INSERT INTO job /i.test(sql)) {
      const [
        id,
        chat_id,
        repo,
        branch,
        sandbox_id,
        owner_token,
        origin,
        input_json,
        created_at,
        started_at,
      ] = params;
      jobs.set(id as string, {
        id: id as string,
        chat_id: chat_id as string,
        repo: repo as string,
        branch: branch as string,
        sandbox_id: sandbox_id as string,
        owner_token: owner_token as string,
        origin: origin as string,
        status: 'running',
        input_json: input_json as string,
        result_json: null,
        error_text: null,
        created_at: created_at as number,
        started_at: started_at as number,
        finished_at: null,
      });
      return [];
    }

    if (/^INSERT INTO event /i.test(sql)) {
      const [job_id, id, ts, type, payload_json] = params;
      events.push({
        seq: nextSeq++,
        job_id: job_id as string,
        id: id as string,
        ts: ts as number,
        type: type as string,
        payload_json: payload_json as string,
      });
      return [];
    }

    if (/^UPDATE job SET status/i.test(sql)) {
      const [status, finished_at, result_json, error_text, id] = params;
      const row = jobs.get(id as string);
      if (row) {
        row.status = status as string;
        row.finished_at = finished_at as number;
        row.result_json = result_json as string | null;
        row.error_text = error_text as string | null;
      }
      return [];
    }

    if (/^SELECT status FROM job WHERE id = \?/i.test(sql)) {
      const row = jobs.get(params[0] as string);
      return row ? [{ status: row.status }] : [];
    }

    if (/^SELECT id FROM job WHERE id = \?/i.test(sql)) {
      const row = jobs.get(params[0] as string);
      return row ? [{ id: row.id }] : [];
    }

    if (/^SELECT seq FROM event WHERE id = \?/i.test(sql)) {
      const ev = events.find((e) => e.id === params[0]);
      return ev ? [{ seq: ev.seq }] : [];
    }

    if (/^SELECT id, type, payload_json FROM event WHERE job_id = \? AND seq > \?/i.test(sql)) {
      const [job_id, minSeq] = params;
      return events
        .filter((e) => e.job_id === job_id && e.seq > (minSeq as number))
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ id: e.id, type: e.type, payload_json: e.payload_json }));
    }

    if (/^SELECT COUNT\(\*\) AS count FROM event WHERE job_id = \?/i.test(sql)) {
      const job_id = params[0] as string;
      return [{ count: events.filter((e) => e.job_id === job_id).length }];
    }

    if (/^SELECT id, status, created_at/i.test(sql)) {
      const row = jobs.get(params[0] as string);
      return row ? [row] : [];
    }

    throw new Error(`Unhandled SQL in mock: ${sql}`);
  }

  return { exec, jobs, events };
}

function makeCtx() {
  const storage = createMockStorage();
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    storage: { sql: { exec: storage.exec } },
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
  } as unknown as DurableObjectState;
  return { ctx, storage, waitUntilPromises };
}

function makeEnv(): Env {
  return {
    RATE_LIMITER: {} as unknown as Env['RATE_LIMITER'],
    ASSETS: {} as Env['ASSETS'],
  };
}

// ---------------------------------------------------------------------------
// Adapters — test doubles
// ---------------------------------------------------------------------------

const stubDetectors: CoderJobDetectorAdapter = {
  detectSandboxToolCall: () => null,
  detectWebSearchToolCall: () => null,
  detectAllToolCalls: () => ({
    readOnly: [],
    fileMutations: [],
    mutating: null,
    extraMutations: [],
  }),
  detectAnyToolCall: () => null,
  tagSandboxCall: (call) => ({ source: 'sandbox', call }),
  tagWebSearchCall: (call) => ({ source: 'web-search', call }),
};

const stubExecutor: CoderJobExecutorAdapter = {
  executeSandboxToolCall: async () => ({ text: 'noop' }),
  executeWebSearch: async () => ({ text: 'noop' }),
  sandboxStatus: async () => ({ head: 'HEAD', changedFiles: [] }),
};

/** Stream fn that immediately produces a short text response with no
 * tool calls — the kernel's first round completes, detector returns
 * null, loop exits. */
function makeNoToolStreamFn(summary: string): ProviderStreamFn<ChatMessage> {
  return async (_messages, onToken, onDone) => {
    onToken(summary);
    onDone({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  };
}

function makeStartInput(overrides: Partial<CoderJobStartInput> = {}): CoderJobStartInput {
  return {
    jobId: 'job-test-1',
    chatId: 'chat-1',
    repoFullName: 'acme/app',
    branch: 'main',
    sandboxId: 'sb-1',
    ownerToken: 'tok-1',
    origin: 'https://push.example.test',
    envelope: {
      task: 'write hello world',
      files: [],
      provider: 'openrouter',
    } as CoderJobStartInput['envelope'],
    provider: 'openrouter',
    model: 'sonnet-4.6',
    userProfile: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoderJob DO — end-to-end', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the Coder kernel and emits subagent.started + subagent.completed events', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-run-1' });

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      streamFn: makeNoToolStreamFn('Task complete.'),
    });

    const job = new CoderJob(ctx, makeEnv());
    const response = await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(202);
    await Promise.all(waitUntilPromises);

    const eventTypes = storage.events.map((e) => e.type);
    expect(eventTypes).toEqual(['subagent.started', 'subagent.completed']);

    const completed = JSON.parse(storage.events[1]!.payload_json) as {
      type: string;
      agent: string;
      summary: string;
    };
    expect(completed.type).toBe('subagent.completed');
    expect(completed.agent).toBe('coder');
    expect(completed.summary).toContain('Task complete');

    const jobRow = storage.jobs.get(input.jobId)!;
    expect(jobRow.status).toBe('completed');
    expect(jobRow.finished_at).toBeTypeOf('number');
  });

  it('persists subagent.failed when the stream errors', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-fail-1' });

    const failingStream: ProviderStreamFn<ChatMessage> = async (_m, _t, _d, onError) => {
      onError(new Error('provider exploded'));
    };

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      streamFn: failingStream,
    });

    const job = new CoderJob(ctx, makeEnv());
    await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    );
    await Promise.all(waitUntilPromises);

    const eventTypes = storage.events.map((e) => e.type);
    expect(eventTypes).toEqual(['subagent.started', 'subagent.failed']);
    const jobRow = storage.jobs.get(input.jobId)!;
    expect(jobRow.status).toBe('failed');
    expect(jobRow.error_text ?? '').toContain('provider exploded');
  });

  it('replays persisted events over SSE using Last-Event-ID', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-replay-1' });

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      streamFn: makeNoToolStreamFn('done'),
    });

    const job = new CoderJob(ctx, makeEnv());
    await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    );
    await Promise.all(waitUntilPromises);

    // Reconnect mid-way: supply the started event's id as Last-Event-ID,
    // the stream should replay only the completed event.
    const startedEventId = storage.events[0]!.id;
    const sseResponse = await job.fetch(
      new Request(`https://do/events?jobId=${input.jobId}`, {
        method: 'GET',
        headers: { 'Last-Event-ID': startedEventId },
      }),
    );
    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get('content-type')).toBe('text/event-stream');

    const body = await sseResponse.text();
    expect(body).not.toContain('event: subagent.started');
    expect(body).toContain('event: subagent.completed');
  });

  it('returns 404 for /events on unknown jobId', async () => {
    const { ctx } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());
    const response = await job.fetch(
      new Request('https://do/events?jobId=nope', { method: 'GET' }),
    );
    expect(response.status).toBe(404);
  });

  it('status snapshot reports terminal state + event count', async () => {
    const { ctx, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-status-1' });
    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      streamFn: makeNoToolStreamFn('ok'),
    });
    const job = new CoderJob(ctx, makeEnv());
    await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    );
    await Promise.all(waitUntilPromises);

    const statusResponse = await job.fetch(
      new Request(`https://do/status?jobId=${input.jobId}`, { method: 'GET' }),
    );
    expect(statusResponse.status).toBe(200);
    const snapshot = (await statusResponse.json()) as {
      status: string;
      eventCount: number;
    };
    expect(snapshot.status).toBe('completed');
    expect(snapshot.eventCount).toBe(2);
  });
});
