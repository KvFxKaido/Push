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
import { randomBytes } from 'node:crypto';

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
import { createDelegationExecutionAdapters } from './pushd/delegation-execution.js';
import { createSessionRuntime } from './pushd/session-runtime.js';

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
import { createDaemonProviderStream } from './daemon-provider-stream.js';
import { TOOL_PROTOCOL, READ_ONLY_TOOL_PROTOCOL } from './tools.js';
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
import { runExplorerAgent } from '../lib/explorer-agent.ts';
import { runCoderAgent } from '../lib/coder-agent.ts';
import { cliProviderModelSupportsNativeToolCalling } from './native-tool-gate.js';
import {
  getCliNativeToolSchemas,
  getCliReadOnlyNativeToolSchemas,
} from './tool-function-schemas.js';
import { RUN_TOKEN_BUDGET_ENV_VAR, resolveRunTokenBudget } from '../lib/run-cost-budget.ts';
import { runReviewer } from '../lib/reviewer-agent.ts';
import { runDeepReviewer } from '../lib/deep-reviewer-agent.ts';
import { buildReviewerContextBlock } from '../lib/role-context.ts';
import {
  capReviewGuidanceLines,
  REVIEW_GUIDANCE_FILENAME,
  resolveReviewGuidance,
} from '../lib/review-guidance.ts';
import { validateTaskGraph, executeTaskGraph, formatTaskGraphResult } from '../lib/task-graph.ts';
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
import { resolveWorkspaceIdentity } from '../lib/workspace-identity.js';
import { buildTypedMemoryBlockForNode, writeTaskGraphResultMemory } from './task-graph-memory.ts';
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

// ─── Session runtime composition (Phase 4) ────────────────────────

const sessionRuntime = createSessionRuntime({
  isRelayRunning: () => relayCoordinator.isRunning(),
});

// Compatibility facade for delegation/recovery slices that move in Phases 5–6.
// The runtime owns the Map; pushd only retains a temporary reference.
const activeSessions = sessionRuntime.sessions;

const { makeDaemonCoderToolExec, makeDaemonExplorerToolExec, emitRoleAgentRunEvent } =
  createDelegationExecutionAdapters(sessionRuntime);

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

// Test-only seam for deterministic delegate_explorer race coverage.
const delegateExplorerTestHooks = {
  beforeTerminalClaim: null,
  afterTerminalDecision: null,
};

