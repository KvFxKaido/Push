/**
 * DaemonSessionController — the TUI's daemon-session state and lifecycle
 * (TUI Decomposition Phase 1; plan in `docs/archive/decisions/TUI
 * Decomposition - Testability Seam and Daemon Session Controller.md`).
 *
 * Owns what used to be ambient `runTUI` closure state — `daemonClient` /
 * `daemonSessionId` / `daemonAttachToken` plus the connection-scoped
 * coordination that must move with them (reconnect backoff, autostart guard,
 * hello build stamp, the per-connection event-seq cursor, the unknown-event
 * warn registry) — privately, and exposes:
 *
 *   - lifecycle: `ensureConnected()`, `tryConnect()`, `ensureSession()`,
 *     `attachExistingSession()`, `ensureReady()`, `scheduleReconnect()`,
 *     `cancelPendingReconnectTimer()`, `teardown()`, `resetForRespawn()`
 *   - transport: `sendVerb(type, payload)` (the bearer-attaching helper),
 *     `client` / `connected` / `sessionId` / `attachToken` accessors,
 *     `adoptAttachToken()`, `noteSeenSeq()`
 *   - session verbs: `revert(turns)`, `unrevert()`, `summarize(preserveTurns)`,
 *     `listChildren()`, `getChild(subagentId)` — typed data boundaries; the
 *     TUI keeps the transcript-rendering side
 *
 * What deliberately does NOT move here (still `runTUI`-owned): the daemon
 * spawn machinery and the stale-runtime self-heal (`refreshDaemon` /
 * `respawnFreshDaemon` and their flags) — those decide *whether* to connect
 * and are injected via hooks; `daemonActiveRunId` (run-loop state, cleared by
 * `setRunState`); the own-user-message echo correlation (send-path state);
 * and every hydration/approval/snapshot reaction, which mutates TUI render
 * state. Hooks are the seam: the controller never touches `tuiState`, the
 * scheduler, or `process.*` directly, so the Phase 0 headless harness drives
 * it through the same `deps.tryConnect` stub as before.
 *
 * Not a `lib/` promotion on purpose: the hook surface is TUI-shaped and the
 * shared contract is the daemon *verbs*, which live daemon-side
 * (`cli/pushd.ts`). See the decision doc's "What this is not".
 */

import { TUI_DAEMON_CAPABILITIES } from '../lib/daemon-capabilities.js';
import { evaluateHelloResponse } from './tui-daemon-handshake.js';
import { classifyDaemonSpawnError } from './tui-daemon-errors.js';
import {
  createReconnectState,
  planNextRetry,
  recordAttemptResult,
  secondsUntilNextRetry,
  type ReconnectState,
} from './tui-daemon-reconnect.js';

// ─── Wire shapes ─────────────────────────────────────────────────

/**
 * Structural view of `cli/daemon-client.ts`'s client — kept structural (not a
 * class import) so the Phase 0 harness's stub client satisfies it unchanged.
 */
export interface DaemonClientLike {
  connected: boolean;
  request(
    type: string,
    payload?: unknown,
    sessionId?: string | null,
    timeoutMs?: number,
  ): Promise<DaemonResponseEnvelope>;
  onEvent(cb: (event: DaemonEventEnvelope) => void): () => void;
  close(): void;
  _socket: { on(event: 'close', cb: () => void): void };
}

/** Response envelope as `daemon-client` resolves it (non-ok envelopes REJECT). */
export interface DaemonResponseEnvelope<TPayload = Record<string, unknown>> {
  ok?: boolean;
  payload?: TPayload;
  error?: { code?: string; message?: string };
}

/** Event envelope as the daemon broadcasts it. */
export interface DaemonEventEnvelope {
  kind?: string;
  type?: string;
  sessionId?: string;
  runId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
}

/** `startDaemonForTui` result shape (spawn stays TUI-side, injected). */
export interface DaemonSpawnResult {
  status: 'started' | 'already-running';
  ready: boolean;
  pid?: number | undefined;
  socketPath: string;
  logPath: string;
}

