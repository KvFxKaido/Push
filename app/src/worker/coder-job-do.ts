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
import {
  CoderSuspendedError,
  resolveLeadRoundOptions,
  runCoderAgent as runCoderAgentLib,
  SandboxUnreachableError,
  type CoderAgentOptions,
  type CoderCheckpointState,
  type CoderSuspendPayload,
  type LeadToolScope,
} from '@push/lib/coder-agent';
import {
  createWorkspaceSnapshot,
  probeSandboxLiveness,
  restoreWorkspaceSnapshot,
  SNAPSHOT_KEY_PREFIX,
  type CreateSnapshotResult,
  type SandboxLivenessResult,
} from './worker-cf-sandbox';
import {
  buildCoderDetectors,
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  type CoderTurnContext,
} from '@push/lib/coder-agent-bindings';
import { CapabilityLedger, ROLE_CAPABILITIES } from '@push/lib/capabilities';
import { createCoderPolicy } from '@push/lib/coder-policy';
import type {
  AcceptanceCriterion,
  AgentRole,
  RunEventInput,
  RunEvent,
} from '@push/lib/runtime-contract';
import type { UserProfile } from '@push/lib/user-identity';
import type {
  AIProviderType,
  LlmContentPart,
  LlmMessage,
  PushStream,
} from '@push/lib/provider-contract';
import type { VerificationPolicy } from '@push/lib/verification-policy';
import { formatVerificationPolicyBlock } from '@push/lib/verification-policy';
import type { CorrelationContext } from '@push/lib/correlation-context';
import type { Capability } from '@push/lib/capabilities';
import type { AttachmentData, ChatCard, ChatMessage, DelegationEnvelope } from '@/types';
import { buildApprovalModeBlock } from '@/lib/approval-mode';
import {
  buildPriorTurnAttachmentParts,
  mergeInitialUserContentParts,
} from '@/lib/attachment-content-parts';
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
  /** Server-resolved GitHub identity of the job owner (session → allowlist
   *  owner → anon), stamped at the route layer — NEVER client-trusted (a
   *  spoofed value would dispatch with another identity's stored provider
   *  keys). Identity only: the stream adapter resolves the actual key from
   *  the user-secrets KV per dispatch; credentials are never persisted in
   *  job state. */
  ownerUserId?: string;
}

/** Discriminated union of every role-aware AgentJob input. PR 1 wires
 *  only `'coder'`; future roles join here as their kernels are migrated
 *  off the in-browser loop. The DO rejects unknown roles at /start with
 *  `UNSUPPORTED_ROLE`. */
export type AgentJobStartInput = CoderJobStartInput;

/**
 * Round-cap kernel options for a background job. When the job IS the
 * conversational lead's own turn (`envelope.leadMode` — set by the main-chat
 * server route in `chat-send-background.ts`), the kernel runs in `leadMode`
 * with NO explicit cap, so it inherits the high invisible backstop
 * (`LEAD_MAX_ROUNDS`) and the lead's graceful, name-free close. A genuinely
 * delegated sub-Coder leaves `leadMode` unset and keeps its configured
 * `maxCoderRounds` and the "[Coder stopped after N rounds…]" marker.
 *
 * The lead round/scope decision itself lives in `resolveLeadRoundOptions`
 * (`lib/coder-agent.ts`), shared with the foreground inline lane; this wrapper
 * just pins the DO's surface as `'sandbox'` (sandbox + web-search only — no
 * PR / merge / promote / artifact / ask-user tools). Exported for unit
 * testing; the DO's `executeCoderJob` is the only production caller.
 */
export function resolveJobLeadModeOptions(
  envelope: Pick<DelegationEnvelope, 'leadMode' | 'harnessSettings'>,
): {
  persona: 'lead' | 'coder';
  harnessMaxRounds: number | undefined;
  leadToolScope?: LeadToolScope;
} {
  return resolveLeadRoundOptions({
    isLead: envelope.leadMode === true,
    maxCoderRounds: envelope.harnessSettings?.maxCoderRounds,
    surface: 'sandbox',
  });
}

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

export type CoderJobStatus =
  | 'queued'
  | 'running'
  // Durably parked awaiting a typed `/resume` — non-terminal (the run is
  // paused, not finished). Excluded from the orphan sweep and wall-clock alarm
  // (both key on status='running'), so a suspended job neither relaunches nor
  // gets force-failed while it waits.
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  /** Pre-run sandbox liveness probe. Default probes via the CF Sandbox SDK
   *  when env.Sandbox is bound and no executor stub is injected; tests
   *  inject a stub to exercise the dead-at-start fail-fast path. */
  livenessProbe?: (sandboxId: string) => Promise<SandboxLivenessResult>;
  /** Workspace snapshot fn for checkpoint capture. Default is
   *  createWorkspaceSnapshot against this DO's env; tests inject a stub to
   *  exercise the transient-failure retry path. */
  snapshot?: (args: { sandboxId: string }) => Promise<CreateSnapshotResult>;
}

const SERVICE_OVERRIDES = new Map<string, CoderJobServiceOverrides>();

// Wall-clock budget for a single Coder job. A run that exceeds this is
// force-terminated by the DO's alarm handler — the backstop against a
// sandbox subrequest or provider stream that never returns and keeps the
// runLoop pinned under `ctx.waitUntil`. Without this, a hung run emits no
// terminal event, SSE stays open, and the browser has nothing to reconcile
// on refresh.
//
// Sized for long-running / big-refactor jobs: an autonomous Coder run can
// legitimately churn through many rounds, so the budget covers a full
// multi-round delegation (well beyond any single tool round-trip) while still
// guaranteeing an unhealthy run recovers in bounded time instead of haunting
// the DO forever. 60 min stays comfortably under the sandbox's own lifetime
// (Modal containers live ~2h), so a job can't outlive the container it runs in.
export const MAX_JOB_WALL_CLOCK_MS = 60 * 60 * 1000;

// Max times a single job will auto-resume from a checkpoint after a confirmed
// sandbox death. Bounded so a sandbox that keeps dying (bad image, infra issue)
// can't restore-and-retry forever — after this the job fails as before.
export const MAX_JOB_RESUMES = 2;

// Deadline for the pre-run liveness probe. Much shorter than the 150s
// per-exec deadline: the probe is a trivial `true`, so anything slower than
// this means the container is not going to serve the job anyway, and a
// background job shouldn't sit minutes in "running" before the first real
// exec discovers the sandbox died between session activity and job dispatch.
const JOB_START_PROBE_DEADLINE_MS = 30_000;