export function __setDelegateExplorerHooksForTesting(hooks = null) {
  delegateExplorerTestHooks.beforeTerminalClaim = hooks?.beforeTerminalClaim || null;
  delegateExplorerTestHooks.afterTerminalDecision = hooks?.afterTerminalDecision || null;
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

// ─── Task graph / delegation scaffolds ──────────────────────────

/**
 * Resolve {provider, model} for a given role on an active session.
 * Honours configure_role_routing entries; falls back to session defaults.
 * Throws an Error with a descriptive message if nothing usable is available.
 */
function resolveRoleRouting(entry, role) {
  const routeEntry = entry.state.roleRouting?.[role];
  const routedProvider = normalizeProviderInput(routeEntry?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    throw new Error(`Unknown provider "${routedProvider}" for ${role} role routing`);
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    throw new Error(`Unknown provider "${sessionProvider || '(missing)'}" in session state`);
  }
  const provider = routedProvider || sessionProvider;
  const model =
    (typeof routeEntry?.model === 'string' && routeEntry.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[provider].defaultModel;
  return { provider, model };
}

// ─── Shared tool-call detector compatibility facade ────────────

/**
 * Wrap a raw CLI tool call (`{ tool, args }`) into the nested shape
 * the lib Coder kernel reads: `{ call: { tool, args } }`. The kernel
 * does a structural cast and reaches for `toolCall.call.tool` /
 * `toolCall.call.args` in both the parallel-reads and single-call
 * branches (`lib/coder-agent.ts` around lines 1437 and 1760). If we
 * hand the kernel a raw flat call, accessing `.call.tool` throws a
 * runtime TypeError and the delegation fails on the first tool turn
 * (codex P1 feedback on PR #282). The `source: 'cli'` tag is a hint
 * to future log inspectors but the kernel itself ignores it.
 *
 * The wrapper + the `DetectedToolCalls` classifier moved to
 * `cli/lead-turn.ts` so the daemon's delegated nodes and the lead-kernel
 * lane (§10 step 2) share one implementation. Re-exported here so
 * existing test imports (`cli/tests/daemon-integration.test.mjs`) keep
 * resolving against pushd.
 */
import {
  wrapCliDetectAllToolCalls,
  wrapCliDetectAnyToolCall,
  wrapCliDetectNativeToolCalls,
} from './lead-turn.js';
export { wrapCliDetectAllToolCalls, wrapCliDetectAnyToolCall, wrapCliDetectNativeToolCalls };

/**
 * Task-graph Explorer node invocation — wires `runExplorerAgent` from
 * `lib/explorer-agent.ts` to the real daemon tool executor
 * (`makeDaemonExplorerToolExec`) so explorer nodes actually read the
 * workspace instead of running against a stub. Mirrors
 * `runCoderForTaskGraph` structurally but without approval gating
 * (Explorer is read-only) and with the simpler `{ resultText }`
 * executor return shape.
 *
 * Used only for task-graph explorer nodes; the direct
 * `delegate_explorer` RPC path still goes through
 * `handleDelegateExplorer` for its race-safe terminal-claim
 * semantics — both call sites share the same `makeDaemonExplorerToolExec`
 * factory.
 */

async function runExplorerForTaskGraph(sessionId, entry, node, signal, preambleExtras = []) {
  const startedAt = Date.now();
  const { provider, model } = resolveRoleRouting(entry, 'explorer');
  const toolExec = makeDaemonExplorerToolExec({ entry, signal });
  const evaluateAfterModel = async () => null;
  const daemonStream = createDaemonProviderStream(provider, sessionId);
  const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(provider, model)
    ? getCliReadOnlyNativeToolSchemas()
    : undefined;

  // Splice graph-internal memory (from executeTaskGraph's
  // enrichedContext) and typed-memory retrieval blocks into the
  // task preamble. The model sees them as part of the task
  // description, separated by blank lines — matches how web's
  // role-memory-context.appendRetrievedMemoryBlock concatenates.
  const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

  const result = await runExplorerAgent(
    {
      provider,
      stream: daemonStream,
      modelId: model,
      sandboxId: null,
      allowedRepo: '',
      userProfile: null,
      taskPreamble,
      symbolSummary: null,
      toolExec,
      detectAllToolCalls: wrapCliDetectAllToolCalls,
      detectNativeToolCalls: wrapCliDetectNativeToolCalls,
      detectAnyToolCall: wrapCliDetectAnyToolCall,
      webSearchToolProtocol: '',
      // `sandboxToolProtocol` replaces the kernel's default
      // `EXPLORER_TOOL_PROTOCOL` block (which advertises web-side
      // public names like `read` / `repo_read` / `search`) with the
      // CLI-named read-only subset (`read_file` / `list_dir` /
      // `search_files` / …). Without this override the model emits
      // tool calls our detector can't recognize and every round
      // silently fails to execute anything (codex + Copilot P1 on
      // PR #284).
      sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
      nativeToolSchemas,
      evaluateAfterModel,
    },
    {
      onStatus: () => {},
      signal,
      // Forward the per-delegation prompt snapshot onto the daemon
      // event stream so a connected client (TUI / CLI / relay
      // consumer) sees the same audit trail the web orchestrator
      // already emits per turn. `appendSessionEvent` manages
      // persistence + seq; `broadcastEvent` fans out to live
      // listeners using the same envelope shape as the rest of the
      // daemon's emit sites.
      //
      // Seq capture: `appendSessionEvent` increments `state.eventSeq`
      // synchronously before its filesystem await resolves, so we read
      // the seq IMMEDIATELY after starting the append. Reading it
      // inside `.then()` would race with concurrent emits (e.g.
      // task-graph `task_completed`) that bump `eventSeq` before this
      // promise resolves, causing the live envelope to reuse a later
      // seq than the persisted record. Codex P2 on PR #540.
      //
      // Error handling: if the filesystem append fails the broadcast
      // is skipped — sending a live envelope that has no persisted
      // counterpart would diverge the journal from the wire.
      onRunEvent: emitRoleAgentRunEvent(sessionId, entry, null),
    },
  );

  const delegationOutcome = {
    agent: 'explorer',
    status: result.hitRoundCap ? 'incomplete' : 'complete',
    summary: result.summary,
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: result.hitRoundCap
      ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
      : null,
    rounds: result.rounds,
    checkpoints: 0,
    elapsedMs: Date.now() - startedAt,
  };

  return {
    summary: result.summary,
    delegationOutcome,
    rounds: result.rounds,
  };
}

/**
 * Task-graph Coder node invocation — wires `runCoderAgent` from
 * `lib/coder-agent.ts` to the real daemon tool executor.
 *
 * Mirrors `runExplorerForTaskGraph` structurally, but plugs in
 * `makeDaemonCoderToolExec` (production tool surface + approval gating)
 * and `wrapCliDetect*` (real detectors over `cli/tools.ts`) instead of
 * stubs. The LLM streams real tokens, tool calls are detected, and
 * `executeToolCall` runs them against `entry.state.cwd` — this is the
 * full-fat daemon Coder path.
 *
 * Approval events from tool calls emit on the `parentRunId` passed in
 * by `handleSubmitTaskGraph`, so a task-graph client that's attached
 * to the session sees approval prompts routed through the parent run's
 * stream (the task graph is part of the parent's work — this matches
 * the semantic the synthetic-downgrade path relies on for v1 clients).
 *
 * Coder-specific option fields that don't apply to a daemon run are
 * filled with null/empty defaults so the kernel's branches short-circuit:
 *   - `sandboxId: ''`               — no sandbox layer; runs against `cwd`
 *   - `sandboxToolProtocol: ''`     — prompt block supplied by tool detectors
 *   - `verificationPolicyBlock: null` — no daemon-side verification policy yet
 *   - `approvalModeBlock: null`     — approval gating happens inside `toolExec`
 *
 * Acceptance criteria / harness overrides are omitted so the kernel's
 * defaults apply (no criteria, no context resets, default round cap).
 */
async function runCoderForTaskGraph(
  sessionId,
  entry,
  node,
  parentRunId,
  signal,
  preambleExtras = [],
) {
  const startedAt = Date.now();
  const { provider, model } = resolveRoleRouting(entry, 'coder');
  const daemonStream = createDaemonProviderStream(provider, sessionId);
  const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(provider, model)
    ? getCliNativeToolSchemas()
    : undefined;
  // `parentRunId` can be null when `submit_task_graph` is called on a
  // session with no active run AND no `parentRunId` payload override.
  // `buildApprovalFn` would emit `approval_required` events with
  // `runId: null` on the wire envelope, which violates the
  // protocol-schema strict-mode rule that `runId` must be omitted or
  // a non-empty string (codex P1 on PR #282). Mint a fresh child run
  // id for the task-graph node in that case so approval events still
  // carry a valid runId, even if no client is specifically listening
  // for this execution's run.
  const effectiveRunId =
    typeof parentRunId === 'string' && parentRunId.trim().length > 0 ? parentRunId : makeRunId();
  const toolExec = makeDaemonCoderToolExec({
    sessionId,
    entry,
    runId: effectiveRunId,
    signal,
  });
  const evaluateAfterModel = async () => null;

  const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

  const result = await runCoderAgent(
    {
      provider,
      stream: daemonStream,
      modelId: model,
      // Daemon task-graph node: a delegated implementer, not the lead.
      persona: 'coder',
      sandboxId: '',
      allowedRepo: '',
      userProfile: null,
      taskPreamble,
      symbolSummary: null,
      toolExec,
      detectAllToolCalls: wrapCliDetectAllToolCalls,
      detectNativeToolCalls: wrapCliDetectNativeToolCalls,
      detectAnyToolCall: wrapCliDetectAnyToolCall,
      webSearchToolProtocol: '',
      // `sandboxToolProtocol` is the tool-instruction block the kernel
      // splices into its system prompt — without it the model has no
      // guidance on what tool-call JSON to emit (codex P1 on PR #282).
      // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
      // non-delegated CLI engine uses.
      sandboxToolProtocol: TOOL_PROTOCOL,
      nativeToolSchemas,
      verificationPolicyBlock: null,
      approvalModeBlock: null,
      evaluateAfterModel,
      // Per-run token budget for this daemon task-graph Coder node. Resolved
      // from env (config is forwarded to `PUSH_RUN_TOKEN_BUDGET` by
      // `applyConfigToEnv`); null (uncapped) maps to undefined for the kernel.
      harnessTokenBudget:
        resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
    },
    {
      onStatus: () => {},
      signal,
      onRunEvent: emitRoleAgentRunEvent(sessionId, entry, parentRunId ?? null),
    },
  );

  const delegationOutcome = {
    agent: 'coder',
    // Runs that return from `runCoderAgent` without throwing have made
    // it through the kernel's loop. The kernel itself doesn't classify
    // "complete vs incomplete"; that's a delegation-outcome concern.
    // We default to 'complete' on a clean return — any structural
    // failure (thrown error) lands in the catch block in the caller
    // and marks the outcome 'inconclusive'. A richer classifier that
    // inspects working memory + acceptance criteria is a follow-up.
    status: 'complete',
    summary: result.summary,
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: null,
    rounds: result.rounds,
    checkpoints: result.checkpoints,
    elapsedMs: Date.now() - startedAt,
  };

  return {
    summary: result.summary,
    delegationOutcome,
    rounds: result.rounds,
  };
}

async function handleSubmitTaskGraph(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const graph = req.payload?.graph;
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.tasks)) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_REQUEST',
      'graph.tasks must be an array of task nodes',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'submit_task_graph',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const validationErrors = validateTaskGraph(graph.tasks);
  if (validationErrors.length > 0) {
    return makeErrorResponse(
      req.requestId,
      'submit_task_graph',
      'INVALID_TASK_GRAPH',
      validationErrors.map((e) => `${e.type}: ${e.message}`).join('; '),
    );
  }

  ensureRuntimeState(entry);

  const executionId = `graph_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const nodeCount = graph.tasks.length;

  entry.activeGraphs.set(executionId, {
    executionId,
    parentRunId,
    abortController,
    startedAt,
    nodeCount,
  });

  const ack = makeResponse(req.requestId, 'submit_task_graph', sessionId, true, {
    executionId,
    accepted: true,
    nodeCount,
  });

  // Background execution — RPC has already acked. Events flow through
  // appendSessionEvent + broadcastEvent as lib/task-graph makes progress.
  (async () => {
    // Index nodes by id so onProgress can recover the agent kind from taskId.
    const nodesById = new Map();
    for (const node of graph.tasks) nodesById.set(node.id, node);

    // Serialize task-graph progress writes through a per-session promise
    // chain. `executeTaskGraph` calls `onProgress` synchronously, and with
    // parallel explorer nodes (max 3) multiple progress callbacks can fire
    // in quick succession. Without serialization, concurrent
    // `appendSessionEvent` calls race on `state.eventSeq` — the field is
    // mutated *before* the filesystem append resolves, so overlapping calls
    // can (a) write events to `events.jsonl` out of seq order and
    // (b) read a seq value for the broadcast envelope that has already been
    // bumped by a later write. `attach_session` replays from disk in file
    // order, so misordering would surface on any reconnect.
    let emitChain = Promise.resolve();
    const emitTaskGraphEvent = (type, payload) => {
      const runIdField = parentRunId ? { runId: parentRunId } : {};
      const chained = emitChain.then(async () => {
        // Pass `parentRunId` (possibly null) through to appendSessionEvent;
        // session-store already omits `runId` from the persisted envelope
        // when the argument is falsy, so the on-disk record stays consistent
        // with the wire envelope built below.
        await appendSessionEvent(entry.state, type, payload, parentRunId).catch(() => {});
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          ...runIdField,
          seq: entry.state.eventSeq,
          ts: Date.now(),
          type,
          payload,
        });
      });
      emitChain = chained.catch(() => {});
      return chained;
    };

    const onProgress = (evt) => {
      if (evt.type === 'graph_complete') {
        // Final graph_completed event is emitted explicitly below with
        // richer metadata (success/aborted/counters) from the result object.
        return;
      }
      const node = evt.taskId ? nodesById.get(evt.taskId) : null;
      const agent = node?.agent || 'explorer';
      switch (evt.type) {
        case 'task_ready':
          emitTaskGraphEvent('task_graph.task_ready', {
            executionId,
            taskId: evt.taskId,
            agent,
            detail: evt.detail,
          });
          return;
        case 'task_started':
          emitTaskGraphEvent('task_graph.task_started', {
            executionId,
            taskId: evt.taskId,
            agent,
            detail: evt.detail,
          });
          return;
        case 'task_completed':
          emitTaskGraphEvent('task_graph.task_completed', {
            executionId,
            taskId: evt.taskId,
            agent,
            summary: evt.detail || '',
            elapsedMs: evt.elapsedMs,
          });
          return;
        case 'task_failed':
          emitTaskGraphEvent('task_graph.task_failed', {
            executionId,
            taskId: evt.taskId,
            agent,
            error: evt.detail || 'Task failed',
            elapsedMs: evt.elapsedMs,
          });
          return;
        case 'task_cancelled':
          emitTaskGraphEvent('task_graph.task_cancelled', {
            executionId,
            taskId: evt.taskId,
            agent,
            reason: evt.detail || 'Task cancelled',
            elapsedMs: evt.elapsedMs,
          });
          return;
        default:
          return;
      }
    };

    // Resolve workspace identity once per graph — branch could move
    // during a long-running graph if a Coder node commits or
    // switches branches, but for the scope of this graph the
    // identity captured here is used as the memory scope for all
    // retrievals + writes. This matches how web uses a single
    // branchInfoRef snapshot per delegation (useAgentDelegation.ts).
    // resolveWorkspaceIdentity is non-throwing by contract (errors
    // become path.basename(cwd) / null fallbacks internally), so no
    // outer catch needed.
    const workspaceIdentity = await resolveWorkspaceIdentity(entry.state.cwd);
    // chatId deliberately omitted from the scope: pushd's sessionId is
    // per-invocation for headless flows, and even attached sessions
    // wouldn't benefit from chatId-narrowing memory across the
    // workspace. Codex P1 review on PR #333.
    const graphMemoryScope = {
      repoFullName: workspaceIdentity.repoFullName,
      branch: workspaceIdentity.branch ?? undefined,
      taskGraphId: executionId,
    };

    const executor = async (node, enrichedContext, signal) => {
      // Retrieve typed memory scoped to this node. Splice it
      // alongside the graph-internal memory (`enrichedContext`
      // from lib/task-graph.ts, containing `[TASK_GRAPH_MEMORY]`
      // summaries of completed dependency + sibling nodes) into
      // the node's taskPreamble. Retrieval failures return null
      // and the node runs with just the graph-internal memory —
      // graceful degradation.
      const retrievedBlock = await buildTypedMemoryBlockForNode({
        node,
        scope: graphMemoryScope,
      });
      const preambleExtras = [
        ...(enrichedContext ?? []),
        ...(retrievedBlock ? [retrievedBlock] : []),
      ];

      if (node.agent === 'explorer') {
        return runExplorerForTaskGraph(sessionId, entry, node, signal, preambleExtras);
      }
      if (node.agent === 'coder') {
        return runCoderForTaskGraph(sessionId, entry, node, parentRunId, signal, preambleExtras);
      }
      throw new Error(`Unsupported task-graph agent: ${node.agent}`);
    };

    let result;
    let execError = null;
    try {
      result = await executeTaskGraph(graph.tasks, executor, {
        signal: abortController.signal,
        onProgress,
      });
    } catch (err) {
      // executeTaskGraph normally does not throw (cancellation surfaces via
      // aborted=true), but defensively emit a terminal event so clients are
      // never left waiting on a silent graph.
      execError = err instanceof Error ? err : new Error(String(err));
    }

    const completedPayload = result
      ? {
          executionId,
          summary: formatTaskGraphResult(result),
          success: result.success,
          aborted: result.aborted,
          nodeCount,
          totalRounds: result.totalRounds,
          wallTimeMs: result.wallTimeMs,
        }
      : {
          executionId,
          summary: `Task graph crashed: ${execError?.message ?? 'unknown error'}`,
          success: false,
          aborted: false,
          nodeCount,
          totalRounds: 0,
          wallTimeMs: Date.now() - startedAt,
        };

    // Persist typed memory for each completed node before emitting
    // graph_completed so later runs can retrieve prior findings +
    // outcomes. Writes are error-isolated — a failure for one node
    // logs and continues, never blocking the completion event.
    // Reuses `graphMemoryScope` already resolved above so we don't
    // invoke git twice per graph.
    if (result) {
      try {
        await writeTaskGraphResultMemory(result, graphMemoryScope);
      } catch (err) {
        // Belt-and-braces — writeTaskGraphResultMemory is
        // error-isolated per-node, so a throw at this level means
        // something went wrong before the loop (e.g., an
        // unexpected store-initialization failure).
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${JSON.stringify({
            level: 'warn',
            event: 'task_graph_memory_persist_failed',
            executionId,
            error: msg,
          })}\n`,
        );
      }
    }

    await emitTaskGraphEvent('task_graph.graph_completed', completedPayload);
    entry.activeGraphs.delete(executionId);
    await saveSessionState(entry.state).catch(() => {});
  })();

  return ack;
}