// Typed payloads for the session verbs (Remote Control Surface Audit
// finding #7 — the controller's verb methods are the typed boundary).
export interface SessionRevertPayload {
  revertedTurns?: number;
  remainingMessages?: number;
}
export interface SessionSummarizePayload {
  summarizedMessages?: number;
  preservedTurns?: number;
}
export interface ChildSessionDescriptor {
  subagentId?: string;
  agent?: string;
  status?: string;
  task?: string;
  [key: string]: unknown;
}
export interface ListChildrenPayload {
  children?: ChildSessionDescriptor[];
}
export interface GetChildSessionPayload {
  child?: ChildSessionDescriptor;
  [key: string]: unknown;
}

// ─── Hook seam ───────────────────────────────────────────────────

/**
 * Everything the controller needs from the TUI shell. All UI mutation flows
 * through these — the controller holds no reference to `tuiState`, the
 * scheduler, or IO streams.
 */
export interface DaemonSessionHooks {
  /** Transport factory — `deps.tryConnect` from the Phase 0 seam, so the
   * headless harness's stub client keeps working unchanged. */
  tryConnectTransport(
    socketPath: string,
    timeoutMs: number,
  ): Promise<DaemonClientLike | null | undefined>;
  /** Append a transcript entry + schedule a redraw. */
  note(kind: 'status' | 'warning' | 'error', text: string): void;
  /** Mark the footer dirty + schedule. */
  markFooterDirty(): void;
  /** Mark everything dirty + schedule. */
  markAllDirty(): void;
  /** Bridge a daemon event envelope into the TUI's engine-event handler. */
  onEngineEvent(event: DaemonEventEnvelope): void;
  /**
   * Socket-close reaction, invoked after the controller has cleared its
   * client/session/token state. The TUI side owns the respawn-vs-reconnect
   * decision (the stale-runtime self-heal arms a respawn flag) and the
   * disconnect UI (workspace chip reset, log tail) — on the plain-disconnect
   * path it calls back into `scheduleReconnect({ announce: true })`.
   */
  onSocketClose(): void;
  /** TUI daemon autostart preference (config-derived). */
  isAutoStartEnabled(): boolean;
  /** Spawn pushd (the TUI-side `startDaemonForTui`). */
  spawnDaemon(): Promise<DaemonSpawnResult>;
  /** Reuse-path staleness assessment (self-heal or mtime warn) — runs after
   * connecting to a daemon this TUI did not just spawn. */
  onReusedDaemon(): Promise<void>;
  /** Best-effort daemon log tail into the transcript. */
  appendDaemonLogTail(heading?: string): Promise<void>;
  /** The durable session handle (`state.sessionId` / `state.attachToken`) —
   * the reconnect/attach path re-reads these; the transient controller copies
   * are cleared on every disconnect. */
  getDurableSession(): {
    persisted: boolean;
    sessionId: string | null;
    attachToken: string | null;
  };
  /** Persist an adopted attach token onto the durable session state. */
  setDurableAttachToken(token: string): void;
  /** Fields `start_session` needs from the live session. */
  getStartSessionPayload(): { provider: string; model: string; cwd: string };
  /** Attach-response reaction: hydrate provider/model from daemon truth and
   * kick the (fire-and-forget) session-snapshot refresh. */
  onAttached(payload: unknown): void;
  /** Wake the frame ticker so the reconnect chip animates. */
  invalidateReconnectAnimators(): void;
}

/** Footer-chip view of the reconnect coordinator. */
export interface DaemonReconnectSnapshot {
  phase: ReconnectState['phase'];
  attempts: number;
  secondsUntilNextRetry: number;
}

// ─── Controller ──────────────────────────────────────────────────

export class DaemonSessionController {
  #hooks: DaemonSessionHooks;
  #client: DaemonClientLike | null = null;
  #sessionId: string | null = null;
  #attachToken: string | null = null;
  #autoStartAttempted = false;
  #everConnected = false;
  #reconnectState: ReconnectState = createReconnectState();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSeenSeq = 0;
  #buildStamp: string | null = null;
  /**
   * Unknown event types already warned about on the current connection.
   * Exposed (and mutated) by the TUI's event handler; cleared on each
   * (re)connect so a daemon upgrade re-surfaces drift.
   */
  readonly unknownEventWarnedTypes = new Set<string>();

  constructor(hooks: DaemonSessionHooks) {
    this.#hooks = hooks;
  }

