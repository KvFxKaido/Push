#!/usr/bin/env node
/**
 * pushd.ts — Push daemon (Track 4)
 *
 * Persistent background daemon that reuses the same engine as the CLI.
 * Transport: Unix domain socket or Windows named pipe, NDJSON (one JSON object per line).
 *
 * Supported request types:
 *   hello            — handshake + capability negotiation
 *   ping             — health check
 *   list_sessions    — discover resumable sessions
 *   start_session    — create a new session
 *   send_user_message — start a run from user input
 *   attach_session   — attach to existing session + event replay
 *   get_session_snapshot — read daemon-owned reconnect status for one session
 *   update_session   — mutate session-scoped state (provider/model)
 *   submit_approval  — respond to an approval_required pause
 *   cancel_run       — abort active run
 *   configure_role_routing — set per-role provider/model routing
 *   submit_task_graph      — scaffold for future task graph execution
 *   delegate_explorer      — launch read-only Explorer sub-agent (real streamFn + real read-only toolExec via makeDaemonExplorerToolExec)
 *   delegate_coder         — launch mutating Coder sub-agent (real streamFn + real full-surface toolExec via makeDaemonCoderToolExec)
 *   delegate_reviewer      — launch advisory Reviewer sub-agent (real streamFn, single-turn JSON review; no tool loop)
 *   delegate_deep_reviewer — launch Deep Reviewer sub-agent (real streamFn + read-only tool loop via makeDaemonExplorerToolExec; investigates then reviews)
 *   cancel_delegation      — cancel active sub-agent delegation
 *   fetch_delegation_events — replay delegation event stream
 *   get_daemon_runtime_config — read daemon-owned exec/search settings
 *   set_daemon_runtime_config — persist daemon-owned exec/search settings
 */
import net from 'node:net';
import { promises as fs } from 'node:fs';
import process from 'node:process';

import { startPushdWs, type PushdWsHandle } from './pushd-ws.js';
import { appendAuditEvent, shouldLogCommandText, truncateForAudit } from './pushd-audit-log.js';
import { auditProvenance } from './pushd/audit-provenance.js';
import { createRelayCoordinator } from './pushd/relay-coordinator.js';
import {
  createDeviceAdminHandlers,
  resolveOrMintTargetAttachToken,
} from './pushd/device-admin-handlers.js';
import { createCoreSessionHandlers, VALID_AGENT_ROLES } from './pushd/core-session-handlers.js';
import { createChildSessionHandlers } from './pushd/child-session-handlers.js';
import { daemonRuntimeHandlers } from './pushd/daemon-runtime-handlers.js';
import {
  createDelegationCoordinator,
  type DelegateExplorerTestHooks,
} from './pushd/delegation-coordinator.js';
import { createDelegationExecutionAdapters } from './pushd/delegation-execution.js';
import type { DaemonResponse } from './pushd/envelopes.js';
import type {
  DaemonEmitEvent,
  DaemonHandler,
  DaemonHandlerContext,
  DaemonRequest,
} from './pushd/handler-types.js';
import { createInterruptedRunRecovery } from './pushd/interrupted-run-recovery.js';
import { createSessionAuthenticator } from './pushd/session-auth.js';
import { createSessionMaintenanceHandlers } from './pushd/session-maintenance-handlers.js';
import {
  createSessionRuntime,
  type SessionEmitEvent,
  type SessionRuntimeEntry,
  type WorkspaceStateEmitMode,
} from './pushd/session-runtime.js';
import {
  wrapCliDetectAllToolCalls,
  wrapCliDetectAnyToolCall,
  wrapCliDetectNativeToolCalls,
} from './lead-turn.js';

/**
 * Dispatcher-level audit emission for request types whose handlers
 * don't emit at a finer grain. Called from `handleRequest` after the
 * handler resolves. Reads `req.payload` for the input fields (path,
 * sessionId, runId) and the response for ok/error metadata. The
 * mapping is intentionally narrow — types not in the switch produce
 * no audit row, so types like `ping` and `hello` stay out of the
 * log.
 *
 * Slice 3 covers: sandbox file ops, delegate.{coder|explorer|reviewer},
 * session.start (start_session), session.cancel_run. The auth and
 * sandbox_exec / mint / revoke handlers emit themselves because they
 * carry context (exit code, closed-connection count, mintedTokenId)
 * the dispatcher doesn't see.
 */
