#!/usr/bin/env node
// @ts-nocheck — gradual typing in progress for this large module
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
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';

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
import { createDelegationCoordinator } from './pushd/delegation-coordinator.js';
import { createDelegationExecutionAdapters } from './pushd/delegation-execution.js';
import { createSessionRuntime } from './pushd/session-runtime.js';
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

import { PROVIDER_CONFIGS, resolveApiKey, getProviderList } from './provider.js';
import { getCuratedModels } from './model-catalog.js';
import {
  getConfigPath,
  loadConfig,
  reapplyProviderConfigToEnv,
  saveConfig,
} from './config-store.js';
import {
  makeRunId,
  makeAttachToken,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  loadSessionEvents,
  rewriteMessagesLog,
  writeRunMarker,
  clearRunMarker,
  scanInterruptedSessions,
  PROTOCOL_VERSION,
} from './session-store.js';
import { compactContext, isFirstUserMessage } from './context-manager.js';
import { runAssistantTurn, DEFAULT_MAX_ROUNDS } from './engine.js';
import { DAEMON_CAPABILITIES } from '../lib/daemon-capabilities.js';
import {
  DAEMON_EXEC_MODES,
  DAEMON_WEB_SEARCH_BACKENDS,
  daemonExecModeToApprovalMode,
  normalizeDaemonExecMode,
  normalizeDaemonWebSearchBackend,
} from '../lib/daemon-runtime-settings.ts';
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

// ─── Phase 1 extractions (Pushd Decomposition Plan) ──────────────
// Implementations moved to typed modules under cli/pushd/. This file stays
// the compatibility facade: existing importers (tests, cli.ts,
// daemon-admin.ts) keep resolving these helpers through pushd.ts.
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
import { makeApprovalId, makeRequestId } from './pushd/ids.js';
import { makeErrorResponse, makeResponse } from './pushd/envelopes.js';
import {
  DEFAULT_RESTART_POLICY,
  getRestartPolicy,
  shouldRecover,
  VALID_RESTART_POLICIES,
} from './pushd/restart-policy.js';
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

// Compatibility facade for delegation/recovery slices that move in Phases 5–6.
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

export function ensureRuntimeState(entry) {
  return sessionRuntime.ensureRuntimeState(entry);
}

export function __getActiveSessionForTesting(sessionId) {
  return sessionRuntime.get(sessionId);
}

export function __evictActiveSessionForTesting(sessionId) {
  return sessionRuntime.evict(sessionId);
}

export function __setActiveSessionForTesting(sessionId, entry) {
  return sessionRuntime.set(sessionId, entry);
}

export function __setDelegateExplorerHooksForTesting(hooks = null) {
  setDelegateExplorerTestHooks(hooks);
}

function buildApprovalFn(sessionId, entry, runId) {
  return sessionRuntime.buildApprovalFn(sessionId, entry, runId);
}

function addSessionClient(sessionId, emitFn, capabilities = []) {
  sessionRuntime.addClient(sessionId, emitFn, capabilities);
}

function removeSessionClient(sessionId, emitFn) {
  sessionRuntime.removeClient(sessionId, emitFn);
}

export function broadcastEvent(sessionId, event) {
  sessionRuntime.broadcast(sessionId, event);
}

export function __emitWorkspaceStateForTesting(sessionId, entry, mode) {
  return sessionRuntime.emitWorkspaceState(sessionId, entry, mode);
}

export function emitEventWithDowngrade(event, emitFn, capabilities) {
  sessionRuntime.emitWithDowngrade(event, emitFn, capabilities);
}

function transcriptSnapshotForClientCapabilities(mirror, capabilities) {
  return sessionRuntime.transcriptSnapshotForCapabilities(mirror, capabilities);
}

