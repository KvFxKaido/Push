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
 * Scaffolding scope: this lands the ledger + the adoption *decision*. The
 * server-side loop that actually continues an adopted run (running the same
 * `lib/` kernels host-agnostically) is the next PR — when `decideAdoption`
 * returns `adopt`, the DO transitions the run to `adoptable` and logs; it does
 * NOT yet run the loop.
 */

import type { ApprovalMode } from './approval-gates.ts';

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
 *                   run from its last checkpoint. (The server-side loop that
 *                   consumes this state is the next PR; this scaffolding
 *                   parks here and logs.)
 *   - `adopted`   — the host is running the loop server-side. Reserved for
 *                   the loop PR; no transition sets it yet.
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

/** The states from which the silence alarm can still act. */
export const RUN_LIFECYCLE_ALARM_ACTIVE_STATES: readonly RunLifecycleState[] = ['watched'];

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
 *   1. Not in an alarm-active state → idle (released/ended/adopted/adoptable
 *      are not the alarm's to touch).
 *   2. No checkpoint yet → idle (nothing to adopt from).
 *   3. Not mid-flight → idle (a finished run is not resurrected).
 *   4. Heartbeats lapsed past the threshold → adopt.
 *   5. Otherwise → re-arm at lastHeartbeat + threshold (still watched).
 */
export function decideAdoption(record: RunHostRecord, now: number): AdoptionDecision {
  if (!RUN_LIFECYCLE_ALARM_ACTIVE_STATES.includes(record.state)) {
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