function emitDispatcherAudit(req: any, response: any, context: any): void {
  if (!req || typeof req.type !== 'string') return;
  // Handlers vary on whether sessionId rides in the top-level envelope
  // or the payload. cancel_run / submit_approval place it in payload;
  // attach_session / send_user_message use the envelope. Read both
  // so the audit row records it consistently regardless of caller
  // shape.
  const sessionId =
    typeof req.sessionId === 'string' && req.sessionId
      ? req.sessionId
      : typeof req.payload?.sessionId === 'string'
        ? req.payload.sessionId
        : undefined;
  const ok = Boolean(response?.ok);
  const errorCode =
    response && response.error && typeof response.error.code === 'string'
      ? response.error.code
      : undefined;
  const prov = auditProvenance(context);
  switch (req.type) {
    case 'sandbox_read_file':
    case 'sandbox_write_file':
    case 'sandbox_list_dir':
    case 'sandbox_diff': {
      void appendAuditEvent({
        type: `tool.${req.type}` as any,
        ...prov,
        sessionId,
        payload: {
          path: typeof req.payload?.path === 'string' ? req.payload.path : undefined,
          ok,
          errorCode,
        },
      });
      return;
    }
    case 'delegate_coder':
    case 'delegate_explorer':
    case 'delegate_reviewer':
    case 'delegate_deep_reviewer': {
      // delegate.* events are coarse — they fire as soon as the
      // handler returns, regardless of how long the delegation
      // itself runs. That's fine for "did this device kick off a
      // delegation," which is the auditable surface. A future slice
      // could emit a paired `delegate.complete` from the agent
      // bindings when the run finishes.
      //
      // Privacy posture: the task string can contain bearer tokens,
      // API keys, or other secrets when the model is asked to do
      // work on credential-sensitive systems. Gate `taskExcerpt`
      // behind the same `PUSHD_AUDIT_LOG_COMMANDS=1` opt-in that
      // controls `sandbox_exec` command-text logging. Default leaves
      // the structural shape (which agent kind was invoked, ok/error)
      // without the free-form payload. #520 Copilot review.
      const taskExcerpt =
        shouldLogCommandText() && typeof req.payload?.task === 'string'
          ? truncateForAudit(req.payload.task)
          : undefined;
      const auditType = req.type.replace('delegate_', 'delegate.') as any;
      void appendAuditEvent({
        type: auditType,
        ...prov,
        sessionId,
        payload: { ok, errorCode, taskExcerpt },
      });
      return;
    }
    case 'start_session': {
      void appendAuditEvent({
        type: 'session.start',
        ...prov,
        sessionId:
          ok && response?.payload?.sessionId ? String(response.payload.sessionId) : sessionId,
        payload: { ok, errorCode },
      });
      return;
    }
    case 'abort': {
      // `abort` sugar routes to cancel_run (parent) or cancel_delegation
      // (child). Child aborts aren't dispatcher-audited (parity with a direct
      // cancel_delegation); for the parent case, mirror the cancel_run audit so
      // an abort-routed cancel keeps its session.cancel_run trail.
      if (typeof req.payload?.subagentId === 'string' && req.payload.subagentId) return;
      const abortRunId =
        typeof req.payload?.runId === 'string' && req.payload.runId ? req.payload.runId : undefined;
      void appendAuditEvent({
        type: 'session.cancel_run',
        ...prov,
        sessionId,
        runId: abortRunId,
        payload: { ok, errorCode },
      });
      return;
    }
    case 'cancel_run': {
      const runId =
        typeof req.payload?.runId === 'string' && req.payload.runId ? req.payload.runId : undefined;
      void appendAuditEvent({
        type: 'session.cancel_run',
        ...prov,
        sessionId,
        runId,
        payload: { ok, errorCode },
      });
      return;
    }
    default:
      return;
  }
}

// Module-scoped reference to the running WS handle. The spine owns transport
// startup/shutdown; device-admin handlers receive a narrow accessor for live
// disconnect and connection-list operations.
let activeWsHandle: PushdWsHandle | null = null;