function eventForClientCapabilities(event, capabilities) {
  return sessionRuntime.eventForCapabilities(event, capabilities);
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

function isDaemonIdle() {
  return sessionRuntime.isIdle();
}

function noteLifecycleClientConnected() {
  sessionRuntime.noteClientConnected();
}

function noteLifecycleClientDisconnected() {
  sessionRuntime.noteClientDisconnected();
}

function cancelLifecycleExit(reason) {
  sessionRuntime.cancelLifecycleExit(reason);
}

function maybeScheduleLifecycleExit() {
  sessionRuntime.maybeScheduleLifecycleExit();
}

function noteRunSettled() {
  sessionRuntime.noteRunSettled();
}

function handleDrain(req, emitEvent, context = null) {
  return sessionRuntime.handleDrain(req, emitEvent, context);
}

export function __setDrainExitForTesting(fn) {
  sessionRuntime.setDrainExitForTesting(fn);
}

export function __setLifecycleExitForTesting(fn, opts) {
  sessionRuntime.setLifecycleExitForTesting(fn, opts);
}

export function __setLiveConnectionsForTesting(n) {
  sessionRuntime.setLiveConnectionsForTesting(n);
}

export function __setActiveRelayForTesting(handle) {
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
    loadAndAuthSession: (request, type) => loadAndAuthSession(request, type),
  });

// ─── Request handlers ────────────────────────────────────────────

async function handleAbort(req, emitEvent, context) {
  const isChild = typeof req.payload?.subagentId === 'string' && req.payload.subagentId.length > 0;
  const underlying = isChild
    ? await handleCancelDelegation(req, emitEvent, context)
    : await handleCancelRun(req, emitEvent, context);
  return underlying && typeof underlying === 'object'
    ? { ...underlying, type: 'abort' }
    : underlying;
}

/**
 * Lazy-load + bearer-validate a session entry for composed request handlers.
 * Restores the persisted token; a legacy tokenless session is claimed only by
 * `attach_session`, so a tokenless read here is rejected — bypass is gone.
 * Returns `{ entry, sessionId }` on success or `{ error }` ready to return.
 */