  // ── Accessors ──
  get client(): DaemonClientLike | null {
    return this.#client;
  }
  get connected(): boolean {
    return Boolean(this.#client?.connected);
  }
  get sessionId(): string | null {
    return this.#sessionId;
  }
  get attachToken(): string | null {
    return this.#attachToken;
  }
  get buildStamp(): string | null {
    return this.#buildStamp;
  }
  /** True once the once-only autostart spawn path has been consumed
   * (read by `/daemon status` to explain why the TUI is inline). */
  get autoStartAttempted(): boolean {
    return this.#autoStartAttempted;
  }
  get reconnecting(): boolean {
    return this.#reconnectState.phase === 'reconnecting';
  }
  /** Live reconnect-chip data for the footer / frame ticker. */
  reconnectSnapshot(nowMs: number): DaemonReconnectSnapshot {
    return {
      phase: this.#reconnectState.phase,
      attempts: this.#reconnectState.attempts,
      secondsUntilNextRetry: secondsUntilNextRetry(this.#reconnectState, nowMs),
    };
  }

  /**
   * Advance the per-connection observed-seq cursor (called from the TUI's
   * event handler). Deliberately NOT `state.eventSeq`: that is the local
   * counter, and using it for attach replay re-replayed everything from seq 0
   * (codex review on PR #664).
   */
  noteSeenSeq(seq: number): void {
    if (seq > this.#lastSeenSeq) this.#lastSeenSeq = seq;
  }

  /**
   * Adopt a freshly minted attach token (remote-pairing path: the daemon
   * mints one for a previously tokenless session). The caller persists it to
   * durable session state separately.
   */
  adoptAttachToken(token: string): void {
    this.#attachToken = token;
  }

  /**
   * Re-arm the once-only autostart guard (the user just re-enabled autostart
   * via `/config daemon auto` or the settings modal) so the next
   * `ensureConnected` may spawn instead of treating autostart as spent.
   */
  resetAutoStart(): void {
    this.#autoStartAttempted = false;
  }

  /**
   * Reset for a drain-driven respawn: clear the session binding and re-arm
   * the once-only autostart guard so `ensureConnected` will spawn a fresh
   * process rather than treating autostart as already-spent.
   */
  resetForRespawn(): void {
    this.#autoStartAttempted = false;
    this.#sessionId = null;
    this.#attachToken = null;
  }

  /** Disconnect from the daemon (session continues in background). */
  teardown(): void {
    this.cancelPendingReconnectTimer();
    if (this.#client) {
      this.#client.close();
      this.#client = null;
    }
  }

  // ── Connect ──

  /**
   * One connection attempt against an already-running daemon: transport
   * connect, hello/handshake, event bridge, socket-close wiring. Returns
   * false (after cleanup) on any failure — the caller decides whether to
   * spawn. Body moved verbatim from `runTUI`'s `tryDaemonConnect`.
   */
  async tryConnect(): Promise<boolean> {
    let client: DaemonClientLike | null | undefined = null;
    try {
      const { getSocketPath } = await import('./pushd.js');
      const socketPath = getSocketPath();
      client = await this.#hooks.tryConnectTransport(socketPath, 500);
      if (!client) return false;
    } catch {
      // Connection-level failures (socket not present, EACCES, etc.)
      // are the "daemon not running" path — silently fall back to
      // inline and let the auto-spawn path handle it.
      return false;
    }

    // From here on, treat the hello round-trip as its own failure domain.
    // `daemon-client.request` REJECTS the promise (not resolves with
    // `ok: false`) when the daemon responds with a non-ok envelope —
    // catching the RequestError here lets the user see the actual reason
    // (`UNSUPPORTED_PROTOCOL_VERSION` is the most common one) instead of
    // mysteriously falling back to inline (codex / copilot on PR #665).
    let hello: DaemonResponseEnvelope;
    try {
      hello = await client.request(
        'hello',
        { capabilities: [...TUI_DAEMON_CAPABILITIES] },
        null,
        500,
      );
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const code = e?.code ? `${e.code}: ` : '';
      const message = e?.message || 'unknown error';
      this.#hooks.note(
        'warning',
        `Daemon hello rejected (${code}${message}). Running inline; restart pushd or rebuild the TUI.`,
      );
      try {
        client.close();
      } catch {
        /* socket may already be torn down */
      }
      return false;
    }

    try {
      const handshake = evaluateHelloResponse(hello.payload);
      if (!handshake.accepted) {
        this.#hooks.note('warning', handshake.reason);
        client.close();
        return false;
      }
      // Surface any non-fatal handshake warnings (e.g. missing
      // runtimeVersion on older daemons) once per connect.
      for (const w of handshake.warnings) {
        this.#hooks.note('warning', w);
      }

      // Stash the daemon's startup build stamp so the reuse-path freshness
      // check (TUI-side self-heal) can compare it to the local stamp.
      // Null for older daemons that don't advertise one — self-heal stays off.
      this.#buildStamp = handshake.buildStamp ?? null;

      this.#client = client;
      this.#hooks.markFooterDirty();

      // Reset the per-connection unknown-event registry so a daemon upgrade
      // across a reconnect re-surfaces drift.
      this.unknownEventWarnedTypes.clear();

      // Register event handler — bridge daemon events to the TUI.
      client.onEvent((event) => {
        if (event.kind !== 'event') return;
        this.#hooks.onEngineEvent(event);
      });

      // Daemon disconnects no longer demote the session to inline mode
      // permanently — the TUI-side close hook either respawns (drain-driven
      // refresh) or calls back into `scheduleReconnect`.
      client._socket.on('close', () => {
        if (this.#client === client) {
          this.#client = null;
          // Null the session/attach tokens so any non-reconnect path (e.g.
          // an unrelated `ensureConnected` invocation) doesn't short-circuit
          // on `sessionId` still being set and end up sending on a stale
          // handle. The durable handle lives on `state.sessionId` /
          // `state.attachToken`, so `attachExistingSession` restores both
          // from there on success (copilot review on PR #664).
          this.#sessionId = null;
          this.#attachToken = null;
          this.#hooks.onSocketClose();
        }
      });

      this.#everConnected = true;
      // Any in-flight backoff is stale once we've handed back a live client.
      this.cancelPendingReconnectTimer();
      this.#reconnectState = recordAttemptResult(this.#reconnectState, 'success');
      this.#hooks.markFooterDirty();

      return true;
    } catch {
      try {
        client.close();
      } catch {
        /* best-effort */
      }
      return false;
    }
  }

  /**
   * Ensure a live connection: fast probe first, then (once per session,
   * unless `resetForRespawn` re-armed it) the autostart spawn path. Body
   * moved verbatim from `runTUI`'s `ensureDaemonConnected`.
   */
  async ensureConnected({ announce = true }: { announce?: boolean } = {}): Promise<boolean> {
    if (this.#client?.connected) return true;

    // Fast probe first — if pushd is already running this stays below a
    // second and avoids an unnecessary spawn path.
    if (await this.tryConnect()) {
      if (announce) {
        this.#hooks.note('status', 'Connected to pushd daemon. Sessions persist in background.');
      }
      // Reused a pre-existing daemon (not spawned here). If its code predates
      // the current source, self-heal (drain + respawn) or, failing that, warn.
      await this.#hooks.onReusedDaemon();
      return true;
    }

    if (!this.#hooks.isAutoStartEnabled() || this.#autoStartAttempted) {
      return false;
    }
    this.#autoStartAttempted = true;

    try {
      const started = await this.#hooks.spawnDaemon();
      if (started.ready && (await this.tryConnect())) {
        if (announce) {
          const verb = started.status === 'already-running' ? 'Connected to' : 'Started';
          this.#hooks.note('status', `${verb} pushd daemon. Sessions persist in background.`);
        }
        // Only the reuse path can be stale; a fresh spawn matches current
        // source by construction.
        if (started.status === 'already-running') await this.#hooks.onReusedDaemon();
        return true;
      }
      // Spawn succeeded but the socket never answered. Show the log tail so
      // the user can see what pushd actually wrote on its way up.
      this.#hooks.note(
        'warning',
        `pushd ${started.status === 'started' ? 'spawned' : 'is running'} but is not responsive yet. Falling back to inline mode. Log: ${started.logPath}`,
      );
      await this.#hooks.appendDaemonLogTail();
      return false;
    } catch (err) {
      // Classify the spawn-path exception into a structured headline +
      // actionable hint instead of dumping the raw `err.message`.
      const classified = classifyDaemonSpawnError(err);
      this.#hooks.note('warning', classified.headline);
      if (classified.hint) this.#hooks.note('warning', classified.hint);
      // Even on spawn failure, a previous run's log tail may explain the
      // problem.
      await this.#hooks.appendDaemonLogTail();
      return false;
    }
  }

  // ── Reconnect coordinator ──

  /** Stop the pending retry timer if armed. Does not reset attempt count —
   * `recordAttemptResult` is the only thing that does that. */
  cancelPendingReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /** Arm the next reconnect retry. Idempotent: calling twice in a row
   * cancels the pending timer first so two never fire in parallel. */
  scheduleReconnect({ announce }: { announce?: boolean } = { announce: false }): void {
    // Don't try to reconnect to a daemon we never connected to in the first
    // place — that's the inline-by-design path, not a regression to recover
    // from.
    if (!this.#everConnected) return;
    this.cancelPendingReconnectTimer();
    if (announce && this.#reconnectState.phase === 'idle') {
      this.#hooks.note(
        'warning',
        'Daemon disconnected. Reconnecting in the background; turns sent now run inline.',
      );
    }
    const { next, delayMs } = planNextRetry(this.#reconnectState, Date.now());
    this.#reconnectState = next;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#attemptReconnect();
    }, delayMs);
    this.#hooks.markFooterDirty();
    this.#hooks.invalidateReconnectAnimators();
  }

  /** Single reconnect attempt: connect + re-attach to the existing session.
   * Wrapped defensively so a thrown helper steps the backoff instead of
   * silently killing the retry loop. */
  async #attemptReconnect(): Promise<void> {
    try {
      if (this.#client?.connected) {
        this.#reconnectState = recordAttemptResult(this.#reconnectState, 'success');
        this.#hooks.markFooterDirty();
        return;
      }
      const connected = await this.tryConnect();
      if (connected) {
        // `tryConnect` records the success itself. If the persisted session
        // is addressable, re-attach so events replay. The socket close
        // handler cleared the transient `sessionId`, so the reconnect path
        // must use the durable handle.
        const durable = this.#hooks.getDurableSession();
        if (durable.persisted && durable.sessionId) {
          const previousSessionId = durable.sessionId;
          const attached = await this.attachExistingSession();
          if (!attached) {
            // Connected to a daemon that doesn't know our session (e.g. it
            // was wiped). Surface the mismatch — don't let the user silently
            // end up on a fresh session. The transient sessionId stays null;
            // the next ensureSession call will start_session.
            this.#hooks.note(
              'warning',
              `Reconnected to pushd but session ${previousSessionId} is not available; new messages will start a fresh daemon session.`,
            );
          }
        }
        this.#hooks.note('status', 'Reconnected to pushd daemon.');
        this.#hooks.markAllDirty();
        this.#hooks.invalidateReconnectAnimators();
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort warning — don't let a thrown helper kill the loop.
      this.#hooks.note('warning', `Daemon reconnect attempt failed: ${message}`);
    }
    this.#reconnectState = recordAttemptResult(this.#reconnectState, 'fail');
    this.scheduleReconnect({ announce: false });
  }