import {
  makeAttachToken,
  saveSessionState,
  loadSessionState,
  PROTOCOL_VERSION,
} from './session-store.js';
import { DAEMON_CAPABILITIES } from '../lib/daemon-capabilities.js';
import { setDefaultMemoryStore } from '../lib/context-memory-store.ts';
import { setDefaultVerbatimLog } from '../lib/verbatim-log.ts';
import { installCliEmbeddingProvider } from './embedding-provider-cli.ts';
import { createFileMemoryStore, getMemoryStoreBaseDir } from './context-memory-file-store.ts';
import { createFileVerbatimLog, getVerbatimLogBaseDir } from './verbatim-log-file-store.ts';
import { getBuildStamp, RUNTIME_VERSION } from './build-stamp.js';

const VERSION = RUNTIME_VERSION;
const DAEMON_STARTED_AT_MS = Date.now();
// The daemon's advertised protocol capability set. The canonical vocabulary
// (with per-capability docs) lives in `lib/daemon-capabilities.ts` so the
// client surfaces that advertise subsets back can't drift from it — see #745.
const CAPABILITIES = DAEMON_CAPABILITIES;

// ─── Compatibility facade exports ───────────────────────────────────
// Implementations live in typed modules under cli/pushd/. Existing importers
// (tests, cli.ts, daemon-admin.ts) keep resolving these helpers through pushd.ts.
import {
  cleanPidFile,
  cleanStaleSocket,
  ensureSocketDir,
  getLogPath,
  getPidPath,
  getPortPath,
  getSocketPath,
  isNamedPipePath,
  isWsListenerEnabled,
  writePidFile,
} from './pushd/paths.js';
import { makeRequestId } from './pushd/ids.js';
import { makeErrorResponse, makeResponse } from './pushd/envelopes.js';
import { DEFAULT_RESTART_POLICY, getRestartPolicy, shouldRecover } from './pushd/restart-policy.js';
import { validateAttachToken } from './pushd/attach-token.js';
import { normalizeProviderInput } from './pushd/provider-input.js';
import {
  collectOrphanedDelegations,
  formatDelegationInterruptedNote,
} from './pushd/recovery-reconciliation.js';
import { handleDaemonIdentify, handleSandboxExec } from './pushd/remote-execution-handlers.js';
import {
  handleSandboxDiff,
  handleSandboxListDir,
  handleSandboxReadFile,
  handleSandboxWriteFile,
} from './pushd/file-operation-handlers.js';

export {
  isNamedPipePath,
  getSocketPath,
  getPidPath,
  getPortPath,
  isWsListenerEnabled,
  getLogPath,
  makeResponse,
  makeErrorResponse,
  getRestartPolicy,
  shouldRecover,
  DEFAULT_RESTART_POLICY,
  validateAttachToken,
  normalizeProviderInput,
  collectOrphanedDelegations,
  formatDelegationInterruptedNote,
  VALID_AGENT_ROLES,
};
// Re-export the session-store mint helper from the daemon module so existing
// importers (and tests) that reach for it here keep resolving after the
// promotion into `./session-store`.
export { makeAttachToken };
export { resolveOrMintTargetAttachToken };
// Detector wrappers live in `cli/lead-turn.ts` (which documents the nested
// `{ call: { tool, args } }` shape the lib Coder kernel requires — handing it
// a flat call throws on `.call.tool` at the first tool turn; codex P1 on
// PR #282). Re-exported so existing test imports keep resolving against pushd.
export { wrapCliDetectAllToolCalls, wrapCliDetectAnyToolCall, wrapCliDetectNativeToolCalls };

// ─── Session runtime composition (Phase 4) ────────────────────────

const sessionRuntime = createSessionRuntime({
  isRelayRunning: () => relayCoordinator.isRunning(),
});
const loadAndAuthSession = createSessionAuthenticator(sessionRuntime);
const { recoverInterruptedRuns } = createInterruptedRunRecovery(sessionRuntime);

// Compatibility facade for callers that still inspect active daemon sessions.
// The runtime owns the Map; pushd only retains a temporary reference.
const activeSessions = sessionRuntime.sessions;

