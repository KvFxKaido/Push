/**
 * CoderJob — Durable Object running a background Coder delegation.
 *
 * Phase 1 PR #2 ships the wire-format-complete shape:
 *   POST /start    — persist input, begin runLoop under ctx.waitUntil
 *   GET  /events   — SSE stream with Last-Event-ID replay
 *   POST /cancel   — abort in-flight run, emit terminal failure event
 *   GET  /status   — snapshot
 *
 * The kernel itself (`runCoderAgent` from `lib/coder-agent.ts`) runs
 * inside `runLoop()` with DO-side services assembled by
 * `coder-job-services.ts`. Production detectors wrap the Web-side
 * implementations behind `coder-job-detector-adapter.ts`; the executor
 * and provider streamFn stubs surface clear errors until PR #3 fills
 * them. See `docs/runbooks/Background Coder Tasks Phase 1.md`.
 *
 * Events emitted to the SSE log: `subagent.started`,
 * `subagent.completed`, `subagent.failed`. Finer-grained progress
 * events are deliberately out of scope — adding a new `RunEventInput`
 * variant would trigger the schema-drift guardrail and belongs in PR
 * #4 alongside the drift-test tranche.
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import { runCoderAgent as runCoderAgentLib, type CoderAgentOptions } from '@push/lib/coder-agent';
import {
  buildCoderDetectors,
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  type CoderTurnContext,
} from '@push/lib/coder-agent-bindings';
import { CapabilityLedger, ROLE_CAPABILITIES } from '@push/lib/capabilities';
import type { AcceptanceCriterion, RunEventInput, RunEvent } from '@push/lib/runtime-contract';
import type { UserProfile } from '@push/lib/user-identity';
import type { AIProviderType, ProviderStreamFn } from '@push/lib/provider-contract';
import type { VerificationPolicy } from '@push/lib/verification-policy';
import { formatVerificationPolicyBlock } from '@push/lib/verification-policy';
import type { CorrelationContext } from '@push/lib/correlation-context';
import type { Capability } from '@push/lib/capabilities';
import type { ChatCard, ChatMessage, DelegationEnvelope } from '@/types';
import { buildApprovalModeBlock } from '@/lib/approval-mode';
// Web-side imports held behind the adapter pattern — see
// `coder-job-detector-adapter.ts` module docstring and the PR #4 plan in
// `docs/runbooks/Background Coder Tasks Phase 1.md`.
import { buildCoderDelegationBrief } from '@/lib/role-context';
import { getSandboxToolProtocol } from '@/lib/sandbox-tool-detection';
import { WEB_SEARCH_TOOL_PROTOCOL } from '@/lib/web-search-tools';
import type { Env } from './worker-middleware';
import {
  createWebDetectorAdapter,
  type AnyToolCall,
  type CoderJobDetectorAdapter,
} from './coder-job-detector-adapter';
import {
  createWebExecutorAdapter,
  type CoderJobExecutorAdapter,
} from './coder-job-executor-adapter';
import { createWebStreamAdapter } from './coder-job-stream-adapter';
import { buildCoderJobServices } from './coder-job-services';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Body shape for POST /api/jobs/start (and the internal DO /start path). */
export interface CoderJobStartInput {
  jobId: string;
  chatId: string;
  repoFullName: string;
  branch: string;
  sandboxId: string;
  ownerToken: string;
  origin: string;
  envelope: DelegationEnvelope;
  provider: AIProviderType;
  model: string | undefined;
  userProfile: UserProfile | null;
  verificationPolicy?: VerificationPolicy;
  declaredCapabilities?: Capability[];
  correlation?: CorrelationContext;
  acceptanceCriteria?: AcceptanceCriterion[];
  projectInstructions?: string;
  instructionFilename?: string;
}

export type CoderJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CoderJobStatusSnapshot {
  jobId: string;
  status: CoderJobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  eventCount: number;
  error?: string;
}

/** Test seam — constructor-time injection of service overrides. Passed
 * via a side-channel map keyed by jobId in tests that don't go through
 * the Worker's env.CoderJob.get(). Production always uses the Web
 * adapters. */
export interface CoderJobServiceOverrides {
  detectors?: CoderJobDetectorAdapter;
  executor?: CoderJobExecutorAdapter;
  streamFn?: ProviderStreamFn<ChatMessage>;
}

const SERVICE_OVERRIDES = new Map<string, CoderJobServiceOverrides>();

/** Test-only entry point to inject service overrides for a job the
 * DO is about to start. The DO looks up its jobId after `start()`
 * persists it. Cleared automatically when the job completes. */
