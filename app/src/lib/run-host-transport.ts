/**
 * run-host-transport.ts — Durable Runs Phase 2 client transport.
 *
 * The web shell's side of the RunHost ledger (`/api/runhost/run/*`,
 * `app/src/worker/run-host-routes.ts`). This module is the owning
 * coordinator for the attached-client lifecycle:
 *
 *   - **Lazy registration** — the first published checkpoint registers the
 *     run (`runId` + scope + approval mode all ride on the checkpoint
 *     itself, so there's no separate bookkeeping to drift).
 *   - **Per-turn checkpoint PUT** — every locally captured RunCheckpointV1
 *     is mirrored to the host, making the host's copy the adoption source.
 *   - **Heartbeat keepalive** — a `RUN_HOST_HEARTBEAT_INTERVAL_MS` loop per
 *     active run. Browser timer throttling in hidden tabs is the *feature*,
 *     not a bug: a backgrounded phone stops beating, the host flips the run
 *     `adoptable`, and adopt-on-silence does its job.
 *   - **Pull-back-local** — a heartbeat answered with `state: 'adoptable'`
 *     means the host lapsed us while we were actually alive (radio gap,
 *     throttled tab that came back). Re-register to reclaim the run.
 *   - **Release** — `finalizeRunSession` releases on every terminal path so
 *     a normally completed run never lingers `watched` and gets adopted.
 *
 * Fire-and-forget discipline (same as `run-checkpoint-capture.ts`): nothing
 * here ever throws into the round loop, and every exit path that changes
 * observable behavior logs symmetrically:
 *
 *   run_host_client_registered ↔ run_host_client_register_failed
 *   run_host_client_checkpoint_sent ↔ run_host_client_checkpoint_failed
 *                                   ↔ run_host_client_checkpoint_oversize
 *   run_host_client_heartbeat_failed ↔ run_host_client_heartbeat_stopped
 *   run_host_client_reclaimed / run_host_client_released
 *   run_host_client_disabled (NOT_CONFIGURED — once per session)
 */

import {
  RUN_HOST_HEARTBEAT_INTERVAL_MS,
  isCompleteScope,
  type RunHostScope,
} from '@push/lib/run-host-adoption';
import type { RunCheckpointV1 } from '@push/lib/run-checkpoint';
import { resolveApiUrl } from './api-url';

const REGISTER_PATH = '/api/runhost/run/register';
const CHECKPOINT_PATH = '/api/runhost/run/checkpoint';
const HEARTBEAT_PATH = '/api/runhost/run/heartbeat';
const RELEASE_PATH = '/api/runhost/run/release';

/** `fetch` keepalive caps in-flight body bytes (~64 KiB); stay under it so a
 * final flush from a hiding tab still ships. Larger bodies go without. The
 * cap is in BYTES, so the check must measure encoded UTF-8 length —
 * `string.length` counts UTF-16 code units and undercounts CJK/emoji-heavy
 * transcripts, which would mark an over-quota body keepalive and get the
 * request rejected outright. */
const KEEPALIVE_BODY_LIMIT_BYTES = 56 * 1024;

interface RunHandle {
  runId: string;
  scope: RunHostScope;
  mode: RunCheckpointV1['approvalMode'];
  registered: boolean;
  /** Latest round seen on a published checkpoint — replayed on re-register
   * so a reclaim doesn't regress the host's view. */
  lastRound: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatIntervalMs: number;
  /** Per-run serialization: register/checkpoint writes chain here so a
   * rapid pair of turn flushes can't race the initial register. */
  queue: Promise<void>;
}

const activeRuns = new Map<string, RunHandle>();

/** Set on a NOT_CONFIGURED (503) register response — the deployment has no
 * RUN_HOST binding, so every future call this session would fail the same
 * way. Logged once, then the transport goes quiet. */
let disabledForSession = false;

function log(level: 'info' | 'warn', event: string, ctx: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...ctx });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