const delegationExecutionAdapters = createDelegationExecutionAdapters(sessionRuntime);
const { makeDaemonCoderToolExec, makeDaemonExplorerToolExec } = delegationExecutionAdapters;

const {
  handleSubmitTaskGraph,
  handleDelegateExplorer,
  handleDelegateCoder,
  handleDelegateReviewer,
  handleDelegateDeepReviewer,
  handleCancelDelegation,
  setDelegateExplorerTestHooks,
} = createDelegationCoordinator({
  runtime: sessionRuntime,
  executionAdapters: delegationExecutionAdapters,
});

export { makeDaemonCoderToolExec, makeDaemonExplorerToolExec };

export function ensureRuntimeState(entry: SessionRuntimeEntry): SessionRuntimeEntry {
  return sessionRuntime.ensureRuntimeState(entry);
}

export function __getActiveSessionForTesting(sessionId: string): SessionRuntimeEntry | null {
  return sessionRuntime.get(sessionId);
}

export function __evictActiveSessionForTesting(sessionId: string): boolean {
  return sessionRuntime.evict(sessionId);
}

export function __setActiveSessionForTesting(
  sessionId: string,
  entry: SessionRuntimeEntry,
): SessionRuntimeEntry {
  return sessionRuntime.set(sessionId, entry);
}

export function __setDelegateExplorerHooksForTesting(
  hooks: DelegateExplorerTestHooks | null = null,
): void {
  setDelegateExplorerTestHooks(hooks);
}

function addSessionClient(
  sessionId: string,
  emitFn: SessionEmitEvent,
  capabilities: unknown = [],
): void {
  sessionRuntime.addClient(sessionId, emitFn, capabilities);
}

function removeSessionClient(sessionId: string, emitFn: SessionEmitEvent): void {
  sessionRuntime.removeClient(sessionId, emitFn);
}

export function broadcastEvent(sessionId: string, event: unknown): void {
  sessionRuntime.broadcast(sessionId, event);
}

export function __emitWorkspaceStateForTesting(
  sessionId: string,
  entry: SessionRuntimeEntry,
  mode: WorkspaceStateEmitMode,
): Promise<void> {
  return sessionRuntime.emitWorkspaceState(sessionId, entry, mode);
}

export function emitEventWithDowngrade(
  event: unknown,
  emitFn: SessionEmitEvent,
  capabilities: Set<string>,
): void {
  sessionRuntime.emitWithDowngrade(event, emitFn, capabilities);
}

const relayCoordinator = createRelayCoordinator({
  dispatch: (request, emitEvent, context) => handleRequest(request, emitEvent, context),
  addSessionClient,
});

const {
  handleHello,
  handlePing,
  handleListSessions,
  handleStartSession,
  handleSendUserMessage,
  handleAttachSession,
  handleGetSessionMessages,
  handleGetSessionSnapshot,
  handleSubmitApproval,
  handleCancelRun,
  handleConfigureRoleRouting,
  handleUpdateSession,
} = createCoreSessionHandlers({
  runtime: sessionRuntime,
  relay: relayCoordinator,
  runtimeVersion: VERSION,
  startedAtMs: DAEMON_STARTED_AT_MS,
  capabilities: CAPABILITIES,
  loadAndAuthSession: (request, type) => loadAndAuthSession(request, type),
});

export { handleGetSessionMessages };

function isDaemonIdle(): boolean {
  return sessionRuntime.isIdle();
}

function noteLifecycleClientConnected(): void {
  sessionRuntime.noteClientConnected();
}

function noteLifecycleClientDisconnected(): void {
  sessionRuntime.noteClientDisconnected();
}

function cancelLifecycleExit(reason: string): void {
  sessionRuntime.cancelLifecycleExit(reason);
}

function maybeScheduleLifecycleExit(): void {
  sessionRuntime.maybeScheduleLifecycleExit();
}

function noteRunSettled(): void {
  sessionRuntime.noteRunSettled();
}

function handleDrain(
  req: DaemonRequest,
  emitEvent: DaemonEmitEvent,
  context: DaemonHandlerContext | null = null,
): Promise<DaemonResponse> {
  return sessionRuntime.handleDrain(req, emitEvent, context);
}

export function __setDrainExitForTesting(fn?: (() => void) | null): void {
  sessionRuntime.setDrainExitForTesting(fn);
}