  // ── Session binding ──

  /**
   * Attach to the durable persisted session, replaying events after the last
   * seq this connection has rendered. Body moved verbatim from
   * `attachExistingDaemonSession`.
   *
   * INVARIANT: the truthy-`sessionId` short-circuit is the double-attach
   * guard — it assumes the socket close handler (the single place that does
   * this) reset the transient `sessionId` to null on any disconnect. If a
   * future disconnect path forgets that clear, this guard silently skips
   * re-attach. Audit: Kilo #744.
   */
  async attachExistingSession(): Promise<boolean> {
    const durable = this.#hooks.getDurableSession();
    if (!this.#client || this.#sessionId || !durable.persisted || !durable.sessionId) {
      return false;
    }
    try {
      const res = await this.#client.request(
        'attach_session',
        {
          sessionId: durable.sessionId,
          // `lastSeenSeq` is this connection's observed-seq cursor, NOT
          // `state.eventSeq` (the local counter) — see `noteSeenSeq`.
          lastSeenSeq: this.#lastSeenSeq,
          attachToken: durable.attachToken || undefined,
          capabilities: [...TUI_DAEMON_CAPABILITIES],
        },
        null,
        1500,
      );
      this.#sessionId = durable.sessionId;
      // Adopt the attach token from the response (Universal Session Bearer).
      // For a legacy tokenless session the daemon's bootstrap grace claimed
      // it and returned a freshly minted token — adopt it into both the
      // in-memory token and the durable state so the NEXT reconnect presents
      // the real token and is accepted. For an already-tokened session the
      // response echoes the token we sent (no-op). Fall back to the durable
      // token if an older daemon omits it.
      const adoptedToken =
        (typeof res.payload?.attachToken === 'string' && res.payload.attachToken) ||
        durable.attachToken ||
        null;
      if (adoptedToken) this.#hooks.setDurableAttachToken(adoptedToken);
      this.#attachToken = adoptedToken;
      // Daemon is the source of truth for session-scoped state: the hook
      // hydrates provider/model from the attach response and fires the
      // (non-blocking) session-snapshot refresh. Audit: Kilo #744.
      this.#hooks.onAttached(res.payload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bind a session: re-attach to the persisted one, else `start_session`.
   * Body moved verbatim from `ensureDaemonSession` (including the
   * fall-back-to-inline close on start failure).
   */
  async ensureSession(): Promise<void> {
    if (!this.#client || this.#sessionId) return;
    if (await this.attachExistingSession()) return;
    try {
      const start = this.#hooks.getStartSessionPayload();
      const res = await this.#client.request('start_session', {
        provider: start.provider,
        model: start.model,
        repo: { rootPath: start.cwd },
        mode: 'tui',
        capabilities: [...TUI_DAEMON_CAPABILITIES],
      });
      this.#sessionId = (res.payload?.sessionId as string) ?? null;
      this.#attachToken = (res.payload?.attachToken as string) ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#hooks.note('warning', `Daemon session failed: ${message}. Using inline mode.`);
      this.#client.close();
      this.#client = null;
      this.#hooks.markFooterDirty();
    }
  }

