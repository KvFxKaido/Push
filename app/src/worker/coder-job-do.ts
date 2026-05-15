/**
 * CoderJob — Durable Object running a background AgentJob.
 *
 * The DO class name is preserved (no rename in PR 1) but its wire
 * contract is now role-aware: a job declares `role: AgentRole` and
 * dispatch in `runLoop` selects the role-specific kernel. Today only
 * `role: 'coder'` is wired; non-coder roles are rejected with
 * `UNSUPPORTED_ROLE`.
 *
 *   POST /start    — persist input, begin runLoop under ctx.waitUntil
 *   GET  /events   — SSE stream with Last-Event-ID replay
 *   POST /cancel   — abort in-flight run, emit terminal failure event
 *   GET  /status   — snapshot
 *
 * Events emitted to the SSE log: `job.started`, `job.completed`,
 * `job.failed`, each carrying a `role` field. These are distinct from
 * the `subagent.*` events emitted by the foreground delegation runtime
 * — the two layers describe runs at different scopes (server-owned
 * job vs. in-tab delegated child run).
 *
 * The kernel for role='coder' (`runCoderAgent` from `lib/coder-agent.ts`)
 * runs inside `executeCoderJob()` with DO-side services assembled by
 * `coder-job-services.ts`. Production detectors wrap the Web-side
 * implementations behind `coder-job-detector-adapter.ts`. See
 * `docs/archive/runbooks/Background Coder Tasks Phase 1.md`.
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
import type {
  AcceptanceCriterion,
  AgentRole,
  RunEventInput,
  RunEvent,
} from '@push/lib/runtime-contract';
import type { UserProfile } from '@push/lib/user-identity';
import type { AIProviderType, LlmMessage, PushStream } from '@push/lib/provider-contract';
import type { VerificationPolicy } from '@push/lib/verification-policy';
import { formatVerificationPolicyBlock } from '@push/lib/verification-policy';
import type { CorrelationContext } from '@push/lib/correlation-context';
import type { Capability } from '@push/lib/capabilities';
import type { ChatCard, ChatMessage, DelegationEnvelope } from '@/types';
import { buildApprovalModeBlock } from '@/lib/approval-mode';
// Web-side imports held behind the adapter pattern — see
// `coder-job-detector-adapter.ts` module docstring and the PR #4 plan in
// `docs/archive/runbooks/Background Coder Tasks Phase 1.md`.
import { buildCoderDelegationBrief } from '@/lib/role-context';
import { getSandboxToolProtocol } from '@/lib/sandbox-tool-detection';
import { WEB_SEARCH_TOOL_PROTOCOL } from '@/lib/web-search-tools';
import type { Env } from './worker-middleware';
import { SUPPORTED_AGENT_JOB_ROLES } from './agent-job-roles';
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
import {
  createWebContextLoader,
  formatPriorTurnsPreamble,
  NULL_CONTEXT_LOADER,
  type ContextLoader,
  type TurnSummaryResponse,
} from './agent-job-context-loader';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Reference to durable chat/session state that the DO can dereference
 *  on demand. PR 2 ships the wire shape only — the field is persisted
 *  via input_json but no kernel path reads from it yet. PR 3 builds the
 *  context loader / resume path that uses these handles to reconstruct
 *  prior turns server-side. Naming is deliberate ("ref", not "context")
 *  so call sites don't drift toward inlining chat history here. */
export interface ChatRef {
  chatId: string;
  repoFullName: string;
  branch: string;
  /** Opaque handle for a checkpoint in the chat's transcript. Format
   *  is reserved for PR 3; today it's recorded but not interpreted. */
  checkpointId?: string;
}

/** AgentJob input shape for `role: 'coder'`. The interface name is
 *  preserved (no rename in PR 1) but a `role` discriminator is now
 *  required so dispatch in `runLoop` is role-aware. */
export interface CoderJobStartInput {
  role: 'coder';
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
  /** Reference to durable chat/session state. PR 2 persists this in
   *  input_json without dereferencing it; PR 3 wires the loader. */
  chatRef?: ChatRef;
}

/** Discriminated union of every role-aware AgentJob input. PR 1 wires
 *  only `'coder'`; future roles join here as their kernels are migrated
 *  off the in-browser loop. The DO rejects unknown roles at /start with
 *  `UNSUPPORTED_ROLE`. */
export type AgentJobStartInput = CoderJobStartInput;

