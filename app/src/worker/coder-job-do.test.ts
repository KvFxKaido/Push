/**
 * End-to-end test for the CoderJob DO. Instantiates the class with a
 * hand-rolled in-memory `DurableObjectState` stub that implements just
 * the SQL + waitUntil + storage surface the DO actually uses.
 *
 * Proves the AgentJob contract for `role: 'coder'`: the DO can drive
 * `runCoderAgent` server-side, persist `job.started` + `job.completed`
 * events to its SQLite event log, and serve them back over SSE with
 * `Last-Event-ID` replay.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// PR #3a wired the DO's executor adapter to handleCloudflareSandbox,
// which in turn imports @cloudflare/sandbox — a Cloudflare-only module
// that isn't resolvable in the node test environment. The adapter is
// never called in these tests (service overrides inject stubs), so a
// minimal module mock is enough to keep module load green.
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
}));
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { LlmContentPart, PushStream } from '@push/lib/provider-contract';
import type { AttachmentData, ChatMessage } from '@/types';
import {
  CoderJob,
  MAX_DO_RESTART_RESUMES,
  MAX_JOB_WALL_CLOCK_MS,
  __setCoderJobServiceOverrides,
  resolveJobLeadModeOptions,
  type CoderJobStartInput,
} from './coder-job-do';
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
  do_resume_count: number;
}

interface EventRow {
  seq: number;
  job_id: string;
  id: string;
  ts: number;
  type: string;
  payload_json: string;
}

interface CheckpointRow {
  job_id: string;
  round: number;
  snapshot_id: string;
  restore_token: string;
  agent_state_json: string;
  created_at: number;
}

interface SuspensionRow {
  job_id: string;
  round: number;
  question: string;
  context: string;
  resume_schema_json: string;
  created_at: number;
}

function createMockStorage() {
  const jobs = new Map<string, JobRow>();
  const events: EventRow[] = [];
  const checkpoints = new Map<string, CheckpointRow>();
  const suspensions = new Map<string, SuspensionRow>();
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

    if (/^ALTER TABLE/i.test(sql)) return [];

    if (/^PRAGMA table_info\(job\)/i.test(sql)) {
      // Mimic the column list a freshly-created `job` table would have.
      return [
        { name: 'id' },
        { name: 'chat_id' },
        { name: 'repo' },
        { name: 'branch' },
        { name: 'sandbox_id' },
        { name: 'owner_token' },
        { name: 'origin' },
        { name: 'status' },
        { name: 'input_json' },
        { name: 'result_json' },
        { name: 'error_text' },
        { name: 'created_at' },
        { name: 'started_at' },
        { name: 'finished_at' },
        { name: 'do_resume_count' },
      ];
    }

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
        do_resume_count: 0,
      });
      return [];
    }

    if (/^UPDATE job SET do_resume_count = \? WHERE id = \?/i.test(sql)) {
      const [count, id] = params;
      const row = jobs.get(id as string);
      if (row) row.do_resume_count = count as number;
      return [];
    }

    if (/^SELECT id, input_json, do_resume_count FROM job WHERE status = 'running'/i.test(sql)) {
      return [...jobs.values()]
        .filter((j) => j.status === 'running')
        .map((j) => ({
          id: j.id,
          input_json: j.input_json,
          do_resume_count: j.do_resume_count,
        }));
    }

    if (/^INSERT OR REPLACE INTO checkpoint/i.test(sql)) {
      const [job_id, round, snapshot_id, restore_token, agent_state_json, created_at] = params;
      checkpoints.set(job_id as string, {
        job_id: job_id as string,
        round: round as number,
        snapshot_id: snapshot_id as string,
        restore_token: restore_token as string,
        agent_state_json: agent_state_json as string,
        created_at: created_at as number,
      });
      return [];
    }

    if (
      /^SELECT round, snapshot_id, restore_token, agent_state_json FROM checkpoint WHERE job_id = \?/i.test(
        sql,
      )
    ) {
      const row = checkpoints.get(params[0] as string);
      return row
        ? [
            {
              round: row.round,
              snapshot_id: row.snapshot_id,
              restore_token: row.restore_token,
              agent_state_json: row.agent_state_json,
            },
          ]
        : [];
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

    // Durable suspend: markSuspended (literal status, id only).
    if (/^UPDATE job SET status = 'suspended' WHERE id = \?/i.test(sql)) {
      const row = jobs.get(params[0] as string);
      if (row) row.status = 'suspended';
      return [];
    }

    // Resume claim: suspended→running with a fresh started_at.
    if (/^UPDATE job SET status = 'running', started_at = \? WHERE id = \?/i.test(sql)) {
      const [started_at, id] = params;
      const row = jobs.get(id as string);
      if (row) {
        row.status = 'running';
        row.started_at = started_at as number;
      }
      return [];
    }

    // Generic terminal transition (markTerminal): 5 params.
    if (/^UPDATE job SET status = \?, finished_at/i.test(sql)) {
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

    if (/^INSERT OR REPLACE INTO suspension/i.test(sql)) {
      const [job_id, round, question, context, resume_schema_json, created_at] = params;
      suspensions.set(job_id as string, {
        job_id: job_id as string,
        round: round as number,
        question: question as string,
        context: context as string,
        resume_schema_json: resume_schema_json as string,
        created_at: created_at as number,
      });
      return [];
    }

    if (
      /^SELECT round, question, context, resume_schema_json FROM suspension WHERE job_id = \?/i.test(
        sql,
      )
    ) {
      const row = suspensions.get(params[0] as string);
      return row
        ? [
            {
              round: row.round,
              question: row.question,
              context: row.context,
              resume_schema_json: row.resume_schema_json,
            },
          ]
        : [];
    }

    if (/^DELETE FROM suspension WHERE job_id = \?/i.test(sql)) {
      suspensions.delete(params[0] as string);
      return [];
    }

    if (/^SELECT input_json FROM job WHERE id = \?/i.test(sql)) {
      const row = jobs.get(params[0] as string);
      return row ? [{ input_json: row.input_json }] : [];
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
      return row ? [row as unknown as Record<string, unknown>] : [];
    }

    if (/^SELECT id, chat_id, status, input_json, finished_at FROM job WHERE id = \?/i.test(sql)) {
      const row = jobs.get(params[0] as string);
      return row
        ? [
            {
              id: row.id,
              chat_id: row.chat_id,
              status: row.status,
              input_json: row.input_json,
              finished_at: row.finished_at,
            },
          ]
        : [];
    }

    if (
      /^SELECT payload_json FROM event WHERE job_id = \? AND type = 'job\.completed'/i.test(sql)
    ) {
      const job_id = params[0] as string;
      const matching = events
        .filter((e) => e.job_id === job_id && e.type === 'job.completed')
        .sort((a, b) => b.seq - a.seq);
      return matching.length > 0 ? [{ payload_json: matching[0]!.payload_json }] : [];
    }

    if (/^SELECT id, started_at FROM job\s+WHERE status = 'running'/i.test(sql)) {
      return [...jobs.values()]
        .filter((j) => j.status === 'running' && j.started_at != null)
        .map((j) => ({ id: j.id, started_at: j.started_at as number }));
    }

    if (/^SELECT MIN\(started_at\) AS oldest FROM job/i.test(sql)) {
      const running = [...jobs.values()].filter(
        (j) => j.status === 'running' && j.started_at != null,
      );
      if (running.length === 0) return [{ oldest: null }];
      return [{ oldest: Math.min(...running.map((j) => j.started_at as number)) }];
    }

    if (/^SELECT MAX\(ts\) AS last_ts FROM event WHERE job_id = \?/i.test(sql)) {
      const jobId = params[0] as string;
      const tsValues = events.filter((e) => e.job_id === jobId).map((e) => e.ts);
      return [{ last_ts: tsValues.length > 0 ? Math.max(...tsValues) : null }];
    }

    throw new Error(`Unhandled SQL in mock: ${sql}`);
  }

  return { exec, jobs, events, checkpoints, suspensions };
}

function makeCtx() {
  const storage = createMockStorage();
  const waitUntilPromises: Promise<unknown>[] = [];
  const alarms: Array<number | null> = [];
  const ctx = {
    storage: {
      sql: { exec: storage.exec },
      setAlarm: async (scheduledTime: number) => {
        alarms.push(scheduledTime);
      },
      deleteAlarm: async () => {
        alarms.push(null);
      },
    },
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
  } as unknown as DurableObjectState;
  return { ctx, storage, waitUntilPromises, alarms };
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
    droppedCandidates: [],
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

/** Stream fn that immediately produces a grounded terminal response with no
 * tool calls — the kernel's first round completes, detector returns null, and
 * the strict delegated-Coder completion guard has concrete file evidence. */