async function loadAndAuthSession(req, type) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  if (!sessionId) {
    return {
      error: makeErrorResponse(req.requestId, type, 'INVALID_REQUEST', 'sessionId is required'),
    };
  }
  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return {
        error: makeErrorResponse(
          req.requestId,
          type,
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`,
        ),
      };
    }
  }
  if (!validateAttachToken(entry, providedToken)) {
    return {
      error: makeErrorResponse(
        req.requestId,
        type,
        'INVALID_TOKEN',
        'Invalid or missing attach token',
      ),
    };
  }
  return { entry, sessionId };
}

/**
 * `session_summarize` — on-demand context compaction (Addressable Session Verbs
 * phase 4; opencode's `session.summarize`). Replaces the older turns with a
 * digest, keeping the system prompt, first user turn, and the last
 * `preserveTurns` turns — the same `compactContext` the CLI `/compact` command
 * uses, now reachable as a bearer-gated daemon verb. Persists the compacted
 * transcript (`rewriteMessagesLog`, since the length-only fast path can skip a
 * same-length swap) and emits `context_compacted`. Rejected while a run is
 * active (compacting mid-run would corrupt the in-flight context).
 */
async function handleSessionSummarize(req, _emitEvent) {
  const auth = await loadAndAuthSession(req, 'session_summarize');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'session_summarize',
      'RUN_IN_PROGRESS',
      `Cannot summarize while run ${entry.activeRunId} is active`,
    );
  }

  // Strict, like the CLI `/compact`: a positive integer (or its exact digit
  // string), clamped to [1, 64]. Reject malformed input rather than coercing.
  const preserveTurns = parsePositiveIntField(req.payload?.preserveTurns, 6, 64);
  if (preserveTurns === null) {
    return makeErrorResponse(
      req.requestId,
      'session_summarize',
      'INVALID_REQUEST',
      'preserveTurns must be a positive integer',
    );
  }

  const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
  const result = compactContext(messages, { preserveTurns });

  // "Nothing to compact" is a valid no-op outcome, not an error.
  if (!result.compacted) {
    return makeResponse(req.requestId, 'session_summarize', sessionId, true, {
      compacted: false,
      preserveTurns: result.preserveTurns,
      totalTurns: result.totalTurns,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      removedCount: 0,
      compactedCount: 0,
    });
  }

  entry.state.messages = result.messages;
  const compactedPayload = {
    preserveTurns: result.preserveTurns,
    totalTurns: result.totalTurns,
    compactedMessages: result.compactedCount,
    removedCount: result.removedCount,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
  };
  await appendSessionEvent(entry.state, 'context_compacted', compactedPayload);
  // Explicit rewrite: compaction can produce a same-length messages array
  // (drop one, insert digest), which `saveSessionState`'s length-only fast path
  // would skip — leaving the on-disk transcript out of sync with memory.
  await rewriteMessagesLog(entry.state);
  // Notify live clients so an attached transcript view doesn't go stale.
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'context_compacted',
    payload: compactedPayload,
  });

  return makeResponse(req.requestId, 'session_summarize', sessionId, true, {
    compacted: true,
    preserveTurns: result.preserveTurns,
    totalTurns: result.totalTurns,
    compactedCount: result.compactedCount,
    removedCount: result.removedCount,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
  });
}

/**
 * Parse a strict positive-integer payload field (a number or its exact digit
 * string), clamped to [1, max]. Returns `null` for anything malformed —
 * matches the CLI `/compact` strictness; the handler turns `null` into an
 * INVALID_REQUEST rather than coercing bad input.
 */
function parsePositiveIntField(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = Number.parseInt(raw.trim(), 10);
  else n = Number.NaN;
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(max, n);
}

/**
 * `session_revert` — undo the last N user turns of the conversation
 * (Addressable Session Verbs phase 5; opencode's `session.revert`). Transcript
 * only: it truncates `state.messages` (and persists via `rewriteMessagesLog`)
 * and stashes the removed tail on the entry so `session_unrevert` can restore
 * it. Sandbox / git state is deliberately untouched — code rollback is a
 * separate concern with its own typed branch tools. Turn boundaries use the
 * same `isFirstUserMessage` detector as compaction. The stash accumulates
 * across consecutive reverts and is cleared by the next `send_user_message`
 * (a new message commits the fork). Bearer-gated; rejected mid-run.
 */
async function handleSessionRevert(req) {
  const auth = await loadAndAuthSession(req, 'session_revert');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'session_revert',
      'RUN_IN_PROGRESS',
      `Cannot revert while run ${entry.activeRunId} is active`,
    );
  }

  const turns = parsePositiveIntField(req.payload?.turns, 1, 1024);
  if (turns === null) {
    return makeErrorResponse(
      req.requestId,
      'session_revert',
      'INVALID_REQUEST',
      'turns must be a positive integer',
    );
  }

  const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
  const turnStarts = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isFirstUserMessage(messages[i])) turnStarts.push(i);
  }
  const totalTurns = turnStarts.length;

  if (totalTurns === 0) {
    return makeResponse(req.requestId, 'session_revert', sessionId, true, {
      reverted: false,
      removedCount: 0,
      totalTurns: 0,
      remainingTurns: 0,
    });
  }

  // Critical section: read `messages` → mutate `state.messages` + `revertedTail`
  // with NO `await` in between, so it runs atomically on Node's single-threaded
  // loop — a concurrent revert/unrevert can't interleave a read-modify-write
  // here (the first `await` below is the only yield point). Same concurrency
  // posture as every other session-mutating handler; no extra lock is taken.
  const effectiveTurns = Math.min(turns, totalTurns);
  const cutIndex = turnStarts[totalTurns - effectiveTurns];
  const removed = messages.slice(cutIndex);
  entry.state.messages = messages.slice(0, cutIndex);
  // Accumulate so `unrevert` can undo a run of consecutive reverts in order.
  entry.revertedTail = [
    ...removed,
    ...(Array.isArray(entry.revertedTail) ? entry.revertedTail : []),
  ];

  const payload = {
    turns: effectiveTurns,
    removedCount: removed.length,
    totalTurns,
    remainingTurns: totalTurns - effectiveTurns,
    remainingMessages: entry.state.messages.length,
  };
  await appendSessionEvent(entry.state, 'session_reverted', payload);
  await rewriteMessagesLog(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'session_reverted',
    payload,
  });

  return makeResponse(req.requestId, 'session_revert', sessionId, true, {
    reverted: true,
    ...payload,
    canUnrevert: true,
  });
}

/**
 * `session_unrevert` — restore the messages removed by the most recent run of
 * `session_revert`(s) (opencode's `session.unrevert`). Appends the stashed tail
 * back, persists, and clears the stash. NOTHING_TO_UNREVERT if no revert is
 * pending (e.g. a `send_user_message` already committed the fork). Bearer-gated;
 * rejected mid-run.
 */
async function handleSessionUnrevert(req) {
  const auth = await loadAndAuthSession(req, 'session_unrevert');
  if (auth.error) return auth.error;
  const { entry, sessionId } = auth;

  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'session_unrevert',
      'RUN_IN_PROGRESS',
      `Cannot unrevert while run ${entry.activeRunId} is active`,
    );
  }

  const tail = Array.isArray(entry.revertedTail) ? entry.revertedTail : [];
  if (tail.length === 0) {
    return makeErrorResponse(
      req.requestId,
      'session_unrevert',
      'NOTHING_TO_UNREVERT',
      'No reverted messages to restore (a new message may have committed the fork)',
    );
  }

  // Await-free critical section (see the note in handleSessionRevert): the
  // read→restore→clear runs atomically before the first await below.
  const restoredCount = tail.length;
  const messages = Array.isArray(entry.state?.messages) ? entry.state.messages : [];
  entry.state.messages = [...messages, ...tail];
  entry.revertedTail = null;

  const payload = { restoredCount, totalMessages: entry.state.messages.length };
  await appendSessionEvent(entry.state, 'session_unreverted', payload);
  await rewriteMessagesLog(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'session_unreverted',
    payload,
  });

  return makeResponse(req.requestId, 'session_unrevert', sessionId, true, {
    unreverted: true,
    ...payload,
  });
}

function resolveDaemonRuntimeConfigPayload(config) {
  const execMode =
    normalizeDaemonExecMode(process.env.PUSH_EXEC_MODE) ||
    normalizeDaemonExecMode(config.execMode) ||
    'auto';
  const webSearchBackend =
    normalizeDaemonWebSearchBackend(process.env.PUSH_WEB_SEARCH_BACKEND) ||
    normalizeDaemonWebSearchBackend(config.webSearchBackend) ||
    'auto';
  return {
    execMode,
    approvalMode: daemonExecModeToApprovalMode(execMode),
    webSearchBackend,
    configPath: getConfigPath(),
  };
}

/**
 * Read daemon-owned runtime controls for paired web clients. Unlike repo-mode
 * controls, these values are resolved from the daemon process itself (env first,
 * then ~/.push/config.json) because Remote turns execute on this machine, not
 * in the browser.
 */
async function handleGetDaemonRuntimeConfig(req) {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_READ_FAILED', message);
  }
  return makeResponse(
    req.requestId,
    req.type,
    null,
    true,
    resolveDaemonRuntimeConfigPayload(config),
  );
}

/**
 * Persist daemon runtime controls and update the live process env so the next
 * turn sees the new setting immediately. Accepts the Unix-socket admin
 * transport and a direct loopback WS connection — both are the operator, on
 * this machine. Refuses true relay callers: unlike a session-scoped verb, this
 * mutates the daemon's GLOBAL execution safety posture (including `yolo`,
 * which disables approval prompts) for every future turn on this daemon, not
 * just the caller's own session — a stolen/leaked Remote-pairing bearer
 * should not be able to downgrade it from across the internet.
 */
async function handleSetDaemonRuntimeConfig(req, _emitEvent, context) {
  if (context?.auth?.boundOrigin === 'relay') {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'UNSUPPORTED_VIA_TRANSPORT',
      'set_daemon_runtime_config is not available over the Remote relay — use a direct loopback connection or the Unix-socket admin transport.',
    );
  }

  const rawPatch =
    req.payload?.patch && typeof req.payload.patch === 'object' && !Array.isArray(req.payload.patch)
      ? req.payload.patch
      : req.payload && typeof req.payload === 'object' && !Array.isArray(req.payload)
        ? req.payload
        : null;
  if (!rawPatch) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      'patch must be a non-null object with optional { execMode, webSearchBackend }',
    );
  }

  const hasExecMode = Object.prototype.hasOwnProperty.call(rawPatch, 'execMode');
  const hasWebSearchBackend = Object.prototype.hasOwnProperty.call(rawPatch, 'webSearchBackend');
  if (!hasExecMode && !hasWebSearchBackend) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      'patch must include execMode or webSearchBackend',
    );
  }

  const execMode = hasExecMode ? normalizeDaemonExecMode(rawPatch.execMode) : null;
  if (hasExecMode && !execMode) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      `execMode must be one of: ${DAEMON_EXEC_MODES.join(', ')}`,
    );
  }

  const webSearchBackend = hasWebSearchBackend
    ? normalizeDaemonWebSearchBackend(rawPatch.webSearchBackend)
    : null;
  if (hasWebSearchBackend && !webSearchBackend) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'INVALID_REQUEST',
      `webSearchBackend must be one of: ${DAEMON_WEB_SEARCH_BACKENDS.join(', ')}`,
    );
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_READ_FAILED', message);
  }

  const next = { ...config };
  if (execMode) {
    next.execMode = execMode;
  }
  if (webSearchBackend) {
    next.webSearchBackend = webSearchBackend;
  }

  try {
    await saveConfig(next);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_WRITE_FAILED', message);
  }

  if (execMode) process.env.PUSH_EXEC_MODE = execMode;
  if (webSearchBackend) process.env.PUSH_WEB_SEARCH_BACKEND = webSearchBackend;

  void appendAuditEvent({
    type: 'daemon.set_runtime_config',
    ...auditProvenance(context),
    payload: {
      boundOrigin: context?.auth?.boundOrigin,
      ...(execMode ? { execMode } : {}),
      ...(webSearchBackend ? { webSearchBackend } : {}),
    },
  });

  return makeResponse(req.requestId, req.type, null, true, resolveDaemonRuntimeConfigPayload(next));
}

/**
 * Read-only catalog of providers this daemon can route to, with curated
 * models per provider. Powers Remote's model picker — the web
 * client has no other way to know what's actually configured on THIS
 * machine (which providers have a working key, what models to offer)
 * versus its own browser-local provider config, which is irrelevant to a
 * daemon-executed turn. Safe over relay: `hasKey` is a boolean, never the
 * key itself (mirrors `getProviderList`'s own posture).
 */
async function handleListProviders(req) {
  const providers = getProviderList().map((p) => ({
    ...p,
    models: getCuratedModels(p.id),
  }));
  return makeResponse(req.requestId, req.type, null, true, { providers });
}

/**
 * Re-read `~/.push/config.json` and force its provider keys/urls/models into
 * the daemon's `process.env`, overwriting stale values. The TUI fires this
 * after a config edit (e.g. rotating a provider API key): the daemon resolves
 * keys live from `process.env` per run (`resolveApiKey`), but inherited its env
 * at spawn, so without this a long-lived daemon keeps serving the old key while
 * `config.json` already shows the new one. No values cross the wire — the verb
 * only triggers a re-read of the local on-disk file, so it's safe over relay.
 */
async function handleReloadConfig(req) {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event: 'pushd_config_reload_failed', message })}\n`,
    );
    return makeErrorResponse(req.requestId, req.type, 'CONFIG_READ_FAILED', message);
  }
  const refreshed = reapplyProviderConfigToEnv(config);
  process.stderr.write(
    `${JSON.stringify({
      level: 'info',
      event: 'pushd_config_reloaded',
      refreshedCount: refreshed.length,
      // env var NAMES only (e.g. PUSH_ZEN_API_KEY) — never the secret values.
      refreshed,
    })}\n`,
  );
  return makeResponse(req.requestId, req.type, null, true, { refreshed });
}