function post(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<Response> {
  const payload = JSON.stringify(body);
  // resolveApiUrl: relative paths don't reach the Worker from the Capacitor
  // native shell (they resolve against the bundled HTML origin).
  return fetch(resolveApiUrl(path), {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive: new TextEncoder().encode(payload).length <= KEEPALIVE_BODY_LIMIT_BYTES,
  });
}

// ---------------------------------------------------------------------------
// Register + heartbeat loop
// ---------------------------------------------------------------------------

async function registerRun(handle: RunHandle): Promise<boolean> {
  let res: Response;
  try {
    res = await post(REGISTER_PATH, {
      runId: handle.runId,
      scope: handle.scope,
      mode: handle.mode,
      round: handle.lastRound,
    });
  } catch (err: unknown) {
    log('warn', 'run_host_client_register_failed', {
      runId: handle.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (res.status === 503) {
    disabledForSession = true;
    stopHeartbeat(handle);
    log('warn', 'run_host_client_disabled', { runId: handle.runId, status: 503 });
    return false;
  }
  if (!res.ok) {
    log('warn', 'run_host_client_register_failed', { runId: handle.runId, status: res.status });
    return false;
  }
  const body = (await res.json().catch(() => ({}))) as { heartbeatIntervalMs?: number };
  // The run may have been released while this register was in flight — a
  // success landing now must not start a heartbeat loop on a dead handle,
  // and the record the host just opened must be torn back down (it has no
  // checkpoint, so it could never be adopted, but don't leave the litter).
  // This release can itself race a *newer* run's register on the same
  // scope; that's safe because the host keys release by runId, not scope —
  // a stale runId against a superseded record is a 409 no-op (see
  // run-host-do.ts runRelease).
  if (!activeRuns.has(handle.runId)) {
    void post(RELEASE_PATH, { runId: handle.runId, scope: handle.scope }).catch(() => {});
    log('info', 'run_host_client_released', { runId: handle.runId, racedRegister: true });
    return false;
  }
  if (typeof body.heartbeatIntervalMs === 'number' && body.heartbeatIntervalMs > 0) {
    handle.heartbeatIntervalMs = body.heartbeatIntervalMs;
  }
  handle.registered = true;
  startHeartbeat(handle);
  log('info', 'run_host_client_registered', {
    runId: handle.runId,
    scope: handle.scope,
    round: handle.lastRound,
  });
  return true;
}

function startHeartbeat(handle: RunHandle): void {
  if (handle.heartbeatTimer) clearInterval(handle.heartbeatTimer);
  handle.heartbeatTimer = setInterval(() => {
    void beat(handle);
  }, handle.heartbeatIntervalMs);
}

function stopHeartbeat(handle: RunHandle): void {
  if (handle.heartbeatTimer) {
    clearInterval(handle.heartbeatTimer);
    handle.heartbeatTimer = null;
  }
}

async function beat(handle: RunHandle): Promise<void> {
  let res: Response;
  try {
    res = await post(HEARTBEAT_PATH, { runId: handle.runId, scope: handle.scope });
  } catch (err: unknown) {
    // Transient (offline, radio gap) — keep beating; the host's silence
    // threshold is what decides, not one failed POST.
    log('warn', 'run_host_client_heartbeat_failed', {
      runId: handle.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (res.status === 409) {
    // The host no longer tracks this run (released elsewhere or superseded
    // by a newer run on the same scope). Beating on would resurrect nothing
    // — stop the loop; the next published checkpoint re-registers if the
    // run really is still live here.
    stopHeartbeat(handle);
    handle.registered = false;
    log('warn', 'run_host_client_heartbeat_stopped', { runId: handle.runId, status: 409 });
    return;
  }
  if (!res.ok) {
    log('warn', 'run_host_client_heartbeat_failed', { runId: handle.runId, status: res.status });
    return;
  }
  const body = (await res.json().catch(() => ({}))) as { state?: string };
  if (body.state === 'adoptable') {
    // We lapsed (throttled tab, radio gap) but we're demonstrably alive and
    // still running the loop in-page — reclaim the run before the
    // server-side loop picks it up.
    handle.registered = false;
    const reclaimed = await registerRun(handle);
    if (reclaimed) {
      log('info', 'run_host_client_reclaimed', { runId: handle.runId });
    }
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Mirror a locally captured checkpoint to the RunHost ledger. Registers the
 * run on first publish (everything register needs rides on the checkpoint).
 * Fire-and-forget: never throws, never blocks the round loop.
 */
export function publishRunCheckpointToHost(checkpoint: RunCheckpointV1): void {
  if (disabledForSession) return;
  const runId = checkpoint.runId;
  if (!runId) {
    // Captures outside an active run (e.g. expiry saves) carry no runId —
    // there is no live run for the host to watch, so mirroring one would
    // manufacture an adoptable ghost.
    log('info', 'run_host_client_publish_skipped', {
      chatId: checkpoint.chatId,
      reason: checkpoint.reason,
      missing: 'runId',
    });
    return;
  }
  const scope: RunHostScope = {
    repoFullName: checkpoint.repoFullName,
    branch: checkpoint.branch,
    chatId: checkpoint.chatId,
  };
  if (!isCompleteScope(scope)) {
    log('info', 'run_host_client_publish_skipped', {
      chatId: checkpoint.chatId,
      reason: checkpoint.reason,
      missing: 'scope',
    });
    return;
  }

  let handle = activeRuns.get(runId);
  if (!handle) {
    handle = {
      runId,
      scope,
      mode: checkpoint.approvalMode,
      registered: false,
      lastRound: checkpoint.round,
      heartbeatTimer: null,
      heartbeatIntervalMs: RUN_HOST_HEARTBEAT_INTERVAL_MS,
      queue: Promise.resolve(),
    };
    activeRuns.set(runId, handle);
  }
  handle.lastRound = checkpoint.round;
  handle.mode = checkpoint.approvalMode;

  const h = handle;
  h.queue = h.queue.then(async () => {
    if (disabledForSession || !activeRuns.has(runId)) return;
    if (!h.registered) {
      const ok = await registerRun(h);
      if (!ok) return; // next publish retries the register
    }
    await putCheckpoint(h, checkpoint);
  });
}

async function putCheckpoint(handle: RunHandle, checkpoint: RunCheckpointV1): Promise<void> {
  let res: Response;
  try {
    res = await post(CHECKPOINT_PATH, { checkpoint }, 'PUT');
  } catch (err: unknown) {
    log('warn', 'run_host_client_checkpoint_failed', {
      runId: handle.runId,
      round: checkpoint.round,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (res.status === 413) {
    // The host rejected the transcript for size but recorded our liveness;
    // the run stays watched on stale data until tiering lands. Loud here so
    // size regressions show up in client logs too.
    const body = (await res.json().catch(() => ({}))) as { bytes?: number };
    log('warn', 'run_host_client_checkpoint_oversize', {
      runId: handle.runId,
      round: checkpoint.round,
      bytes: body.bytes,
    });
    return;
  }
  if (res.status === 409) {
    // NOT_REGISTERED (host lost the record) or RUN_MISMATCH (superseded).
    // Drop registration so the next publish re-registers and retries.
    handle.registered = false;
    log('warn', 'run_host_client_checkpoint_failed', {
      runId: handle.runId,
      round: checkpoint.round,
      status: 409,
    });
    return;
  }
  if (!res.ok) {
    log('warn', 'run_host_client_checkpoint_failed', {
      runId: handle.runId,
      round: checkpoint.round,
      status: res.status,
    });
    return;
  }
  log('info', 'run_host_client_checkpoint_sent', {
    runId: handle.runId,
    round: checkpoint.round,
  });
}

/**
 * Release the run on the host and tear down the local handle. Called from
 * `finalizeRunSession` on every terminal path (completed, aborted, threw).
 * Idempotent; a run that never published is a silent no-op (there is
 * nothing on the host to release).
 */
export function releaseRunFromHost(runId: string | null | undefined): void {
  if (!runId) return;
  const handle = activeRuns.get(runId);
  if (!handle) return;
  activeRuns.delete(runId);
  stopHeartbeat(handle);
  if (disabledForSession || !handle.registered) return;
  void post(RELEASE_PATH, { runId: handle.runId, scope: handle.scope })
    .then((res) => {
      if (res.ok) {
        log('info', 'run_host_client_released', { runId: handle.runId });
      } else {
        log('warn', 'run_host_client_release_failed', {
          runId: handle.runId,
          status: res.status,
        });
      }
    })
    .catch((err: unknown) => {
      log('warn', 'run_host_client_release_failed', {
        runId: handle.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Test-only: clear module state (handles, timers, the session-disable
 * latch) between cases. */
export function __resetRunHostTransportForTests(): void {
  for (const handle of activeRuns.values()) stopHeartbeat(handle);
  activeRuns.clear();
  disabledForSession = false;
}

// Dev-only (Vite HMR): a module swap replaces `activeRuns` but the old
// incarnation's interval timers would keep beating against dead handles.
// Clear them on dispose; the next published checkpoint re-registers through
// the new module. Production builds strip this block.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const handle of activeRuns.values()) stopHeartbeat(handle);
  });
}