export function __setCoderJobServiceOverrides(
  jobId: string,
  overrides: CoderJobServiceOverrides,
): void {
  SERVICE_OVERRIDES.set(jobId, overrides);
}

// ---------------------------------------------------------------------------
// SQLite schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_job_id_idx ON event (job_id, seq);
`;

// ---------------------------------------------------------------------------
// CoderJob DO
// ---------------------------------------------------------------------------

export class CoderJob {
  /** Per-job AbortControllers so /cancel can interrupt an in-flight run. */
  private abortControllers = new Map<string, AbortController>();

  /** In-memory live-event broadcast. SSE streams subscribe here to
   * receive events immediately after they're persisted. */
  private liveListeners = new Set<(event: RunEvent) => void>();

  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  // The DO runtime injects (state, env) at construction time. We keep
  // plain `ctx` / `env` fields instead of extending the
  // `cloudflare:workers` `DurableObject` base class so the DO can be
  // type-checked without pulling ambient-module declarations into the
  // app tsconfig's `types` array. `env` is threaded into the executor
  // and stream adapters so they can call the existing Worker handlers
  // directly (no HTTP self-loop and no origin-validation round trip).
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.initSchema();
  }

  private initSchema(): void {
    this.ctx.storage.sql.exec(SCHEMA_SQL);
  }

  // -------------------------------------------------------------------------
  // HTTP dispatch
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const action = segments[segments.length - 1];

    try {
      switch (action) {
        case 'start':
          return await this.handleStart((await request.json()) as CoderJobStartInput);
        case 'events':
          return this.handleEvents(request);
        case 'cancel':
          return await this.handleCancel(url.searchParams.get('jobId') ?? '');
        case 'status':
          return this.handleStatus(url.searchParams.get('jobId') ?? '');
        default:
          return json({ error: 'UNKNOWN_ACTION', action }, 404);
      }
    } catch (err) {
      return json(
        { error: 'DO_FETCH_FAILED', message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  }

  // -------------------------------------------------------------------------
  // /start
  // -------------------------------------------------------------------------

  private async handleStart(input: CoderJobStartInput): Promise<Response> {
    const existing = this.ctx.storage.sql
      .exec('SELECT status FROM job WHERE id = ?', input.jobId)
      .toArray()[0];
    if (existing) {
      return json({ error: 'JOB_ALREADY_EXISTS', jobId: input.jobId }, 409);
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO job (id, chat_id, repo, branch, sandbox_id, owner_token, origin,
                        status, input_json, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      input.jobId,
      input.chatId,
      input.repoFullName,
      input.branch,
      input.sandboxId,
      input.ownerToken,
      input.origin,
      JSON.stringify(input),
      now,
      now,
    );

    await this.appendEvent(input.jobId, {
      type: 'subagent.started',
      executionId: input.jobId,
      agent: 'coder',
      detail: input.envelope.task,
    });

    // Keep the DO alive beyond the request lifetime while runLoop works.
    this.ctx.waitUntil(this.runLoop(input));

    return json({ jobId: input.jobId }, 202);
  }

  // -------------------------------------------------------------------------
  // runLoop — assemble services, invoke the kernel, emit terminal event
  // -------------------------------------------------------------------------

  private async runLoop(input: CoderJobStartInput): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(input.jobId, abortController);

    try {
      const overrides = SERVICE_OVERRIDES.get(input.jobId) ?? {};
      const detectors = overrides.detectors ?? createWebDetectorAdapter();
      const executor =
        overrides.executor ??
        createWebExecutorAdapter({
          env: this.env,
          origin: input.origin,
          sandboxId: input.sandboxId,
          ownerToken: input.ownerToken,
          provider: input.provider,
          jobId: input.jobId,
        });
      const streamFn =
        overrides.streamFn ??
        createWebStreamAdapter({
          env: this.env,
          origin: input.origin,
          provider: input.provider,
          modelId: input.model,
          jobId: input.jobId,
        });

      const declaredCaps = input.declaredCapabilities ?? Array.from(ROLE_CAPABILITIES.coder);
      const capabilityLedger = new CapabilityLedger(declaredCaps);

      const turnCtx: CoderTurnContext = {
        role: 'coder',
        round: 0,
        maxRounds: input.envelope.harnessSettings?.maxCoderRounds ?? 30,
        sandboxId: input.sandboxId,
        allowedRepo: input.repoFullName,
        activeProvider: input.provider,
        activeModel: input.model,
        signal: abortController.signal,
      };

      const services = buildCoderJobServices({
        detectors,
        executor,
        capabilityLedger,
        turnCtx,
        onStatus: () => {
          // PR #2: no fine-grained progress events; the job status
          // column + terminal event is all the UI layer gets.
        },
        correlation: input.correlation,
        activeProvider: input.provider,
        activeModel: input.model,
        sandboxId: input.sandboxId,
      });

      let taskPreamble = buildCoderDelegationBrief({
        ...input.envelope,
        provider: input.provider,
        model: input.model,
      });
      if (input.envelope.plannerBrief) {
        taskPreamble += '\n\n' + input.envelope.plannerBrief;
      }

      const options: CoderAgentOptions<AnyToolCall, ChatCard> = {
        provider: input.provider,
        streamFn: streamFn as unknown as CoderAgentOptions<AnyToolCall, ChatCard>['streamFn'],
        modelId: input.model,
        sandboxId: input.sandboxId,
        allowedRepo: input.repoFullName,
        branchContext: input.envelope.branchContext,
        projectInstructions: input.projectInstructions ?? input.envelope.projectInstructions,
        instructionFilename: input.instructionFilename ?? input.envelope.instructionFilename,
        userProfile: input.userProfile,
        taskPreamble,
        symbolSummary: null,
        toolExec: buildCoderToolExec(services),
        ...buildCoderDetectors(services),
        webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
        sandboxToolProtocol: getSandboxToolProtocol(),
        verificationPolicyBlock: formatVerificationPolicyBlock(input.verificationPolicy),
        approvalModeBlock: buildApprovalModeBlock('full-auto'),
        evaluateAfterModel: buildCoderEvaluateAfterModel(services),
        acceptanceCriteria: input.acceptanceCriteria ?? input.envelope.acceptanceCriteria,
        harnessMaxRounds: input.envelope.harnessSettings?.maxCoderRounds,
        harnessContextResetsEnabled: input.envelope.harnessSettings?.contextResetsEnabled,
      };

      const result = await runCoderAgentLib(options, {
        onStatus: () => {},
        signal: abortController.signal,
      });

      await this.appendEvent(input.jobId, {
        type: 'subagent.completed',
        executionId: input.jobId,
        agent: 'coder',
        summary: result.summary,
      });
      this.markTerminal(input.jobId, 'completed', result.summary, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.appendEvent(input.jobId, {
        type: 'subagent.failed',
        executionId: input.jobId,
        agent: 'coder',
        error: message,
      });
      this.markTerminal(
        input.jobId,
        abortController.signal.aborted ? 'cancelled' : 'failed',
        null,
        message,
      );
    } finally {
      this.abortControllers.delete(input.jobId);
      SERVICE_OVERRIDES.delete(input.jobId);
    }
  }

  // -------------------------------------------------------------------------
  // /events — SSE with Last-Event-ID replay
  // -------------------------------------------------------------------------

  private handleEvents(request: Request): Response {
    const jobId = new URL(request.url).searchParams.get('jobId') ?? '';
    if (!jobId) return json({ error: 'MISSING_JOB_ID' }, 400);

    const existing = this.ctx.storage.sql
      .exec('SELECT id FROM job WHERE id = ?', jobId)
      .toArray()[0];
    if (!existing) return json({ error: 'JOB_NOT_FOUND' }, 404);

    const lastEventId = request.headers.get('Last-Event-ID') ?? '';
    const startAfterSeq = this.resolveLastEventSeq(lastEventId);

    const encoder = new TextEncoder();
    const sqlExec = this.ctx.storage.sql.exec.bind(this.ctx.storage.sql);
    const liveListeners = this.liveListeners;
    const jobStatusLookup = (id: string) => this.getJobStatus(id);

    // Hoisted to stream-scope so `cancel()` (which fires on client
    // disconnect) can remove the subscription and we don't leak
    // listener closures into the DO's in-memory set.
    let activeListener: ((event: RunEvent) => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Replay any persisted events past the last-seen seq.
        for (const row of sqlExec(
          'SELECT id, type, payload_json FROM event WHERE job_id = ? AND seq > ? ORDER BY seq ASC',
          jobId,
          startAfterSeq,
        )) {
          controller.enqueue(
            encoder.encode(
              formatSseChunk(row as unknown as { id: string; type: string; payload_json: string }),
            ),
          );
        }

        // Subscribe to live events.
        const listener = (event: RunEvent) => {
          try {
            controller.enqueue(
              encoder.encode(
                formatSseChunk({
                  id: event.id,
                  type: event.type,
                  payload_json: JSON.stringify(event),
                }),
              ),
            );
            if (isTerminalEventType(event.type)) {
              liveListeners.delete(listener);
              activeListener = null;
              controller.close();
            }
          } catch {
            liveListeners.delete(listener);
            activeListener = null;
          }
        };
        activeListener = listener;
        liveListeners.add(listener);

        // If the job is already terminal and we replayed everything,
        // close immediately.
        const status = jobStatusLookup(jobId);
        if (status && isTerminalStatus(status)) {
          liveListeners.delete(listener);
          activeListener = null;
          controller.close();
        }
      },
      cancel() {
        // Client disconnected before a terminal event — drop the live
        // subscription so the DO's in-memory set doesn't leak closures
        // and keep the instance "hot" longer than necessary.
        if (activeListener) {
          liveListeners.delete(activeListener);
          activeListener = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }

  private resolveLastEventSeq(lastEventId: string): number {
    if (!lastEventId) return 0;
    // `id` has a UNIQUE constraint in the schema, but LIMIT 1 makes the
    // intent explicit and avoids a full index scan if the engine picks
    // a different plan.
    const row = this.ctx.storage.sql
      .exec('SELECT seq FROM event WHERE id = ? LIMIT 1', lastEventId)
      .toArray()[0] as { seq?: number } | undefined;
    return row?.seq ?? 0;
  }

  // -------------------------------------------------------------------------
  // /cancel
  // -------------------------------------------------------------------------

  private async handleCancel(jobId: string): Promise<Response> {
    if (!jobId) return json({ error: 'MISSING_JOB_ID' }, 400);
    const controller = this.abortControllers.get(jobId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
      return json({ jobId, cancelled: true });
    }
    const status = this.getJobStatus(jobId);
    if (status && isTerminalStatus(status)) {
      return json({ jobId, cancelled: false, status, reason: 'ALREADY_TERMINAL' });
    }
    return json({ jobId, cancelled: false, reason: 'NO_ACTIVE_RUN' });
  }

  // -------------------------------------------------------------------------
  // /status
  // -------------------------------------------------------------------------

  private handleStatus(jobId: string): Response {
    if (!jobId) return json({ error: 'MISSING_JOB_ID' }, 400);
    const row = this.ctx.storage.sql
      .exec(
        `SELECT id, status, created_at, started_at, finished_at, error_text
         FROM job WHERE id = ?`,
        jobId,
      )
      .toArray()[0] as
      | {
          id: string;
          status: string;
          created_at: number;
          started_at: number | null;
          finished_at: number | null;
          error_text: string | null;
        }
      | undefined;
    if (!row) return json({ error: 'JOB_NOT_FOUND' }, 404);

    const eventCountRow = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS count FROM event WHERE job_id = ?', jobId)
      .toArray()[0] as { count: number };

    const snapshot: CoderJobStatusSnapshot = {
      jobId: row.id,
      status: row.status as CoderJobStatus,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      eventCount: eventCountRow.count,
      error: row.error_text ?? undefined,
    };
    return json(snapshot);
  }

  // -------------------------------------------------------------------------
  // Event append (persist + broadcast)
  // -------------------------------------------------------------------------

  private async appendEvent(jobId: string, input: RunEventInput): Promise<void> {
    const event: RunEvent = {
      ...input,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO event (job_id, id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)',
      jobId,
      event.id,
      event.timestamp,
      event.type,
      JSON.stringify(event),
    );
    for (const listener of this.liveListeners) {
      try {
        listener(event);
      } catch {
        // Don't let one broken subscriber stop the others.
      }
    }
  }

  private markTerminal(
    jobId: string,
    status: CoderJobStatus,
    summary: string | null,
    error: string | null,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE job SET status = ?, finished_at = ?, result_json = ?, error_text = ? WHERE id = ?`,
      status,
      Date.now(),
      summary ? JSON.stringify({ summary }) : null,
      error,
      jobId,
    );
  }

  private getJobStatus(jobId: string): CoderJobStatus | null {
    const row = this.ctx.storage.sql
      .exec('SELECT status FROM job WHERE id = ?', jobId)
      .toArray()[0] as { status?: string } | undefined;
    return (row?.status as CoderJobStatus | undefined) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formatSseChunk(row: { id: string; type: string; payload_json: string }): string {
  return `id: ${row.id}\nevent: ${row.type}\ndata: ${row.payload_json}\n\n`;
}

function isTerminalEventType(type: string): boolean {
  return type === 'subagent.completed' || type === 'subagent.failed';
}

function isTerminalStatus(status: CoderJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