export function __setLifecycleExitForTesting(
  fn?: (() => void) | null,
  opts?: { graceMs?: number } | null,
): void {
  sessionRuntime.setLifecycleExitForTesting(fn, opts);
}

export function __setLiveConnectionsForTesting(n: number): void {
  sessionRuntime.setLiveConnectionsForTesting(n);
}

export function __setActiveRelayForTesting(
  handle?: Parameters<typeof relayCoordinator.setActiveForTesting>[0] | null,
): void {
  relayCoordinator.setActiveForTesting(handle ?? null);
}

export {
  handleDrain,
  noteRunSettled,
  isDaemonIdle,
  maybeScheduleLifecycleExit,
  cancelLifecycleExit,
};

const {
  handleRevokeDeviceToken,
  handleMintDeviceAttachToken,
  handleRevokeDeviceAttachToken,
  handleRelayEnable,
  handleRelayDisable,
  handleRelayStatus,
  handleMintRemotePairBundle,
  handleGrantSessionAttach,
  handleListAttachTokens,
  handleListDevices,
} = createDeviceAdminHandlers({
  relay: relayCoordinator,
  getWsHandle: () => activeWsHandle,
  sessions: activeSessions,
  loadSessionState,
  saveSessionState,
});

const { handleFetchDelegationEvents, handleListChildren, handleGetChildSession } =
  createChildSessionHandlers({
    runtime: sessionRuntime,
    loadAndAuthSession,
  });

const { handleSessionSummarize, handleSessionRevert, handleSessionUnrevert } =
  createSessionMaintenanceHandlers({
    runtime: sessionRuntime,
    loadAndAuthSession,
  });

const {
  handleGetDaemonRuntimeConfig,
  handleSetDaemonRuntimeConfig,
  handleListProviders,
  handleReloadConfig,
} = daemonRuntimeHandlers;

// ─── Cross-owner abort composition ───────────────────────────────

const handleAbort: DaemonHandler = async (req, emitEvent, context) => {
  const isChild = typeof req.payload?.subagentId === 'string' && req.payload.subagentId.length > 0;
  const underlying = isChild
    ? await handleCancelDelegation(req, emitEvent, context)
    : await handleCancelRun(req, emitEvent, context);
  return underlying && typeof underlying === 'object'
    ? { ...underlying, type: 'abort' }
    : underlying;
};

// ─── Request dispatcher ──────────────────────────────────────────

const HANDLERS: Record<string, DaemonHandler> = {
  hello: handleHello,
  ping: handlePing,
  list_sessions: handleListSessions,
  start_session: handleStartSession,
  send_user_message: handleSendUserMessage,
  attach_session: handleAttachSession,
  get_session_messages: handleGetSessionMessages,
  get_session_snapshot: handleGetSessionSnapshot,
  update_session: handleUpdateSession,
  submit_approval: handleSubmitApproval,
  cancel_run: handleCancelRun,
  drain: handleDrain,
  abort: handleAbort,
  configure_role_routing: handleConfigureRoleRouting,
  submit_task_graph: handleSubmitTaskGraph,
  delegate_explorer: handleDelegateExplorer,
  delegate_coder: handleDelegateCoder,
  delegate_reviewer: handleDelegateReviewer,
  delegate_deep_reviewer: handleDelegateDeepReviewer,
  cancel_delegation: handleCancelDelegation,
  fetch_delegation_events: handleFetchDelegationEvents,
  list_children: handleListChildren,
  get_child_session: handleGetChildSession,
  session_summarize: handleSessionSummarize,
  session_revert: handleSessionRevert,
  session_unrevert: handleSessionUnrevert,
  sandbox_exec: handleSandboxExec,
  sandbox_read_file: handleSandboxReadFile,
  sandbox_write_file: handleSandboxWriteFile,
  sandbox_list_dir: handleSandboxListDir,
  sandbox_diff: handleSandboxDiff,
  daemon_identify: handleDaemonIdentify,
  revoke_device_token: handleRevokeDeviceToken,
  list_devices: handleListDevices,
  mint_device_attach_token: handleMintDeviceAttachToken,
  revoke_device_attach_token: handleRevokeDeviceAttachToken,
  list_attach_tokens: handleListAttachTokens,
  relay_enable: handleRelayEnable,
  relay_disable: handleRelayDisable,
  relay_status: handleRelayStatus,
  mint_remote_pair_bundle: handleMintRemotePairBundle,
  grant_session_attach: handleGrantSessionAttach,
  get_daemon_runtime_config: handleGetDaemonRuntimeConfig,
  set_daemon_runtime_config: handleSetDaemonRuntimeConfig,
  list_providers: handleListProviders,
  reload_config: handleReloadConfig,
};