// Backoff between checkpoint-snapshot retries. A checkpoint that silently
// fails on a transient R2/exec blip means the next sandbox death cold-resumes
// from a stale round (or not at all), so a failed snapshot is worth two more
// attempts before giving up. Only status-500 failures retry — 413 (workspace
// over the snapshot cap) and 503 (storage not configured) are deterministic.
const CHECKPOINT_SNAPSHOT_BACKOFF_MS = [1_000, 3_000];

// Max times a single job will auto-resume after a DO eviction (deploy, isolate
// crash, hibernate without a live waitUntil). Independent from MAX_JOB_RESUMES:
// the former counts sandbox-death resumes within a single runLoop call (lost on
// DO restart), the latter counts DO-restart resumes and is persisted in the
// `do_resume_count` column so the cap survives across evictions. Bounded so a
// run that keeps killing its DO (OOM, bad input, infra issue) can't relaunch
// itself forever on every wake — after this the orphan sweep fails the job.
export const MAX_DO_RESTART_RESUMES = 2;

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
  finished_at INTEGER,
  do_resume_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS job_status_idx ON job (status);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS event_job_id_idx ON event (job_id, seq);

CREATE TABLE IF NOT EXISTS checkpoint (
  job_id TEXT PRIMARY KEY,
  round INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  restore_token TEXT NOT NULL,
  agent_state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Typed suspension metadata for a durably-parked job. The resumable filesystem
-- + loop state lives in the checkpoint table (captured at suspend time); this
-- table holds only the human-facing question/context and the resume-data
-- contract, so /resume can render the prompt and validate the caller's payload.
-- One row per job, cleared on resume or cancel.
CREATE TABLE IF NOT EXISTS suspension (
  job_id TEXT PRIMARY KEY,
  round INTEGER NOT NULL,
  question TEXT NOT NULL,
  context TEXT NOT NULL,
  resume_schema_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// ---------------------------------------------------------------------------
// CoderJob DO
// ---------------------------------------------------------------------------

/** Latest durable resume checkpoint for a job: a filesystem snapshot handle
 *  paired with the serialized loop state captured at the same round, so a
 *  resume restores both consistently. One row per job (upserted). */
interface JobCheckpoint {
  round: number;
  snapshotId: string;
  restoreToken: string;
  /** JSON of { round, messages, workingMemory, cards } from CoderCheckpointState. */
  agentStateJson: string;
}

/** Per-job seed used to relaunch `runLoop` after a DO eviction. The orphan
 *  sweep restores the workspace snapshot before kicking off runLoop, so the
 *  seeded sandbox handle is already wired to the restored state. */
interface RestartSeed {
  sandboxId: string;
  ownerToken: string;
  resumeState: CoderCheckpointState<ChatCard>;
}

export class CoderJob {
  /** Per-job AbortControllers so /cancel can interrupt an in-flight run. */
  private abortControllers = new Map<string, AbortController>();

  /** In-memory live-event broadcast. SSE streams subscribe here to
   * receive events immediately after they're persisted. */
  private liveListeners = new Set<(event: RunEvent) => void>();

  /** True once `sweepOrphanedJobs` has been kicked off for this DO instance.
   *  Reset on every cold start — the persisted `do_resume_count` column is
   *  the cross-eviction backstop. */
  private orphanSweepKicked = false;

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
    // Add `do_resume_count` to pre-existing `job` tables created before the
    // orphan-sweep landed. SQLite doesn't support ADD COLUMN IF NOT EXISTS,
    // so probe via PRAGMA and only ALTER when the column is missing. The
    // earlier `try { ALTER } catch {}` form would swallow real storage
    // errors (sql-flake, table corruption) along with the expected duplicate.
    const cols = this.ctx.storage.sql.exec('PRAGMA table_info(job)').toArray() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'do_resume_count')) {
      this.ctx.storage.sql.exec(
        'ALTER TABLE job ADD COLUMN do_resume_count INTEGER NOT NULL DEFAULT 0',
      );
    }
  }

  // -------------------------------------------------------------------------
  // HTTP dispatch
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    // First fetch after DO wake: scan for jobs left in 'running' by a prior
    // eviction (deploy rollover, isolate OOM, hibernate without a live
    // waitUntil) and either resume them from their last checkpoint or fail
    // them with a structured terminal event. Without this sweep an orphaned
    // job hangs for up to MAX_JOB_WALL_CLOCK_MS until the alarm backstop
    // fires, and a `/events` reconnect sees no live events. Sweep runs in
    // the background so the inbound request returns promptly; waitUntil
    // keeps the DO alive until the sweep settles.
    if (!this.orphanSweepKicked) {
      this.orphanSweepKicked = true;
      this.ctx.waitUntil(this.sweepOrphanedJobs());
    }

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
        case 'resume':
          return await this.handleResume(
            url.searchParams.get('jobId') ?? '',
            (await request.json().catch(() => ({}))) as { resumeData?: unknown },
          );
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

  private async runLoop(input: AgentJobStartInput, seed?: RestartSeed): Promise<void> {
    const abortController = new AbortController();
    this.abortControllers.set(input.jobId, abortController);

    try {
      const result = await this.executeJob(input, abortController.signal, seed);

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
      // Durable suspension is not a failure: `suspendJob` (called from
      // executeCoderJob before the rethrow) already flipped the row to
      // 'suspended' and emitted `job.suspended`. Returning here leaves that
      // non-terminal state intact — markTerminal below would otherwise no-op on
      // it anyway (the row isn't 'running'), but returning also skips emitting a
      // spurious `job.failed`. The `finally` still runs: it clears the in-memory
      // controller and reschedules the alarm off this now-parked job.
      if (err instanceof CoderSuspendedError) return;
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
    seed?: RestartSeed,
  ): Promise<{ summary: string }> {
    switch (input.role) {
      case 'coder':
        return this.executeCoderJob(input, signal, seed);
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
    seed?: RestartSeed,
  ): Promise<{ summary: string }> {
    const overrides = SERVICE_OVERRIDES.get(input.jobId) ?? {};
    const detectors = overrides.detectors ?? createWebDetectorAdapter();
    const stream =
      overrides.stream ??
      createWebStreamAdapter({
        env: this.env,
        origin: input.origin,
        provider: input.provider,
        modelId: input.model,
        jobId: input.jobId,
        ownerUserId: input.ownerUserId,
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

    let taskPreamble = buildCoderDelegationBrief({
      ...input.envelope,
      provider: input.provider,
      model: input.model,
    });
    // PR 3: prepend prior-turn summaries so the Coder kernel sees
    // multi-turn context without inlining full chat history. The block
    // is empty when no chain was found — fresh-chat behavior is
    // unchanged.
    if (priorTurnsBlock) {
      taskPreamble = priorTurnsBlock + '\n' + taskPreamble;
    }
    // Prior-turn attachments come from the SAME chain walk as the summaries
    // (each prior job's persisted envelope.attachments, read via /turn-summary),
    // so the multimodal context and the text context describe the same turns —
    // no drift between two independently-sourced channels (#938). priorTurns is
    // already oldest→newest, so the flattened parts read in conversation order.
    const priorAttParts = buildPriorTurnAttachmentParts(
      priorTurns.flatMap((t) => t.attachments ?? []),
    );
    const initialUserContentParts: LlmContentPart[] | undefined = mergeInitialUserContentParts(
      taskPreamble,
      priorAttParts,
      input.envelope.attachments,
    );

    // Seamless resume loop: on a confirmed sandbox death the kernel throws
    // SandboxUnreachableError; we restore the latest checkpoint into a fresh
    // sandbox and re-run the loop seeded with the checkpoint state. The
    // sandbox-bound pieces (executor, turnCtx, services, options) are rebuilt
    // each attempt against the current sandbox. Bounded by MAX_JOB_RESUMES.
    //
    // `seed` is set when the orphan sweep relaunches this job after a DO
    // eviction — it carries a freshly restored sandbox handle and the
    // checkpoint loop state, so the kernel starts already-resumed rather
    // than re-running from round 0 against a dead sandbox.
    let sandboxId = seed?.sandboxId ?? input.sandboxId;
    let ownerToken = seed?.ownerToken ?? input.ownerToken;
    let resumeState: CoderCheckpointState<ChatCard> | undefined = seed?.resumeState;
    let resumesUsed = 0;
    // Policy counters (drift, trailing intent, mutation backpressure) belong to
    // the logical job, not one sandbox attempt. Services are rebuilt after a
    // sandbox restore, so keep the shared policy instance outside that loop.
    const policy = createCoderPolicy();

    // Fail fast on a sandbox that died between session activity and job
    // dispatch. Without this probe the first sign of trouble is the kernel's
    // first tool exec — after a full model round has streamed — so the user
    // watches "job running" for minutes before the unreachable error lands.
    // Skipped for seeded resumes (the orphan sweep just restored that sandbox)
    // and for test runs that stub the executor without a real sandbox.
    const livenessProbe =
      overrides.livenessProbe ??
      (this.env.Sandbox && !overrides.executor
        ? (id: string) =>
            probeSandboxLiveness(this.env, id, { deadlineMs: JOB_START_PROBE_DEADLINE_MS })
        : undefined);
    if (!seed && livenessProbe) {
      const probe = await livenessProbe(sandboxId);
      if (!probe.alive) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'coder_job_start_sandbox_unreachable',
            jobId: input.jobId,
            sandboxId,
            reason: probe.reason,
            attempts: probe.attempts,
            error: probe.error,
          }),
        );
        throw new Error(
          probe.reason === 'wedged'
            ? `Sandbox stopped responding before the job started (probe exceeded ${JOB_START_PROBE_DEADLINE_MS}ms). Retry once the sandbox recovers, or restart it and re-delegate.`
            : 'Sandbox was lost before the job started. Restart the sandbox and re-delegate the task.',
        );
      }
    }

    for (;;) {
      const executor =
        overrides.executor ??
        createWebExecutorAdapter({
          env: this.env,
          origin: input.origin,
          sandboxId,
          ownerToken,
          provider: input.provider,
          jobId: input.jobId,
          // Honor the session's Protect Main in the background lane (#977): a
          // raw `git push` via sandbox_exec is blocked under Protect Main even
          // with allowDirectGit, matching the web git-guard.
          protectMain: input.envelope.branchContext?.protectMain ?? false,
        });
      const turnCtx: CoderTurnContext = {
        role: 'coder',
        round: 0,
        maxRounds: input.envelope.harnessSettings?.maxCoderRounds ?? 30,
        sandboxId,
        allowedRepo: input.repoFullName,
        activeProvider: input.provider,
        activeModel: input.model,
        taskInFlight: true,
        signal,
      };
      const services = buildCoderJobServices({
        detectors,
        executor,
        capabilityLedger: new CapabilityLedger(declaredCaps),
        turnCtx,
        onStatus: () => {},
        correlation: input.correlation,
        activeProvider: input.provider,
        activeModel: input.model,
        sandboxId,
        policy,
        // NOTE: memory tools are intentionally NOT wired for background jobs.
        // `getDefaultMemoryStore()` is an in-memory singleton populated within a
        // runtime; the browser session accumulates records and the delegated
        // Coder reads them, but this Worker/DO isolate starts empty and nothing
        // populates it — so advertising memory here would be a non-functional
        // (always-empty) tool surface. Deferred until a Worker-side persistent
        // store (KV/DO/R2) is wired — tracked under "LCM follow-through".
      });

      const options: CoderAgentOptions<AnyToolCall, ChatCard> = {
        provider: input.provider,
        stream: stream as unknown as PushStream<LlmMessage>,
        modelId: input.model,
        sandboxId,
        allowedRepo: input.repoFullName,
        branchContext: input.envelope.branchContext,
        projectInstructions: input.projectInstructions ?? input.envelope.projectInstructions,
        instructionFilename: input.instructionFilename ?? input.envelope.instructionFilename,
        userProfile: input.userProfile,
        taskPreamble,
        initialUserContentParts,
        symbolSummary: null,
        toolExec: buildCoderToolExec(services),
        ...buildCoderDetectors(services),
        webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
        sandboxToolProtocol: getSandboxToolProtocol(),
        // Memory not advertised for background jobs — no Worker-side store (see
        // the executeMemory note above). Advertising must match executor support.
        verificationPolicyBlock: formatVerificationPolicyBlock(input.verificationPolicy),
        approvalModeBlock: buildApprovalModeBlock('full-auto'),
        evaluateAfterModel: buildCoderEvaluateAfterModel(services),
        acceptanceCriteria: input.acceptanceCriteria ?? input.envelope.acceptanceCriteria,
        // When the job IS the conversational lead's own turn (main-chat routed
        // to the server), run the kernel in leadMode (high invisible backstop +
        // graceful, name-free close); a delegated sub-Coder keeps its configured
        // cap and the "[Coder stopped after N rounds…]" marker. See
        // `resolveJobLeadModeOptions`.
        ...resolveJobLeadModeOptions(input.envelope),
        // Per-run token budget rides the envelope's harness settings (resolved
        // client-side with the user's preference folded in), so the background
        // lane honors the same cap as the foreground lead.
        harnessTokenBudget: input.envelope.harnessSettings?.runTokenBudget,
        harnessContextResetsEnabled: input.envelope.harnessSettings?.contextResetsEnabled,
        resumeState,
        // Durable suspension only when the job IS the user's own turn (leadMode):
        // the counterparty to a guidance call is then the human, who may answer
        // long after this DO isolate is evicted, so the pause must survive as
        // persisted state, not a held await. A delegated sub-Coder has no human
        // to answer, so it keeps the kernel's fall-through-to-done and never
        // parks. `leadMode` is the same discriminator resolveJobLeadModeOptions
        // uses to pick lead vs. coder persona.
        durableSuspension: input.envelope.leadMode === true,
      };

      const checkpointSandboxId = sandboxId;
      try {
        const result = await runCoderAgentLib(options, {
          onStatus: () => {},
          signal,
          // Forward the per-delegation prompt snapshot onto the job's SSE
          // event stream so a foreground watcher can answer "what went to
          // the background Coder for this job?" without re-running the build.
          onRunEvent: (event) => {
            void this.appendEvent(input.jobId, event);
          },
          // Durable resume checkpoint: snapshot the workspace + persist loop
          // state every few rounds so a sandbox death can be recovered. The
          // captured/skipped boolean is only consumed by the suspend path (which
          // calls captureCheckpoint directly); the cadence hook discards it.
          onCheckpoint: async (state) => {
            await this.captureCheckpoint(input.jobId, checkpointSandboxId, state);
          },
        });
        return { summary: result.summary };
      } catch (err) {
        // Durable suspension: the run asked for guidance and parked itself.
        // Snapshot + persist here (sandboxId is in scope) while the job is still
        // 'running', then rethrow so runLoop skips its terminal handling and
        // leaves the row 'suspended'. If the snapshot can't be captured there's
        // no durable state to resume from, so `suspendJob` rethrows a plain
        // error and the job fails as usual rather than parking un-resumably.
        if (err instanceof CoderSuspendedError) {
          await this.suspendJob(input.jobId, checkpointSandboxId, input.role, err);
          throw err;
        }
        if (!(err instanceof SandboxUnreachableError)) throw err;
        const recovered = await this.resumeFromCheckpoint(input.jobId, resumesUsed);
        if (!recovered) throw err;
        sandboxId = recovered.sandboxId;
        ownerToken = recovered.ownerToken;
        resumeState = recovered.resumeState;
        resumesUsed += 1;
      }
    }
  }

  /**
   * Restore the latest checkpoint into a fresh sandbox so the job can resume.
   * Returns the new sandbox handle + the deserialized loop state, or null when
   * resume isn't possible (cap hit, no checkpoint, restore failed) — in which
   * case the caller lets the original failure stand.
   */
  private async resumeFromCheckpoint(
    jobId: string,
    resumesUsed: number,
  ): Promise<{
    sandboxId: string;
    ownerToken: string;
    resumeState: CoderCheckpointState<ChatCard>;
  } | null> {
    // Three silent-null paths in this function previously returned without
    // any log: cap-exhausted, no-checkpoint, and JSON parse failure on the
    // persisted agent state. From the outside they're indistinguishable
    // from a successful resume that just didn't happen yet, which made
    // debugging a stalled / terminally-failing job require reading DO
    // storage directly. Each path now emits a single structured warn log
    // so `wrangler tail` shows why a resume bailed.
    if (resumesUsed >= MAX_JOB_RESUMES) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'coder_resume_cap_exhausted',
          jobId,
          resumesUsed,
          cap: MAX_JOB_RESUMES,
        }),
      );
      return null;
    }
    const cp = this.readCheckpoint(jobId);
    if (!cp) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'coder_resume_no_checkpoint',
          jobId,
          resumesUsed,
        }),
      );
      return null;
    }

    const restored = await restoreWorkspaceSnapshot(this.env, {
      snapshotId: cp.snapshotId,
      restoreToken: cp.restoreToken,
    });
    if (!restored.ok) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'coder_resume_restore_failed',
          jobId,
          round: cp.round,
          error: restored.error,
        }),
      );
      return null;
    }

    let resumeState: CoderCheckpointState<ChatCard>;
    try {
      resumeState = JSON.parse(cp.agentStateJson) as CoderCheckpointState<ChatCard>;
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'coder_resume_state_parse_failed',
          jobId,
          round: cp.round,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_job_resumed',
        jobId,
        round: cp.round,
        sandboxId: restored.sandboxId,
      }),
    );
    return { sandboxId: restored.sandboxId, ownerToken: restored.ownerToken, resumeState };
  }

  // -------------------------------------------------------------------------
  // Durable suspend / typed resume
  // -------------------------------------------------------------------------

  /**
   * Park a run that emitted a durable guidance call. Called from
   * executeCoderJob's catch while the row is still 'running' and `sandboxId` is
   * in scope. Captures the workspace + loop state into the `checkpoint` table
   * (the same durable pair a sandbox-death resume uses), persists the typed
   * suspension metadata, flips the row to 'suspended', and emits `job.suspended`.
   *
   * If the checkpoint can't be captured there is no durable state to resume
   * from, so this rethrows a plain error and lets runLoop fail the job — parking
   * a job we could never revive would strand it in 'suspended' forever.
   */
  private async suspendJob(
    jobId: string,
    sandboxId: string,
    role: AgentRole,
    err: CoderSuspendedError<ChatCard>,
  ): Promise<void> {
    const captured = await this.captureCheckpoint(jobId, sandboxId, err.state);
    if (!captured) {
      // captureCheckpoint already logged the snapshot failure (coder_checkpoint_
      // failed / _too_large). Add the suspend-specific consequence so tail logs
      // show *why* the guidance call became a hard failure instead of a pause.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'coder_suspend_no_durable_state',
          jobId,
          round: err.state.round,
        }),
      );
      throw new Error(
        'Run tried to suspend for guidance but its workspace snapshot could not be captured, so there is no durable state to resume from.',
      );
    }

    // Claim the running→suspended transition. Mirrors markTerminal's atomic
    // read-then-update (single-threaded SQL, no await between): if /cancel or
    // the alarm already moved the row off 'running' while the snapshot was in
    // flight, we lose the claim and skip both the metadata write and the event.
    if (!this.markSuspended(jobId)) {
      console.log(JSON.stringify({ level: 'info', event: 'coder_suspend_preempted', jobId }));
      return;
    }

    this.persistSuspension(jobId, {
      round: err.state.round,
      question: err.payload.question,
      context: err.payload.context,
      resumeSchemaJson: JSON.stringify(err.payload.resumeSchema),
    });

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_job_suspended',
        jobId,
        round: err.state.round,
      }),
    );

    await this.appendEvent(jobId, {
      type: 'job.suspended',
      executionId: jobId,
      role,
      question: err.payload.question,
      context: err.payload.context,
      resumeSchema: JSON.stringify(err.payload.resumeSchema),
    });
  }

  /**
   * Claim the running→suspended transition. Returns true only if this call
   * flipped a 'running' row — false if some other path (cancel, alarm) already
   * moved it. `finished_at` stays null: a suspended job is paused, not finished.
   */
  private markSuspended(jobId: string): boolean {
    if (this.getJobStatus(jobId) !== 'running') return false;
    this.ctx.storage.sql.exec("UPDATE job SET status = 'suspended' WHERE id = ?", jobId);
    return true;
  }

  private persistSuspension(
    jobId: string,
    s: { round: number; question: string; context: string; resumeSchemaJson: string },
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO suspension
         (job_id, round, question, context, resume_schema_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      jobId,
      s.round,
      s.question,
      s.context,
      s.resumeSchemaJson,
      Date.now(),
    );
  }

  private readSuspension(jobId: string): {
    round: number;
    question: string;
    context: string;
    resumeSchema: CoderSuspendPayload['resumeSchema'];
  } | null {
    const row = this.ctx.storage.sql
      .exec(
        'SELECT round, question, context, resume_schema_json FROM suspension WHERE job_id = ?',
        jobId,
      )
      .toArray()[0] as
      | { round?: number; question?: string; context?: string; resume_schema_json?: string }
      | undefined;
    if (!row || typeof row.question !== 'string') return null;
    let resumeSchema: CoderSuspendPayload['resumeSchema'];
    try {
      resumeSchema = JSON.parse(
        row.resume_schema_json ?? '{}',
      ) as CoderSuspendPayload['resumeSchema'];
    } catch {
      // A corrupt schema shouldn't block resume — fall back to the default
      // free-text contract so a stored suspension is never un-resumable.
      resumeSchema = { required: ['answer'], fields: { answer: 'string' } };
    }
    return {
      round: row.round ?? 0,
      question: row.question,
      context: row.context ?? '',
      resumeSchema,
    };
  }

  private clearSuspension(jobId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM suspension WHERE job_id = ?', jobId);
  }

  // -------------------------------------------------------------------------
  // Orphan sweep — recover jobs left in 'running' by a DO eviction
  // -------------------------------------------------------------------------

  /**
   * Scan for `status='running'` rows whose runLoop died with the prior DO
   * isolate (deploy, OOM, hibernate without a live waitUntil). For each
   * orphan: if a checkpoint exists and the persisted DO-restart cap isn't
   * exhausted, restore the workspace into a fresh sandbox and relaunch
   * runLoop already-resumed. Otherwise mark the job failed with a
   * structured terminal event so SSE consumers see the failure instead of
   * waiting up to MAX_JOB_WALL_CLOCK_MS for the alarm backstop.
   *
   * Idempotent within a DO lifetime via `orphanSweepKicked`; persisted
   * `do_resume_count` caps total relaunches across evictions.
   */
  private async sweepOrphanedJobs(): Promise<void> {
    const orphans = this.ctx.storage.sql
      .exec(`SELECT id, input_json, do_resume_count FROM job WHERE status = 'running'`)
      .toArray() as Array<{ id: string; input_json: string; do_resume_count: number }>;

    if (orphans.length === 0) return;

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_orphan_sweep_started',
        orphans: orphans.length,
      }),
    );

    for (const row of orphans) {
      await this.resumeOrphanedJob(row.id, row.input_json, row.do_resume_count);
    }
  }

  private async resumeOrphanedJob(
    jobId: string,
    inputJson: string,
    doResumeCount: number,
  ): Promise<void> {
    let input: AgentJobStartInput;
    try {
      input = JSON.parse(inputJson) as AgentJobStartInput;
    } catch (err) {
      await this.failOrphan(
        jobId,
        'coder_orphan_input_parse_failed',
        'coder',
        `DO restart: input_json parse failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return;
    }

    if (doResumeCount >= MAX_DO_RESTART_RESUMES) {
      await this.failOrphan(
        jobId,
        'coder_orphan_resume_cap_exhausted',
        input.role,
        `DO restart: resume cap of ${MAX_DO_RESTART_RESUMES} exhausted; the job has been auto-resumed too many times across DO evictions and is being failed to prevent an unbounded restart loop.`,
      );
      return;
    }

    const cp = this.readCheckpoint(jobId);
    if (!cp) {
      await this.failOrphan(
        jobId,
        'coder_orphan_no_checkpoint',
        input.role,
        'DO restart: the run was evicted before a checkpoint was captured (first checkpoint lands at round 5). No durable state exists to resume from.',
      );
      return;
    }

    // Pre-restore re-check. The fetch path may have already taken /cancel
    // (which now flips the row to 'cancelled' even with no live controller)
    // or the wall-clock alarm may have fired between sweepOrphanedJobs's
    // initial SELECT and our turn in the for-loop. Either way, restoring
    // the snapshot is wasted work.
    if (this.getJobStatus(jobId) !== 'running') {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'coder_orphan_preempted',
          jobId,
          phase: 'pre_restore',
        }),
      );
      return;
    }

    const restored = await restoreWorkspaceSnapshot(this.env, {
      snapshotId: cp.snapshotId,
      restoreToken: cp.restoreToken,
    });
    if (!restored.ok) {
      await this.failOrphan(
        jobId,
        'coder_orphan_restore_failed',
        input.role,
        `DO restart: workspace snapshot restore failed (${restored.error}).`,
      );
      return;
    }

    let resumeState: CoderCheckpointState<ChatCard>;
    try {
      resumeState = JSON.parse(cp.agentStateJson) as CoderCheckpointState<ChatCard>;
    } catch (err) {
      await this.failOrphan(
        jobId,
        'coder_orphan_state_parse_failed',
        input.role,
        `DO restart: agent_state_json parse failed (${err instanceof Error ? err.message : String(err)}).`,
      );
      return;
    }

    // Post-restore re-check. restoreWorkspaceSnapshot is the long await in
    // this path; /cancel or alarm() can land while it's pending. Without
    // this, we'd unconditionally launch runLoop on a job the client was
    // already told was terminal, and the kernel could call sandbox tools /
    // commit / open PRs after the terminal SSE event fired. markTerminal()
    // at runLoop's end gates the duplicate terminal event but not the work
    // in between. Sandbox cleanup is left to the provider's idle timeout —
    // a small efficiency loss in this rare race, not a correctness gap.
    if (this.getJobStatus(jobId) !== 'running') {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'coder_orphan_preempted',
          jobId,
          phase: 'post_restore',
          sandboxId: restored.sandboxId,
        }),
      );
      return;
    }

    // Persist the incremented count BEFORE relaunching the loop. If this
    // resume also dies before checkpointing, the next sweep sees the higher
    // count and trips the cap — the alternative (increment on first
    // checkpoint) lets a job that dies pre-checkpoint cycle forever.
    this.ctx.storage.sql.exec(
      'UPDATE job SET do_resume_count = ? WHERE id = ?',
      doResumeCount + 1,
      jobId,
    );

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_orphan_resumed',
        jobId,
        round: cp.round,
        sandboxId: restored.sandboxId,
        doResumeCount: doResumeCount + 1,
      }),
    );

    this.ctx.waitUntil(
      this.runLoop(input, {
        sandboxId: restored.sandboxId,
        ownerToken: restored.ownerToken,
        resumeState,
      }),
    );

    // Ensure the wall-clock backstop is wired for the resumed run. handleStart
    // schedules the alarm best-effort and a flake there would leave the
    // orphaned row alarm-less; without rescheduling here, a resumed run that
    // hangs would never get force-terminated. Same best-effort semantics as
    // handleStart so an alarm-flake doesn't sink the recovery.
    await this.rescheduleAlarm().catch(() => {});
  }

  /**
   * Mark an orphan as failed and emit a terminal SSE event. Uses the same
   * `markTerminal` claim as runLoop / alarm() so a race with the alarm
   * backstop or a late-arriving runLoop terminal cannot produce two
   * conflicting `job.failed` broadcasts for the same id.
   */
  private async failOrphan(
    jobId: string,
    event: string,
    role: AgentRole,
    error: string,
  ): Promise<void> {
    if (!this.markTerminal(jobId, 'failed', null, error)) return;
    console.warn(JSON.stringify({ level: 'warn', event, jobId, error }));
    await this.appendEvent(jobId, {
      type: 'job.failed',
      executionId: jobId,
      role,
      error,
    });
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
            if (isStreamHaltEventType(event.type)) {
              dropListener();
              controller.close();
            }
          } catch {
            dropListener();
          }
        };
        activeListener = listener;
        liveListeners.add(listener);

        // If the job is already terminal — or suspended, which produces no
        // further events until a /resume — and we replayed everything, close
        // immediately rather than holding a heartbeat loop open on a run that
        // won't emit again on this connection.
        const status = jobStatusLookup(jobId);
        if (status && isStreamHaltStatus(status)) {
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
    // No live AbortController but the row is still 'running'. The only
    // legitimate source of this state is an orphan: a DO eviction left the
    // row behind, and the sweep either hasn't run yet or is mid-restore
    // (the long await window in resumeOrphanedJob). Marking the row
    // 'cancelled' here makes the sweep's post-restore status re-check bail
    // before relaunching, and gives the client a real terminal so the
    // Cancel button doesn't lock out further attempts on an apparent 2xx.
    if (status === 'running') {
      const error = 'cancelled before resume';
      if (this.markTerminal(jobId, 'cancelled', null, error)) {
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: 'coder',
          error,
        });
      }
      return json({ jobId, cancelled: true, reason: 'CANCELLED_ORPHAN' });
    }
    // A suspended job has no live run to abort, but the user can still cancel
    // the pause outright. markTerminal flips suspended→cancelled (it only guards
    // against re-terminating an already-terminal row, and 'suspended' isn't
    // terminal), and we drop the now-dead suspension metadata so a later /resume
    // can't revive a cancelled job.
    if (status === 'suspended') {
      const error = 'cancelled while suspended';
      if (this.markTerminal(jobId, 'cancelled', null, error)) {
        this.clearSuspension(jobId);
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: 'coder',
          error,
        });
      }
      return json({ jobId, cancelled: true, reason: 'CANCELLED_SUSPENDED' });
    }
    return json({ jobId, cancelled: false, reason: 'NO_ACTIVE_RUN' });
  }

  // -------------------------------------------------------------------------
  // /resume — revive a suspended job with typed resumeData
  // -------------------------------------------------------------------------

  /**
   * Revive a durably-suspended job. Validates `resumeData` against the stored
   * resume schema, restores the checkpoint workspace into a fresh sandbox,
   * appends the caller's answer as the next user message (so the kernel re-enters
   * exactly where the synchronous checkpoint path's `continue` would land), flips
   * suspended→running, and relaunches runLoop seeded with that state.
   *
   * The suspended→running claim is synchronous (single-threaded SQL, no await
   * between read and update) so two concurrent /resume calls can't both relaunch
   * the same job. The claim happens BEFORE the long snapshot restore; if the
   * restore then fails, the job is failed terminally rather than left half-alive.
   */
  private async handleResume(jobId: string, body: { resumeData?: unknown }): Promise<Response> {
    if (!jobId) return json({ error: 'MISSING_JOB_ID' }, 400);

    const status = this.getJobStatus(jobId);
    if (status == null) return json({ error: 'JOB_NOT_FOUND', jobId }, 404);
    if (status !== 'suspended') {
      return json({ error: 'NOT_SUSPENDED', jobId, status }, 409);
    }

    const suspension = this.readSuspension(jobId);
    if (!suspension) {
      // Status says suspended but the metadata row is gone — inconsistent state
      // we can't resume from. Fail the job so the client stops waiting.
      const error = 'Suspension metadata missing; cannot resume.';
      if (this.markTerminal(jobId, 'failed', null, error)) {
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: 'coder',
          error,
        });
      }
      return json({ error: 'SUSPENSION_STATE_MISSING', jobId }, 409);
    }

    const validation = validateResumeData(body.resumeData, suspension.resumeSchema);
    if (!validation.ok) {
      return json({ error: 'INVALID_RESUME_DATA', jobId, issues: validation.issues }, 400);
    }

    const input = this.readJobInput(jobId);
    if (!input) {
      const error = 'Job input missing; cannot resume.';
      if (this.markTerminal(jobId, 'failed', null, error)) {
        this.clearSuspension(jobId);
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: 'coder',
          error,
        });
      }
      return json({ error: 'JOB_INPUT_MISSING', jobId }, 409);
    }

    const cp = this.readCheckpoint(jobId);
    if (!cp) {
      const error = 'Resume checkpoint missing; cannot resume.';
      if (this.markTerminal(jobId, 'failed', null, error)) {
        this.clearSuspension(jobId);
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: input.role,
          error,
        });
      }
      return json({ error: 'CHECKPOINT_MISSING', jobId }, 409);
    }

    let resumeState: CoderCheckpointState<ChatCard>;
    try {
      resumeState = JSON.parse(cp.agentStateJson) as CoderCheckpointState<ChatCard>;
    } catch (err) {
      const error = `Resume state parse failed (${err instanceof Error ? err.message : String(err)}).`;
      if (this.markTerminal(jobId, 'failed', null, error)) {
        this.clearSuspension(jobId);
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: input.role,
          error,
        });
      }
      return json({ error: 'RESUME_STATE_PARSE_FAILED', jobId }, 409);
    }

    // Claim suspended→running synchronously so a concurrent /resume loses the
    // race and no-ops below. Restart the wall-clock budget (started_at = now):
    // a resumed run gets a fresh MAX_JOB_WALL_CLOCK_MS window, not the residue
    // of the pre-suspension clock.
    if (this.getJobStatus(jobId) !== 'suspended') {
      return json({ error: 'NOT_SUSPENDED', jobId, status: this.getJobStatus(jobId) }, 409);
    }
    this.ctx.storage.sql.exec(
      "UPDATE job SET status = 'running', started_at = ? WHERE id = ?",
      Date.now(),
      jobId,
    );
    this.clearSuspension(jobId);

    // Inject the human's answer as the next user message. Mirrors the
    // synchronous checkpoint path's `[CHECKPOINT RESPONSE …]` envelope so the
    // kernel treats durable-resumed guidance identically to in-tab guidance.
    const answer = extractResumeAnswer(body.resumeData);
    resumeState.messages.push({
      id: `coder-resume-answer-${resumeState.round}`,
      role: 'user',
      content: `[CHECKPOINT RESPONSE — guidance from the user]\n${answer}\n[/CHECKPOINT RESPONSE]`,
      timestamp: Date.now(),
    });

    const restored = await restoreWorkspaceSnapshot(this.env, {
      snapshotId: cp.snapshotId,
      restoreToken: cp.restoreToken,
    });
    if (!restored.ok) {
      const error = `Resume workspace restore failed (${restored.error}).`;
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'coder_resume_restore_failed',
          jobId,
          round: cp.round,
          phase: 'suspend_resume',
          error: restored.error,
        }),
      );
      if (this.markTerminal(jobId, 'failed', null, error)) {
        await this.appendEvent(jobId, {
          type: 'job.failed',
          executionId: jobId,
          role: input.role,
          error,
        });
      }
      return json({ error: 'RESUME_RESTORE_FAILED', jobId }, 502);
    }

    // Post-restore re-check — the same race the orphan-resume path guards. The
    // claim flipped the row to 'running' before this long restore await, so a
    // concurrent /cancel during the window is handled as a running orphan and
    // marks the job 'cancelled' + emits a terminal event. Without this guard we
    // would still append job.resumed and launch runLoop, running sandbox work
    // after the client was told the job was terminal. Bail instead; the freshly
    // restored sandbox is left to the provider's idle timeout (a rare-race
    // efficiency loss, not a correctness gap), mirroring resumeOrphanedJob.
    if (this.getJobStatus(jobId) !== 'running') {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'coder_resume_preempted',
          jobId,
          phase: 'post_restore',
          sandboxId: restored.sandboxId,
        }),
      );
      return json({ jobId, resumed: false, reason: 'PREEMPTED' }, 409);
    }

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_job_resumed_from_suspend',
        jobId,
        round: resumeState.round,
        sandboxId: restored.sandboxId,
      }),
    );

    await this.appendEvent(jobId, {
      type: 'job.resumed',
      executionId: jobId,
      role: input.role,
    });

    this.ctx.waitUntil(
      this.runLoop(input, {
        sandboxId: restored.sandboxId,
        ownerToken: restored.ownerToken,
        resumeState,
      }),
    );
    await this.rescheduleAlarm().catch(() => {});

    return json({ jobId, resumed: true }, 202);
  }

  /** Read + parse a job's persisted start input, or null if absent/corrupt. */
  private readJobInput(jobId: string): AgentJobStartInput | null {
    const row = this.ctx.storage.sql
      .exec('SELECT input_json FROM job WHERE id = ?', jobId)
      .toArray()[0] as { input_json?: string } | undefined;
    if (!row?.input_json) return null;
    try {
      return JSON.parse(row.input_json) as AgentJobStartInput;
    } catch {
      return null;
    }
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
    let attachments: AttachmentData[] | undefined;
    try {
      const input = JSON.parse(row.input_json) as CoderJobStartInput;
      task = input.envelope?.task ?? '';
      priorCheckpointId = input.chatRef?.checkpointId ?? null;
      if (input.envelope?.attachments && input.envelope.attachments.length > 0) {
        attachments = input.envelope.attachments;
      }
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
      // Contract: no summary, no attachments. The loader only consumes a turn
      // when it's completed + summary-bearing, so shipping base64 bytes for a
      // running/failed job would just be discarded — gate them out here.
      ...(summary != null && attachments ? { attachments } : {}),
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
   * call was the one that actually flipped the row from a non-terminal
   * state ('running' or 'suspended') to a terminal one — false means
   * someone else (runLoop, alarm, cancel) already wrote a terminal state
   * first, or the row is already terminal. Callers gate the terminal
   * appendEvent on the return so SSE never sees two conflicting terminals
   * for the same run.
   *
   * 'suspended' is claimable too: a parked job can be cancelled by the user
   * or failed by a resume-precondition check (missing metadata/checkpoint),
   * and those paths need the transition to actually land — guarding on
   * 'running' alone silently no-oped them, stranding the row as 'suspended'.
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
    if (current !== 'running' && current !== 'suspended') return false;
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

  /**
   * Capture a durable resume checkpoint: snapshot the workspace and persist the
   * serialized loop state at the same round, so a future resume restores both
   * consistently. Best-effort — a snapshot failure just skips this checkpoint
   * and the run continues uninterrupted.
   *
   * Checkpoints are PER-JOB and deliberately omit repo/branch, so they do NOT
   * touch the shared repo/branch snapshot index. Otherwise a concurrent job (or
   * a client hibernate) on the same branch would reclaim this job's
   * still-referenced checkpoint object and break its resume. We reclaim this
   * job's own previous checkpoint ourselves below.
   */
  private async captureCheckpoint(
    jobId: string,
    sandboxId: string,
    state: CoderCheckpointState<ChatCard>,
  ): Promise<boolean> {
    const prior = this.readCheckpoint(jobId);
    const snapshotFn =
      SERVICE_OVERRIDES.get(jobId)?.snapshot ??
      ((args: { sandboxId: string }) => createWorkspaceSnapshot(this.env, args));
    // Retry transient (status-500) snapshot failures with backoff: a single
    // R2/exec blip otherwise skips this checkpoint silently, and the next
    // sandbox death resumes from a round several checkpoints stale. 413 and
    // 503 are deterministic and exit the loop immediately.
    let attempts = 1;
    let snap = await snapshotFn({ sandboxId });
    for (const delayMs of CHECKPOINT_SNAPSHOT_BACKOFF_MS) {
      if (snap.ok || snap.status !== 500) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempts += 1;
      snap = await snapshotFn({ sandboxId });
    }
    if (!snap.ok) {
      // Surface the lost checkpoint in logs — onStatus is a no-op here, so this
      // is the only diagnostic trail for a snapshot a future resume may need.
      // Too-large gets its own event name: it recurs every cadence once the
      // workspace outgrows the snapshot cap, and the remediation (commit/push
      // or clean large artifacts) is nothing like a transient storage failure.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: snap.status === 413 ? 'coder_checkpoint_too_large' : 'coder_checkpoint_failed',
          jobId,
          round: state.round,
          status: snap.status,
          attempts,
          error: snap.error,
        }),
      );
      return false;
    }
    this.persistCheckpoint(jobId, {
      round: state.round,
      snapshotId: snap.snapshotId,
      restoreToken: snap.restoreToken,
      agentStateJson: JSON.stringify({
        round: state.round,
        messages: state.messages,
        workingMemory: state.workingMemory,
        cards: state.cards,
      }),
    });
    // Success-side mirror of `coder_checkpoint_failed` and `coder_job_resumed` —
    // a single structured log line per durable checkpoint so observability of
    // the resume path is symmetric (failure → log, success → log). Without it,
    // a successful checkpoint was a silent operation: tail logs only revealed
    // the resume path when it broke, never when it worked. snapshotId omitted
    // (it's a per-run UUID that only the DO needs); round + jobId is enough to
    // correlate with a captureCheckpoint cadence boundary in any later replay.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_checkpoint_captured',
        jobId,
        round: state.round,
      }),
    );
    // Reclaim this job's previous checkpoint object now the new one is durable —
    // per-job, never cross-job. Prefix-guarded so we only delete our own R2 keys.
    if (
      prior &&
      prior.snapshotId !== snap.snapshotId &&
      prior.snapshotId.startsWith(SNAPSHOT_KEY_PREFIX) &&
      this.env.SNAPSHOTS
    ) {
      await this.env.SNAPSHOTS.delete(prior.snapshotId).catch(() => {});
    }
    return true;
  }

  private persistCheckpoint(jobId: string, cp: JobCheckpoint): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO checkpoint
         (job_id, round, snapshot_id, restore_token, agent_state_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      jobId,
      cp.round,
      cp.snapshotId,
      cp.restoreToken,
      cp.agentStateJson,
      Date.now(),
    );
  }

  /** Read the latest persisted checkpoint for a job, or null if none. Consumed
   *  by per-job reclaim here and by the Phase 1 resume path. */
  private readCheckpoint(jobId: string): JobCheckpoint | null {
    const row = this.ctx.storage.sql
      .exec(
        'SELECT round, snapshot_id, restore_token, agent_state_json FROM checkpoint WHERE job_id = ?',
        jobId,
      )
      .toArray()[0] as
      | { round?: number; snapshot_id?: string; restore_token?: string; agent_state_json?: string }
      | undefined;
    if (!row || typeof row.snapshot_id !== 'string') return null;
    return {
      round: row.round ?? 0,
      snapshotId: row.snapshot_id,
      restoreToken: row.restore_token ?? '',
      agentStateJson: row.agent_state_json ?? '',
    };
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

/**
 * Statuses at which the SSE stream should close: the terminals plus `suspended`.
 * A suspended job emits no further events until a `/resume` relaunches it (which
 * a new SSE connection then follows), so holding the pipe open would just leak a
 * heartbeat loop against a run that isn't producing anything.
 */
function isStreamHaltStatus(status: CoderJobStatus): boolean {
  return isTerminalStatus(status) || status === 'suspended';
}

/** Event types that close the SSE stream when observed live — terminals + suspend. */
function isStreamHaltEventType(type: string): boolean {
  return isTerminalEventType(type) || type === 'job.suspended';
}

/**
 * Validate a `/resume` caller's `resumeData` against a stored suspend schema.
 * The schema is deliberately small (string fields only), so this checks that
 * every `required` field is present as a non-empty string. Structured issues are
 * returned to the caller so a bad payload is a clear 400, not a silent stall.
 */
function validateResumeData(
  data: unknown,
  schema: CoderSuspendPayload['resumeSchema'],
): { ok: true } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, issues: ['resumeData must be a JSON object'] };
  }
  const obj = data as Record<string, unknown>;
  for (const field of schema.required) {
    const value = obj[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push(`field "${field}" is required and must be a non-empty string`);
    }
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Extract the free-text answer to inject into the resumed run's message history.
 * The default schema names it `answer`; a richer future schema without one falls
 * back to a compact JSON rendering so the guidance is never dropped on the floor.
 */
function extractResumeAnswer(data: unknown): string {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const answer = (data as Record<string, unknown>).answer;
    if (typeof answer === 'string') return answer;
    return JSON.stringify(data);
  }
  return String(data);
}
