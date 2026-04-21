#!/usr/bin/env node
// @ts-nocheck — gradual typing in progress for this large module
/**
 * pushd.ts — Push daemon (Track 4)
 *
 * Persistent background daemon that reuses the same engine as the CLI.
 * Transport: Unix domain socket, NDJSON (one JSON object per line).
 *
 * Supported request types:
 *   hello            — handshake + capability negotiation
 *   ping             — health check
 *   list_sessions    — discover resumable sessions
 *   start_session    — create a new session
 *   send_user_message — start a run from user input
 *   attach_session   — attach to existing session + event replay
 *   submit_approval  — respond to an approval_required pause
 *   cancel_run       — abort active run
 *   configure_role_routing — set per-role provider/model routing
 *   submit_task_graph      — scaffold for future task graph execution
 *   delegate_explorer      — launch read-only Explorer sub-agent (real streamFn via daemon-provider-stream; toolExec still stubbed)
 *   delegate_coder         — launch mutating Coder sub-agent (real streamFn via daemon-provider-stream; toolExec still stubbed)
 *   delegate_reviewer      — launch advisory Reviewer sub-agent (real streamFn, single-turn JSON review; no tool loop)
 *   cancel_delegation      — cancel active sub-agent delegation
 *   fetch_delegation_events — replay delegation event stream
 */
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import { PROVIDER_CONFIGS, resolveApiKey } from './provider.js';
import { createDaemonProviderStream } from './daemon-provider-stream.js';
import {
  executeToolCall,
  detectAllToolCalls as cliDetectAllToolCalls,
  detectToolCall as cliDetectToolCall,
  READ_ONLY_TOOLS,
  FILE_MUTATION_TOOLS,
  TOOL_PROTOCOL,
  READ_ONLY_TOOL_PROTOCOL,
} from './tools.js';
import {
  makeSessionId,
  makeRunId,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  loadSessionEvents,
  listSessions,
  writeRunMarker,
  clearRunMarker,
  scanInterruptedSessions,
  PROTOCOL_VERSION,
} from './session-store.js';
import {
  buildSystemPrompt,
  runAssistantLoop,
  runAssistantTurn,
  DEFAULT_MAX_ROUNDS,
} from './engine.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { runExplorerAgent } from '../lib/explorer-agent.ts';
import { runCoderAgent } from '../lib/coder-agent.ts';
import { runReviewer } from '../lib/reviewer-agent.ts';
import { buildReviewerContextBlock } from '../lib/role-context.ts';
import { validateTaskGraph, executeTaskGraph, formatTaskGraphResult } from '../lib/task-graph.ts';
import { assertValidEvent, isStrictModeEnabled } from './protocol-schema.js';
import { isV2DelegationEvent, synthesizeV1DelegationEvent } from './v1-downgrade.js';
import {
  roleCanUseTool,
  getToolCapabilities,
  isCapabilityMapped,
  ROLE_CAPABILITIES,
} from '../lib/capabilities.ts';
import { setDefaultMemoryStore } from '../lib/context-memory-store.ts';
import { createFileMemoryStore, getMemoryStoreBaseDir } from './context-memory-file-store.ts';
import { resolveWorkspaceIdentity } from './workspace-identity.ts';
import { buildTypedMemoryBlockForNode, writeTaskGraphResultMemory } from './task-graph-memory.ts';

const VERSION = '0.3.0';
const CAPABILITIES = [
  'stream_tokens',
  'approvals',
  'replay_attach',
  'multi_client',
  'crash_recovery',
  'role_routing',
  'delegation_explorer_v1',
  'delegation_reviewer_v1',
  // `delegation_coder_v1`: `delegate_coder` RPC + task-graph coder nodes
  // run through `runCoderAgent` with a REAL daemon tool executor
  // (`makeDaemonCoderToolExec`) that routes through `executeToolCall`
  // from `cli/tools.ts` with approval gating via `buildApprovalFn`.
  // Coder delegations actually read/write files and run shell commands
  // under approval gating; outcomes land as `'complete'` on clean
  // kernel returns.
  'delegation_coder_v1',
  // v2 task-graph execution: submit_task_graph accepts graphs, runs
  // them through lib/task-graph.executeTaskGraph, and streams
  // task_graph.* events. Both `agent: 'coder'` and `agent: 'explorer'`
  // nodes route through their respective real daemon tool executors
  // (see `delegation_coder_v1` above and `multi_agent` below).
  'task_graph_v1',
  // `event_v2`: the daemon emits raw `subagent.*` / `task_graph.*` envelopes
  // to clients that advertise this cap back in `attach_session.capabilities`.
  // Clients that omit the cap (including v1 clients that don't know to send
  // it) receive synthesized `assistant_token` events on the parent runId
  // instead — see `cli/v1-downgrade.ts` and the "v1 Client Handling —
  // Option C" section of `docs/decisions/push-runtime-v2.md`.
  'event_v2',
  // `multi_agent`: both Explorer and Coder daemon-side tool executors
  // are wired to real production tool surfaces (`executeToolCall` from
  // `cli/tools.ts`). Explorer runs `makeDaemonExplorerToolExec` with
  // `roleCanUseTool('explorer', ...)` enforcement against the shared
  // capability table (`lib/capabilities.ts`) and no approval gating;
  // Coder runs `makeDaemonCoderToolExec` with full tool surface +
  // approval gating (Coder capability gate is deferred per Gap 2
  // rollout phasing — needs its own grant audit).
  // Delegation outcomes land as `'complete'` for both agents on clean
  // kernel returns — the daemon can host end-to-end multi-agent flows
  // (direct delegation RPCs + dependency-ordered task graphs).
  // Reviewer stays single-turn JSON-only by design.
  'multi_agent',
];

const VALID_AGENT_ROLES = new Set(['orchestrator', 'explorer', 'coder', 'reviewer', 'auditor']);

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Socket path ─────────────────────────────────────────────────

export function getSocketPath() {
  if (process.env.PUSHD_SOCKET) return process.env.PUSHD_SOCKET;
  const pushDir = path.join(os.homedir(), '.push', 'run');
  return path.join(pushDir, 'pushd.sock');
}

export function getPidPath() {
  return path.join(os.homedir(), '.push', 'run', 'pushd.pid');
}

export function getLogPath() {
  if (process.env.PUSHD_LOG) return process.env.PUSHD_LOG;
  return path.join(os.homedir(), '.push', 'run', 'pushd.log');
}

async function writePidFile() {
  const pidPath = getPidPath();
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  await fs.writeFile(pidPath, String(process.pid), 'utf8');
}

async function cleanPidFile() {
  try {
    await fs.unlink(getPidPath());
  } catch {
    /* ignore */
  }
}