// ─── Request dispatcher ──────────────────────────────────────────

const HANDLERS = {
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

export async function handleRequest(req, emitEvent, context = null) {
  if (!req || req.v !== PROTOCOL_VERSION) {
    return makeErrorResponse(
      req?.requestId || makeRequestId(),
      req?.type || 'unknown',
      'UNSUPPORTED_PROTOCOL_VERSION',
      `Expected ${PROTOCOL_VERSION}, got ${req?.v}`,
    );
  }

  if (req.kind !== 'request') {
    return makeErrorResponse(
      req.requestId || makeRequestId(),
      req.type || 'unknown',
      'INVALID_REQUEST',
      `Expected kind "request", got "${req.kind}"`,
    );
  }

  const handler = HANDLERS[req.type];
  if (!handler) {
    return makeErrorResponse(
      req.requestId,
      req.type,
      'UNSUPPORTED_REQUEST_TYPE',
      `Unknown request type: ${req.type}`,
    );
  }

  let response;
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

function handleConnection(socket) {
  // A local client connected — count it and abort any pending lifecycle exit so
  // a transient disconnect / self-heal respawn never kills a daemon back in use.
  noteLifecycleClientConnected();
  let buffer = '';
  const attachedSessions = new Set(); // track which sessions this socket is observing
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
  let socketCapabilities = null;

  const emitEvent = (event) => {
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
        const req = JSON.parse(line);
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
        if (socketCapabilities === null && Array.isArray(req.payload?.capabilities)) {
          socketCapabilities = req.payload.capabilities;
        }
        const response = await handleRequest(req, emitEvent);
        socket.write(JSON.stringify(response) + '\n');

        // Track attach for cleanup on disconnect
        if (req.type === 'attach_session' && response.ok) {
          attachedSessions.add(req.payload?.sessionId);
        }
        // Auto-attach when starting a session or sending a message
        if ((req.type === 'start_session' || req.type === 'send_user_message') && response.ok) {
          const sid =
            response.sessionId ||
            response.payload?.sessionId ||
            req.sessionId ||
            req.payload?.sessionId;
          if (sid) {
            addSessionClient(sid, emitEvent, socketCapabilities);
            attachedSessions.add(sid);
          }
        }
      } catch (err) {
        const errResponse = makeErrorResponse(
          makeRequestId(),
          'unknown',
          'INVALID_REQUEST',
          `Failed to parse request: ${err.message}`,
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

// ─── Crash recovery ──────────────────────────────────────────────

/**
 * Scan for sessions with run markers (interrupted by daemon crash).
 * For each, check restart policy and optionally re-enter the assistant loop.
 *
 * Recovery injects a [SESSION_RECOVERED] reconciliation message so the model
 * knows context was interrupted and can adjust.
 */
async function recoverInterruptedRuns() {
  let interrupted;
  try {
    interrupted = await scanInterruptedSessions();
  } catch {
    return; // scan failure is non-fatal
  }

  if (interrupted.length === 0) return;
  process.stdout.write(`crash recovery: found ${interrupted.length} interrupted session(s)\n`);

  for (const { sessionId, marker } of interrupted) {
    let state;
    try {
      state = await loadSessionState(sessionId);
    } catch {
      // Can't load state — clear stale marker and skip
      await clearRunMarker(sessionId).catch(() => {});
      process.stdout.write(`  ${sessionId}: state unreadable, clearing marker\n`);
      continue;
    }

    const policy = getRestartPolicy(state);
    if (!shouldRecover(policy, marker)) {
      await clearRunMarker(sessionId).catch(() => {});
      const reason = policy === 'never' ? 'policy=never' : 'marker too old';
      process.stdout.write(`  ${sessionId}: skipped (${reason})\n`);

      // Log that we skipped recovery
      await appendSessionEvent(state, 'recovery_skipped', {
        originalRunId: marker.runId,
        reason,
        policy,
        markerAge: Date.now() - (marker.startedAt || 0),
      }).catch(() => {});
      await saveSessionState(state).catch(() => {});
      continue;
    }

    // Resolve provider + API key
    const providerConfig = PROVIDER_CONFIGS[state.provider];
    if (!providerConfig) {
      await clearRunMarker(sessionId).catch(() => {});
      process.stdout.write(
        `  ${sessionId}: unknown provider "${state.provider}", clearing marker\n`,
      );
      continue;
    }

    let apiKey;
    try {
      apiKey = resolveApiKey(providerConfig);
    } catch {
      await clearRunMarker(sessionId).catch(() => {});
      process.stdout.write(`  ${sessionId}: no API key for "${state.provider}", clearing marker\n`);
      continue;
    }

    const recoveryRunId = makeRunId();
    const abortController = new AbortController();
    // Restore the persisted attach token so a client that had the session
    // open before the crash can successfully re-attach with the SAME token
    // they originally received from `start_session`. A legacy session with no
    // persisted token is claimed on its first `attach_session` (bootstrap
    // grace); the implicit tokenless bypass is gone (Universal Session Bearer).
    const attachToken = state.attachToken;

    // Register in-memory
    const entry = { state, attachToken, activeRunId: recoveryRunId, abortController };
    activeSessions.set(sessionId, entry);

    // Crash recovery is narrow: we recover the parent only. Any sub-agents or
    // task graphs that were in-flight when the daemon died are lost. Detect
    // them from the event log and fold a DELEGATION_INTERRUPTED note into the
    // recovery turn so the recovered lead re-delegates rather than waiting on
    // ghost completions that will never arrive.
    let orphans = { subagents: [], graphs: [] };
    try {
      const events = await loadSessionEvents(sessionId);
      orphans = collectOrphanedDelegations(events, marker.runId);
    } catch {
      // Event-log scan is best-effort — if we can't read it, skip the note.
    }
    const interruptedNote = formatDelegationInterruptedNote(orphans);

    // Inject reconciliation as a SINGLE recovery turn — the kernel lane runs it
    // as the lead's `userText`, so the recovery note + the interrupted note must
    // be one message (a second would render as clipped "prior conversation"
    // rather than the task).
    const recoveryUserText = [
      `[SESSION_RECOVERED]\nThe previous run (${marker.runId}) was interrupted by a daemon crash.\nYou are resuming in a new run (${recoveryRunId}). Review your working memory and continue where you left off.\nDo NOT restart from scratch — pick up from the last completed step.\n[/SESSION_RECOVERED]`,
      interruptedNote,
    ]
      .filter(Boolean)
      .join('\n\n');
    state.messages.push({ role: 'user', content: recoveryUserText });
    if (interruptedNote) {
      await appendSessionEvent(state, 'delegation_interrupted', {
        originalRunId: marker.runId,
        recoveryRunId,
        subagents: orphans.subagents,
        graphs: orphans.graphs,
      }).catch(() => {});
    }

    await appendSessionEvent(state, 'run_recovered', {
      originalRunId: marker.runId,
      recoveryRunId,
      policy,
      markerAge: Date.now() - (marker.startedAt || 0),
    }).catch(() => {});

    process.stdout.write(`  ${sessionId}: recovering run ${marker.runId} → ${recoveryRunId}\n`);

    // Clear old marker and write new one for the recovery run
    await clearRunMarker(sessionId).catch(() => {});
    await writeRunMarker(sessionId, recoveryRunId, {
      provider: state.provider,
      model: state.model,
      cwd: state.cwd,
      recoveredFrom: marker.runId,
    }).catch(() => {});

    // Build approval gate so recovered runs can request client approvals
    const approvalFn = buildApprovalFn(sessionId, entry, recoveryRunId);

    // Launch recovery run in background (same pattern as handleSendUserMessage)
    (async () => {
      let sawError = false;
      let sawRunComplete = false;
      try {
        await runAssistantTurn(
          state,
          providerConfig,
          apiKey,
          recoveryUserText,
          DEFAULT_MAX_ROUNDS,
          {
            runId: recoveryRunId,
            // Fixed cap on daemon turns — see handleSendUserMessage; adaptation
            // stays off until the client cap is threaded through the daemon.
            explicitMaxRounds: true,
            approvalFn,
            signal: abortController.signal,
            emit: (event) => {
              const seq = state.eventSeq;
              if (event.type === 'error') sawError = true;
              if (event.type === 'run_complete') sawRunComplete = true;

              broadcastEvent(sessionId, {
                v: PROTOCOL_VERSION,
                kind: 'event',
                sessionId: event.sessionId,
                runId: event.runId,
                seq,
                ts: Date.now(),
                type: event.type,
                payload: event.payload,
              });
            },
          },
        );
        await saveSessionState(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!sawError) {
          await appendSessionEvent(
            state,
            'error',
            { code: 'RECOVERY_ERROR', message, retryable: false },
            recoveryRunId,
          ).catch(() => {});
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            runId: recoveryRunId,
            seq: state.eventSeq,
            ts: Date.now(),
            type: 'error',
            payload: { code: 'RECOVERY_ERROR', message, retryable: false },
          });
        }
        if (!sawRunComplete) {
          await appendSessionEvent(
            state,
            'run_complete',
            { runId: recoveryRunId, outcome: 'failed', summary: message.slice(0, 500) },
            recoveryRunId,
          ).catch(() => {});
          broadcastEvent(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            runId: recoveryRunId,
            seq: state.eventSeq,
            ts: Date.now(),
            type: 'run_complete',
            payload: { outcome: 'failed', summary: message.slice(0, 500) },
          });
        }
        await saveSessionState(state).catch(() => {});
      } finally {
        entry.activeRunId = null;
        entry.abortController = null;
        if (entry.pendingApproval) {
          clearTimeout(entry.pendingApproval.timer);
          entry.pendingApproval = null;
        }
        clearRunMarker(sessionId).catch(() => {});
      }
    })();
  }
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

export function __handleConnectionForTesting(socket) {
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
