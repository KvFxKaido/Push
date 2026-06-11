/**
 * RunHost adoption vocabulary + decision kernel — Durable Runs
 * (Adopt-on-Silence) track, Phase 2 substrate.
 *
 * This is the single source of truth for the run-lifecycle state machine the
 * `RunHost` Durable Object drives: the heartbeat ledger, the silence→adoption
 * decision, the durable-storage byte cap, and the scope→instance mapping a
 * reopening client reconstructs to attach (Phase 3). The DO in
 * `app/src/worker/run-host-do.ts` is a thin storage/alarm wrapper around the
 * pure functions here; keeping the decision logic out of the DO makes it
 * unit-testable without storage mocking and keeps the vocabulary pinnable
 * (`cli/tests/run-host-adoption.test.mjs`, same discipline as
 * `run-checkpoint.ts` / `protocol-schema.ts`).
 *
 * Phase 2 loop scope: alongside the silence decision (`decideAdoption`), this
 * module owns the adopted-run watchdog decision (`decideAdoptedAlarm`) — the
 * pure kernel behind orphan relaunch after a DO eviction, the wall-clock
 * backstop, and the relaunch cap. The loop body itself (mapping a stored
 * checkpoint into the coder kernel, deferral notes, supervised pause) lives in
 * `lib/run-adoption-loop.ts`; the DO-side assembly lives in
 * `app/src/worker/run-host-adoption-runner.ts`.
 */

import type { ApprovalMode } from './approval-gates.ts';
import type { RunCheckpointV1 } from './run-checkpoint.ts';

export const RUN_HOST_PROTOCOL_VERSION = 1 as const;

/**
 * A single Durable Object storage value caps at 128 KiB. A checkpoint above
 * this needs chunking or R2 spill — the tiering decision Phase 1 deferred
 * (see `docs/decisions/Durable Runs — Adopt-on-Silence.md` §Phase 1). Until
 * that lands, the host is the enforcing consumer: it rejects an oversize
 * checkpoint *loudly* (structured error + log) rather than letting the
 * `storage.put` fail opaquely, and logs the observed byte size on every
 * accepted write so real adoption traffic answers the "do we need tiering?"
 * question with data instead of estimates.
 */
export const RUN_HOST_CHECKPOINT_MAX_BYTES = 128 * 1024;

/**
 * How long past the last client heartbeat before a watched run is considered
 * abandoned and becomes adoptable. Generous by design: adoption is idempotent
 * and pull-back-local is always available, so the bias is against
 * false-adopting a brief radio gap (Phase 0 caveat: re-measure on bad
 * cellular before tuning this).
 */
export const RUN_HOST_SILENCE_THRESHOLD_MS = 45_000;

/**
 * The heartbeat cadence the host expects while a client is attached. The
 * silence threshold is ~3x this so a single dropped beat never trips
 * adoption. Exported so the client and the host agree from one constant.
 */
export const RUN_HOST_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Watchdog cadence while a run is `adopted`. The loop re-arms the alarm at
 * this interval (each per-round checkpoint), so after a DO eviction the alarm
 * survives in durable storage, fires, finds no live loop in memory, and
 * relaunches from the last persisted checkpoint — the orphan-sweep recovery
 * the CoderJob DO does via its first-fetch sweep, expressed as an alarm
 * because an adopted run has no client traffic to wake the DO.
 */
export const RUN_HOST_ADOPTED_WATCHDOG_MS = 60_000;

/**
 * Max times an adopted run is relaunched after a DO eviction or a loop
 * failure. Persisted on the record (`adoptionRelaunches`) so the cap survives
 * evictions — the same anti-restart-loop discipline as the CoderJob DO's
 * MAX_DO_RESTART_RESUMES.
 */
export const RUN_HOST_MAX_ADOPTION_RELAUNCHES = 2;

/**
 * Wall-clock budget for a single adoption (from `adoptedAt`). The kernel's
 * own round cap bounds rounds; this bounds time, so a stalled provider or
 * sandbox can't keep an adopted run alive forever. CoderJob parity (60 min).
 */
