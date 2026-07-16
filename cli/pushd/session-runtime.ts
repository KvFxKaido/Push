/**
 * session-runtime.ts — mutable session/client ownership for pushd.
 *
 * Owns active sessions, client fan-out, approval waits, workspace-state
 * serialization, drain/idle lifecycle accounting, and shutdown traversal.
 * Handler and delegation modules consume this runtime instead of owning maps or
 * lifecycle flags independently.
 */
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  assertValidEvent,
  isProtocolObserveEnabled,
  isStrictModeEnabled,
  PROTOCOL_VERSION,
  validateEvent,
} from '../../lib/protocol-schema.js';
import { EVENT_V2, TOOL_CARDS_V1, WORKSPACE_STATE_V1 } from '../../lib/daemon-capabilities.js';
import { appendSessionEvent } from '../session-store.js';
import {
  applyDaemonTranscriptEvent,
  snapshotDaemonTranscript,
} from '../daemon-transcript-mirror.js';
import { synthesizeV1DelegationEvent, isV2DelegationEvent } from '../v1-downgrade.js';
import { nextWorkspaceStateEvent, readWorkspaceStateFromGit } from '../workspace-state-emitter.js';
import { makeErrorResponse, makeResponse, type DaemonResponse } from './envelopes.js';
import type { DaemonHandlerContext, DaemonRequest } from './handler-types.js';
import { makeApprovalId } from './ids.js';

const execFileAsync = promisify(execFile);
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const DRAIN_IDLE_POLL_MS = 250;

export type SessionEmitEvent = (event: any) => void;

export interface PendingApproval {
  approvalId: string;
  resolve(decision: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  runId?: string | null;
  kind?: string | null;
  title?: string | null;
  summary?: string | null;
}

export interface SessionRuntimeEntry {
  state: any;
  attachToken?: string | null;
  abortController?: AbortController | null;
  activeRunId?: string | null;
  pendingApproval?: PendingApproval | null;
  activeDelegations?: Map<string, any>;
  activeGraphs?: Map<string, any>;
  transcriptMirror?: any;
  workspaceStateProducer?: any;
  workspaceStateEmitChain?: Promise<void>;
  [key: string]: any;
}

interface SessionClientMeta {
  capabilities: Set<string>;
}

export interface PendingWorkSummary {
  runs: Array<{ sessionId: string; runId: string }>;
  delegations: number;
  graphs: number;
  total: number;
}

export interface SessionRuntimeDependencies {
  isRelayRunning(): boolean;
}

export type WorkspaceStateEmitMode = 'snapshot' | 'delta' | 'resync';

export class SessionRuntime {
  readonly sessions = new Map<string, SessionRuntimeEntry>();
  readonly #clients = new Map<string, Map<SessionEmitEvent, SessionClientMeta>>();
  readonly #dependencies: SessionRuntimeDependencies;

  #draining = false;
  #drainExitScheduled = false;
  #drainIdleWatcher: NodeJS.Timeout | null = null;
  #drainExitFn: () => void = () => process.kill(process.pid, 'SIGTERM');

  #liveConnections = 0;
  #lifecycleExitTimer: NodeJS.Timeout | null = null;
  #lifecycleExitArmed = false;
  #lifecycleExitFired = false;
  #lifecycleGraceMs: number;
  // Injectable so a test can observe the exit decision without SIGTERM-ing the
  // runner. Production raises SIGTERM so `main()`'s shutdown closure runs the
  // full teardown (relay close, WS close, socket/pidfile cleanup) — same path
  // as drain.
  #lifecycleExitFn: () => void = () => process.kill(process.pid, 'SIGTERM');

  constructor(dependencies: SessionRuntimeDependencies) {
    this.#dependencies = dependencies;
    const configuredGrace = Number(process.env.PUSH_DAEMON_IDLE_GRACE_MS);
    this.#lifecycleGraceMs =
      Number.isFinite(configuredGrace) && configuredGrace >= 0 ? configuredGrace : 8_000;
  }

  ensureRuntimeState(entry: SessionRuntimeEntry): SessionRuntimeEntry {
    if (!entry.activeDelegations) entry.activeDelegations = new Map();
    if (!entry.activeGraphs) entry.activeGraphs = new Map();
    return entry;
  }

  get(sessionId: string): SessionRuntimeEntry | null {
    return this.sessions.get(sessionId) ?? null;
  }

  set(sessionId: string, entry: SessionRuntimeEntry): SessionRuntimeEntry {
    this.sessions.set(sessionId, entry);
    return entry;
  }