// Role registry lives in its own module so the worker route layer can
// import it without pulling the DO's transitive deps. Re-exported here
// for backward compatibility with any external importer.
export { SUPPORTED_AGENT_JOB_ROLES };

/** Thrown by `executeJob` when dispatch hits a role with no wired
 *  kernel. Surfaces as a `job.failed` SSE event with the message body
 *  so clients can render a clear error rather than a generic stall. */
export class UnsupportedRoleError extends Error {
  // Plain field + assignment instead of a TS parameter-property because
  // the app tsconfig sets `erasableSyntaxOnly` (no runtime-emitting TS
  // syntax). Same pattern used by other classes in this package.
  readonly role: string;
  constructor(role: string) {
    super(`AgentJob role '${role}' is not yet wired in this runtime.`);
    this.name = 'UnsupportedRoleError';
    this.role = role;
  }
}

export type CoderJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CoderJobStatusSnapshot {
  jobId: string;
  status: CoderJobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  eventCount: number;
  /** Wall-clock timestamp of the most recent persisted event, or null if
   * none yet. Lets the client detect stalls (`status === 'running'` but
   * `lastEventAt` is N minutes old) without subscribing to the SSE
   * stream — useful for polling status in the background and surfacing a
   * "looks stuck" affordance without waiting on a hung event stream. */
  lastEventAt: number | null;
  error?: string;
}

/** Test seam — constructor-time injection of service overrides. Passed
 * via a side-channel map keyed by jobId in tests that don't go through
 * the Worker's env.CoderJob.get(). Production always uses the Web
 * adapters. */
export interface CoderJobServiceOverrides {
  detectors?: CoderJobDetectorAdapter;
  executor?: CoderJobExecutorAdapter;
  stream?: PushStream<ChatMessage>;
  /** Loads prior-turn summaries for chatRef chain-walks (PR 3). Default
   *  is a Web loader that fetches sibling DOs via env.CoderJob; tests
   *  inject a stub. */
  contextLoader?: ContextLoader;
}

const SERVICE_OVERRIDES = new Map<string, CoderJobServiceOverrides>();

// Wall-clock budget for a single Coder job. A run that exceeds this is
// force-terminated by the DO's alarm handler — the backstop against a
// sandbox subrequest or provider stream that never returns and keeps the
// runLoop pinned under `ctx.waitUntil`. Without this, a hung run emits no
// terminal event, SSE stays open, and the browser has nothing to reconcile
// on refresh.
//
// Sized generously: 30 minutes is longer than any single tool round-trip
// we ever expect to see, so healthy runs never bump into it; unhealthy
// ones recover in bounded time instead of haunting the DO forever.
export const MAX_JOB_WALL_CLOCK_MS = 30 * 60 * 1000;