export const RUN_HOST_ADOPTED_WALL_CLOCK_MS = 60 * 60 * 1000;

/**
 * How often an attached viewer polls `/run/attach` for cursor-follow while
 * the run is detached (adoptable/adopted). Read-only — polls never count as
 * heartbeats, so a viewer can watch an adopted run without resurrecting it.
 * Exported so the client and any future host hint agree from one constant.
 */
export const RUN_HOST_ATTACH_POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * A run's lifecycle as the host sees it:
 *
 *   - `watched`   — a client is attached and heartbeating; the loop runs
 *                   in-page (today's behavior, byte-for-byte). The alarm
 *                   watches for heartbeat lapse.
 *   - `adoptable` — heartbeats lapsed mid-flight; the host SHOULD adopt the
 *                   run from its last checkpoint. The DO attempts adoption
 *                   immediately on this transition; a run parks here only
 *                   when provisioning is blocked (no credentials, no
 *                   checkpoint, unsupported provider) or the relaunch cap is
 *                   exhausted. One-way: a late heartbeat or checkpoint does
 *                   NOT resurrect an `adoptable` run to `watched` (that
 *                   would race the loop about to start). A still-alive
 *                   client takes it back only via an explicit re-register
 *                   (pull-back-local).
 *   - `adopted`   — the host is running the loop server-side (or has paused
 *                   it at a supervised approval gate — `pausedForApproval`
 *                   set). A client re-register reclaims the run: register
 *                   always wins, the server loop aborts at its next
 *                   ownership check, and the record returns to `watched`.
 *   - `released`  — a client pulled the run back local, or explicitly tore it
 *                   down. Terminal for the alarm.
 *   - `ended`     — the run reached a terminal state (completed or aborted).
 *                   Terminal for the alarm.
 */
export type RunLifecycleState = 'watched' | 'adoptable' | 'adopted' | 'released' | 'ended';

export const RUN_LIFECYCLE_STATES: readonly RunLifecycleState[] = [
  'watched',
  'adoptable',
  'adopted',
  'released',
  'ended',
];

/**
 * The states in which an alarm may legitimately be scheduled, and what a
 * wake means there:
 *   - `watched`   — the silence detector (`decideAdoption`).
 *   - `adoptable` — a scheduled adoption retry after a loop failure (a run
 *                   parked adoptable for a *blocked* reason has its alarm
 *                   cleared, so a wake here always means "retry").
 *   - `adopted`   — the loop watchdog (`decideAdoptedAlarm`): liveness
 *                   re-arm, orphan relaunch after eviction, wall-clock cap.
 */
export const RUN_LIFECYCLE_ALARM_ACTIVE_STATES: readonly RunLifecycleState[] = [
  'watched',
  'adoptable',
  'adopted',
];

// ---------------------------------------------------------------------------
// Scope → instance
// ---------------------------------------------------------------------------

/**
 * The durable scope a run is filed under — `repoFullName + branch` is the
 * cross-surface scope key (CLI-first durable-identifier discipline) and
 * `chatId` pins the one active run per chat. A reopening client reconstructs
 * the same triple from its chat context, so `runHostInstanceId` yields the
 * same DO instance on attach (Phase 3) without the client needing to have
 * stashed a server-minted id.
 */
export interface RunHostScope {
  repoFullName: string;
  branch: string;
  chatId: string;
}

/**
 * Canonical DO-instance name for a run's scope. Each part is percent-encoded
 * so a branch or chat id containing the delimiter can't collide two distinct
 * scopes onto one instance. Both the Worker route layer and the reopening
 * client call this — one function, no drift.
 */
export function runHostInstanceId(scope: RunHostScope): string {
  const enc = encodeURIComponent;
  return `runhost:v${RUN_HOST_PROTOCOL_VERSION}:${enc(scope.repoFullName)}:${enc(scope.branch)}:${enc(scope.chatId)}`;
}

export function isCompleteScope(value: unknown): value is RunHostScope {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.repoFullName === 'string' &&
    s.repoFullName.length > 0 &&
    typeof s.branch === 'string' &&
    s.branch.length > 0 &&
    typeof s.chatId === 'string' &&
    s.chatId.length > 0
  );
}