interface IncomingDaemonRequest {
  v?: unknown;
  kind?: unknown;
  requestId?: unknown;
  type?: unknown;
  sessionId?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

function asIncomingDaemonRequest(value: unknown): IncomingDaemonRequest | null {
  return value !== null && typeof value === 'object' ? (value as IncomingDaemonRequest) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export async function handleRequest(
  input: unknown,
  emitEvent: DaemonEmitEvent,
  context: DaemonHandlerContext | null = null,
): Promise<DaemonResponse> {
  const incoming = asIncomingDaemonRequest(input);
  if (!incoming || incoming.v !== PROTOCOL_VERSION) {
    return makeErrorResponse(
      typeof incoming?.requestId === 'string' && incoming.requestId
        ? incoming.requestId
        : makeRequestId(),
      typeof incoming?.type === 'string' && incoming.type ? incoming.type : 'unknown',
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Expected ${PROTOCOL_VERSION}, got ${incoming?.v}`,
    );
  }

  if (incoming.kind !== 'request') {
    return makeErrorResponse(
      typeof incoming.requestId === 'string' && incoming.requestId
        ? incoming.requestId
        : makeRequestId(),
      typeof incoming.type === 'string' && incoming.type ? incoming.type : 'unknown',
      'INVALID_REQUEST',
      `Expected kind "request", got "${incoming.kind}"`,
    );
  }

  const requestId =
    typeof incoming.requestId === 'string' && incoming.requestId
      ? incoming.requestId
      : makeRequestId();
  const requestType =
    typeof incoming.type === 'string' && incoming.type ? incoming.type : 'unknown';
  const handler = HANDLERS[requestType];
  if (!handler) {
    return makeErrorResponse(
      requestId,
      requestType,
      'UNSUPPORTED_REQUEST_TYPE',
      `Unknown request type: ${requestType}`,
    );
  }

  // Known handlers receive the original object unchanged. The dispatcher has
  // narrowed `type` above; the handler remains responsible for its payload.
  const req = incoming as DaemonRequest;

  let response: DaemonResponse;
  try {
    response = await handler(req, emitEvent, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    response = makeErrorResponse(req.requestId, req.type, 'INTERNAL_ERROR', message);
  }
  // Phase 3 slice 3: dispatcher-level audit emission for the
  // request types whose handlers don't already emit themselves.
  // The sandbox_exec / mint / revoke handlers emit at a finer
  // grain (they know exit codes / closed-connection counts), so
  // they're excluded here. Auth.upgrade is emitted in pushd-ws on
  // connection. Everything else flows through this wrapper so we
  // don't have to thread audit calls through every handler body.
  try {
    emitDispatcherAudit(req, response, context);
  } catch {
    // audit never throws into the response path
  }
  return response;
}

// ─── Connection handling ─────────────────────────────────────────

function handleConnection(socket: net.Socket): void {
  // A local client connected — count it and abort any pending lifecycle exit so
  // a transient disconnect / self-heal respawn never kills a daemon back in use.
  noteLifecycleClientConnected();
  let buffer = '';
  const attachedSessions = new Set<string>(); // track which sessions this socket is observing
  // Remember the capabilities the client most recently advertised at
  // attach-time so that a later auto-attach (start_session /
  // send_user_message on the same socket) inherits them. Without this
  // a client that sends `start_session` or `send_user_message` with
  // capabilities but no prior `attach_session` would have the
  // auto-attach register it as a v1 client, and delegation events
  // would get synthesized into `assistant_token`s even though the
  // client is v2-capable (codex P1 feedback on PR #281).
  //
  // Capabilities are pinned on the FIRST observed request that
  // carries a `capabilities` array — any request type (attach_session,
  // start_session, send_user_message). Subsequent requests with
  // capability arrays are ignored to prevent a client from flipping
  // between v1/v2 behaviour mid-connection, which would change how
  // delegation events route for clients attached via auto-attach.
  // `null` sentinel means "not yet observed"; once pinned the value
  // persists until the socket closes.
  let socketCapabilities: unknown = null;

  const emitEvent: SessionEmitEvent = (event) => {
    try {
      socket.write(JSON.stringify(event) + '\n');
    } catch {
      // connection may have closed
    }
  };

  socket.on('data', async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = asIncomingDaemonRequest(JSON.parse(line));
        if (!req) throw new Error('Request must be a JSON object');
        const payload = asRecord(req.payload);
        // Pin capabilities on first-observed request of ANY type that
        // carries a `capabilities` array. This covers:
        //   - explicit `attach_session` (the documented path)
        //   - `start_session` (first request on a fresh socket)
        //   - `send_user_message` (clients that only ever send turns)
        //   - `hello` (capability negotiation handshake)
        // The second-and-later capability arrays are ignored — pin-on-
        // first keeps the socket's classification stable for the
        // lifetime of the connection so delegation-event routing can't
        // flip mid-session.
        if (socketCapabilities === null && Array.isArray(payload?.capabilities)) {
          socketCapabilities = payload.capabilities;
        }
        const response = await handleRequest(req, emitEvent);
        socket.write(JSON.stringify(response) + '\n');

        // Track attach for cleanup on disconnect
        if (
          req.type === 'attach_session' &&
          response.ok &&
          typeof payload?.sessionId === 'string'
        ) {
          attachedSessions.add(payload.sessionId);
        }
        // Auto-attach when starting a session or sending a message
        if ((req.type === 'start_session' || req.type === 'send_user_message') && response.ok) {
          const responsePayload = asRecord(response.payload);
          const sidCandidate =
            response.sessionId || responsePayload?.sessionId || req.sessionId || payload?.sessionId;
          if (typeof sidCandidate === 'string' && sidCandidate) {
            addSessionClient(sidCandidate, emitEvent, socketCapabilities);
            attachedSessions.add(sidCandidate);
          }
        }
      } catch (err) {
        const errResponse = makeErrorResponse(
          makeRequestId(),
          'unknown',
          'INVALID_REQUEST',
          `Failed to parse request: ${err instanceof Error ? err.message : String(err)}`,
        );
        socket.write(JSON.stringify(errResponse) + '\n');
      }
    }
  });

  // close and error can both fire for one socket — decrement exactly once, then
  // re-evaluate the lifecycle exit (last client gone → arm the grace window).
  let connectionClosed = false;
  const cleanupConnection = () => {
    if (connectionClosed) return;
    connectionClosed = true;
    for (const sessionId of attachedSessions) {
      removeSessionClient(sessionId, emitEvent);
    }
    attachedSessions.clear();
    noteLifecycleClientDisconnected();
  };

  socket.on('close', cleanupConnection);
  socket.on('error', cleanupConnection);
}

// ─── Main ────────────────────────────────────────────────────────

export async function main() {
  const socketPath = getSocketPath();
  await ensureSocketDir(socketPath);
  await cleanStaleSocket(socketPath);

  // Freeze the build stamp at startup so it reflects the commit THIS process
  // loaded — captured now, before any client can connect, so the first hello
  // advertises a stamp synchronously via `peekBuildStamp()`.
  getBuildStamp().catch(() => {
    /* stamp falls back to <version>+nogit on failure; never fatal */
  });

  // Wire a file-backed ContextMemoryStore so typed memory records
  // written by task-graph node completions (see delegation-coordinator.ts)
  // persist across pushd restarts. The in-memory default would lose
  // all history on SIGTERM/restart, which defeats the "memory" in
  // typed memory. See Gap 3 Step 3 in the Architecture Remediation
  // Plan for context.
  setDefaultMemoryStore(createFileMemoryStore({ baseDir: getMemoryStoreBaseDir() }));
  // LCM Phase 3: durable verbatim log (twin of the typed store above) so the
  // full original behind a record's verbatimRef survives restarts.
  setDefaultVerbatimLog(createFileVerbatimLog({ baseDir: getVerbatimLogBaseDir() }));
  installCliEmbeddingProvider();

  const server = net.createServer(handleConnection);

  const oldUmask = process.umask(0o077);
  server.listen(socketPath, () => {
    process.umask(oldUmask);
    process.stdout.write(`pushd listening on ${socketPath}\n`);
    process.stdout.write(`protocol: ${PROTOCOL_VERSION}\n`);
    process.stdout.write(`version: ${VERSION}\n`);
    process.stdout.write(`pid: ${process.pid}\n`);
  });

  let wsHandle: PushdWsHandle | null = null;

  server.on('listening', async () => {
    try {
      await writePidFile();
      if (!isNamedPipePath(socketPath)) {
        await fs.chmod(socketPath, 0o600);
      }
    } catch {
      // non-fatal
    }

    // Optional WebSocket listener for browser clients (PR 1 of the
    // remote-sessions track). Loopback-only, token + Origin gated.
    // Dormant unless PUSHD_WS=1.
    if (isWsListenerEnabled()) {
      try {
        wsHandle = await startPushdWs(
          {
            handleRequest,
            addSessionClient,
            removeSessionClient,
            makeErrorResponse,
            makeRequestId,
            onClientConnected: noteLifecycleClientConnected,
            onClientDisconnected: noteLifecycleClientDisconnected,
          },
          { portFilePath: getPortPath() },
        );
        activeWsHandle = wsHandle;
        process.stdout.write(`pushd-ws listening on 127.0.0.1:${wsHandle.port}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`pushd-ws failed to start: ${msg}\n`);
      }
    }

    // Phase 2.e: if a relay config is persisted, dial the Worker.
    // Independent of PUSHD_WS — the relay is the OUTBOUND path,
    // PUSHD_WS gates the INBOUND loopback listener.
    //
    // Hash-allowlist hardening: rebuild the in-process allowlist from
    // the persisted attach-token store BEFORE starting the relay
    // client. The relay client's first `onOpen` fires the full
    // `relay_phone_allow` re-emit; if the registry hadn't been
    // seeded yet, that re-emit would be empty and every paired phone
    // would lose forwarding access across the restart.
    try {
      const seeded = await relayCoordinator.seedAllowlistFromAttachTokens();
      if (seeded > 0) {
        process.stdout.write(`pushd-relay allowlist seeded from ${seeded} attach token(s)\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pushd-relay allowlist seed failed: ${msg}\n`);
    }
    try {
      const relayConfig = await relayCoordinator.startPersisted();
      if (relayConfig) {
        process.stdout.write(`pushd-relay dialing ${relayConfig.deploymentUrl}\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pushd-relay startup failed: ${msg}\n`);
    }

    // Recover interrupted runs from previous crash
    try {
      await recoverInterruptedRuns();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`crash recovery failed: ${msg}\n`);
    }
  });