async function handleCancelDelegation(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const subagentId = req.payload?.subagentId;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!subagentId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'INVALID_REQUEST',
      'subagentId is required',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'cancel_delegation',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  ensureRuntimeState(entry);
  const delegation = entry.activeDelegations.get(subagentId);

  // If the id doesn't map to an active delegation, treat it as a task-graph
  // executionId. We reuse cancel_delegation here so v2 task-graph clients
  // don't need a new RPC just to abort a graph.
  if (!delegation) {
    const graph = entry.activeGraphs.get(subagentId);
    if (graph) {
      if (graph.abortController) graph.abortController.abort();
      // The background executor loop observes `signal.aborted`, drives each
      // running node to a `task_graph.task_cancelled` event, and emits the
      // final `task_graph.graph_completed` with aborted=true before removing
      // the entry from activeGraphs.
      return makeResponse(req.requestId, 'cancel_delegation', sessionId, true, {
        accepted: true,
        kind: 'task_graph',
        executionId: subagentId,
      });
    }
    return makeErrorResponse(
      req.requestId,
      'cancel_delegation',
      'DELEGATION_NOT_FOUND',
      `No active delegation with subagentId: ${subagentId}`,
      false,
    );
  }

  if (delegation.abortController) {
    delegation.abortController.abort();
  }
  entry.activeDelegations.delete(subagentId);

  const childRunId = typeof delegation.childRunId === 'string' ? delegation.childRunId : null;
  const parentRunId = typeof delegation.parentRunId === 'string' ? delegation.parentRunId : null;
  const agent = delegation.agent || delegation.role || 'subagent';
  const message = 'Cancelled by client';
  const eventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    ...(childRunId ? { childRunId } : {}),
    agent,
    role: delegation.role || agent,
    error: message,
    errorDetails: { code: 'CANCELLED', message, retryable: false },
  };
  await appendSessionEvent(entry.state, 'subagent.failed', eventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.failed',
    payload: eventPayload,
  });

  return makeResponse(req.requestId, 'cancel_delegation', sessionId, true, {
    accepted: true,
  });
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