async function ensureSocketDir(socketPath) {
  const dir = path.dirname(socketPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function cleanStaleSocket(socketPath) {
  try {
    await fs.unlink(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ─── ID generators ──────────────────────────────────────────────

function makeRequestId() {
  return `req_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function makeAttachToken() {
  return `att_${randomBytes(8).toString('hex')}`;
}

function makeApprovalId() {
  return `appr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

// ─── Envelope helpers ────────────────────────────────────────────

export function makeResponse(requestId, type, sessionId, ok, payload, error = null) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'response',
    requestId,
    type,
    sessionId: sessionId || null,
    ok,
    payload,
    error,
  };
}

export function makeErrorResponse(requestId, type, code, message, retryable = false) {
  return makeResponse(
    requestId,
    type,
    null,
    false,
    {},
    {
      code,
      message,
      retryable,
    },
  );
}

// ─── Restart policies ─────────────────────────────────────────────
// Each session can have a restart policy that controls crash recovery.
//   'on-failure' (default) — recover runs that were interrupted by daemon crash
//   'always'               — always recover (same as on-failure for now; future: timer-based restarts)
//   'never'                — never auto-recover; user must manually re-send
const DEFAULT_RESTART_POLICY = 'on-failure';
const VALID_RESTART_POLICIES = new Set(['on-failure', 'always', 'never']);

function getRestartPolicy(state) {
  const policy = state?.restartPolicy || DEFAULT_RESTART_POLICY;
  return VALID_RESTART_POLICIES.has(policy) ? policy : DEFAULT_RESTART_POLICY;
}

function shouldRecover(policy, marker) {
  if (policy === 'never') return false;
  // 'on-failure' and 'always' both recover interrupted runs
  // Guard: reject missing/non-finite startedAt and stale markers (>1 hour)
  const startedAt = Number(marker.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  const age = Date.now() - startedAt;
  const ONE_HOUR = 60 * 60 * 1000;
  if (age < 0 || age > ONE_HOUR) return false;
  return true;
}

// ─── Token validation ─────────────────────────────────────────────

export { getRestartPolicy, shouldRecover, DEFAULT_RESTART_POLICY, VALID_AGENT_ROLES };

export function validateAttachToken(entry, providedToken) {
  if (!entry || !entry.attachToken) return true;
  if (typeof providedToken !== 'string' || !providedToken) return false;
  return entry.attachToken === providedToken;
}

export function normalizeProviderInput(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return '';
  return normalized;
}

// ─── Session registry (in-memory) ────────────────────────────────

// sessionId → { state, attachToken, abortController?, activeRunId?, pendingApproval?, activeDelegations?, activeGraphs? }
const activeSessions = new Map();

export function ensureRuntimeState(entry) {
  if (!entry.activeDelegations) entry.activeDelegations = new Map();
  if (!entry.activeGraphs) entry.activeGraphs = new Map();
  return entry;
}

export function __getActiveSessionForTesting(sessionId) {
  return activeSessions.get(sessionId) || null;
}

/**
 * Test-only: evict a session from the in-memory registry so the next
 * handler call has to lazy-load it from disk. Used to simulate the
 * daemon-restart path without actually restarting the daemon.
 */
export function __evictActiveSessionForTesting(sessionId) {
  return activeSessions.delete(sessionId);
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

// ─── Shared approval builder ─────────────────────────────────────

/**
 * Build an approvalFn for a session entry. The returned function emits
 * approval_required events and awaits a client decision (or times out).
 * Used by both normal runs and crash-recovery runs.
 */
function buildApprovalFn(sessionId, entry, runId) {
  return async (tool, detail) => {
    const approvalId = makeApprovalId();

    const approvalPromise = new Promise((resolve, reject) => {
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
      entry.pendingApproval = { approvalId, resolve, reject, timer, runId };
    });

    const approvalPayload = {
      approvalId,
      kind: tool?.tool || 'tool_execution',
      title: `Approve ${tool?.tool || 'action'}`,
      summary: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
      options: ['approve', 'deny'],
    };
    await appendSessionEvent(entry.state, 'approval_required', approvalPayload, runId);
    broadcastEvent(sessionId, {
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
      const decision = await approvalPromise;
      return decision === 'approve';
    } catch {
      return false;
    }
  };
}

// ─── Multi-client fan-out ────────────────────────────────────────

// sessionId → Map<emitFn, { capabilities: Set<string> }>
//
// Keyed on the emitFn itself so `removeSessionClient(sessionId, emitFn)`
// can find the entry without the caller needing to hold on to an
// opaque handle. The Map is iterated in insertion order, so the
// effective broadcast order matches the v1 Set-based implementation
// and existing tests that assert "client A attached first, so it gets
// events first" still hold.
const sessionClients = new Map();

/**
 * Register a client listener for a session.
 *
 * @param sessionId     the session the client is attached to
 * @param emitFn        a function that takes an event envelope and
 *                      writes it to the client
 * @param capabilities  optional list of v2 capability names the
 *                      client advertises. Clients that include
 *                      `'event_v2'` receive raw delegation events;
 *                      clients that omit it (including the v1
 *                      default) receive synthesized `assistant_token`
 *                      shadows built by `cli/v1-downgrade.ts`.
 */
function addSessionClient(sessionId, emitFn, capabilities = []) {
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Map());
  }
  const caps = new Set(Array.isArray(capabilities) ? capabilities : []);
  sessionClients.get(sessionId).set(emitFn, { capabilities: caps });
}

function removeSessionClient(sessionId, emitFn) {
  const clients = sessionClients.get(sessionId);
  if (clients) {
    clients.delete(emitFn);
    if (clients.size === 0) sessionClients.delete(sessionId);
  }
}

export function broadcastEvent(sessionId, event) {
  // Strict-mode schema check. Opt-in via `PUSH_PROTOCOL_STRICT=1` — the
  // daemon-integration test harness flips this on at module load so any
  // drift between the wire-format contract (`cli/protocol-schema.ts`)
  // and what a handler actually produces lands as a test failure
  // instead of silent consumer-side breakage. Production leaves this
  // off to avoid any per-event overhead.
  if (isStrictModeEnabled()) {
    assertValidEvent(event);
  }
  const clients = sessionClients.get(sessionId);
  if (!clients) return;

  // Fast path: non-delegation events pass through unchanged to every
  // client regardless of capabilities. This covers the vast majority
  // of traffic (`assistant_token`, `tool_call`, `tool_result`,
  // `status`, `run_complete`, `error`, `session_started`,
  // `approval_required`, etc.).
  const isDelegation = isV2DelegationEvent(event.type);
  if (!isDelegation) {
    for (const [emitFn] of clients) {
      try {
        emitFn(event);
      } catch {
        /* client may have disconnected */
      }
    }
    return;
  }

  // Slow path: a v2 delegation event. Every client that advertised
  // `event_v2` at attach time gets the raw envelope; every other
  // client gets the synthesized v1-shaped `assistant_token` shadow(s)
  // built by `cli/v1-downgrade.ts`. A single synthesis per v1 event
  // is sufficient even with multiple v1 clients — the envelope is
  // pure data and can be fanned out as-is.
  //
  // Approval events are NOT delegation events (see
  // `isV2DelegationEvent` in `cli/v1-downgrade.ts`) and take the fast
  // path above. They reach v1 clients verbatim, and the daemon's
  // internal approvalId → delegation map routes the response back to
  // the correct child — the v1 client never has to know a delegation
  // was involved.
  let synthesized = null;
  for (const [emitFn, meta] of clients) {
    if (meta.capabilities.has('event_v2')) {
      try {
        emitFn(event);
      } catch {
        /* client may have disconnected */
      }
      continue;
    }
    // v1 client: build the downgrade lazily on first need so sessions
    // with only v2 clients pay nothing.
    if (synthesized === null) {
      synthesized = synthesizeV1DelegationEvent(event);
      if (isStrictModeEnabled()) {
        for (const synth of synthesized) assertValidEvent(synth);
      }
    }
    for (const synth of synthesized) {
      try {
        emitFn(synth);
      } catch {
        /* client may have disconnected */
      }
    }
  }
}

/**
 * Emit a single event to a single client applying the same v1 synthetic
 * downgrade rules as `broadcastEvent`'s live-fanout slow path. Used by
 * the replay path inside `handleAttachSession` so a v1 client that
 * reconnects with `lastSeenSeq` doesn't receive raw `subagent.*` /
 * `task_graph.*` events from disk and silently drop them.
 *
 * Fixes the PR #281 codex P1 feedback: before this helper, the replay
 * loop called `emitEvent(event)` directly, which reintroduced the exact
 * "unknown event gets dropped" gap the live broadcast was meant to
 * close. Now every path that emits a delegation event to a client goes
 * through capability-aware synthesis.
 *
 * `capabilities` is a `Set<string>` matching the shape stored in
 * `sessionClients`. Callers that track capabilities as arrays should
 * wrap in `new Set(arr)` before calling.
 */
function emitEventWithDowngrade(event, emitFn, capabilities) {
  const isDelegation = isV2DelegationEvent(event.type);
  if (!isDelegation || capabilities.has('event_v2')) {
    try {
      emitFn(event);
    } catch {
      /* client may have disconnected */
    }
    return;
  }
  // v1 client + delegation event — synthesize the downgrade shadow(s).
  const synthesized = synthesizeV1DelegationEvent(event);
  if (isStrictModeEnabled()) {
    for (const synth of synthesized) assertValidEvent(synth);
  }
  for (const synth of synthesized) {
    try {
      emitFn(synth);
    } catch {
      /* client may have disconnected */
    }
  }
}

// ─── Request handlers ────────────────────────────────────────────

async function handleHello(req) {
  return makeResponse(req.requestId, 'hello', null, true, {
    runtimeName: 'pushd',
    runtimeVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: CAPABILITIES,
  });
}

async function handlePing(req) {
  return makeResponse(req.requestId, 'ping', null, true, {
    pong: true,
    ts: Date.now(),
  });
}

async function handleListSessions(req) {
  const limit = req.payload?.limit || 20;
  const sessions = await listSessions();
  const limited = sessions.slice(0, limit);

  // Enrich with active run state
  const enriched = limited.map((s) => {
    const entry = activeSessions.get(s.sessionId);
    return {
      ...s,
      state: entry?.activeRunId ? 'running' : 'idle',
      activeRunId: entry?.activeRunId || null,
    };
  });

  return makeResponse(req.requestId, 'list_sessions', null, true, {
    sessions: enriched,
  });
}

async function handleStartSession(req) {
  const payload = req.payload || {};
  const provider = payload.provider || 'ollama';
  const providerConfig = PROVIDER_CONFIGS[provider];
  if (!providerConfig) {
    return makeErrorResponse(
      req.requestId,
      'start_session',
      'PROVIDER_NOT_CONFIGURED',
      `Unknown provider: ${provider}`,
    );
  }

  const cwd = payload.repo?.rootPath || process.cwd();
  const model = payload.model || PROVIDER_CONFIGS[provider].defaultModel;
  const restartPolicy = VALID_RESTART_POLICIES.has(payload.restartPolicy)
    ? payload.restartPolicy
    : DEFAULT_RESTART_POLICY;
  const sessionId = makeSessionId();
  const attachToken = makeAttachToken();
  const now = Date.now();

  const state = {
    sessionId,
    createdAt: now,
    updatedAt: now,
    provider,
    model,
    cwd,
    restartPolicy,
    roleRouting: {},
    delegationOutcomes: [],
    rounds: 0,
    eventSeq: 0,
    messages: [{ role: 'system', content: await buildSystemPrompt(cwd) }],
    // Persist the attach token so that disk-reload paths (daemon restart,
    // session eviction, cross-handler lazy load) can restore the SAME token
    // the client received at start_session time instead of minting a fresh
    // one and immediately rejecting the client's original token as invalid.
    attachToken,
  };

  await appendSessionEvent(state, 'session_started', {
    sessionId,
    state: 'idle',
    mode: payload.mode || 'interactive',
    provider,
    sandboxProvider: payload.sandboxProvider || 'local',
  });
  await saveSessionState(state);

  activeSessions.set(sessionId, { state, attachToken });

  return makeResponse(req.requestId, 'start_session', sessionId, true, {
    sessionId,
    state: 'idle',
    attachToken,
    roleRouting: state.roleRouting,
  });
}

async function handleSendUserMessage(req, emitEvent) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const text = req.payload?.text;

  if (!sessionId || !text) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'INVALID_REQUEST',
      'sessionId and text are required',
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'send_user_message',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  // Reject if a run is already in progress
  if (entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'RUN_IN_PROGRESS',
      `Run ${entry.activeRunId} is already active`,
    );
  }

  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const { state } = entry;
  const runId = makeRunId();
  const abortController = new AbortController();

  entry.activeRunId = runId;
  entry.abortController = abortController;

  // Acknowledge immediately
  const ack = makeResponse(req.requestId, 'send_user_message', sessionId, true, {
    runId,
    accepted: true,
  });

  await appendUserMessageWithFileReferences(state, text, state.cwd);
  await appendSessionEvent(
    state,
    'user_message',
    { chars: text.length, preview: text.slice(0, 280) },
    runId,
  );

  const providerConfig = PROVIDER_CONFIGS[state.provider];
  let apiKey;
  try {
    apiKey = resolveApiKey(providerConfig);
  } catch (err) {
    entry.activeRunId = null;
    entry.abortController = null;
    return makeErrorResponse(
      req.requestId,
      'send_user_message',
      'PROVIDER_NOT_CONFIGURED',
      err.message,
    );
  }

  const approvalFn = buildApprovalFn(sessionId, entry, runId);

  // Run in background — broadcast events to all attached clients
  (async () => {
    // Write run marker so crash recovery can detect interrupted runs.
    // Awaited inside the async IIFE so a crash right after launch is still detectable.
    try {
      await writeRunMarker(sessionId, runId, {
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
      });
    } catch (err) {
      process.stderr.write(
        `warning: failed to write run marker for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    let sawError = false;
    let sawRunComplete = false;
    try {
      await runAssistantTurn(state, providerConfig, apiKey, text, DEFAULT_MAX_ROUNDS, {
        runId,
        signal: abortController.signal,
        approvalFn,
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
      });
      await saveSessionState(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!sawError) {
        await appendSessionEvent(
          state,
          'error',
          {
            code: 'INTERNAL_ERROR',
            message,
            retryable: false,
          },
          runId,
        );
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId,
          seq: state.eventSeq,
          ts: Date.now(),
          type: 'error',
          payload: { code: 'INTERNAL_ERROR', message, retryable: false },
        });
      }
      if (!sawRunComplete) {
        await appendSessionEvent(
          state,
          'run_complete',
          {
            runId,
            outcome: 'failed',
            summary: message.slice(0, 500),
          },
          runId,
        );
        broadcastEvent(sessionId, {
          v: PROTOCOL_VERSION,
          kind: 'event',
          sessionId,
          runId,
          seq: state.eventSeq,
          ts: Date.now(),
          type: 'run_complete',
          payload: { outcome: 'failed', summary: message.slice(0, 500) },
        });
      }
      await saveSessionState(state);
    } finally {
      entry.activeRunId = null;
      entry.abortController = null;
      if (entry.pendingApproval) {
        clearTimeout(entry.pendingApproval.timer);
        entry.pendingApproval = null;
      }
      // Clear run marker — this run is no longer active
      clearRunMarker(sessionId).catch(() => {});
    }
  })();

  return ack;
}

async function handleAttachSession(req, emitEvent) {
  const {
    sessionId,
    lastSeenSeq,
    attachToken: providedToken,
    capabilities: clientCapabilities,
  } = req.payload || {};
  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'attach_session',
      'INVALID_REQUEST',
      'sessionId is required',
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'attach_session',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'attach_session',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  // Register this client for multi-client fan-out. Capabilities drive
  // the v1 synthetic-downgrade path in `broadcastEvent` — clients that
  // include `'event_v2'` receive raw delegation envelopes, clients
  // that omit it (or pass `capabilities: []`, or don't include the
  // field at all) receive synthesized `assistant_token` shadows.
  const capabilitiesArray = Array.isArray(clientCapabilities) ? clientCapabilities : [];
  addSessionClient(sessionId, emitEvent, capabilitiesArray);
  // Same capability set is used to drive the replay path below so v1
  // clients see synthesized events for missed delegation rounds as
  // well as live ones (codex P1 on PR #281).
  const replayCapabilities = new Set(capabilitiesArray);

  const { state } = entry;
  const currentSeq = state.eventSeq;
  const fromSeq = (lastSeenSeq || 0) + 1;

  // Replay missed events from disk. Route each through
  // `emitEventWithDowngrade` so v1 clients don't silently drop raw
  // `subagent.*` / `task_graph.*` envelopes that landed on disk while
  // they were disconnected. The live fan-out path already does this
  // via `broadcastEvent`; the replay path has to do it too or
  // reconnects on `lastSeenSeq` reintroduce the gap this PR was meant
  // to close.
  try {
    const allEvents = await loadSessionEvents(sessionId);
    const missed = allEvents.filter((e) => e.seq >= fromSeq && e.seq <= currentSeq);
    for (const event of missed) {
      emitEventWithDowngrade(event, emitEvent, replayCapabilities);
    }
  } catch {
    // best-effort replay
  }

  return makeResponse(req.requestId, 'attach_session', sessionId, true, {
    sessionId,
    state: entry.activeRunId ? 'running' : 'idle',
    activeRunId: entry.activeRunId || null,
    roleRouting: state.roleRouting || {},
    replay: {
      fromSeq,
      toSeq: currentSeq,
      completed: true,
      gap: fromSeq > currentSeq + 1,
    },
  });
}

async function handleSubmitApproval(req) {
  const { sessionId, approvalId, decision } = req.payload || {};
  if (!sessionId || !approvalId || !decision) {
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'INVALID_REQUEST',
      'sessionId, approvalId, and decision are required',
    );
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'SESSION_NOT_FOUND',
      `Session not found: ${sessionId}`,
    );
  }

  const pending = entry.pendingApproval;
  if (!pending || pending.approvalId !== approvalId) {
    return makeErrorResponse(
      req.requestId,
      'submit_approval',
      'APPROVAL_NOT_FOUND',
      `No pending approval with id: ${approvalId}`,
    );
  }

  clearTimeout(pending.timer);
  entry.pendingApproval = null;
  pending.resolve(decision);

  // Emit approval_received to all clients on the SAME runId we used
  // for `approval_required` (stored alongside in `buildApprovalFn`).
  // Falling back to `entry.activeRunId` — which is the parent run for
  // a main loop, but null for delegations and task-graph nodes —
  // caused the received event to mismatch the required event for
  // anything routed through `delegate_coder` /
  // `handleSubmitTaskGraph`, making client-side correlation
  // impossible.
  const approvalRunId = typeof pending.runId === 'string' ? pending.runId : entry.activeRunId;
  const eventPayload = { approvalId, decision, by: 'client' };
  await appendSessionEvent(entry.state, 'approval_received', eventPayload, approvalRunId);
  // Build envelope after appendSessionEvent so seq matches the persisted event.
  // Omit `runId` when falsy (protocol-schema strict mode rejects
  // `runId: null` on wire envelopes — see PR #276 review).
  const envelope = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'approval_received',
    payload: eventPayload,
  };
  if (typeof approvalRunId === 'string' && approvalRunId.length > 0) {
    envelope.runId = approvalRunId;
  }
  broadcastEvent(sessionId, envelope);

  return makeResponse(req.requestId, 'submit_approval', sessionId, true, {
    accepted: true,
  });
}

async function handleCancelRun(req) {
  const { sessionId, runId } = req.payload || {};
  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'SESSION_NOT_FOUND',
      `Session not found: ${sessionId}`,
    );
  }

  if (!entry.activeRunId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'NO_ACTIVE_RUN',
      'No active run to cancel',
    );
  }

  if (runId && entry.activeRunId !== runId) {
    return makeErrorResponse(
      req.requestId,
      'cancel_run',
      'NO_ACTIVE_RUN',
      `Run ${runId} is not the active run`,
    );
  }

  // Abort the run
  if (entry.abortController) {
    entry.abortController.abort();
  }

  // Also resolve any pending approval as denied
  if (entry.pendingApproval) {
    clearTimeout(entry.pendingApproval.timer);
    entry.pendingApproval.resolve('deny');
    entry.pendingApproval = null;
  }

  return makeResponse(req.requestId, 'cancel_run', sessionId, true, {
    accepted: true,
  });
}

// ─── Role routing ───────────────────────────────────────────────

async function handleConfigureRoleRouting(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const routing = req.payload?.routing;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'configure_role_routing',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return makeErrorResponse(
      req.requestId,
      'configure_role_routing',
      'INVALID_REQUEST',
      'routing must be a non-null object mapping role → { provider, model? }',
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'configure_role_routing',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const normalized = {};
  for (const [role, spec] of Object.entries(routing)) {
    if (!VALID_AGENT_ROLES.has(role)) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_ROLE',
        `Unknown agent role: ${role}. Valid roles: ${[...VALID_AGENT_ROLES].join(', ')}`,
      );
    }

    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_REQUEST',
        `Entry for role "${role}" must be an object with at least { provider }`,
      );
    }

    const provider = typeof spec.provider === 'string' ? spec.provider.trim() : spec.provider;
    if (!provider || typeof provider !== 'string') {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'INVALID_REQUEST',
        `Entry for role "${role}" must specify a provider`,
      );
    }

    const providerConfig = PROVIDER_CONFIGS[provider];
    if (!providerConfig) {
      return makeErrorResponse(
        req.requestId,
        'configure_role_routing',
        'PROVIDER_NOT_CONFIGURED',
        `Unknown provider "${provider}" for role "${role}"`,
      );
    }

    normalized[role] = {
      provider,
      model:
        typeof spec.model === 'string' && spec.model.trim()
          ? spec.model.trim()
          : providerConfig.defaultModel,
    };
  }

  const { state } = entry;
  state.roleRouting = { ...(state.roleRouting || {}), ...normalized };
  await saveSessionState(state);

  return makeResponse(req.requestId, 'configure_role_routing', sessionId, true, {
    roleRouting: state.roleRouting,
  });
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

// ─── Daemon Coder tool executor (real lib-kernel integration) ──

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
 */
function wrapCall(call) {
  return { source: 'cli', call };
}

/**
 * Wrap `cli/tools.ts`'s flat `{ calls, malformed }` detector output into
 * the `DetectedToolCalls` shape the lib Coder kernel expects
 * (`{ readOnly, fileMutations, mutating, extraMutations }` from
 * `lib/deep-reviewer-agent.ts`).
 *
 * Classification:
 * - `READ_ONLY_TOOLS` → `readOnly`
 * - `FILE_MUTATION_TOOLS` (pure file writes/edits) → `fileMutations`,
 *   batched into one mutation transaction per turn
 * - Anything else (`exec`, `git_commit`, etc.) → the trailing `mutating`
 *   side-effect slot (at most one)
 * - Overflow after the trailing slot, or a second side-effect → `extraMutations`
 *
 * Reads that appear after a mutation has started are treated as a
 * boundary: the sequence stops there so we don't silently reorder the
 * model's intent.
 *
 * Each slot holds a kernel-shaped `{ call: { tool, args } }` wrapper
 * (see `wrapCall`) — NOT the raw CLI call shape — so the kernel's
 * structural cast `toolCall.call.tool` resolves correctly.
 *
 * Exported so unit tests can assert the classification directly without
 * having to drive a full kernel loop through a mock provider.
 */
export function wrapCliDetectAllToolCalls(text) {
  const { calls } = cliDetectAllToolCalls(text);
  const readOnly = [];
  const fileMutations = [];
  const extraMutations = [];
  let mutating = null;
  let phase = 'reads'; // 'reads' → 'mutations' → 'done'
  for (const call of calls) {
    const wrapped = wrapCall(call);
    const isRead = READ_ONLY_TOOLS.has(call.tool);
    const isFileMut = !isRead && FILE_MUTATION_TOOLS.has(call.tool);

    if (phase === 'done') {
      extraMutations.push(wrapped);
      continue;
    }

    if (isRead) {
      if (phase === 'reads') {
        readOnly.push(wrapped);
        continue;
      }
      // Read after a mutation started — ordering violation. Push it
      // into `extraMutations` (and flip `phase` so any remaining calls
      // land there too) so the caller can surface a structured error
      // instead of silently dropping the call.
      extraMutations.push(wrapped);
      phase = 'done';
      continue;
    }

    if (isFileMut) {
      phase = 'mutations';
      fileMutations.push(wrapped);
      continue;
    }

    // Side-effecting call (exec, git_commit, save_memory, etc.)
    mutating = wrapped;
    phase = 'done';
  }
  return { readOnly, fileMutations, mutating, extraMutations };
}

/**
 * Wraps the CLI single-call detector into the kernel's nested shape.
 * Returns `null` when no tool call is present, matching the kernel's
 * `detectAnyToolCall` slot contract.
 */
function wrapCliDetectAnyToolCall(text) {
  const call = cliDetectToolCall(text);
  if (!call) return null;
  return wrapCall(call);
}

/**
 * Build a `CoderToolExecResult`-shaped tool executor bound to a running
 * delegation. The closure runs `executeToolCall` from `cli/tools.ts`
 * (the same production tool executor the non-delegated CLI engine
 * loop uses at `cli/engine.ts:runAssistantLoop`) against the session's
 * `state.cwd`, with approval gating routed through `buildApprovalFn`
 * so any high-risk exec emits an `approval_required` event on the
 * child `runId` and blocks on a `submit_approval` RPC.
 *
 * The result is translated from CLI's
 * `{ ok, text, meta?, structuredError? }` shape to lib's discriminated
 * union (`{ kind: 'executed', resultText, errorType? } | { kind: 'denied', reason }`).
 * `errorType` feeds the kernel's mutation-failure tracker
 * (`lib/coder-agent.ts` guards against repeated same-tool+file failures).
 *
 * Non-goals: no sandbox layer (runs directly against `state.cwd`, same
 * model as the CLI engine), no OpenTelemetry spans, no
 * `CapabilityLedger` gating, no `TurnPolicyRegistry` (all Web-side).
 * Pushd is an RPC transport + approval gate, nothing more.
 */
export function makeDaemonCoderToolExec({ sessionId, entry, runId, signal }) {
  const approvalFn = buildApprovalFn(sessionId, entry, runId);
  const workspaceRoot = entry.state.cwd;
  return async (toolCall, _execCtx) => {
    // The kernel passes the nested wrapper we returned from
    // `wrapCliDetectAllToolCalls` / `wrapCliDetectAnyToolCall` — a
    // `{ source, call: { tool, args } }` shape. Unwrap once to get the
    // flat `{ tool, args }` form `executeToolCall` expects. If a
    // caller somehow hands us a bare CLI call (e.g. tests that call
    // the executor directly), fall through and pass it as-is.
    const rawCall =
      toolCall && typeof toolCall === 'object' && toolCall.call ? toolCall.call : toolCall;
    try {
      const result = await executeToolCall(rawCall, workspaceRoot, {
        approvalFn,
        signal,
        // Daemon delegations are expected to run the full tool surface;
        // the approval gate above keeps high-risk exec commands behind
        // an explicit user decision. `execMode: 'auto'` mirrors the
        // non-delegated CLI engine's default, which gates only the
        // commands `isHighRiskCommand()` flags.
        allowExec: true,
        execMode: 'auto',
      });
      const resultText = typeof result?.text === 'string' ? result.text : '';
      if (result && result.ok === true) {
        return {
          kind: 'executed',
          resultText,
        };
      }
      // Tool ran to completion but reported failure. Feed the opaque
      // structured-error code into the kernel's mutation-failure
      // tracker via `errorType` so repeated same-tool+file failures
      // trigger the kernel's halt guard (`lib/coder-agent.ts`
      // ~line 1407).
      return {
        kind: 'executed',
        resultText,
        errorType: result?.structuredError?.code,
      };
    } catch (err) {
      // `executeToolCall` throwing is the rare exception path —
      // approval-timeout, abort during exec, catastrophic I/O. Surface
      // as a `denied` result so the kernel doesn't spin on the same
      // call forever. The kernel injects the `reason` into the next
      // user message so the model can react to it.
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'denied', reason: `daemon tool executor error: ${message}` };
    }
  };
}

/**
 * Build an Explorer-shaped tool executor bound to a running delegation.
 *
 * Mirrors `makeDaemonCoderToolExec` but returns the simpler Explorer
 * shape `{ resultText, card? }` instead of the Coder kernel's
 * discriminated union. Two other differences:
 *
 *   1. **No approval gating.** Explorer's contract is read-only — it
 *      inspects the workspace but never mutates it. High-risk exec is
 *      moot because the executor refuses mutating tools outright. We
 *      therefore skip `buildApprovalFn` entirely and pass
 *      `approvalFn: null` / `allowExec: false` to `executeToolCall`.
 *
 *   2. **Capability refusal.** Even with a read-only contract, the
 *      Explorer kernel still routes the optional `mutating` slot
 *      (returned by `wrapCliDetectAllToolCalls`) through `toolExec`
 *      when the model emits one — see `lib/explorer-agent.ts:470`.
 *      We call `roleCanUseTool('explorer', toolName)` inside the
 *      executor and return a polite denial `resultText` for any tool
 *      the Explorer role does not grant, so the kernel feeds the
 *      refusal back into the next round and the model can
 *      course-correct. This mirrors the web-side
 *      `ROLE_CAPABILITY_DENIED` check at
 *      `app/src/lib/web-tool-execution-runtime.ts:147` so both
 *      surfaces enforce via one shared capability table
 *      (`lib/capabilities.ts`). Gate swapped 2026-04-18 as part of
 *      the Gap 2 daemon-side role-capability tranche; the previous
 *      `READ_ONLY_TOOLS` allowlist still exists in `cli/tools.ts`
 *      because `lib/deep-reviewer-agent.ts` consumes it for a
 *      different purpose (read/mutation bucketing of detected tool
 *      calls).
 *
 * We skip `card` entirely. The web-side Explorer tool executor attaches
 * rich metadata cards pulled from structured tool output (e.g. a
 * `read_file` card with the file path + first N lines). Daemon-side we
 * don't have that layer yet, so the `card?` field is simply omitted —
 * the kernel handles `undefined` cards fine (see the `if (entry.card)`
 * guard around line 460).
 *
 * Non-goals (same as Coder): no sandbox layer, no OTel spans, no
 * `CapabilityLedger` gating, no `TurnPolicyRegistry`.
 */
export function makeDaemonExplorerToolExec({ entry, signal }) {
  const workspaceRoot = entry.state.cwd;
  return async (toolCall, _execCtx) => {
    // Unwrap the `{ source, call: { tool, args } }` shape produced by
    // `wrapCliDetectAllToolCalls` / `wrapCliDetectAnyToolCall`. Tests
    // that hand in a bare CLI call fall through unchanged.
    const rawCall =
      toolCall && typeof toolCall === 'object' && toolCall.call ? toolCall.call : toolCall;

    // Enforce the role capability grant. The Explorer kernel happily
    // routes a mutating slot through `toolExec` when the model emits
    // one — but Explorer is inspection-only by design. Return a denial
    // resultText so the kernel feeds the refusal back into the next
    // round as a user message and the model can adapt.
    //
    // Three-layer gate (deny if ANY layer says no):
    //   (1) `toolName` must be a non-empty string (defense against
    //       malformed detector output).
    //   (2) `isCapabilityMapped(toolName)` must be true — the name
    //       must have an own-property entry in `TOOL_CAPABILITIES`.
    //       This is stricter than `roleCanUseTool`'s documented
    //       fail-open semantics and diverges intentionally from the
    //       web runtime's fail-open behavior at
    //       `app/src/lib/web-tool-execution-runtime.ts:147`. The
    //       rationale (Copilot PR #331): if a new CLI tool ever
    //       reaches `executeToolCall` without a matching
    //       `TOOL_CAPABILITIES` entry, Explorer should refuse it at
    //       the gate rather than have `roleCanUseTool` fail-open and
    //       silently admit it. The web runtime has other layers that
    //       catch unknown names (per-source executor dispatch table);
    //       the daemon Explorer gate is closer to the model and
    //       should be fail-closed.
    //   (3) `roleCanUseTool('explorer', toolName)` must be true for
    //       the known tool. This is the core Gap 2 check.
    //
    // Layer (2) also defends against prototype-key attacks (`__proto__`,
    // `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
    // `isPrototypeOf`) — `getToolCapabilities` uses `Object.hasOwn`
    // to avoid resolving those to inherited prototype values, but
    // `isCapabilityMapped` belt-and-braces the same concern at the
    // gate. Codex review on PR #331.
    const toolName = typeof rawCall?.tool === 'string' ? rawCall.tool : null;
    if (!toolName || !isCapabilityMapped(toolName) || !roleCanUseTool('explorer', toolName)) {
      // Phrasing note: we deliberately do NOT name `delegate_coder`
      // here because Explorer cannot invoke it from inside the kernel
      // (delegation is an RPC initiated by the orchestrator / client,
      // not a tool the Explorer model can emit). Naming it would send
      // the model down a dead-end loop of trying to call it as a tool
      // (Copilot review on PR #284).
      //
      // Structured log so operators can grep for ROLE_CAPABILITY_DENIED
      // the same way they do on web. Console.warn keeps this out of
      // the session event protocol (no new event types) while still
      // giving observability parity with the web runtime's structured
      // error at `web-tool-execution-runtime.ts:152`.
      if (toolName) {
        const required = getToolCapabilities(toolName);
        const granted = Array.from(ROLE_CAPABILITIES.explorer ?? []);
        try {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'role_capability_denied',
              type: 'ROLE_CAPABILITY_DENIED',
              role: 'explorer',
              tool: toolName,
              required,
              granted,
              sessionId: entry?.sessionId ?? null,
            }),
          );
        } catch {
          // JSON.stringify cycle guard — don't let a malformed log
          // crash the executor.
        }
      }
      return {
        resultText: `[pushd] tool "${toolName ?? '(unknown)'}" is not available to Explorer. Explorer is read-only; if mutation is needed, report it in your summary and the orchestrator will request a Coder delegation after you finish.`,
      };
    }

    try {
      const result = await executeToolCall(rawCall, workspaceRoot, {
        // Explorer never gates on approvals — it's read-only.
        approvalFn: null,
        signal,
        // `allowExec: false` keeps the tool surface genuinely read-only
        // even if the capability table ever accidentally grants an
        // exec-family tool to Explorer. Defense in depth behind
        // `roleCanUseTool`.
        allowExec: false,
        execMode: 'auto',
      });
      const resultText = typeof result?.text === 'string' ? result.text : '';
      return { resultText };
    } catch (err) {
      // `executeToolCall` throwing is the rare exception path (abort
      // during read, catastrophic I/O). Surface the message as a
      // resultText so the kernel can see what went wrong rather than
      // crashing the delegation. Matches Coder's "don't spin forever"
      // stance.
      const message = err instanceof Error ? err.message : String(err);
      return { resultText: `[pushd] Explorer tool executor error: ${message}` };
    }
  };
}

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
  const daemonStreamFn = createDaemonProviderStream(provider, sessionId);

  // Splice graph-internal memory (from executeTaskGraph's
  // enrichedContext) and typed-memory retrieval blocks into the
  // task preamble. The model sees them as part of the task
  // description, separated by blank lines — matches how web's
  // role-memory-context.appendRetrievedMemoryBlock concatenates.
  const taskPreamble = [node.task, ...preambleExtras].filter(Boolean).join('\n\n');

  const result = await runExplorerAgent(
    {
      provider,
      streamFn: daemonStreamFn,
      modelId: model,
      sandboxId: null,
      allowedRepo: '',
      userProfile: null,
      taskPreamble,
      symbolSummary: null,
      toolExec,
      detectAllToolCalls: wrapCliDetectAllToolCalls,
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
      evaluateAfterModel,
    },
    {
      onStatus: () => {},
      signal,
    },
  );

  const delegationOutcome = {
    agent: 'explorer',
    status: 'complete',
    summary: result.summary,
    evidence: [],
    checks: [],
    gateVerdicts: [],
    missingRequirements: [],
    nextRequiredAction: null,
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
  const daemonStreamFn = createDaemonProviderStream(provider, sessionId);
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
      streamFn: daemonStreamFn,
      modelId: model,
      sandboxId: '',
      allowedRepo: '',
      userProfile: null,
      taskPreamble,
      symbolSummary: null,
      toolExec,
      detectAllToolCalls: wrapCliDetectAllToolCalls,
      detectAnyToolCall: wrapCliDetectAnyToolCall,
      webSearchToolProtocol: '',
      // `sandboxToolProtocol` is the tool-instruction block the kernel
      // splices into its system prompt — without it the model has no
      // guidance on what tool-call JSON to emit (codex P1 on PR #282).
      // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
      // non-delegated CLI engine uses.
      sandboxToolProtocol: TOOL_PROTOCOL,
      verificationPolicyBlock: null,
      approvalModeBlock: null,
      evaluateAfterModel,
    },
    {
      onStatus: () => {},
      signal,
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
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
    // chatId deliberately omitted from the scope — see the same
    // comment in delegation-entry.ts. Pushd's sessionId is also
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
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

// ─── Delegation event replay ────────────────────────────────────

async function handleFetchDelegationEvents(req) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const providedToken = req.payload?.attachToken;
  const subagentId = req.payload?.subagentId;
  const childRunId = req.payload?.childRunId;
  const sinceSeq = req.payload?.sinceSeq;
  const limit = req.payload?.limit;

  if (!sessionId) {
    return makeErrorResponse(
      req.requestId,
      'fetch_delegation_events',
      'INVALID_REQUEST',
      'sessionId is required',
    );
  }

  if (!subagentId && !childRunId) {
    return makeErrorResponse(
      req.requestId,
      'fetch_delegation_events',
      'INVALID_REQUEST',
      'At least one of subagentId or childRunId is required',
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
      entry = { state, attachToken: state.attachToken };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(
        req.requestId,
        'fetch_delegation_events',
        'SESSION_NOT_FOUND',
        `Session not found: ${sessionId}`,
      );
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(
      req.requestId,
      'fetch_delegation_events',
      'INVALID_TOKEN',
      'Invalid or missing attach token',
    );
  }

  const allEvents = await loadSessionEvents(sessionId);

  let filtered = allEvents.filter((e) => {
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    if (subagentId && p.subagentId === subagentId) return true;
    if (subagentId && p.executionId === subagentId) return true;
    if (childRunId && p.childRunId === childRunId) return true;
    if (childRunId && e.runId === childRunId) return true;
    return false;
  });

  if (typeof sinceSeq === 'number' && Number.isFinite(sinceSeq)) {
    filtered = filtered.filter((e) => e.seq > sinceSeq);
  }

  const fromSeq = filtered.length > 0 ? filtered[0].seq : 0;

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  const toSeq = filtered.length > 0 ? filtered[filtered.length - 1].seq : fromSeq;

  return makeResponse(req.requestId, 'fetch_delegation_events', sessionId, true, {
    events: filtered,
    replay: {
      fromSeq,
      toSeq,
      completed: true,
    },
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
 * The capability flag is `delegation_explorer_v1`, not `multi_agent`. Flipping
 * `multi_agent` still blocks on (a) a real daemon-side tool executor and
 * (b) at least one other role (Coder) wired.
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
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
      const daemonStreamFn = createDaemonProviderStream(resolvedProvider, sessionId);
      const result = await runExplorerAgent(
        {
          provider: resolvedProvider,
          streamFn: daemonStreamFn,
          modelId: resolvedModel,
          sandboxId: null,
          allowedRepo,
          userProfile: null,
          taskPreamble: trimmedTask,
          symbolSummary: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
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
        status: 'complete',
        summary: result.summary,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
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
 * `policyPost` drives the kernel's halt guard). Explorer still runs
 * through the scaffold executor — its real tool wiring is a follow-up.
 *
 * Provider / model resolution honours `entry.state.roleRouting.coder` —
 * set via `configure_role_routing` — and falls back to session defaults
 * otherwise. The resolved values feed both the daemon stream adapter and
 * the `modelId` option on the kernel.
 *
 * Capability flag: `delegation_coder_v1`. Flipping `multi_agent` still
 * needs (a) real explorer tool execution and (b) the v1 synthetic
 * downgrade path — both are separate follow-up slices, not blockers for
 * this handler.
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
      const daemonStreamFn = createDaemonProviderStream(resolvedProvider, sessionId);
      const result = await runCoderAgent(
        {
          provider: resolvedProvider,
          streamFn: daemonStreamFn,
          modelId: resolvedModel,
          sandboxId: '',
          allowedRepo,
          userProfile: null,
          taskPreamble: trimmedTask,
          symbolSummary: null,
          toolExec,
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
          webSearchToolProtocol: '',
          // `sandboxToolProtocol` is the tool-instruction block the kernel
          // splices into its system prompt — without it the model has no
          // guidance on what tool-call JSON to emit (codex P1 on PR #282).
          // Feed in `TOOL_PROTOCOL` from `cli/tools.ts`, the same block the
          // non-delegated CLI engine uses.
          sandboxToolProtocol: TOOL_PROTOCOL,
          verificationPolicyBlock: null,
          approvalModeBlock: null,
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
      // Legacy sessions without a persisted token fall through the bypass
      // in `validateAttachToken` (`!entry.attachToken → return true`).
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
      const baseStreamFn = createDaemonProviderStream(resolvedProvider, sessionId);
      // runReviewer doesn't forward a signal through the 12-arg envelope —
      // it calls streamFn with 9 positional args. Wrap the adapter so that
      // arg 11 (signal) is always the handler's abort signal, giving
      // cancel_delegation a clean AbortError path through streamCompletion.
      const signalAwareStreamFn = (
        messages,
        onToken,
        onDone,
        onError,
        onThinkingToken,
        workspaceContext,
        hasSandbox,
        modelOverride,
        systemPromptOverride,
        scratchpadContent,
        _ignoredSignal,
        onPreCompact,
      ) =>
        baseStreamFn(
          messages,
          onToken,
          onDone,
          onError,
          onThinkingToken,
          workspaceContext,
          hasSandbox,
          modelOverride,
          systemPromptOverride,
          scratchpadContent,
          abortController.signal,
          onPreCompact,
        );

      reviewResult = await runReviewer(
        diff,
        {
          provider: resolvedProvider,
          streamFn: signalAwareStreamFn,
          modelId: resolvedModel,
          context: rawContext,
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

// ─── Request dispatcher ──────────────────────────────────────────

const HANDLERS = {
  hello: handleHello,
  ping: handlePing,
  list_sessions: handleListSessions,
  start_session: handleStartSession,
  send_user_message: handleSendUserMessage,
  attach_session: handleAttachSession,
  submit_approval: handleSubmitApproval,
  cancel_run: handleCancelRun,
  configure_role_routing: handleConfigureRoleRouting,
  submit_task_graph: handleSubmitTaskGraph,
  delegate_explorer: handleDelegateExplorer,
  delegate_coder: handleDelegateCoder,
  delegate_reviewer: handleDelegateReviewer,
  cancel_delegation: handleCancelDelegation,
  fetch_delegation_events: handleFetchDelegationEvents,
};

export async function handleRequest(req, emitEvent) {
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

  try {
    return await handler(req, emitEvent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeErrorResponse(req.requestId, req.type, 'INTERNAL_ERROR', message);
  }
}

// ─── Connection handling ─────────────────────────────────────────

function handleConnection(socket) {
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

  socket.on('close', () => {
    for (const sessionId of attachedSessions) {
      removeSessionClient(sessionId, emitEvent);
    }
    attachedSessions.clear();
  });

  socket.on('error', () => {
    for (const sessionId of attachedSessions) {
      removeSessionClient(sessionId, emitEvent);
    }
    attachedSessions.clear();
  });
}

// ─── Crash recovery ──────────────────────────────────────────────

/**
 * Scan for sessions with run markers (interrupted by daemon crash).
 * For each, check restart policy and optionally re-enter the assistant loop.
 *
 * Recovery injects a [SESSION_RECOVERED] reconciliation message so the model
 * knows context was interrupted and can adjust.
 */
/**
 * Scan a session event log and return delegations/task-graphs that were
 * tied to the given parent run but never reached a terminal event. Used by
 * crash recovery to build the `[DELEGATION_INTERRUPTED]` reconciliation note.
 *
 * A subagent delegation is "orphaned" if there is a `subagent.started` event
 * whose `payload.parentRunId === parentRunId` AND no matching
 * `subagent.completed` / `subagent.failed` for the same `subagentId`.
 *
 * A task graph is "orphaned" if there is any `task_graph.*` event whose
 * envelope `runId === parentRunId` AND no matching `task_graph.graph_completed`
 * for the same `executionId`.
 *
 * We deliberately restrict to events bound to the interrupted parent run —
 * older fire-and-forget failures from prior runs are not this recovery's
 * problem.
 */
export function collectOrphanedDelegations(events, parentRunId) {
  const startedSubagents = new Map(); // subagentId -> { agent }
  const terminatedSubagents = new Set(); // subagentId
  const seenGraphs = new Map(); // executionId -> true
  const completedGraphs = new Set(); // executionId

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const payload = event.payload || {};

    if (event.type === 'subagent.started') {
      if (payload.parentRunId !== parentRunId) continue;
      const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
      if (!subagentId) continue;
      startedSubagents.set(subagentId, {
        agent: typeof payload.agent === 'string' ? payload.agent : 'subagent',
      });
      continue;
    }
    if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      const subagentId = typeof payload.subagentId === 'string' ? payload.subagentId : null;
      if (subagentId) terminatedSubagents.add(subagentId);
      continue;
    }
    if (event.type.startsWith('task_graph.')) {
      if (event.runId !== parentRunId) continue;
      const executionId = typeof payload.executionId === 'string' ? payload.executionId : null;
      if (!executionId) continue;
      if (event.type === 'task_graph.graph_completed') {
        completedGraphs.add(executionId);
      } else {
        seenGraphs.set(executionId, true);
      }
      continue;
    }
  }

  const orphanedSubagents = [];
  for (const [subagentId, meta] of startedSubagents) {
    if (!terminatedSubagents.has(subagentId)) {
      orphanedSubagents.push({ subagentId, agent: meta.agent });
    }
  }

  const orphanedGraphs = [];
  for (const [executionId] of seenGraphs) {
    if (!completedGraphs.has(executionId)) {
      orphanedGraphs.push({ executionId });
    }
  }

  return { subagents: orphanedSubagents, graphs: orphanedGraphs };
}

/**
 * Build the `[DELEGATION_INTERRUPTED]` reconciliation note injected into the
 * message history on recovery. Returns null if nothing was orphaned.
 */
export function formatDelegationInterruptedNote(orphans) {
  const { subagents, graphs } = orphans;
  if (subagents.length === 0 && graphs.length === 0) return null;
  const lines = ['[DELEGATION_INTERRUPTED]'];
  lines.push(
    'One or more sub-agents launched during the interrupted run never reported a terminal result.',
  );
  if (subagents.length > 0) {
    lines.push('Unfinished delegations:');
    for (const { subagentId, agent } of subagents) {
      lines.push(`  - ${agent} (${subagentId})`);
    }
  }
  if (graphs.length > 0) {
    lines.push('Unfinished task graphs:');
    for (const { executionId } of graphs) {
      lines.push(`  - ${executionId}`);
    }
  }
  lines.push(
    'Assume their work is lost. If you still need their results, re-delegate explicitly — do not wait for ghost completions.',
  );
  lines.push('[/DELEGATION_INTERRUPTED]');
  return lines.join('\n');
}

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
    // they originally received from `start_session`. Legacy sessions that
    // have no persisted token fall through `validateAttachToken`'s bypass.
    const attachToken = state.attachToken;

    // Register in-memory
    const entry = { state, attachToken, activeRunId: recoveryRunId, abortController };
    activeSessions.set(sessionId, entry);

    // Inject reconciliation message so the model knows it was interrupted
    state.messages.push({
      role: 'user',
      content: `[SESSION_RECOVERED]\nThe previous run (${marker.runId}) was interrupted by a daemon crash.\nYou are resuming in a new run (${recoveryRunId}). Review your working memory and continue where you left off.\nDo NOT restart from scratch — pick up from the last completed step.\n[/SESSION_RECOVERED]`,
    });

    // Crash recovery is narrow: we recover the parent only. Any sub-agents or
    // task graphs that were in-flight when the daemon died are lost. Detect
    // them from the event log and append a DELEGATION_INTERRUPTED note so the
    // recovered parent Orchestrator re-delegates rather than waiting on ghost
    // completions that will never arrive.
    let orphans = { subagents: [], graphs: [] };
    try {
      const events = await loadSessionEvents(sessionId);
      orphans = collectOrphanedDelegations(events, marker.runId);
    } catch {
      // Event-log scan is best-effort — if we can't read it, skip the note.
    }
    const interruptedNote = formatDelegationInterruptedNote(orphans);
    if (interruptedNote) {
      state.messages.push({ role: 'user', content: interruptedNote });
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
        await runAssistantLoop(state, providerConfig, apiKey, DEFAULT_MAX_ROUNDS, {
          runId: recoveryRunId,
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
        });
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

  // Wire a file-backed ContextMemoryStore so typed memory records
  // written by task-graph node completions (see handleSubmitTaskGraph)
  // persist across pushd restarts. The in-memory default would lose
  // all history on SIGTERM/restart, which defeats the "memory" in
  // typed memory. See Gap 3 Step 3 in the Architecture Remediation
  // Plan for context.
  setDefaultMemoryStore(createFileMemoryStore({ baseDir: getMemoryStoreBaseDir() }));

  const server = net.createServer(handleConnection);

  const oldUmask = process.umask(0o077);
  server.listen(socketPath, () => {
    process.umask(oldUmask);
    process.stdout.write(`pushd listening on ${socketPath}\n`);
    process.stdout.write(`protocol: ${PROTOCOL_VERSION}\n`);
    process.stdout.write(`version: ${VERSION}\n`);
    process.stdout.write(`pid: ${process.pid}\n`);
  });

  server.on('listening', async () => {
    try {
      await writePidFile();
      await fs.chmod(socketPath, 0o600);
    } catch {
      // non-fatal
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

    // Abort all active runs
    for (const [, entry] of activeSessions) {
      if (entry.abortController) {
        entry.abortController.abort();
      }
      if (entry.pendingApproval) {
        clearTimeout(entry.pendingApproval.timer);
        entry.pendingApproval.resolve('deny');
      }
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