// ---------------------------------------------------------------------------
// The ledger record (durable in the DO)
// ---------------------------------------------------------------------------

/**
 * The host's per-run ledger entry. Holds identity, the heartbeat clock, the
 * adoption-relevant flags, and the lifecycle state — but NEVER the transcript
 * (that's the separately-keyed checkpoint, subject to the byte cap) and NEVER
 * credentials (provisioned out-of-band at adoption time, the CoderJob
 * precedent — see the checkpoint's credential-field blocklist).
 */
export interface RunHostRecord {
  v: typeof RUN_HOST_PROTOCOL_VERSION;
  runId: string;
  scope: RunHostScope;
  /** The chat's locked approval mode — decides adopted-run semantics
   * (full-auto continues; supervised pauses at gates). */
  mode: ApprovalMode;
  state: RunLifecycleState;
  registeredAt: number;
  lastHeartbeatAt: number;
  /** True once at least one checkpoint has been persisted — there's nothing
   * to adopt from before the first one. */
  hasCheckpoint: boolean;
  /** Whether the run is still mid-flight (a completed/aborted run is not
   * adopted even if heartbeats lapse). Set from the checkpoint's terminal
   * signal on each write. */
  midFlight: boolean;
  /** Latest checkpoint round, for status/observability. */
  round: number;

  // --- Adoption-loop fields (all optional: pre-loop records lack them) ---

  /** Deployment origin, stamped server-derived by the route layer on
   * register/checkpoint and persisted here so adoption-time provisioning can
   * build internal Requests (stream/executor adapters) without trusting any
   * client value. */
  origin?: string;
  /** Epoch-ms the current adoption began (state flipped to `adopted`). */
  adoptedAt?: number;
  /** Identity of the in-flight adoption. The loop checks it on every
   * per-round checkpoint; a client re-register clears it, which is how the
   * server loop learns it was reclaimed and stops without writing. */
  adoptionId?: string;
  /** Times this run has been (re)launched server-side. Persisted so the cap
   * (`RUN_HOST_MAX_ADOPTION_RELAUNCHES`) survives DO evictions. */
  adoptionRelaunches?: number;
  /** Set when a supervised adopted run paused at an approval gate. The
   * watchdog never relaunches a paused run; a returning client reclaims it —
   * or resolves the gate via `/run/approval` (Phase 3), which relaunches the
   * loop with `resolvedApproval` set. */
  pausedForApproval?: {
    approvalId: string;
    kind: string;
    /** The gated tool, carried explicitly so an approval grant can be
     * matched on relaunch without parsing it back out of the approvalId. */
    tool?: string;
    title?: string;
    summary?: string;
  } | null;
  /** A user decision on the pending gate (Phase 3 attach controls). Set by
   * the approval endpoint when it relaunches a paused run; consumed by that
   * launch (cleared when the record flips `adopted`) so the grant is
   * one-shot — a crash-relaunch re-pauses rather than re-using it. */
  resolvedApproval?: RunHostResolvedApproval | null;
  /** Last loop failure, for status/observability. */
  lastError?: string;
}

/** A user's decision on a paused supervised gate, delivered through the
 * Phase 3 attach surface. */
export interface RunHostResolvedApproval {
  approvalId: string;
  /** The gated tool the decision applies to (from `pausedForApproval`). */
  tool: string;
  kind: string;
  decision: 'approve' | 'deny';
  decidedAt: number;
}

export const RUN_HOST_RECORD_FIELDS = [
  'v',
  'runId',
  'scope',
  'mode',
  'state',
  'registeredAt',
  'lastHeartbeatAt',
  'hasCheckpoint',
  'midFlight',
  'round',
] as const;

/** The optional adoption-loop additions to the record vocabulary, pinned
 * separately so the base Phase 2 substrate fields stay byte-stable. */
export const RUN_HOST_RECORD_ADOPTION_FIELDS = [
  'origin',
  'adoptedAt',
  'adoptionId',
  'adoptionRelaunches',
  'pausedForApproval',
  'resolvedApproval',
  'lastError',
] as const;