  evict(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  addClient(sessionId: string, emitEvent: SessionEmitEvent, capabilities: unknown = []): void {
    let clients = this.#clients.get(sessionId);
    if (!clients) {
      clients = new Map();
      this.#clients.set(sessionId, clients);
    }
    const normalized = new Set<string>(
      (Array.isArray(capabilities) ? capabilities : []) as string[],
    );
    clients.set(emitEvent, { capabilities: normalized });
  }

  removeClient(sessionId: string, emitEvent: SessionEmitEvent): void {
    const clients = this.#clients.get(sessionId);
    if (!clients) return;
    clients.delete(emitEvent);
    if (clients.size === 0) this.#clients.delete(sessionId);
  }

  /**
   * Build an approvalFn for a session entry. The returned function emits
   * approval_required events and awaits a client decision (or times out).
   * Used by both normal runs and crash-recovery runs.
   */
  buildApprovalFn(sessionId: string, entry: SessionRuntimeEntry, runId?: string | null) {
    return async (tool: any, detail: unknown): Promise<boolean> => {
      const approvalId = makeApprovalId();
      // Display fields, computed once and shared between the `approval_required`
      // event payload and the persisted `entry.pendingApproval` so a reconnect
      // snapshot can rebuild a faithful pane (see handleGetSessionSnapshot).
      const approvalKind = tool?.tool || 'tool_execution';
      const approvalTitle = `Approve ${tool?.tool || 'action'}`;
      const approvalSummary = typeof detail === 'string' ? detail : JSON.stringify(detail || {});

      const approvalPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pendingApproval = null;
          reject(new Error('Approval timed out'));
        }, APPROVAL_TIMEOUT_MS);
        // Store the runId alongside the approvalId so `handleSubmitApproval`
        // can emit `approval_received` on the SAME runId we emitted
        // `approval_required` on. Without this, delegation + task-graph
        // approvals mismatched: the required event fired on the child
        // runId while the received event fell back to `entry.activeRunId`
        // (which is the parent for delegations, and null for task-graph
        // nodes), making client-side correlation impossible (codex P1
        // on PR #282).
        //
        // Also persist the display fields (kind/title/summary). A client that
        // reconnects while an approval is pending — with the `approval_required`
        // event already outside its replay window — rebuilds the pane from the
        // snapshot's `pendingApproval`; without these it could only show a
        // generic "waiting for approval" pane (#746).
        entry.pendingApproval = {
          approvalId,
          resolve,
          reject,
          timer,
          runId,
          kind: approvalKind,
          title: approvalTitle,
          summary: approvalSummary,
        };
      });