function makeNoToolStreamFn(summary: string): PushStream<ChatMessage> {
  return () =>
    (async function* () {
      yield { type: 'text_delta', text: `${summary} I modified the fixture.ts file.` };
      yield {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    })();
}

/** Raw terminal text used when a test needs to exercise completion policy. */
function makeRawTextStreamFn(summary: string): PushStream<ChatMessage> {
  return () =>
    (async function* () {
      yield { type: 'text_delta', text: summary };
      yield {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    })();
}

/** Stream fn that emits a single `coder_checkpoint` guidance call as fenced
 * JSON. Under `durableSuspension` (leadMode jobs) the kernel throws
 * `CoderSuspendedError` on seeing this, parking the run. */
function makeCheckpointStreamFn(question: string, context = ''): PushStream<ChatMessage> {
  const body = JSON.stringify({ tool: 'coder_checkpoint', args: { question, context } });
  return () =>
    (async function* () {
      yield { type: 'text_delta', text: '```json\n' + body + '\n```' };
      yield {
        type: 'done',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    })();
}

/** A leadMode start input — durable suspension is only wired for lead turns
 * (the human is the counterparty to a guidance call). */
function makeLeadStartInput(overrides: Partial<CoderJobStartInput> = {}): CoderJobStartInput {
  const base = makeStartInput(overrides);
  return {
    ...base,
    envelope: { ...base.envelope, leadMode: true } as CoderJobStartInput['envelope'],
  };
}

function makeStartInput(overrides: Partial<CoderJobStartInput> = {}): CoderJobStartInput {
  return {
    role: 'coder',
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

describe('resolveJobLeadModeOptions', () => {
  it('runs a lead turn in leadMode with no explicit cap (high invisible backstop)', () => {
    const opts = resolveJobLeadModeOptions({
      leadMode: true,
      harnessSettings: { maxCoderRounds: 30 } as never,
    });
    expect(opts.persona).toBe('lead');
    // undefined → the kernel applies LEAD_MAX_ROUNDS (150) + graceful close.
    expect(opts.harnessMaxRounds).toBeUndefined();
    // The DO is sandbox + web-search only — scope lead guidance accordingly so
    // it doesn't steer toward PR/CI/merge/promote/artifact/ask-user tools.
    expect(opts.leadToolScope).toBe('sandbox');
  });

  it('keeps the delegated sub-Coder cap when leadMode is unset', () => {
    const opts = resolveJobLeadModeOptions({
      harnessSettings: { maxCoderRounds: 30 } as never,
    });
    expect(opts.persona).toBe('coder');
    expect(opts.harnessMaxRounds).toBe(30);
    // Irrelevant for a delegated Coder (non-lead guidelines) — left unset.
    expect(opts.leadToolScope).toBeUndefined();
  });

  it('passes through undefined cap for a delegated job with no harness override', () => {
    const opts = resolveJobLeadModeOptions({});
    expect(opts.persona).toBe('coder');
    expect(opts.harnessMaxRounds).toBeUndefined();
    expect(opts.leadToolScope).toBeUndefined();
  });
});

describe('CoderJob DO — end-to-end', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the Coder kernel and emits job.started + job.completed events with role=coder', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-run-1' });

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeNoToolStreamFn('Task complete.'),
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
    // The DO forwards the Coder kernel's prompt snapshot and per-round
    // assistant turn events onto its SSE journal between `job.started`
    // and `job.completed`. This keeps background Coder jobs observable
    // with the same vocabulary as foreground lead turns.
    expect(eventTypes).toEqual([
      'job.started',
      'assistant.prompt_snapshot',
      'assistant.turn_start',
      'assistant.turn_end',
      'job.completed',
    ]);

    const started = JSON.parse(storage.events[0]!.payload_json) as {
      type: string;
      role: string;
    };
    expect(started.type).toBe('job.started');
    expect(started.role).toBe('coder');

    const completedEvent = storage.events.find((event) => event.type === 'job.completed')!;
    const completed = JSON.parse(completedEvent.payload_json) as {
      type: string;
      role: string;
      summary: string;
    };
    expect(completed.type).toBe('job.completed');
    expect(completed.role).toBe('coder');
    expect(completed.summary).toContain('Task complete');

    const jobRow = storage.jobs.get(input.jobId)!;
    expect(jobRow.status).toBe('completed');
    expect(jobRow.finished_at).toBeTypeOf('number');
  });

  it('lets a conversational background lead return an ordinary short answer', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeLeadStartInput({ jobId: 'job-lead-conversation' });
    input.envelope.task = 'What changed?';

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeRawTextStreamFn('Nothing changed.'),
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

    const row = storage.jobs.get(input.jobId)!;
    expect(row.status).toBe('completed');
    expect(JSON.parse(row.result_json ?? '{}').summary).toContain('Nothing changed.');
    expect(storage.events.filter((event) => event.type === 'assistant.turn_start')).toHaveLength(1);
  });

  it('converts envelope attachments into the initial coder-task content parts', async () => {
    const { ctx, waitUntilPromises } = makeCtx();
    const attachments: AttachmentData[] = [
      {
        id: 'img-1',
        type: 'image',
        filename: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        content: 'data:image/png;base64,abc123',
      },
      {
        id: 'doc-1',
        type: 'document',
        filename: 'brief.md',
        mimeType: 'text/markdown',
        sizeBytes: 7,
        content: '# Brief',
      },
    ];
    const input = makeStartInput({
      jobId: 'job-attachments',
      envelope: {
        task: 'inspect attached files',
        attachments,
        files: [],
        provider: 'openrouter',
      } as CoderJobStartInput['envelope'],
    });
    let capturedInitial:
      | { id: string; content: string; contentParts?: LlmContentPart[] }
      | undefined;
    const capturingStream: PushStream<ChatMessage> = (req) => {
      capturedInitial = req.messages.find((message) => message.id === 'coder-task') as
        | { id: string; content: string; contentParts?: LlmContentPart[] }
        | undefined;
      return (async function* () {
        yield { type: 'text_delta', text: 'Task complete.' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: capturingStream,
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

    expect(capturedInitial?.content).toContain('inspect attached files');
    expect(capturedInitial?.contentParts).toEqual([
      { type: 'text', text: capturedInitial?.content },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
      { type: 'text', text: '[Attached file: brief.md]\n```\n# Brief\n```' },
    ]);
  });

  it('assembles prior-turn attachments from the chain walk, ordered preamble → prior → current (#938)', async () => {
    const { ctx, waitUntilPromises } = makeCtx();
    const priorImg: AttachmentData = {
      id: 'prior-img',
      type: 'image',
      filename: 'prior.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      content: 'data:image/png;base64,prior',
    };
    const currentImg: AttachmentData = {
      id: 'cur-img',
      type: 'image',
      filename: 'cur.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      content: 'data:image/png;base64,cur',
    };
    const input = makeStartInput({
      jobId: 'job-prior-atts',
      chatRef: {
        chatId: 'chat-1',
        repoFullName: 'acme/app',
        branch: 'main',
        checkpointId: 'job-prior',
      },
      envelope: {
        task: 'compare with the previous screenshot',
        files: [],
        provider: 'openrouter',
        attachments: [currentImg],
      } as CoderJobStartInput['envelope'],
    });

    let capturedInitial: { content: string; contentParts?: LlmContentPart[] } | undefined;
    const capturingStream: PushStream<ChatMessage> = (req) => {
      capturedInitial = req.messages.find((m) => m.id === 'coder-task') as typeof capturedInitial;
      return (async function* () {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: capturingStream,
      // Stub the chain walk: one completed prior turn that carried an image.
      contextLoader: {
        async loadPriorTurns() {
          return [
            {
              jobId: 'job-prior',
              task: 'first screenshot',
              summary: 'looked at it',
              finishedAt: 1,
              attachments: [priorImg],
            },
          ];
        },
      },
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

    // Prior image (labeled) precedes the current image; both follow the
    // preamble text. The prior pixels come from the walk, not a client list.
    expect(capturedInitial?.contentParts).toEqual([
      { type: 'text', text: capturedInitial?.content },
      { type: 'text', text: '[Image from prior turn: prior.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,prior' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cur' } },
    ]);
  });

  it('persists job.failed when the stream errors', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-fail-1' });

    const failingStream: PushStream<ChatMessage> = () => {
      // Async generator that throws on first iteration. Defined inline rather
      // than as a `function*` body with a stray `yield` after `throw` to keep
      // ESLint's `no-unreachable` rule clean.
      const thrower: AsyncIterable<never> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<never>> {
              return Promise.reject(new Error('provider exploded'));
            },
          };
        },
      };
      return thrower as unknown as ReturnType<PushStream<ChatMessage>>;
    };

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: failingStream,
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
    // Prompt snapshot fires before the stream errors because the emit is inside
    // the kernel's prompt-build phase; turn_start/end then bracket the failed
    // model round before the job terminal event.
    expect(eventTypes).toEqual([
      'job.started',
      'assistant.prompt_snapshot',
      'assistant.turn_start',
      'assistant.turn_end',
      'job.failed',
    ]);
    const failedEvent = storage.events.find((event) => event.type === 'job.failed')!;
    const failed = JSON.parse(failedEvent.payload_json) as {
      type: string;
      role: string;
      error: string;
    };
    expect(failed.role).toBe('coder');
    const jobRow = storage.jobs.get(input.jobId)!;
    expect(jobRow.status).toBe('failed');
    expect(jobRow.error_text ?? '').toContain('provider exploded');
  });

  it('fails fast when the pre-run liveness probe reports the sandbox dead', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-probe-dead' });

    let probed: string | null = null;
    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeNoToolStreamFn('should never stream'),
      livenessProbe: async (sandboxId) => {
        probed = sandboxId;
        return { alive: false, reason: 'dead', attempts: 3, error: 'container gone' };
      },
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

    expect(probed).toBe('sb-1');
    // Fail-fast: no model round runs (no prompt snapshot), the job lands in
    // 'failed' with an actionable message instead of hanging until the first
    // kernel exec discovers the dead sandbox.
    const eventTypes = storage.events.map((e) => e.type);
    expect(eventTypes).toEqual(['job.started', 'job.failed']);
    const jobRow = storage.jobs.get(input.jobId)!;
    expect(jobRow.status).toBe('failed');
    expect(jobRow.error_text ?? '').toMatch(/before the job started/i);
  });

  it('runs normally when the pre-run liveness probe reports alive', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-probe-alive' });

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeNoToolStreamFn('Task complete.'),
      livenessProbe: async () => ({ alive: true, attempts: 1 }),
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

    expect(storage.jobs.get(input.jobId)!.status).toBe('completed');
  });

  it('captureCheckpoint retries transient snapshot failures before persisting', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, storage } = makeCtx();
      const job = new CoderJob(ctx, makeEnv());

      let calls = 0;
      __setCoderJobServiceOverrides('job-cp-retry', {
        snapshot: async () => {
          calls += 1;
          if (calls < 3) return { ok: false, error: 'transient R2 blip', status: 500 };
          return { ok: true, snapshotId: 'snapshot:retry-ok', restoreToken: 'rt', sizeBytes: 1 };
        },
      });

      const capture = (
        job as unknown as {
          captureCheckpoint(jobId: string, sandboxId: string, state: unknown): Promise<void>;
        }
      ).captureCheckpoint('job-cp-retry', 'sb-1', {
        round: 5,
        messages: [],
        workingMemory: null,
        cards: [],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await capture;

      expect(calls).toBe(3);
      expect(storage.checkpoints.get('job-cp-retry')).toMatchObject({
        snapshot_id: 'snapshot:retry-ok',
        round: 5,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('captureCheckpoint does not retry deterministic failures (too-large, not-configured)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    let calls = 0;
    __setCoderJobServiceOverrides('job-cp-large', {
      snapshot: async () => {
        calls += 1;
        return { ok: false, error: 'archive exceeds cap', status: 413 };
      },
    });

    await (
      job as unknown as {
        captureCheckpoint(jobId: string, sandboxId: string, state: unknown): Promise<void>;
      }
    ).captureCheckpoint('job-cp-large', 'sb-1', {
      round: 10,
      messages: [],
      workingMemory: null,
      cards: [],
    });

    expect(calls).toBe(1);
    expect(storage.checkpoints.has('job-cp-large')).toBe(false);
    // Too-large gets its own event name — it recurs every cadence once the
    // workspace outgrows the cap, and the remediation differs from a
    // transient storage failure.
    const events = warn.mock.calls
      .map((args) => {
        try {
          return JSON.parse(args[0] as string) as { event?: string };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { event: string } => Boolean(entry?.event));
    expect(events.map((e) => e.event)).toContain('coder_checkpoint_too_large');
  });

  it('rejects /start with an unsupported role at the DO layer (defense in depth)', async () => {
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());
    // Worker route normally guards against this, but the DO must
    // reject too so direct callers (tests, future code) can't half-
    // persist a run for a role that has no kernel wired.
    const input = { ...makeStartInput({ jobId: 'job-bad-role' }), role: 'planner' };
    const response = await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: string; role: string };
    expect(parsed.error).toBe('UNSUPPORTED_ROLE');
    expect(parsed.role).toBe('planner');
    // No row written, no event emitted.
    expect(storage.jobs.get('job-bad-role')).toBeUndefined();
    expect(storage.events.length).toBe(0);
  });

  it('rejects /start with missing role at the DO layer (MISSING_FIELDS)', async () => {
    // Mirrors the route layer's missing-vs-unsupported distinction.
    // Direct DO callers (tests, internal code) that omit role get the
    // same MISSING_FIELDS error vocabulary they'd get going through
    // /api/jobs/start, instead of being lumped under UNSUPPORTED_ROLE.
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());
    const { role: _omitted, ...inputWithoutRole } = makeStartInput({ jobId: 'job-no-role' });
    void _omitted;
    const response = await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(inputWithoutRole),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(response.status).toBe(400);
    const parsed = (await response.json()) as { error: string; fields: string[] };
    expect(parsed.error).toBe('MISSING_FIELDS');
    expect(parsed.fields).toContain('role');
    expect(storage.jobs.get('job-no-role')).toBeUndefined();
    expect(storage.events.length).toBe(0);
  });

  it('replays persisted events over SSE using Last-Event-ID', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-replay-1' });

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeNoToolStreamFn('done'),
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
    expect(body).not.toContain('event: job.started');
    expect(body).toContain('event: job.completed');
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
      stream: makeNoToolStreamFn('ok'),
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
      lastEventAt: number | null;
    };
    expect(snapshot.status).toBe('completed');
    // `job.started`, `assistant.prompt_snapshot`, turn_start/end,
    // `job.completed`.
    expect(snapshot.eventCount).toBe(5);
    expect(typeof snapshot.lastEventAt).toBe('number');
  });

  it('status snapshot reports lastEventAt: null for jobs with no events yet', async () => {
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    // Warm the DO — see comment on the `/turn-summary` non-completed test.
    await job.fetch(new Request('https://do/status?jobId=warmup-noop', { method: 'GET' }));

    // Seed a running job directly without going through handleStart so
    // no `job.started` event is appended.
    storage.jobs.set('job-noev', {
      id: 'job-noev',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: '{}',
      result_json: null,
      error_text: null,
      created_at: Date.now(),
      started_at: Date.now(),
      finished_at: null,
      do_resume_count: 0,
    });

    const response = await job.fetch(
      new Request('https://do/status?jobId=job-noev', { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as { lastEventAt: number | null };
    expect(snapshot.lastEventAt).toBeNull();
  });

  it('runLoop does not overwrite a terminal state written by alarm()', async () => {
    // Simulates the race the reviewers flagged: alarm() fires and marks
    // the job 'failed' while runLoop is still awaiting the kernel. The
    // kernel's underlying sandbox/provider promise ignores abort and
    // resolves cleanly — runLoop would then try to call markTerminal
    // with 'completed'. Without the conditional guard this would stomp
    // the alarm's terminal write and emit a duplicate SSE event.
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-race' });

    let releaseStream: () => void = () => {};
    const parkedStream: PushStream<ChatMessage> = () =>
      (async function* () {
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield {
          type: 'text_delta',
          text: 'ignored by alarm; I modified the fixture.ts file.',
        };
        yield {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      })();

    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: parkedStream,
    });

    const job = new CoderJob(ctx, makeEnv());
    await job.fetch(
      new Request('https://do/start', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    );
    // runLoop is now parked inside runCoderAgentLib. Simulate alarm's
    // winning terminal write by flipping the row directly.
    storage.jobs.get(input.jobId)!.status = 'failed';
    storage.jobs.get(input.jobId)!.error_text = 'alarm won';

    // Unblock the stream so runLoop races to its completion path.
    releaseStream();
    await Promise.all(waitUntilPromises);

    // Conditional markTerminal saw status !== 'running' and no-opped.
    expect(storage.jobs.get(input.jobId)!.status).toBe('failed');
    expect(storage.jobs.get(input.jobId)!.error_text).toBe('alarm won');
    const terminalEvents = storage.events
      .map((e) => e.type)
      .filter((t) => t === 'job.completed' || t === 'job.failed');
    // The test seeded the terminal row directly (bypassing appendEvent),
    // so there should be zero terminal events from runLoop — proving the
    // broadcast is gated on winning the mark.
    expect(terminalEvents).toEqual([]);
  });

  it('SSE stream emits heartbeat comments while the job is running', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, storage } = makeCtx();
      const job = new CoderJob(ctx, makeEnv());

      // Warm the DO — see comment on the `/turn-summary` non-completed test.
      await job.fetch(new Request('https://do/status?jobId=warmup-noop', { method: 'GET' }));

      storage.jobs.set('job-hb', {
        id: 'job-hb',
        chat_id: 'c',
        repo: 'a/b',
        branch: 'main',
        sandbox_id: 'sb',
        owner_token: 't',
        origin: 'https://push.example.test',
        status: 'running',
        input_json: '{}',
        result_json: null,
        error_text: null,
        created_at: Date.now(),
        started_at: Date.now(),
        finished_at: null,
        do_resume_count: 0,
      });

      const response = await job.fetch(
        new Request('https://do/events?jobId=job-hb', { method: 'GET' }),
      );
      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // No real events enqueued yet — first read blocks until the
      // heartbeat interval fires.
      const firstRead = reader.read();
      await vi.advanceTimersByTimeAsync(25_000);
      const { value } = await firstRead;
      const chunk = decoder.decode(value);
      expect(chunk).toContain('heartbeat');

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('alarm() force-terminates a run that has exceeded its wall-clock budget', async () => {
    const { ctx, storage, alarms } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    // Inject a running job whose started_at is beyond the budget. We
    // write to the storage map directly rather than go through
    // handleStart + a hanging streamFn so the test doesn't need fake
    // timers or a promise that never settles.
    const startedLongAgo = Date.now() - MAX_JOB_WALL_CLOCK_MS - 5_000;
    storage.jobs.set('job-stalled', {
      id: 'job-stalled',
      chat_id: 'chat-1',
      repo: 'acme/app',
      branch: 'main',
      sandbox_id: 'sb-1',
      owner_token: 'tok-1',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-stalled' })),
      result_json: null,
      error_text: null,
      created_at: startedLongAgo,
      started_at: startedLongAgo,
      finished_at: null,
      do_resume_count: 0,
    });

    await job.alarm();

    const row = storage.jobs.get('job-stalled')!;
    expect(row.status).toBe('failed');
    expect(row.error_text).toMatch(/wall-clock budget/i);
    expect(row.finished_at).toBeTypeOf('number');

    const failed = storage.events.find((e) => e.type === 'job.failed');
    expect(failed).toBeDefined();
    expect(JSON.parse(failed!.payload_json).error).toMatch(/stalled|forcibly terminated/i);

    // No running jobs left → alarm should be cleared.
    expect(alarms.at(-1)).toBeNull();
  });

  it('alarm() leaves a still-fresh running job alone and reschedules the alarm', async () => {
    const { ctx, storage, alarms } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    const startedRecently = Date.now() - 60_000; // 1 minute ago
    storage.jobs.set('job-fresh', {
      id: 'job-fresh',
      chat_id: 'chat-1',
      repo: 'acme/app',
      branch: 'main',
      sandbox_id: 'sb-1',
      owner_token: 'tok-1',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-fresh' })),
      result_json: null,
      error_text: null,
      created_at: startedRecently,
      started_at: startedRecently,
      finished_at: null,
      do_resume_count: 0,
    });

    await job.alarm();

    expect(storage.jobs.get('job-fresh')!.status).toBe('running');
    expect(storage.events.length).toBe(0);
    // Alarm rescheduled to this job's deadline.
    expect(alarms.at(-1)).toBe(startedRecently + MAX_JOB_WALL_CLOCK_MS);
  });

  // ---------------------------------------------------------------------------
  // /turn-summary route — internal endpoint walked by ContextLoader (PR 3)
  // ---------------------------------------------------------------------------

  it('/turn-summary returns task + summary + priorCheckpointId for a completed job', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const tsImage: AttachmentData = {
      id: 'ts-img',
      type: 'image',
      filename: 'prior.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      content: 'data:image/png;base64,prior',
    };
    const input = makeStartInput({
      jobId: 'job-ts-1',
      // Pin the chatRef so the loader can walk back from this job.
      chatRef: {
        chatId: 'chat-1',
        repoFullName: 'acme/app',
        branch: 'main',
        checkpointId: 'job-prior',
      },
      envelope: {
        task: 'write hello world',
        files: [],
        provider: 'openrouter',
        attachments: [tsImage],
      } as CoderJobStartInput['envelope'],
    });
    __setCoderJobServiceOverrides(input.jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeNoToolStreamFn('outcome text'),
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
    expect(storage.jobs.get(input.jobId)!.status).toBe('completed');

    const resp = await job.fetch(
      new Request(`https://do/turn-summary?jobId=${input.jobId}`, { method: 'GET' }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      jobId: string;
      chatId: string | null;
      status: string;
      task: string;
      summary: string | null;
      finishedAt: number | null;
      priorCheckpointId: string | null;
      attachments?: AttachmentData[];
    };
    expect(body.jobId).toBe(input.jobId);
    // chatId is included so the loader can enforce same-chat continuity
    // — defense against forged checkpointIds (Copilot review fix).
    expect(body.chatId).toBe('chat-1');
    expect(body.status).toBe('completed');
    expect(body.task).toBe('write hello world');
    expect(body.summary).toContain('outcome text');
    expect(typeof body.finishedAt).toBe('number');
    expect(body.priorCheckpointId).toBe('job-prior');
    // #938: the persisted envelope's attachments ride the same endpoint the
    // ContextLoader walks, so prior-turn images reach a later background turn.
    expect(body.attachments).toEqual([tsImage]);
  });

  it('/turn-summary returns null summary for a non-completed job (loader stops here)', async () => {
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());
    // Warm the DO so the orphan-recovery sweep is a no-op when the real
    // fetch lands. In production a `status='running'` row on a cold DO is
    // an orphan (the runLoop died with the prior isolate) and the sweep
    // correctly fails it; the test fixture below shortcuts that path by
    // seeding a row directly, so we have to mimic a warm DO here.
    await job.fetch(new Request('https://do/status?jobId=warmup-noop', { method: 'GET' }));
    // Seed a job row that's still running — no terminal event yet. It carries
    // an attachment in its envelope to prove the "no summary, no attachments"
    // contract: a non-completed turn must not ship base64 bytes the loader
    // would discard anyway.
    storage.jobs.set('job-running', {
      id: 'job-running',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(
        makeStartInput({
          jobId: 'job-running',
          envelope: {
            task: 'in progress',
            files: [],
            provider: 'openrouter',
            attachments: [
              {
                id: 'running-img',
                type: 'image',
                filename: 'wip.png',
                mimeType: 'image/png',
                sizeBytes: 4,
                content: 'data:image/png;base64,wip',
              },
            ],
          } as CoderJobStartInput['envelope'],
        }),
      ),
      result_json: null,
      error_text: null,
      created_at: Date.now(),
      started_at: Date.now(),
      finished_at: null,
      do_resume_count: 0,
    });

    const resp = await job.fetch(
      new Request('https://do/turn-summary?jobId=job-running', { method: 'GET' }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      status: string;
      summary: string | null;
      attachments?: AttachmentData[];
    };
    expect(body.status).toBe('running');
    expect(body.summary).toBeNull();
    // Gated out: no summary → no attachments on the wire.
    expect(body.attachments).toBeUndefined();
  });

  it('/turn-summary returns 404 for unknown jobId', async () => {
    const { ctx } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());
    const resp = await job.fetch(
      new Request('https://do/turn-summary?jobId=nope', { method: 'GET' }),
    );
    expect(resp.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Orphan sweep — recovery after DO eviction
  // ---------------------------------------------------------------------------

  it('orphan sweep marks a checkpoint-less running job failed on first fetch after DO wake', async () => {
    // A `running` row with no `checkpoint` row models a job whose runLoop
    // was evicted before round 5 (the first checkpoint cadence). On wake,
    // there's no durable state to resume from, so the sweep fails the job
    // with a structured terminal event instead of leaving SSE consumers
    // waiting on the 60-minute alarm backstop.
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    storage.jobs.set('job-orphan-nocp', {
      id: 'job-orphan-nocp',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-orphan-nocp' })),
      result_json: null,
      error_text: null,
      created_at: Date.now() - 60_000,
      started_at: Date.now() - 60_000,
      finished_at: null,
      do_resume_count: 0,
    });

    // Fetch on any route triggers the sweep on the first call.
    await job.fetch(new Request('https://do/status?jobId=job-orphan-nocp', { method: 'GET' }));

    const row = storage.jobs.get('job-orphan-nocp')!;
    expect(row.status).toBe('failed');
    expect(row.error_text).toMatch(/checkpoint/i);

    const failed = storage.events.find((e) => e.type === 'job.failed');
    expect(failed).toBeDefined();
    expect(JSON.parse(failed!.payload_json).error).toMatch(/checkpoint/i);
  });

  it('orphan sweep refuses to resume past the DO-restart cap and fails the job', async () => {
    // A job whose `do_resume_count` has reached MAX_DO_RESTART_RESUMES is a
    // job whose previous DO-restart resumes keep dying before checkpointing
    // again (each wake bumps the count before relaunching). Without this
    // cap, an OOM-loop or bad input could relaunch on every DO wake
    // forever; with the cap, the sweep terminally fails the job so a human
    // gets a structured failure event and a clear error.
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    storage.jobs.set('job-orphan-cap', {
      id: 'job-orphan-cap',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-orphan-cap' })),
      result_json: null,
      error_text: null,
      created_at: Date.now() - 600_000,
      started_at: Date.now() - 600_000,
      finished_at: null,
      do_resume_count: MAX_DO_RESTART_RESUMES,
    });
    // A checkpoint exists (so the no-checkpoint branch can't claim this),
    // proving the cap path is what fired.
    storage.checkpoints.set('job-orphan-cap', {
      job_id: 'job-orphan-cap',
      round: 10,
      snapshot_id: 'snap-1',
      restore_token: 'tok-1',
      agent_state_json: JSON.stringify({ round: 10, messages: [], workingMemory: {}, cards: [] }),
      created_at: Date.now(),
    });

    await job.fetch(new Request('https://do/status?jobId=job-orphan-cap', { method: 'GET' }));

    const row = storage.jobs.get('job-orphan-cap')!;
    expect(row.status).toBe('failed');
    expect(row.error_text).toMatch(/cap of \d+ exhausted/i);

    const failed = storage.events.find((e) => e.type === 'job.failed');
    expect(failed).toBeDefined();
    expect(JSON.parse(failed!.payload_json).error).toMatch(/cap of \d+ exhausted/i);
  });

  it('orphan sweep with a checkpoint but no SNAPSHOTS env fails with restore-failed', async () => {
    // A real DO will have env.SNAPSHOTS bound; the test env doesn't.
    // `restoreWorkspaceSnapshot` returns `{ ok: false, error: ... }` rather
    // than throwing, so this models the production case where the R2
    // binding is gone (misconfig) or the snapshot object was deleted — the
    // sweep must surface that as a terminal failure, not a silent hang.
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    storage.jobs.set('job-orphan-restore', {
      id: 'job-orphan-restore',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-orphan-restore' })),
      result_json: null,
      error_text: null,
      created_at: Date.now() - 60_000,
      started_at: Date.now() - 60_000,
      finished_at: null,
      do_resume_count: 0,
    });
    storage.checkpoints.set('job-orphan-restore', {
      job_id: 'job-orphan-restore',
      round: 5,
      snapshot_id: 'snap-1',
      restore_token: 'tok-1',
      agent_state_json: JSON.stringify({ round: 5, messages: [], workingMemory: {}, cards: [] }),
      created_at: Date.now(),
    });

    await job.fetch(new Request('https://do/status?jobId=job-orphan-restore', { method: 'GET' }));

    const row = storage.jobs.get('job-orphan-restore')!;
    expect(row.status).toBe('failed');
    expect(row.error_text).toMatch(/snapshot restore failed/i);
  });

  it('orphan sweep is idempotent within a DO lifetime', async () => {
    // The sweep flag is in-memory and only flips once per DO instance.
    // Subsequent fetches must not re-sweep (no duplicate terminal events,
    // no double-increment of do_resume_count).
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    storage.jobs.set('job-orphan-once', {
      id: 'job-orphan-once',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-orphan-once' })),
      result_json: null,
      error_text: null,
      created_at: Date.now() - 60_000,
      started_at: Date.now() - 60_000,
      finished_at: null,
      do_resume_count: 0,
    });

    await job.fetch(new Request('https://do/status?jobId=job-orphan-once', { method: 'GET' }));
    // Second fetch on a different route: even if there were still orphans,
    // the sweep should not fire again on this DO instance.
    await job.fetch(new Request('https://do/status?jobId=other', { method: 'GET' }));

    const failedEvents = storage.events.filter((e) => e.type === 'job.failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('orphan sweep is a no-op when there are no running jobs', async () => {
    // The happy DO-wake path: nothing left over from a prior eviction, so
    // the sweep emits no logs, writes nothing, and the inbound request
    // dispatches normally.
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    const response = await job.fetch(
      new Request('https://do/status?jobId=nope', { method: 'GET' }),
    );

    expect(response.status).toBe(404);
    expect(storage.jobs.size).toBe(0);
    expect(storage.events.length).toBe(0);
  });

  it('/cancel on a running row with no live controller marks it cancelled (orphan path)', async () => {
    // Codex P1 race: the sweep awaits restoreWorkspaceSnapshot, and during
    // that window /cancel finds no AbortController for the orphan. The
    // pre-fix behavior returned NO_ACTIVE_RUN and left the row 'running',
    // so the UI permanently disabled Cancel on a 2xx while the sweep then
    // launched runLoop anyway. Now /cancel marks the row 'cancelled' so
    // the post-restore re-check in resumeOrphanedJob bails before relaunch.
    const { ctx, storage } = makeCtx();
    const job = new CoderJob(ctx, makeEnv());

    // Warm the DO before seeding the orphan so the sweep is a no-op on this
    // /cancel call. Models the production case where /cancel lands on a
    // warm DO whose runLoop has died silently (or was never relaunched).
    await job.fetch(new Request('https://do/status?jobId=warmup-noop', { method: 'GET' }));

    storage.jobs.set('job-cancel-orphan', {
      id: 'job-cancel-orphan',
      chat_id: 'c',
      repo: 'a/b',
      branch: 'main',
      sandbox_id: 'sb',
      owner_token: 't',
      origin: 'https://push.example.test',
      status: 'running',
      input_json: JSON.stringify(makeStartInput({ jobId: 'job-cancel-orphan' })),
      result_json: null,
      error_text: null,
      created_at: Date.now() - 60_000,
      started_at: Date.now() - 60_000,
      finished_at: null,
      do_resume_count: 0,
    });

    const resp = await job.fetch(
      new Request('https://do/cancel?jobId=job-cancel-orphan', { method: 'POST' }),
    );

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      cancelled: boolean;
      reason?: string;
    };
    expect(body.cancelled).toBe(true);
    expect(body.reason).toBe('CANCELLED_ORPHAN');

    const row = storage.jobs.get('job-cancel-orphan')!;
    expect(row.status).toBe('cancelled');
    expect(row.error_text).toMatch(/cancelled before resume/i);

    // Terminal SSE event is emitted so any /events subscriber sees the
    // failure instead of waiting on the wall-clock alarm.
    const terminal = storage.events.find((e) => e.type === 'job.failed');
    expect(terminal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Durable suspend / typed resume
// ---------------------------------------------------------------------------

describe('CoderJob DO — durable suspend / resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const okSnapshot = async () => ({
    ok: true as const,
    snapshotId: 'snapshot:suspend-1',
    restoreToken: 'rt-1',
    sizeBytes: 1,
  });

  async function startAndSuspend(jobId: string) {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeLeadStartInput({ jobId });
    __setCoderJobServiceOverrides(jobId, {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeCheckpointStreamFn('Which config approach — A or B?', 'two options on the table'),
      snapshot: okSnapshot,
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
    return { ctx, storage, job };
  }

  it('parks a lead job that emits a guidance call: status=suspended, job.suspended, durable state persisted', async () => {
    const { storage } = await startAndSuspend('job-suspend-1');

    // Non-terminal park, not a completion or failure.
    expect(storage.jobs.get('job-suspend-1')!.status).toBe('suspended');
    expect(storage.jobs.get('job-suspend-1')!.finished_at).toBeNull();

    const suspended = storage.events.find((e) => e.type === 'job.suspended');
    expect(suspended).toBeDefined();
    const payload = JSON.parse(suspended!.payload_json);
    expect(payload.role).toBe('coder');
    expect(payload.question).toBe('Which config approach — A or B?');
    expect(payload.context).toBe('two options on the table');
    // The typed resume contract rides the event so a caller knows what to send.
    expect(JSON.parse(payload.resumeSchema)).toEqual({
      required: ['answer'],
      fields: { answer: 'string' },
    });

    // Both halves of the durable pair are persisted: the filesystem+loop
    // checkpoint and the typed suspension metadata.
    expect(storage.checkpoints.has('job-suspend-1')).toBe(true);
    const suspension = storage.suspensions.get('job-suspend-1');
    expect(suspension).toMatchObject({ question: 'Which config approach — A or B?' });

    // Never marked terminal.
    expect(storage.events.some((e) => e.type === 'job.completed')).toBe(false);
    expect(storage.events.some((e) => e.type === 'job.failed')).toBe(false);
  });

  it('fails instead of parking when the suspend snapshot cannot be captured', async () => {
    // No durable state → an un-resumable park. The job must fail, not hang in
    // `suspended` forever awaiting a resume that could never restore anything.
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeLeadStartInput({ jobId: 'job-suspend-nostate' });
    __setCoderJobServiceOverrides('job-suspend-nostate', {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeCheckpointStreamFn('Need guidance'),
      // 413 = workspace over the snapshot cap — deterministic, non-retryable.
      snapshot: async () => ({ ok: false as const, status: 413, error: 'too large' }),
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

    expect(storage.jobs.get('job-suspend-nostate')!.status).toBe('failed');
    expect(storage.suspensions.has('job-suspend-nostate')).toBe(false);
    expect(storage.events.some((e) => e.type === 'job.suspended')).toBe(false);
    expect(storage.events.some((e) => e.type === 'job.failed')).toBe(true);
  });

  it('/resume rejects resumeData that violates the schema and leaves the job suspended', async () => {
    const { job, storage } = await startAndSuspend('job-resume-bad');

    const res = await job.fetch(
      new Request('https://do/resume?jobId=job-resume-bad', {
        method: 'POST',
        body: JSON.stringify({ resumeData: {} }), // missing required `answer`
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe('INVALID_RESUME_DATA');
    expect(body.issues.join(' ')).toMatch(/answer/);

    // A rejected resume is a no-op: the job stays parked and re-resumable.
    expect(storage.jobs.get('job-resume-bad')!.status).toBe('suspended');
    expect(storage.suspensions.has('job-resume-bad')).toBe(true);
  });

  it('/cancel on a suspended job terminates it: status=cancelled, suspension cleared, job.failed', async () => {
    // Regression guard for the markTerminal(running-only) bug: cancelling a
    // suspended job must actually flip it terminal and drop the metadata, not
    // silently no-op and leave it parked.
    const { job, storage } = await startAndSuspend('job-cancel-suspended');
    expect(storage.jobs.get('job-cancel-suspended')!.status).toBe('suspended');

    const res = await job.fetch(
      new Request('https://do/cancel?jobId=job-cancel-suspended', { method: 'POST' }),
    );
    const body = (await res.json()) as { cancelled: boolean; reason: string };
    expect(body).toMatchObject({ cancelled: true, reason: 'CANCELLED_SUSPENDED' });

    expect(storage.jobs.get('job-cancel-suspended')!.status).toBe('cancelled');
    expect(storage.suspensions.has('job-cancel-suspended')).toBe(false);
    expect(storage.events.some((e) => e.type === 'job.failed')).toBe(true);
  });

  it('/resume on a non-suspended job returns 409 NOT_SUSPENDED', async () => {
    const { ctx, storage, waitUntilPromises } = makeCtx();
    const input = makeStartInput({ jobId: 'job-resume-running' });
    __setCoderJobServiceOverrides('job-resume-running', {
      detectors: stubDetectors,
      executor: stubExecutor,
      stream: makeNoToolStreamFn('done'),
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
    expect(storage.jobs.get('job-resume-running')!.status).toBe('completed');

    const res = await job.fetch(
      new Request('https://do/resume?jobId=job-resume-running', {
        method: 'POST',
        body: JSON.stringify({ resumeData: { answer: 'x' } }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('NOT_SUSPENDED');
  });

  it('/resume claims the job then fails terminally when the workspace restore fails', async () => {
    // Valid resumeData clears schema validation; the DO claims suspended→running
    // and clears the suspension, then the real restore (no SNAPSHOTS env) fails,
    // so the job ends terminally rather than half-alive. Proves the claim +
    // restore-failure path without needing a live snapshot store.
    const { job, storage } = await startAndSuspend('job-resume-restorefail');

    const res = await job.fetch(
      new Request('https://do/resume?jobId=job-resume-restorefail', {
        method: 'POST',
        body: JSON.stringify({ resumeData: { answer: 'go with option A' } }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('RESUME_RESTORE_FAILED');

    expect(storage.jobs.get('job-resume-restorefail')!.status).toBe('failed');
    // Suspension metadata was consumed by the claim — no lingering parked state.
    expect(storage.suspensions.has('job-resume-restorefail')).toBe(false);
    // Restore fails before the resumed marker, so no job.resumed was emitted.
    expect(storage.events.some((e) => e.type === 'job.resumed')).toBe(false);
    expect(storage.events.some((e) => e.type === 'job.failed')).toBe(true);
  });
});
