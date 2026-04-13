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
import { buildSystemPrompt, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.js';
import { appendUserMessageWithFileReferences } from './file-references.js';
import { runExplorerAgent } from '../lib/explorer-agent.ts';
import { runReviewer } from '../lib/reviewer-agent.ts';
import { buildReviewerContextBlock } from '../lib/role-context.ts';

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

function makeResponse(requestId, type, sessionId, ok, payload, error = null) {
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

function makeErrorResponse(requestId, type, code, message, retryable = false) {
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

function normalizeProviderInput(value) {
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

      entry.pendingApproval = { approvalId, resolve, reject, timer };
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

// sessionId → Set<emitFn>
const sessionClients = new Map();

function addSessionClient(sessionId, emitFn) {
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Set());
  }
  sessionClients.get(sessionId).add(emitFn);
}

function removeSessionClient(sessionId, emitFn) {
  const clients = sessionClients.get(sessionId);
  if (clients) {
    clients.delete(emitFn);
    if (clients.size === 0) sessionClients.delete(sessionId);
  }
}

function broadcastEvent(sessionId, event) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const emitFn of clients) {
    try {
      emitFn(event);
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
      entry = { state, attachToken: makeAttachToken() };
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
      await runAssistantLoop(state, providerConfig, apiKey, DEFAULT_MAX_ROUNDS, {
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
  const { sessionId, lastSeenSeq, attachToken: providedToken } = req.payload || {};
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
      entry = { state, attachToken: makeAttachToken() };
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

  // Register this client for multi-client fan-out
  addSessionClient(sessionId, emitEvent);

  const { state } = entry;
  const currentSeq = state.eventSeq;
  const fromSeq = (lastSeenSeq || 0) + 1;

  // Replay missed events from disk
  try {
    const allEvents = await loadSessionEvents(sessionId);
    const missed = allEvents.filter((e) => e.seq >= fromSeq && e.seq <= currentSeq);
    for (const event of missed) {
      emitEvent(event);
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

  // Emit approval_received to all clients
  const eventPayload = { approvalId, decision, by: 'client' };
  await appendSessionEvent(entry.state, 'approval_received', eventPayload, entry.activeRunId);
  // Build envelope after appendSessionEvent so seq matches the persisted event
  broadcastEvent(sessionId, {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: entry.activeRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'approval_received',
    payload: eventPayload,
  });

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
      entry = { state, attachToken: makeAttachToken() };
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

async function handleSubmitTaskGraph(req) {
  return makeErrorResponse(
    req.requestId,
    'submit_task_graph',
    'NOT_IMPLEMENTED',
    'Task graph execution is not yet available (Phase 6B)',
    false,
  );
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
      entry = { state, attachToken: makeAttachToken() };
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

  if (!delegation) {
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
      entry = { state, attachToken: makeAttachToken() };
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
      entry = { state, attachToken: makeAttachToken() };
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
    const emptyDetection = { readOnly: [], mutating: null, extraMutations: [] };
    const stubDetectAllToolCalls = () => emptyDetection;
    const stubDetectAnyToolCall = () => null;
    const stubToolExec = async () => ({
      resultText: '[pushd scaffold] daemon-side Explorer tool execution is not yet wired',
    });
    const stubEvaluateAfterModel = async () => null;

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
          toolExec: stubToolExec,
          detectAllToolCalls: stubDetectAllToolCalls,
          detectAnyToolCall: stubDetectAnyToolCall,
          webSearchToolProtocol: '',
          evaluateAfterModel: stubEvaluateAfterModel,
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
        status: 'inconclusive',
        summary: result.summary,
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [
          'Daemon-side Explorer tool executor (stubbed in handleDelegateExplorer)',
        ],
        nextRequiredAction:
          'Wire a real daemon Explorer tool executor before advertising multi_agent',
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
          ? 'Explorer cancelled during daemon scaffold run.'
          : `Explorer failed during daemon scaffold run: ${message}`,
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
      entry = { state, attachToken: makeAttachToken() };
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
            addSessionClient(sid, emitEvent);
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
    const attachToken = makeAttachToken();

    // Register in-memory
    const entry = { state, attachToken, activeRunId: recoveryRunId, abortController };
    activeSessions.set(sessionId, entry);

    // Inject reconciliation message so the model knows it was interrupted
    state.messages.push({
      role: 'user',
      content: `[SESSION_RECOVERED]\nThe previous run (${marker.runId}) was interrupted by a daemon crash.\nYou are resuming in a new run (${recoveryRunId}). Review your working memory and continue where you left off.\nDo NOT restart from scratch — pick up from the last completed step.\n[/SESSION_RECOVERED]`,
    });

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

// Only run main() when executed directly (not when imported)
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('/pushd.ts') || process.argv[1].endsWith('\\pushd.ts'));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