// ─── Delegate Explorer (scaffold + real lib-kernel integration) ─

/**
 * `delegate_explorer` — daemon-side Explorer launch.
 *
 * Wires the full delegate_explorer RPC path from handler → runExplorerAgent
 * (the Phase 5D step 1 lib kernel) → DelegationOutcome persistence. The
 * `streamFn` DI slot is a real daemon-side adapter (`createDaemonProviderStream`,
 * see cli/daemon-provider-stream.ts) that streams tokens through the existing
 * `cli/provider.ts#streamCompletion` helper. The `toolExec` slot remains stubbed
 * — stub detectors short-circuit it, so no tool is ever actually invoked.
 *
 * Provider / model resolution honors role routing: if
 * `entry.state.roleRouting.explorer` is set (via `configure_role_routing`),
 * that provider+model is used; otherwise the session-level defaults are.
 * The adapter itself stays provider-agnostic — all policy lives here.
 *
 * The capability flag is `delegation_explorer_v1`. `multi_agent` is also
 * advertised (see the CAPABILITIES list) — both prerequisites it once waited
 * on are shipped: this handler runs `makeDaemonExplorerToolExec` (real
 * `executeToolCall`) and `handleDelegateCoder` wires the second role.
 */
async function handleDelegateExplorer(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const task = req.payload?.task;
  const allowedRepo = typeof req.payload?.allowedRepo === 'string' ? req.payload.allowedRepo : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!task || typeof task !== 'string' || !task.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'INVALID_REQUEST',
      'task is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_explorer',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Resolve provider/model with role-routing precedence. configure_role_routing
  // stores `state.roleRouting[role] = { provider, model }`; when present for
  // 'explorer' it overrides the session-level defaults for this delegation.
  const explorerRoute = entry.state.roleRouting?.explorer;
  const routedProvider = normalizeProviderInput(explorerRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for explorer role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_explorer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof explorerRoute?.model === 'string' && explorerRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_explorer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const trimmedTask = task.trim();

  entry.activeDelegations.set(subagentId, {
    role: 'explorer',
    agent: 'explorer',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: trimmedTask,
  });

  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'explorer',
    role: 'explorer',
    detail: trimmedTask.slice(0, 280),
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_explorer', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  // Background run. The RPC has already acked. Events are broadcast as the
  // lib kernel progresses. Terminal ownership is claimed synchronously by
  // deleting the delegation entry before any awaited terminal-event work so
  // cancel_delegation wins whenever it removes the entry first.
  (async () => {
    const toolExec = makeDaemonExplorerToolExec({
      entry,
      signal: abortController.signal,
    });
    const evaluateAfterModel = async () => null;

    let outcome;
    let runError = null;
    try {
      const daemonStream = createDaemonProviderStream(resolvedProvider, sessionId);
      const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
        resolvedProvider,
        resolvedModel,
      )
        ? getCliReadOnlyNativeToolSchemas()
        : undefined;
      const result = await runExplorerAgent(
        {
          provider: resolvedProvider,
          stream: daemonStream,
          modelId: resolvedModel,
          sandboxId: null,
          allowedRepo,
          userProfile: null,
          taskPreamble: trimmedTask,
          symbolSummary: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          webSearchToolProtocol: '',
          // See `runExplorerForTaskGraph` above for why this matters:
          // the kernel's default `EXPLORER_TOOL_PROTOCOL` advertises
          // web-side public tool names (`read`, `repo_read`, `search`)
          // that the daemon's detector doesn't recognize. Overriding
          // with `READ_ONLY_TOOL_PROTOCOL` from `cli/tools.ts` makes
          // the model emit CLI tool names that match
          // `READ_ONLY_TOOLS` + `executeToolCall`'s dispatch table.
          sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
          nativeToolSchemas,
          evaluateAfterModel,
        },
        {
          onStatus: () => {
            // Quiet for now — later slices can emit agent_status events here.
          },
          signal: abortController.signal,
        },
      );

      outcome = {
        agent: 'explorer',
        status: result.hitRoundCap ? 'incomplete' : 'complete',
        summary: result.summary,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: result.hitRoundCap
          ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
          : null,
        rounds: result.rounds,
        checkpoints: 0,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      runError = err;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        agent: 'explorer',
        status: 'inconclusive',
        summary: isAbort
          ? 'Explorer cancelled during daemon run.'
          : `Explorer failed during daemon run: ${message}`,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: 0,
        checkpoints: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Persist the outcome record even if cancel_delegation already emitted —
    // the session-state record must reflect what the scaffold run produced.
    if (!Array.isArray(entry.state.delegationOutcomes)) {
      entry.state.delegationOutcomes = [];
    }
    entry.state.delegationOutcomes.push({ subagentId, outcome });

    if (delegateExplorerTestHooks.beforeTerminalClaim) {
      await delegateExplorerTestHooks.beforeTerminalClaim({
        sessionId,
        subagentId,
        childRunId,
        outcome,
        runError,
      });
    }

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      // cancel_delegation already removed the entry and emitted subagent.failed.
      // Persist outcome only, no event emission to avoid duplicates.
      await saveSessionState(entry.state);
      if (delegateExplorerTestHooks.afterTerminalDecision) {
        await delegateExplorerTestHooks.afterTerminalDecision({
          sessionId,
          subagentId,
          childRunId,
          emittedTerminalEvent: false,
          terminalEventType: null,
        });
      }
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError) {
      const isAbort =
        (runError instanceof Error && runError.name === 'AbortError') ||
        (typeof runError?.message === 'string' && runError.message.includes('cancelled'));
      const message = runError instanceof Error ? runError.message : String(runError);
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'explorer',
        role: 'explorer',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'EXPLORER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'explorer',
        role: 'explorer',
        summary: outcome.summary.slice(0, 280),
        delegationOutcome: outcome,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
    if (delegateExplorerTestHooks.afterTerminalDecision) {
      await delegateExplorerTestHooks.afterTerminalDecision({
        sessionId,
        subagentId,
        childRunId,
        emittedTerminalEvent: true,
        terminalEventType: runError ? 'subagent.failed' : 'subagent.completed',
      });
    }
  })();

  return ack;
}

// ─── Delegate Coder (scaffold + real lib-kernel integration) ───

/**
 * `delegate_coder` — daemon-side Coder launch.
 *
 * Resolves role routing, validates input, mints ids, emits
 * `subagent.started`, acks the RPC, and runs the lib Coder kernel in the
 * background. The kernel consumes `makeDaemonCoderToolExec` (a real
 * `executeToolCall`-backed tool executor from `cli/tools.ts`) and
 * `wrapCliDetect*` (the production detectors from `cli/tools.ts`). LLM
 * streams real tokens via `createDaemonProviderStream`; tool calls the
 * model emits are parsed, classified into read-only / mutating by
 * `READ_ONLY_TOOLS`, and executed against `entry.state.cwd` with
 * approval gating routed through `buildApprovalFn` on `childRunId`. This
 * is the full-fat daemon Coder path — no scaffolding, no stubs.
 *
 * Why a separate handler from `delegate_explorer` when the shapes are so
 * similar: the explorer kernel's option interface is narrower (no
 * `sandboxToolProtocol`, no approval/verification policy slots), and
 * the coder kernel's `CoderToolExecResult` discriminated union has its
 * own shape rules (`errorType` feeds the mutation-failure tracker,
 * `policyPost` drives the kernel's halt guard). Explorer is also fully
 * wired (`makeDaemonExplorerToolExec` → real `executeToolCall`); the two
 * handlers stay separate for the option-shape reasons above, not because
 * either is still a stub.
 *
 * Provider / model resolution honours `entry.state.roleRouting.coder` —
 * set via `configure_role_routing` — and falls back to session defaults
 * otherwise. The resolved values feed both the daemon stream adapter and
 * the `modelId` option on the kernel.
 *
 * Capability flag: `delegation_coder_v1`. `multi_agent` is advertised too —
 * both executors (Explorer + Coder) are real and the v1 synthetic downgrade
 * path ships in `cli/v1-downgrade.ts`, so nothing here still blocks it.
 */
async function handleDelegateCoder(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const task = req.payload?.task;
  const allowedRepo = typeof req.payload?.allowedRepo === 'string' ? req.payload.allowedRepo : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!task || typeof task !== 'string' || !task.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'INVALID_REQUEST',
      'task is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_coder',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Resolve provider/model with role-routing precedence for the coder role.
  // Mirrors the explorer block; we inline rather than delegate to
  // `resolveRoleRouting()` (used by the task-graph scaffold path) so we can
  // produce structured `PROVIDER_NOT_CONFIGURED` errors before any state
  // mutation or subagent.started event — same contract as explorer.
  const coderRoute = entry.state.roleRouting?.coder;
  const routedProvider = normalizeProviderInput(coderRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for coder role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_coder',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof coderRoute?.model === 'string' && coderRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_coder_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const trimmedTask = task.trim();

  entry.activeDelegations.set(subagentId, {
    role: 'coder',
    agent: 'coder',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: trimmedTask,
  });

  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'coder',
    role: 'coder',
    detail: trimmedTask.slice(0, 280),
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_coder', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  // Background run — identical lifecycle to handleDelegateExplorer: the
  // RPC has already acked, the lib kernel streams real tokens through the
  // daemon provider adapter, and terminal ownership is claimed synchronously
  // by deleting the delegation registry entry BEFORE any awaited terminal
  // event so `cancel_delegation` wins whenever it removes the entry first.
  (async () => {
    // Real daemon tool executor + real CLI detectors. Replaces the
    // scaffold stubs that returned `{ kind: 'denied', reason: 'not yet wired' }`.
    // Tool calls now actually read/write files and run shell commands
    // under approval gating — high-risk exec commands emit an
    // `approval_required` event on `childRunId` and block on a
    // `submit_approval` RPC via `buildApprovalFn` (baked into the
    // executor closure itself).
    const toolExec = makeDaemonCoderToolExec({
      sessionId,
      entry,
      runId: childRunId,
      signal: abortController.signal,
    });
    const evaluateAfterModel = async () => null;

    let outcome;
    let runError = null;
    try {
      const daemonStream = createDaemonProviderStream(resolvedProvider, sessionId);
      const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
        resolvedProvider,
        resolvedModel,
      )
        ? getCliNativeToolSchemas()
        : undefined;
      const result = await runCoderAgent(
        {
          provider: resolvedProvider,
          stream: daemonStream,
          modelId: resolvedModel,
          // Daemon delegated child Coder run, not the lead.
          persona: 'coder',
          sandboxId: '',
          allowedRepo,
          userProfile: null,
          taskPreamble: trimmedTask,
          symbolSummary: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          webSearchToolProtocol: '',
          // `sandboxToolProtocol` is the tool-instruction block the kernel
          // splices into its system prompt — without it the model has no
          // guidance on what tool-call JSON to emit (codex P1 on PR #282).
          // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
          // non-delegated CLI engine uses.
          sandboxToolProtocol: TOOL_PROTOCOL,
          nativeToolSchemas,
          verificationPolicyBlock: null,
          approvalModeBlock: null,
          evaluateAfterModel,
          // Per-run token budget for this daemon delegated Coder. Resolved from
          // env (config forwarded to `PUSH_RUN_TOKEN_BUDGET` by
          // `applyConfigToEnv`); null (uncapped) maps to undefined.
          harnessTokenBudget:
            resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
        },
        {
          onStatus: () => {
            // Quiet for now — later slices can emit agent_status events here.
          },
          signal: abortController.signal,
          onRunEvent: emitRoleAgentRunEvent(sessionId, entry, childRunId ?? null),
        },
      );

      outcome = {
        agent: 'coder',
        // Kernel returned cleanly — default to 'complete'. Deeper
        // classification (incomplete on unfinished acceptance criteria,
        // inconclusive on policy halts) is a follow-up that inspects
        // working memory + criteriaResults. For now, structural success
        // (no thrown error) lands as 'complete'.
        status: 'complete',
        summary: result.summary,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: result.rounds,
        checkpoints: result.checkpoints,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      runError = err;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        agent: 'coder',
        status: 'inconclusive',
        summary: isAbort
          ? 'Coder cancelled during daemon run.'
          : `Coder failed during daemon run: ${message}`,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: 0,
        checkpoints: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }

    if (!Array.isArray(entry.state.delegationOutcomes)) {
      entry.state.delegationOutcomes = [];
    }
    entry.state.delegationOutcomes.push({ subagentId, outcome });

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      // cancel_delegation already removed the entry and emitted subagent.failed.
      // Persist outcome only, no event emission to avoid duplicates.
      await saveSessionState(entry.state);
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError) {
      const isAbort =
        (runError instanceof Error && runError.name === 'AbortError') ||
        (typeof runError?.message === 'string' && runError.message.includes('cancelled'));
      const message = runError instanceof Error ? runError.message : String(runError);
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'coder',
        role: 'coder',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'CODER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'coder',
        role: 'coder',
        summary: outcome.summary.slice(0, 280),
        delegationOutcome: outcome,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
  })();

  return ack;
}

// ─── Delegate Reviewer (advisory diff review, single-turn) ──────

// Byte ceiling for the bounded REVIEW.md read below. Comfortably exceeds the
// downstream char cap in role-context (8000) and ~600 lines of guidance, while
// bounding memory so a pathological REVIEW.md can't be materialized whole.
const REVIEW_GUIDANCE_MAX_BYTES = 64 * 1024;

/**
 * Read the working-copy REVIEW.md from a daemon workspace, byte- and line-capped.
 * The daemon reviews the local checkout, so the working copy (including unpushed
 * edits) is the authoritative guidance. Returns null when the file is absent so
 * `resolveReviewGuidance` treats it as "no guidance" rather than a read failure;
 * a genuine read error (permissions, etc.) rethrows so the resolver logs it.
 *
 * Reads at most `REVIEW_GUIDANCE_MAX_BYTES` via a bounded file-handle read rather
 * than `fs.readFile`, so the cap actually bounds memory instead of slicing a
 * fully-materialized file after the fact.
 */
async function readWorkspaceReviewGuidance(cwd) {
  let handle;
  try {
    handle = await fs.open(path.join(cwd, REVIEW_GUIDANCE_FILENAME), 'r');
    const buffer = Buffer.alloc(REVIEW_GUIDANCE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, REVIEW_GUIDANCE_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return capReviewGuidanceLines(text);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * `delegate_reviewer` — daemon-side Reviewer launch.
 *
 * Wires the full delegate_reviewer RPC path from handler → runReviewer
 * (the Phase 5D reviewer lib kernel) → ReviewResult persistence. Unlike
 * Explorer, the Reviewer is single-turn and read-only — it streams JSON
 * once, parses it into a ReviewResult, and returns. No tool loop, no
 * stub detectors, no DelegationOutcome envelope: the review payload has
 * its own schema (`filesReviewed` / `totalFiles` / `truncated` / `comments`)
 * that would be lossy in the gate-shaped DelegationOutcome contract.
 *
 * The streamFn adapter is wrapped in a signal-forwarding closure so the
 * handler's AbortController still reaches the underlying fetch even though
 * `runReviewer` itself doesn't accept an AbortSignal in its options.
 *
 * Provider / model resolution honors `roleRouting.reviewer`; otherwise
 * it falls back to session-level defaults.
 *
 * Capability flag: `delegation_reviewer_v1`.
 */
async function handleDelegateReviewer(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const diff = typeof req.payload?.diff === 'string' ? req.payload.diff : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;
  const rawContext =
    req.payload?.context && typeof req.payload.context === 'object'
      ? req.payload.context
      : undefined;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!diff || typeof diff !== 'string' || !diff.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'INVALID_REQUEST',
      'diff is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      // Restore the persisted attach token from session state instead of
      // minting a fresh one. Without this, clients lose their token on any
      // handler that lazy-loads a session from disk (including after a
      // daemon crash + restart), because `validateAttachToken` would
      // compare the caller's original token against a freshly minted one.
      // Legacy sessions without a persisted token load with attachToken
      // undefined; they are claimed on first `attach_session` (bootstrap
      // grace). A non-attach handler reached before that claim now rejects —
      // the implicit tokenless bypass is gone (Universal Session Bearer).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_reviewer',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const reviewerRoute = entry.state.roleRouting?.reviewer;
  const routedProvider = normalizeProviderInput(reviewerRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for reviewer role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof reviewerRoute?.model === 'string' && reviewerRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_reviewer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();

  entry.activeDelegations.set(subagentId, {
    role: 'reviewer',
    agent: 'reviewer',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: 'review-diff',
  });

  const detail = `review diff (${diff.length} chars)`;
  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'reviewer',
    role: 'reviewer',
    detail,
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_reviewer', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  (async () => {
    let reviewResult = null;
    let runError = null;
    try {
      const baseStream = createDaemonProviderStream(resolvedProvider, sessionId);
      // The lib reviewer's `iteratePushStreamText` only owns its own activity
      // controller. Compose `abortController.signal` with the consumer's
      // per-stream signal so cancel_delegation aborts the upstream call.
      const signalAwareStream = (req) =>
        baseStream({
          ...req,
          signal: req.signal
            ? AbortSignal.any([req.signal, abortController.signal])
            : abortController.signal,
        });

      // Default-on REVIEW.md: an explicit caller-supplied `reviewGuidance` wins
      // (the RPC client knows the review ref); otherwise resolve the daemon
      // workspace's working-copy REVIEW.md so the CLI Reviewer gets the same
      // repo-specific guidance the web Reviewer already does.
      const callerGuidance =
        rawContext && typeof rawContext.reviewGuidance === 'string'
          ? rawContext.reviewGuidance
          : null;
      const reviewGuidance =
        callerGuidance ??
        (await resolveReviewGuidance({
          readWorkingCopy: () => readWorkspaceReviewGuidance(entry.state.cwd),
        }));
      const reviewerContext = reviewGuidance
        ? { ...(rawContext ?? {}), reviewGuidance }
        : rawContext;

      reviewResult = await runReviewer(
        diff,
        {
          provider: resolvedProvider,
          stream: signalAwareStream,
          modelId: resolvedModel,
          context: reviewerContext,
          resolveRuntimeContext: async (_diff, context) => buildReviewerContextBlock(context) || '',
        },
        () => {
          // Quiet for now — later slices can emit agent_status events here.
        },
      );
    } catch (err) {
      runError = err;
    }

    // Persist review result even if cancel_delegation already claimed the entry.
    if (reviewResult) {
      if (!Array.isArray(entry.state.reviewOutcomes)) {
        entry.state.reviewOutcomes = [];
      }
      entry.state.reviewOutcomes.push({ subagentId, result: reviewResult });
    }

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      // cancel_delegation already removed the entry and emitted subagent.failed.
      // Persist outcome only, no event emission.
      await saveSessionState(entry.state);
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError || !reviewResult) {
      const err = runError;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message = err instanceof Error ? err.message : String(err ?? 'unknown reviewer error');
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'reviewer',
        role: 'reviewer',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'REVIEWER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const summary = typeof reviewResult.summary === 'string' ? reviewResult.summary : '';
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'reviewer',
        role: 'reviewer',
        summary: summary.slice(0, 280),
        reviewResult,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
  })();

  return ack;
}

/**
 * `delegate_deep_reviewer` — daemon-side Deep Reviewer launch.
 *
 * Same RPC/persistence/event shape as `handleDelegateReviewer`, but routes
 * through the multi-round investigation kernel (`runDeepReviewer`) instead of
 * the single-shot `runReviewer`. The deep reviewer reads surrounding code,
 * callers, and tests via a read-only tool loop before forming its opinion,
 * then returns the same `ReviewResult`.
 *
 * Tool loop wiring (the only structural difference from the simple reviewer):
 *   - `toolExec: makeDaemonExplorerToolExec({ role: 'reviewer' })` — the same
 *     read-only CLI-native executor the Explorer uses, gated on the reviewer
 *     role (which grants repo:read / pr:read / web:search — exactly the
 *     read-only surface).
 *   - `detectAllToolCalls` / `detectAnyToolCall: wrapCliDetect*` — the CLI
 *     detectors that produce the `DetectedToolCalls` shape the kernel expects.
 *   - `sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL` — overrides the kernel's
 *     built-in web-public-name tool block with the CLI-native names the
 *     detector + executor actually recognize. Without this the model would
 *     emit `repo_read` / `search` and the CLI detector would drop them, wasting
 *     rounds (the Explorer P1 from PR #284, avoided by construction here).
 *
 * Provider / model resolution honors `roleRouting.reviewer` (shared with the
 * simple reviewer); results persist to `reviewOutcomes` and surface through the
 * same `subagent.*` lifecycle, tagged `agent: 'deep_reviewer'`.
 *
 * Capability flag: `delegation_deep_reviewer_v1`.
 */
async function handleDelegateDeepReviewer(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const diff = typeof req.payload?.diff === 'string' ? req.payload.diff : '';
  const parentRunIdPayload =
    typeof req.payload?.parentRunId === 'string' ? req.payload.parentRunId : null;
  const rawContext =
    req.payload?.context && typeof req.payload.context === 'object'
      ? req.payload.context
      : undefined;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!diff || typeof diff !== 'string' || !diff.trim()) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'INVALID_REQUEST',
      'diff is required and must be a non-empty string',
    );
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'delegate_deep_reviewer',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Provider/model routing — shared with the simple reviewer (roleRouting.reviewer).
  const reviewerRoute = entry.state.roleRouting?.reviewer;
  const routedProvider = normalizeProviderInput(reviewerRoute?.provider);
  if (routedProvider && !PROVIDER_CONFIGS[routedProvider]) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${routedProvider}" for reviewer role routing`,
    );
  }
  const sessionProvider = normalizeProviderInput(entry.state.provider);
  if (!routedProvider && (!sessionProvider || !PROVIDER_CONFIGS[sessionProvider])) {
    return makeErrorResponse(
      req.requestId,
      'delegate_deep_reviewer',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider "${sessionProvider || '(missing)'}" in session state`,
    );
  }
  const resolvedProvider = routedProvider || sessionProvider;
  const resolvedModel =
    (typeof reviewerRoute?.model === 'string' && reviewerRoute.model.trim()) ||
    (typeof entry.state.model === 'string' && entry.state.model.trim()) ||
    PROVIDER_CONFIGS[resolvedProvider].defaultModel;

  ensureRuntimeState(entry);

  const subagentId = `sub_deepreviewer_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const childRunId = makeRunId();
  const parentRunId = parentRunIdPayload || entry.activeRunId || null;
  const abortController = new AbortController();
  const startedAt = Date.now();

  entry.activeDelegations.set(subagentId, {
    role: 'reviewer',
    agent: 'deep_reviewer',
    parentRunId,
    childRunId,
    abortController,
    startedAt,
    task: 'deep-review-diff',
  });

  const detail = `deep review diff (${diff.length} chars)`;
  const startEventPayload = {
    executionId: subagentId,
    subagentId,
    ...(parentRunId ? { parentRunId } : {}),
    childRunId,
    agent: 'deep_reviewer',
    role: 'reviewer',
    detail,
  };
  await appendSessionEvent(entry.state, 'subagent.started', startEventPayload, childRunId);
  await saveSessionState(entry.state);
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: childRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'subagent.started',
    payload: startEventPayload,
  });

  const ack = makeResponse(req.requestId, 'delegate_deep_reviewer', sessionId, true, {
    subagentId,
    childRunId,
    accepted: true,
  });

  (async () => {
    let reviewResult = null;
    let runError = null;
    try {
      const baseStream = createDaemonProviderStream(resolvedProvider, sessionId);
      const signalAwareStream = (req) =>
        baseStream({
          ...req,
          signal: req.signal
            ? AbortSignal.any([req.signal, abortController.signal])
            : abortController.signal,
        });

      const callerGuidance =
        rawContext && typeof rawContext.reviewGuidance === 'string'
          ? rawContext.reviewGuidance
          : null;
      const reviewGuidance =
        callerGuidance ??
        (await resolveReviewGuidance({
          readWorkingCopy: () => readWorkspaceReviewGuidance(entry.state.cwd),
        }));
      const reviewerContext = reviewGuidance
        ? { ...(rawContext ?? {}), reviewGuidance }
        : rawContext;

      // Read-only CLI-native tool loop, gated on the reviewer role.
      const toolExec = makeDaemonExplorerToolExec({
        entry,
        signal: abortController.signal,
        role: 'reviewer',
      });

      reviewResult = await runDeepReviewer(
        diff,
        {
          provider: resolvedProvider,
          stream: signalAwareStream,
          modelId: resolvedModel,
          context: reviewerContext,
          resolveRuntimeContext: async (_diff, context) => buildReviewerContextBlock(context) || '',
          // The daemon investigates the LOCAL working tree, not a cloud
          // sandbox. We still pass a truthy sandboxId (the workspace path) so
          // the kernel does NOT inject its "No sandbox available — use GitHub
          // tools instead" guidance: that guidance is wrong here because (a)
          // our sandboxToolProtocol override advertises the local read tools
          // (read_file / search_files / …) the executor actually runs, and
          // (b) no GitHub tools are wired on this path. Without a truthy id the
          // model would be steered away from the only tools it has (Codex P2).
          // `sandboxId` is informational in the kernel (prompt guidance +
          // hasSandbox flag) — it's never used as a real sandbox handle; all
          // tool calls route through `toolExec` above.
          sandboxId: entry.state.cwd || 'local',
          allowedRepo: '',
          userProfile: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          // Advertise the CLI-native read-only tool names (matches the
          // detector + executor); see the handler doc above. The block already
          // lists web_search, so the separate webSearchToolProtocol is unused.
          sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL,
          webSearchToolProtocol: '',
        },
        {
          onStatus: () => {
            // Quiet for now — later slices can emit agent_status events.
          },
          signal: abortController.signal,
        },
      );
    } catch (err) {
      runError = err;
    }

    if (reviewResult) {
      if (!Array.isArray(entry.state.reviewOutcomes)) {
        entry.state.reviewOutcomes = [];
      }
      entry.state.reviewOutcomes.push({ subagentId, result: reviewResult });
    }

    const activeDelegation = entry.activeDelegations?.get(subagentId);
    if (!activeDelegation) {
      await saveSessionState(entry.state);
      return;
    }
    entry.activeDelegations.delete(subagentId);

    if (runError || !reviewResult) {
      const err = runError;
      const isAbort =
        err &&
        ((err instanceof Error && err.name === 'AbortError') ||
          (typeof err?.message === 'string' && err.message.includes('cancelled')));
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown deep reviewer error');
      const failPayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'deep_reviewer',
        role: 'reviewer',
        error: message,
        errorDetails: {
          code: isAbort ? 'CANCELLED' : 'REVIEWER_FAILED',
          message,
          retryable: false,
        },
      };
      await appendSessionEvent(entry.state, 'subagent.failed', failPayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.failed',
        payload: failPayload,
      });
    } else {
      const summary = typeof reviewResult.summary === 'string' ? reviewResult.summary : '';
      const completePayload = {
        executionId: subagentId,
        subagentId,
        ...(parentRunId ? { parentRunId } : {}),
        childRunId,
        agent: 'deep_reviewer',
        role: 'reviewer',
        summary: summary.slice(0, 280),
        reviewResult,
      };
      await appendSessionEvent(entry.state, 'subagent.completed', completePayload, childRunId);
      await saveSessionState(entry.state);
      broadcastEvent(sessionId, {
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId: childRunId,
        seq: entry.state.eventSeq,
        ts: Date.now(),
        type: 'subagent.completed',
        payload: completePayload,
      });
    }
  })();

  return ack;
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
  // written by task-graph node completions (see handleSubmitTaskGraph)
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