  const shutdown = async () => {
    process.stdout.write('\nshutting down...\n');

    // Session runtime owns active-run and approval teardown traversal.
    sessionRuntime.shutdownSessions();

    // Phase 2.e: close the outbound relay first so any in-flight
    // `relay_phone_*` envelope finishes flushing before the daemon
    // tears down the WS listener that mint/revoke hangs off.
    relayCoordinator.stop();

    if (wsHandle) {
      try {
        await wsHandle.close();
      } catch {
        /* ignore */
      }
      activeWsHandle = null;
    }

    server.close();
    await cleanStaleSocket(socketPath);
    await cleanPidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err) => {
    process.stderr.write(`Server error: ${err.message}\n`);
    process.exit(1);
  });
}

export function __handleConnectionForTesting(socket: net.Socket): void {
  return handleConnection(socket);
}

// Only run main() when executed directly (not when imported).
// Matches the entry basename `pushd` with any of the extensions we ship
// under (`.ts` via tsx for dev/tests, `.js`/`.mjs`/`.cjs` for compiled
// output produced by `npm run build:cli`). Handles POSIX (`/`) and
// Windows (`\\`) path separators so a packaged daemon binary on either
// platform still boots.
const isDirectRun =
  typeof process.argv[1] === 'string' && /[/\\]pushd\.(ts|mjs|cjs|js)$/.test(process.argv[1]);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