  /**
   * True when a daemon-backed session is available to address. The session
   * id is populated lazily — a fresh connect has `client` connected but
   * `sessionId` still null until the first send. The session-verb commands
   * need it eagerly, so attach/start here the same way the send path does
   * (`ensureSession` is a no-op once the id is set).
   */
  async ensureReady(): Promise<boolean> {
    if (!this.#client?.connected) return false;
    if (!this.#sessionId) await this.ensureSession();
    return Boolean(this.#sessionId);
  }

  // ── Transport ──

  /**
   * Send a bearer-gated session verb for the current session. Returns the
   * response envelope, or `null` when there is no daemon session (the caller
   * prints mode-specific guidance). `sessionId` + `attachToken` are attached
   * uniformly — every session-ful daemon verb requires both.
   */
  async sendVerb<TPayload = Record<string, unknown>>(
    type: string,
    extraPayload: Record<string, unknown> = {},
  ): Promise<DaemonResponseEnvelope<TPayload> | null> {
    if (!this.#client?.connected || !this.#sessionId) return null;
    return this.#client.request(
      type,
      { sessionId: this.#sessionId, attachToken: this.#attachToken, ...extraPayload },
      this.#sessionId,
    ) as Promise<DaemonResponseEnvelope<TPayload>>;
  }

  // ── Session verbs (typed data boundary; rendering stays TUI-side) ──

  /** `session_revert` — undo the last N user turns on the daemon. */
  revert(turns: number): Promise<DaemonResponseEnvelope<SessionRevertPayload> | null> {
    return this.sendVerb<SessionRevertPayload>('session_revert', { turns });
  }

  /** `session_unrevert` — restore the most recent revert. */
  unrevert(): Promise<DaemonResponseEnvelope<Record<string, unknown>> | null> {
    return this.sendVerb('session_unrevert', {});
  }

  /** `session_summarize` — compact daemon-side history, preserving a tail. */
  summarize(
    preserveTurns: number,
  ): Promise<DaemonResponseEnvelope<SessionSummarizePayload> | null> {
    return this.sendVerb<SessionSummarizePayload>('session_summarize', { preserveTurns });
  }

  /** `list_children` — the delegated child runs of this session. */
  listChildren(): Promise<DaemonResponseEnvelope<ListChildrenPayload> | null> {
    return this.sendVerb<ListChildrenPayload>('list_children', { includeEventDerived: true });
  }

  /** `get_child_session` — one delegated child as a structured descriptor. */
  getChild(subagentId: string): Promise<DaemonResponseEnvelope<GetChildSessionPayload> | null> {
    return this.sendVerb<GetChildSessionPayload>('get_child_session', { subagentId });
  }
}

export function createDaemonSession(hooks: DaemonSessionHooks): DaemonSessionController {
  return new DaemonSessionController(hooks);
}