// ---------------------------------------------------------------------------
// The adoption decision (pure)
// ---------------------------------------------------------------------------

export type AdoptionAction = 'adopt' | 'rearm' | 'idle';

export interface AdoptionDecision {
  action: AdoptionAction;
  /** When `action === 'rearm'`, the epoch-ms the alarm should next fire. */
  reArmAt?: number;
  /** A stable token naming the branch taken, for the symmetric structured
   * log the DO emits on every alarm wake. */
  reason: string;
}

/**
 * Decide what the silence alarm should do for a run at time `now`. Pure: the
 * DO supplies the record and the clock, applies the result. Every branch
 * returns a `reason` so the DO's alarm log distinguishes "adopted",
 * "re-armed, still watched", and the several idle cases from each other —
 * none of them is silent.
 *
 * Decision order (most-terminal first):
 *   1. Not `watched` → idle (the silence detector only ever adopts a watched
 *      run; adoptable/adopted alarm wakes are dispatched to the retry /
 *      watchdog paths by the DO, not here).
 *   2. No checkpoint yet → idle (nothing to adopt from).
 *   3. Not mid-flight → idle (a finished run is not resurrected).
 *   4. Heartbeats lapsed past the threshold → adopt.
 *   5. Otherwise → re-arm at lastHeartbeat + threshold (still watched).
 */
export function decideAdoption(record: RunHostRecord, now: number): AdoptionDecision {
  if (record.state !== 'watched') {
    return { action: 'idle', reason: `state_${record.state}` };
  }
  if (!record.hasCheckpoint) {
    return { action: 'idle', reason: 'no_checkpoint' };
  }
  if (!record.midFlight) {
    return { action: 'idle', reason: 'not_mid_flight' };
  }
  const silentForMs = now - record.lastHeartbeatAt;
  if (silentForMs >= RUN_HOST_SILENCE_THRESHOLD_MS) {
    return { action: 'adopt', reason: 'heartbeat_lapsed' };
  }
  return {
    action: 'rearm',
    reArmAt: record.lastHeartbeatAt + RUN_HOST_SILENCE_THRESHOLD_MS,
    reason: 'still_watched',
  };
}

/** Whether a serialized checkpoint exceeds the DO-storage value cap. The DO
 * rejects on `true` rather than attempting the put. */