// SSE keepalive cadence. Cloudflare's edge proxies drop HTTP streams that
// go quiet for ~100s, so a long gap between real events (model thinking,
// a slow sandbox tool) can disconnect the browser mid-run even though the
// DO is healthy. Emitting a comment frame well under that threshold keeps
// the pipe open; SSE comments (`: ...`) are filtered by EventSource so
// the client never sees them. 20s = five frames per proxy timeout, plenty
// of margin without meaningfully loading the DO.
const SSE_HEARTBEAT_INTERVAL_MS = 20 * 1000;

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
        case 'turn-summary':
          return this.handleTurnSummary(url.searchParams.get('jobId') ?? '');
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
  // alarm — wall-clock backstop
  // -------------------------------------------------------------------------

  /**
   * Dispatched by the DO runtime when the scheduled alarm fires. Walks
   * every `running` job, force-terminates any that have exceeded
   * `MAX_JOB_WALL_CLOCK_MS`, and reschedules the alarm for the next
   * outstanding deadline. Idempotent: if runLoop races us and writes its
   * own terminal event first, the re-check in this handler no-ops.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, started_at FROM job
         WHERE status = 'running' AND started_at IS NOT NULL`,
      )
      .toArray() as Array<{ id: string; started_at: number }>;

    for (const row of rows) {
      if (now - row.started_at < MAX_JOB_WALL_CLOCK_MS) continue;

      // Wake any AbortController still held in memory. If the DO was
      // evicted between start and alarm fire, the controller is gone —
      // that's fine, we still claim the terminal transition below.
      const controller = this.abortControllers.get(row.id);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }

      const minutes = Math.round(MAX_JOB_WALL_CLOCK_MS / 60_000);
      const error = `Job exceeded wall-clock budget of ${minutes}m; the sandbox or provider stream appears stalled and was forcibly terminated.`;
      // Conditional mark wins the terminal write if runLoop hasn't
      // already finished. Only broadcast the failure event if we won —
      // otherwise SSE would deliver two conflicting terminals.
      //
      // Role on the alarm-emitted event is hardcoded to 'coder' because
      // PR 1 only wires that role; when PR 2 lands a second role, the
      // schema gains a `role` column (or this path parses input_json)
      // so the alarm can recover the original role per row.
      if (this.markTerminal(row.id, 'failed', null, error)) {
        await this.appendEvent(row.id, {
          type: 'job.failed',
          executionId: row.id,
          role: 'coder',
          error,
        });
      }
    }

    await this.rescheduleAlarm();
  }

  private async rescheduleAlarm(): Promise<void> {
    // DO alarms are singletons — setAlarm replaces any prior schedule.
    // Find the earliest remaining deadline and schedule for it; if no
    // jobs are running, clear the alarm entirely. Calls are direct (not
    // optional) on purpose: setAlarm/deleteAlarm are part of the base DO
    // storage contract, and a missing implementation means the wall-
    // clock backstop is silently disabled. Better to crash loudly than
    // ship a stuck job nobody is watching.
    const row = this.ctx.storage.sql
      .exec(
        `SELECT MIN(started_at) AS oldest FROM job
         WHERE status = 'running' AND started_at IS NOT NULL`,
      )
      .toArray()[0] as { oldest?: number | null } | undefined;

    if (!row || row.oldest == null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(row.oldest + MAX_JOB_WALL_CLOCK_MS);
  }

  // -------------------------------------------------------------------------
  // /start
  // -------------------------------------------------------------------------

  private async handleStart(input: CoderJobStartInput): Promise<Response> {
    // Defense in depth: the worker route validates `role`, but tests
    // and direct DO callers can bypass it (the `as` cast in `fetch()`
    // hides a missing/invalid discriminator at the type layer). The
    // missing-vs-unsupported distinction mirrors the route layer so
    // direct callers see the same error vocabulary they'd see if they
    // went through `/api/jobs/start`.
    const role = (input as unknown as { role?: unknown }).role;
    if (typeof role !== 'string') {
      return json({ error: 'MISSING_FIELDS', fields: ['role'] }, 400);
    }
    if (!SUPPORTED_AGENT_JOB_ROLES.has(role as AgentRole)) {
      return json({ error: 'UNSUPPORTED_ROLE', role }, 400);
    }

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
      type: 'job.started',
      executionId: input.jobId,
      role: input.role,
      detail: input.envelope.task,
    });

    // Keep the DO alive beyond the request lifetime while runLoop works.
    this.ctx.waitUntil(this.runLoop(input));

    // Schedule the wall-clock alarm so a hung runLoop eventually gets
    // force-terminated. `rescheduleAlarm` picks the earliest deadline
    // across all running jobs so concurrent starts don't stomp on each
    // other. Best-effort — the alarm is a safety net, not a correctness
    // invariant, so a storage flake here shouldn't fail the start.
    await this.rescheduleAlarm().catch(() => {});

    return json({ jobId: input.jobId }, 202);
  }

  // -------------------------------------------------------------------------
  // runLoop — role-agnostic: drive a job to a terminal state and emit
  // the terminal SSE event. Role dispatch and kernel invocation live in
  // executeJob / executeCoderJob below so adding a new role in PR 2 is
  // a localized change, not a rewrite of the lifecycle wrapper.
  // -------------------------------------------------------------------------

  private async runLoop(input: AgentJobStartInput): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(input.jobId, abortController);

    try {
      const result = await this.executeJob(input, abortController.signal);

      // Claim the terminal transition atomically. If the alarm() or
      // /cancel path already wrote 'failed'/'cancelled' for this job
      // while we were awaiting the kernel (common when a sandbox call
      // ignores abort and resolves late), markTerminal returns false and
      // we skip the broadcast — otherwise SSE consumers would see two
      // conflicting terminal events for the same run.
      if (this.markTerminal(input.jobId, 'completed', result.summary, null)) {
        await this.appendEvent(input.jobId, {
          type: 'job.completed',
          executionId: input.jobId,
          role: input.role,
          summary: result.summary,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Role for the failure event: if the input shape itself is bad
      // (UnsupportedRoleError thrown from executeJob), fall back to the
      // raw role string so the SSE consumer still has something to
      // render. Coder is the only live arm in PR 1, so the cast is safe.
      const failureRole: AgentRole =
        err instanceof UnsupportedRoleError ? (err.role as AgentRole) : input.role;
      if (
        this.markTerminal(
          input.jobId,
          abortController.signal.aborted ? 'cancelled' : 'failed',
          null,
          message,
        )
      ) {
        await this.appendEvent(input.jobId, {
          type: 'job.failed',
          executionId: input.jobId,
          role: failureRole,
          error: message,
        });
      }
    } finally {
      this.abortControllers.delete(input.jobId);
      SERVICE_OVERRIDES.delete(input.jobId);
      // Collapse or clear the alarm now that this job is done — either it
      // points at the next still-running job, or it's removed entirely.
      await this.rescheduleAlarm().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // executeJob — role dispatcher. Each role has its own private
  // executor; this method picks the right one and forwards the abort
  // signal. Adding a new role in PR 2 is a one-line case + a new
  // private method — no changes to runLoop's terminal-event handling.
  // -------------------------------------------------------------------------

  private async executeJob(
    input: AgentJobStartInput,
    signal: AbortSignal,
  ): Promise<{ summary: string }> {
    switch (input.role) {
      case 'coder':
        return this.executeCoderJob(input, signal);
      // PR 2 adds new role arms here.
    }
    // The post-switch throw is the dispatcher's exhaustiveness backstop.
    // TypeScript narrows `input` to `never` here today (the union has
    // only the 'coder' member); when PR 2 expands the union without
    // expanding the switch, `(input as { role: string }).role` keeps
    // the throw working at runtime and the `never` narrowing surfaces
    // the gap as a compile error. At runtime this also covers the path
    // where a malformed input slips past both the worker validator and
    // handleStart's defense-in-depth check — far better than the
    // silent `undefined.summary` that runLoop would otherwise await.
    throw new UnsupportedRoleError((input as { role: string }).role);
  }

  private async executeCoderJob(
    input: CoderJobStartInput,
    signal: AbortSignal,
  ): Promise<{ summary: string }> {
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
    const stream =
      overrides.stream ??
      createWebStreamAdapter({
        env: this.env,
        origin: input.origin,
        provider: input.provider,
        modelId: input.model,
        jobId: input.jobId,
      });
    // PR 3: Resolve prior-turn context via the chatRef chain. The default
    // Web loader walks env.CoderJob hop-by-hop; tests inject a stub via
    // overrides. NULL_CONTEXT_LOADER fallback covers the case where the
    // CoderJob binding is missing (NOT_CONFIGURED-shaped environments).
    const contextLoader: ContextLoader =
      overrides.contextLoader ??
      (this.env.CoderJob
        ? createWebContextLoader({
            env: this.env as unknown as Parameters<typeof createWebContextLoader>[0]['env'],
          })
        : NULL_CONTEXT_LOADER);
    const priorTurns = await contextLoader.loadPriorTurns({ chatRef: input.chatRef });
    const priorTurnsBlock = formatPriorTurnsPreamble(priorTurns);

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
      signal,
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
    // PR 3: prepend prior-turn summaries so the Coder kernel sees
    // multi-turn context without inlining full chat history. The block
    // is empty when no chain was found — fresh-chat behavior is
    // unchanged.
    if (priorTurnsBlock) {
      taskPreamble = priorTurnsBlock + '\n' + taskPreamble;
    }

    const options: CoderAgentOptions<AnyToolCall, ChatCard> = {
      provider: input.provider,
      stream: stream as unknown as PushStream<LlmMessage>,
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
      signal,
      // Forward the per-delegation prompt snapshot onto the job's SSE
      // event stream so a foreground watcher can answer "what went to
      // the background Coder for this job?" without re-running the build.
      onRunEvent: (event) => {
        void this.appendEvent(input.jobId, event);
      },
    });

    return { summary: result.summary };
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
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const dropListener = (): void => {
      if (activeListener) {
        liveListeners.delete(activeListener);
        activeListener = null;
      }
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

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
              dropListener();
              controller.close();
            }
          } catch {
            dropListener();
          }
        };
        activeListener = listener;
        liveListeners.add(listener);

        // If the job is already terminal and we replayed everything,
        // close immediately.
        const status = jobStatusLookup(jobId);
        if (status && isTerminalStatus(status)) {
          dropListener();
          controller.close();
          return;
        }

        // Keep the pipe alive through edge proxy idle timeouts while the
        // job is running. SSE comments (`: ...\n\n`) are invisible to
        // EventSource consumers but reset the proxy's idle timer.
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            dropListener();
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
      },
      cancel() {
        // Client disconnected before a terminal event — drop the live
        // subscription so the DO's in-memory set doesn't leak closures
        // and keep the instance "hot" longer than necessary.
        dropListener();
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
    const lastEventRow = this.ctx.storage.sql
      .exec('SELECT MAX(ts) AS last_ts FROM event WHERE job_id = ?', jobId)
      .toArray()[0] as { last_ts?: number | null } | undefined;

    const snapshot: CoderJobStatusSnapshot = {
      jobId: row.id,
      status: row.status as CoderJobStatus,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      eventCount: eventCountRow.count,
      lastEventAt: lastEventRow?.last_ts ?? null,
      error: row.error_text ?? undefined,
    };
    return json(snapshot);
  }

  // -------------------------------------------------------------------------
  // /turn-summary — internal route the ContextLoader walks across DOs.
  // Returns intent (input.envelope.task) + outcome (job.completed
  // summary) + the prior job in the chain (input.chatRef.checkpointId).
  // Not exposed at the public route layer — `worker-coder-job.ts` does
  // not include this action; it's reachable only via DO-to-DO fetch.
  // -------------------------------------------------------------------------

  private handleTurnSummary(jobId: string): Response {
    if (!jobId) return json({ error: 'MISSING_JOB_ID' }, 400);
    const row = this.ctx.storage.sql
      .exec(`SELECT id, chat_id, status, input_json, finished_at FROM job WHERE id = ?`, jobId)
      .toArray()[0] as
      | {
          id: string;
          chat_id: string;
          status: string;
          input_json: string;
          finished_at: number | null;
        }
      | undefined;
    if (!row) return json({ error: 'JOB_NOT_FOUND' }, 404);

    let task = '';
    let priorCheckpointId: string | null = null;
    try {
      const input = JSON.parse(row.input_json) as CoderJobStartInput;
      task = input.envelope?.task ?? '';
      priorCheckpointId = input.chatRef?.checkpointId ?? null;
    } catch {
      // Malformed input_json — leave defaults, the loader will skip.
    }

    let summary: string | null = null;
    if (row.status === 'completed') {
      const completedRow = this.ctx.storage.sql
        .exec(
          `SELECT payload_json FROM event WHERE job_id = ? AND type = 'job.completed'
           ORDER BY seq DESC LIMIT 1`,
          jobId,
        )
        .toArray()[0] as { payload_json?: string } | undefined;
      if (completedRow?.payload_json) {
        try {
          const payload = JSON.parse(completedRow.payload_json) as { summary?: string };
          summary = payload.summary ?? null;
        } catch {
          // Leave summary null; loader will stop the chain walk here.
        }
      }
    }

    const response: TurnSummaryResponse = {
      jobId: row.id,
      chatId: row.chat_id ?? null,
      status: row.status as CoderJobStatus,
      task,
      summary,
      finishedAt: row.finished_at,
      priorCheckpointId,
    };
    return json(response);
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

  /**
   * Claim the terminal transition for a job. Returns true only if this
   * call was the one that actually flipped the row from 'running' to a
   * terminal state — false means someone else (runLoop, alarm, cancel)
   * already wrote a terminal state first. Callers gate the terminal
   * appendEvent on the return so SSE never sees two conflicting
   * terminals for the same run.
   *
   * DO SQL is single-threaded and these two statements contain no
   * awaits, so the read-then-update is effectively atomic: no other
   * coroutine can interleave between them.
   */
  private markTerminal(
    jobId: string,
    status: CoderJobStatus,
    summary: string | null,
    error: string | null,
  ): boolean {
    const current = this.getJobStatus(jobId);
    if (current !== 'running') return false;
    this.ctx.storage.sql.exec(
      `UPDATE job SET status = ?, finished_at = ?, result_json = ?, error_text = ? WHERE id = ?`,
      status,
      Date.now(),
      summary ? JSON.stringify({ summary }) : null,
      error,
      jobId,
    );
    return true;
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
  return type === 'job.completed' || type === 'job.failed';
}

function isTerminalStatus(status: CoderJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