      const approvalPayload = {
        approvalId,
        kind: approvalKind,
        title: approvalTitle,
        summary: approvalSummary,
        options: ['approve', 'deny'],
      };
      await appendSessionEvent(entry.state, 'approval_required', approvalPayload, runId as any);
      this.broadcast(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'approval_required',
        payload: approvalPayload,
      });

      try {
        return (await approvalPromise) === 'approve';
      } catch {
        return false;
      }
    };
  }

  broadcast(sessionId: string, event: any): void {
    this.#checkOutboundEvent(event);
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (
        event.type === 'context_compacted' ||
        event.type === 'session_reverted' ||
        event.type === 'session_unreverted'
      ) {
        entry.transcriptMirror = null;
      } else if (entry.transcriptMirror) {
        applyDaemonTranscriptEvent(entry.transcriptMirror, event);
      }
    }

    const clients = this.#clients.get(sessionId);
    if (!clients) return;
    // Fast path: non-delegation events pass through unchanged to every
    // client regardless of capabilities. This covers the vast majority
    // of traffic (`assistant_token`, `tool_call`, `tool_result`,
    // `status`, `run_complete`, `error`, `session_started`,
    // `approval_required`, etc.).
    if (!isV2DelegationEvent(event.type)) {
      for (const [emitEvent, meta] of clients) {
        try {
          emitEvent(this.#eventForCapabilities(event, meta.capabilities));
        } catch {
          // Client may have disconnected.
        }
      }
      return;
    }

    // Slow path: a v2 delegation event. Clients that advertised
    // `event_v2` get the raw envelope; v1 clients get synthesized
    // `assistant_token` shadows built by `cli/v1-downgrade.ts`.
    let synthesized: any[] | null = null;
    for (const [emitEvent, meta] of clients) {
      if (meta.capabilities.has(EVENT_V2)) {
        try {
          emitEvent(event);
        } catch {
          // Client may have disconnected.
        }
        continue;
      }
      if (synthesized === null) {
        synthesized = synthesizeV1DelegationEvent(event);
        for (const shadow of synthesized) this.#checkOutboundEvent(shadow);
      }
      for (const shadow of synthesized) {
        try {
          emitEvent(shadow);
        } catch {
          // Client may have disconnected.
        }
      }
    }
  }

  /**
   * Emit a single event to a single client applying the same v1 synthetic
   * downgrade rules as `broadcast`'s live-fanout slow path. Used by the
   * replay path inside `handleAttachSession` so a v1 client that reconnects
   * with `lastSeenSeq` doesn't receive raw `subagent.*` / `task_graph.*`
   * events from disk and silently drop them.
   *
   * Fixes the PR #281 codex P1 feedback: before this helper, the replay
   * loop called `emitEvent(event)` directly, which reintroduced the exact
   * "unknown event gets dropped" gap the live broadcast was meant to
   * close. Now every path that emits a delegation event to a client goes
   * through capability-aware synthesis.
   */
  emitWithDowngrade(event: any, emitEvent: SessionEmitEvent, capabilities: Set<string>): void {
    this.#checkOutboundEvent(event);
    if (!isV2DelegationEvent(event.type) || capabilities.has(EVENT_V2)) {
      try {
        emitEvent(this.#eventForCapabilities(event, capabilities));
      } catch {
        // Client may have disconnected.
      }
      return;
    }
    const synthesized = synthesizeV1DelegationEvent(event);
    for (const shadow of synthesized) this.#checkOutboundEvent(shadow);
    for (const shadow of synthesized) {
      try {
        emitEvent(shadow);
      } catch {
        // Client may have disconnected.
      }
    }
  }

  transcriptSnapshotForCapabilities(mirror: any, capabilities: Set<string>): any {
    const snapshot = snapshotDaemonTranscript(mirror);
    if (capabilities.has(TOOL_CARDS_V1)) return snapshot;
    return {
      ...snapshot,
      rows: snapshot.rows.map((row: any) => {
        if (!row?.card) return row;
        const { card: _card, ...legacyRow } = row;
        return legacyRow;
      }),
    };
  }

  eventForCapabilities(event: any, capabilities: Set<string>): any {
    return this.#eventForCapabilities(event, capabilities);
  }

  emitWorkspaceState(
    sessionId: string,
    entry: SessionRuntimeEntry,
    mode: WorkspaceStateEmitMode,
  ): Promise<void> {
    const prior = entry.workspaceStateEmitChain ?? Promise.resolve();
    const next = prior.then(() => this.#runWorkspaceStateEmit(sessionId, entry, mode));
    entry.workspaceStateEmitChain = next;
    return next;
  }

  isDraining(): boolean {
    return this.#draining;
  }

  isIdle(): boolean {
    for (const entry of this.sessions.values()) {
      if (entry.activeRunId) return false;
      if (entry.activeDelegations && entry.activeDelegations.size > 0) return false;
      if (entry.activeGraphs && entry.activeGraphs.size > 0) return false;
    }
    return true;
  }

  pendingWorkSummary(): PendingWorkSummary {
    const runs: Array<{ sessionId: string; runId: string }> = [];
    let delegations = 0;
    let graphs = 0;
    for (const [sessionId, entry] of this.sessions) {
      if (entry.activeRunId) runs.push({ sessionId, runId: entry.activeRunId });
      if (entry.activeDelegations) delegations += entry.activeDelegations.size;
      if (entry.activeGraphs) graphs += entry.activeGraphs.size;
    }
    return { runs, delegations, graphs, total: runs.length + delegations + graphs };
  }

  async handleDrain(
    req: DaemonRequest,
    _emitEvent: SessionEmitEvent,
    context: DaemonHandlerContext | null = null,
  ): Promise<DaemonResponse> {
    if (context?.relaySenderId) {
      return makeErrorResponse(
        req.requestId,
        'drain',
        'FORBIDDEN',
        'drain is a loopback-only operation',
      );
    }
    const reason = typeof req.payload?.reason === 'string' ? req.payload.reason : null;
    this.#draining = true;
    const work = this.pendingWorkSummary();
    const idle = work.total === 0;
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'pushd_drain_requested',
        idle,
        pendingRuns: work.runs.length,
        pendingDelegations: work.delegations,
        pendingGraphs: work.graphs,
        reason,
      }),
    );
    if (idle) this.#scheduleDrainExit();
    else this.#startDrainIdleWatcher();
    return makeResponse(req.requestId, 'drain', null, true, {
      draining: true,
      idle,
      pendingRuns: work.runs,
      pendingDelegations: work.delegations,
      pendingGraphs: work.graphs,
      pendingWork: work.total,
    });
  }

  noteRunSettled(): void {
    if (!this.#draining) return;
    if (this.isIdle()) {
      console.log(JSON.stringify({ level: 'info', event: 'pushd_drain_idle_reached' }));
      this.#scheduleDrainExit();
    } else {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'pushd_drain_awaiting_idle',
          pendingWork: this.pendingWorkSummary().total,
        }),
      );
    }
  }

  noteClientConnected(): void {
    this.#liveConnections += 1;
    this.cancelLifecycleExit('client_connected');
  }

  noteClientDisconnected(): void {
    this.#liveConnections = Math.max(0, this.#liveConnections - 1);
    this.maybeScheduleLifecycleExit();
  }

  cancelLifecycleExit(reason: string): void {
    this.#clearLifecycleExitTimer();
    if (this.#lifecycleExitArmed) {
      this.#lifecycleExitArmed = false;
      console.log(
        JSON.stringify({ level: 'info', event: 'pushd_lifecycle_exit_cancelled', reason }),
      );
    }
  }

  maybeScheduleLifecycleExit(): void {
    if (this.#draining || this.#drainExitScheduled || this.#lifecycleExitFired) return;
    if (this.#liveConnections > 0 || this.#dependencies.isRelayRunning()) {
      this.cancelLifecycleExit('client_or_relay_present');
      return;
    }
    if (this.#lifecycleExitTimer) return;
    if (!this.#lifecycleExitArmed) {
      this.#lifecycleExitArmed = true;
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'pushd_lifecycle_exit_armed',
          graceMs: this.#lifecycleGraceMs,
          idle: this.isIdle(),
        }),
      );
    }
    this.#lifecycleExitTimer = setTimeout(() => {
      this.#lifecycleExitTimer = null;
      if (this.#draining || this.#drainExitScheduled || this.#lifecycleExitFired) return;
      if (this.#liveConnections > 0 || this.#dependencies.isRelayRunning()) {
        this.cancelLifecycleExit('client_or_relay_present');
        return;
      }
      if (!this.isIdle()) {
        this.maybeScheduleLifecycleExit();
        return;
      }
      this.#lifecycleExitFired = true;
      this.#lifecycleExitArmed = false;
      console.log(JSON.stringify({ level: 'info', event: 'pushd_lifecycle_exit_fired' }));
      this.#lifecycleExitFn();
    }, this.#lifecycleGraceMs);
  }

  setDrainExitForTesting(exitFn?: (() => void) | null): void {
    this.#drainExitFn =
      typeof exitFn === 'function' ? exitFn : () => process.kill(process.pid, 'SIGTERM');
    this.#draining = false;
    this.#drainExitScheduled = false;
    this.#clearDrainIdleWatcher();
  }

  setLifecycleExitForTesting(
    exitFn?: (() => void) | null,
    options?: { graceMs?: number } | null,
  ): void {
    this.#lifecycleExitFn =
      typeof exitFn === 'function' ? exitFn : () => process.kill(process.pid, 'SIGTERM');
    if (options && Number.isFinite(options.graceMs)) this.#lifecycleGraceMs = options.graceMs!;
    this.#liveConnections = 0;
    this.#lifecycleExitArmed = false;
    this.#lifecycleExitFired = false;
    this.#clearLifecycleExitTimer();
  }

  setLiveConnectionsForTesting(count: number): void {
    this.#liveConnections = Math.max(0, Math.trunc(count) || 0);
  }

  shutdownSessions(): void {
    for (const entry of this.sessions.values()) {
      entry.abortController?.abort();
      if (entry.pendingApproval) {
        clearTimeout(entry.pendingApproval.timer);
        entry.pendingApproval.resolve('deny');
      }
    }
  }

  #eventForCapabilities(event: any, capabilities: Set<string>): any {
    if (capabilities.has(TOOL_CARDS_V1)) return event;
    if (event?.type !== 'tool.execution_complete' || !event.payload?.card) return event;
    const { card: _card, ...payload } = event.payload;
    return { ...event, payload };
  }

  #checkOutboundEvent(event: any): void {
    if (isStrictModeEnabled()) {
      assertValidEvent(event);
      return;
    }
    if (!isProtocolObserveEnabled()) return;
    const issues = validateEvent(event);
    if (issues.length === 0) return;
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'protocol_drift_detected',
        sessionId: event?.sessionId,
        type: event?.type,
        seq: event?.seq,
        // Log only the dotted paths, never `issue.message` — validator messages
        // embed JSON.stringify(value) of the offending field, and a drifted
        // tool-call / approval / stream payload can carry user prompts, tool
        // args, or command output. Path + type + seq is enough drift signal;
        // reproduce with PUSH_PROTOCOL_STRICT=1 locally to see the full values.
        issuePaths: issues.map((issue) => issue.path || '(root)'),
      }),
    );
  }

  #broadcastWorkspaceStateEvent(sessionId: string, entry: SessionRuntimeEntry, event: any): void {
    const { type, ...payload } = event;
    const envelope = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      seq: entry.state?.eventSeq ?? 0,
      ts: Date.now(),
      type,
      payload,
    };
    this.#checkOutboundEvent(envelope);
    const clients = this.#clients.get(sessionId);
    if (!clients) return;
    for (const [emitEvent, meta] of clients) {
      if (!meta.capabilities.has(WORKSPACE_STATE_V1)) continue;
      try {
        emitEvent(envelope);
      } catch {
        // Client may have disconnected.
      }
    }
  }

  async #runWorkspaceStateEmit(
    sessionId: string,
    entry: SessionRuntimeEntry,
    mode: WorkspaceStateEmitMode,
  ): Promise<void> {
    try {
      if (mode === 'resync' && entry.workspaceStateProducer) {
        this.#broadcastWorkspaceStateEvent(
          sessionId,
          entry,
          entry.workspaceStateProducer.snapshot(),
        );
        return;
      }
      const cwd = entry.state?.cwd || process.cwd();
      const nextState = await readWorkspaceStateFromGit(
        cwd,
        { protectMain: false },
        async (args, gitCwd) => {
          try {
            const { stdout } = await execFileAsync('git', args, {
              cwd: gitCwd,
              timeout: 5_000,
              maxBuffer: 10 * 1024 * 1024,
            });
            return { stdout };
          } catch {
            return null;
          }
        },
      );
      if (!nextState) {
        console.error(
          JSON.stringify({
            level: 'info',
            event: 'workspace_state_emit_skipped',
            sessionId,
            reason: 'no_git_status',
          }),
        );
        return;
      }
      const { producer, event } = nextWorkspaceStateEvent(
        entry.workspaceStateProducer ?? null,
        sessionId,
        nextState,
        mode === 'delta' ? 'delta' : 'snapshot',
      );
      entry.workspaceStateProducer = producer;
      if (event) this.#broadcastWorkspaceStateEvent(sessionId, entry, event);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'workspace_state_emit_failed',
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  #clearDrainIdleWatcher(): void {
    if (!this.#drainIdleWatcher) return;
    clearTimeout(this.#drainIdleWatcher);
    this.#drainIdleWatcher = null;
  }

  #scheduleDrainExit(): void {
    if (this.#drainExitScheduled) return;
    this.#drainExitScheduled = true;
    this.#clearDrainIdleWatcher();
    console.log(JSON.stringify({ level: 'info', event: 'pushd_drain_exit_scheduled' }));
    setTimeout(() => this.#drainExitFn(), 50);
  }

  #startDrainIdleWatcher(): void {
    if (this.#drainIdleWatcher || this.#drainExitScheduled) return;
    const tick = () => {
      this.#drainIdleWatcher = null;
      if (!this.#draining || this.#drainExitScheduled) return;
      if (this.isIdle()) {
        console.log(JSON.stringify({ level: 'info', event: 'pushd_drain_idle_reached' }));
        this.#scheduleDrainExit();
        return;
      }
      this.#drainIdleWatcher = setTimeout(tick, DRAIN_IDLE_POLL_MS);
    };
    this.#drainIdleWatcher = setTimeout(tick, DRAIN_IDLE_POLL_MS);
  }

  #clearLifecycleExitTimer(): void {
    if (!this.#lifecycleExitTimer) return;
    clearTimeout(this.#lifecycleExitTimer);
    this.#lifecycleExitTimer = null;
  }
}

export function createSessionRuntime(dependencies: SessionRuntimeDependencies): SessionRuntime {
  return new SessionRuntime(dependencies);
}