export function checkpointExceedsHostCap(bytes: number): boolean {
  return bytes > RUN_HOST_CHECKPOINT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// The attach snapshot (Phase 3)
// ---------------------------------------------------------------------------

/**
 * What `/run/attach` returns to a reopening client: the run's lifecycle
 * summary plus — when it's fresher than the caller's cursor — the stored
 * checkpoint itself. The checkpoint IS the snapshot (the RunHost analogue of
 * pushd's `get_session_snapshot` packet); `checkpointSavedAt` is the cursor a
 * viewer echoes back as `sinceSavedAt` to cursor-follow the host's per-round
 * persistence without re-downloading an unchanged transcript.
 *
 * Read-only by design: serving an attach never bumps the heartbeat clock or
 * mutates the record, so a viewer can watch an adopted run without
 * resurrecting it (control flows through register / approval / stop /
 * release, all explicit).
 */
export interface RunHostAttachSnapshot {
  v: typeof RUN_HOST_PROTOCOL_VERSION;
  runId: string;
  state: RunLifecycleState;
  mode: ApprovalMode;
  round: number;
  midFlight: boolean;
  lastHeartbeatAt: number;
  /** `savedAt` of the host's stored checkpoint — the attach cursor. Null
   * when no checkpoint has been persisted yet. */
  checkpointSavedAt: number | null;
  /** Present when the stored checkpoint is fresher than `sinceSavedAt`. */
  checkpoint?: RunCheckpointV1;
  adoptedAt?: number;
  pausedForApproval?: RunHostRecord['pausedForApproval'];
  lastError?: string;
}

export const RUN_HOST_ATTACH_SNAPSHOT_FIELDS = [
  'v',
  'runId',
  'state',
  'mode',
  'round',
  'midFlight',
  'lastHeartbeatAt',
  'checkpointSavedAt',
] as const;

export const RUN_HOST_ATTACH_SNAPSHOT_OPTIONAL_FIELDS = [
  'checkpoint',
  'adoptedAt',
  'pausedForApproval',
  'lastError',
] as const;

/**
 * Assemble the attach snapshot for a record + stored checkpoint at cursor
 * `sinceSavedAt` (null = first attach, always include the checkpoint when
 * one exists). Pure — the DO supplies storage reads and serves the result.
 */
export function buildAttachSnapshot(
  record: RunHostRecord,
  checkpoint: RunCheckpointV1 | null,
  sinceSavedAt: number | null,
): RunHostAttachSnapshot {
  const savedAt = checkpoint?.savedAt ?? null;
  const fresh =
    checkpoint !== null && savedAt !== null && (sinceSavedAt === null || savedAt > sinceSavedAt);
  return {
    v: RUN_HOST_PROTOCOL_VERSION,
    runId: record.runId,
    state: record.state,
    mode: record.mode,
    round: record.round,
    midFlight: record.midFlight,
    lastHeartbeatAt: record.lastHeartbeatAt,
    checkpointSavedAt: savedAt,
    ...(fresh ? { checkpoint: checkpoint } : {}),
    ...(record.adoptedAt !== undefined ? { adoptedAt: record.adoptedAt } : {}),
    ...(record.pausedForApproval ? { pausedForApproval: record.pausedForApproval } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

// ---------------------------------------------------------------------------
// The adopted-run watchdog decision (pure)
// ---------------------------------------------------------------------------

export type AdoptedAlarmAction = 'idle' | 'rearm' | 'relaunch' | 'expire';

export interface AdoptedAlarmDecision {
  action: AdoptedAlarmAction;
  /** When `action === 'rearm'`, the epoch-ms the watchdog should next fire. */
  reArmAt?: number;
  /** Stable token naming the branch taken, for the DO's symmetric alarm log. */
  reason: string;
}

/**
 * Decide what a watchdog wake should do for an `adopted` run. Pure: the DO
 * supplies the record, the clock, and whether the loop is alive in this
 * isolate's memory (a cold-started DO has no live loop — that's exactly the
 * orphan case the watchdog exists to recover).
 *
 * Decision order (most-terminal first):
 *   1. Not `adopted` → idle (not the watchdog's run).
 *   2. Paused at a supervised approval gate → idle (nothing to relaunch; the
 *      run waits for a returning client to reclaim it).
 *   3. Wall-clock budget exhausted → expire (the DO aborts the loop, ends
 *      the run, and logs — the CoderJob alarm-backstop pattern).
 *   4. Loop alive in memory → re-arm (pure liveness keepalive).
 *   5. Loop dead, relaunch cap exhausted → expire.
 *   6. Loop dead, cap remaining → relaunch from the last checkpoint.
 */
export function decideAdoptedAlarm(
  record: RunHostRecord,
  ctx: { now: number; loopAlive: boolean },
): AdoptedAlarmDecision {
  if (record.state !== 'adopted') {
    return { action: 'idle', reason: `state_${record.state}` };
  }
  if (record.pausedForApproval) {
    return { action: 'idle', reason: 'paused_for_approval' };
  }
  const adoptedAt = record.adoptedAt ?? record.lastHeartbeatAt;
  if (ctx.now - adoptedAt >= RUN_HOST_ADOPTED_WALL_CLOCK_MS) {
    return { action: 'expire', reason: 'wall_clock_exhausted' };
  }
  if (ctx.loopAlive) {
    return {
      action: 'rearm',
      reArmAt: ctx.now + RUN_HOST_ADOPTED_WATCHDOG_MS,
      reason: 'loop_alive',
    };
  }
  if ((record.adoptionRelaunches ?? 0) >= RUN_HOST_MAX_ADOPTION_RELAUNCHES) {
    return { action: 'expire', reason: 'relaunch_cap_exhausted' };
  }
  return { action: 'relaunch', reason: 'loop_orphaned' };
}
