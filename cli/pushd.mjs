#!/usr/bin/env node
/**
 * pushd — Push daemon (Track 4)
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
 */
import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

import { PROVIDER_CONFIGS, resolveApiKey } from './provider.mjs';
import {
  makeSessionId,
  makeRunId,
  saveSessionState,
  appendSessionEvent,
  loadSessionState,
  loadSessionEvents,
  listSessions,
  PROTOCOL_VERSION,
} from './session-store.mjs';
import { buildSystemPrompt, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.mjs';
import { appendUserMessageWithFileReferences } from './file-references.mjs';

const VERSION = '0.2.0';
const CAPABILITIES = ['stream_tokens', 'approvals', 'replay_attach', 'multi_client'];

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
  try { await fs.unlink(getPidPath()); } catch { /* ignore */ }
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
  return makeResponse(requestId, type, null, false, {}, {
    code,
    message,
    retryable,
  });
}

// ─── Token validation ─────────────────────────────────────────────

export function validateAttachToken(entry, providedToken) {
  if (!entry || !entry.attachToken) return true;
  if (typeof providedToken !== 'string' || !providedToken) return false;
  return entry.attachToken === providedToken;
}

// ─── Session registry (in-memory) ────────────────────────────────

// sessionId → { state, attachToken, abortController?, activeRunId?, pendingApproval? }
const activeSessions = new Map();

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
    try { emitFn(event); } catch { /* client may have disconnected */ }
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
    return makeErrorResponse(req.requestId, 'start_session', 'PROVIDER_NOT_CONFIGURED', `Unknown provider: ${provider}`);
  }

  const cwd = payload.repo?.rootPath || process.cwd();
  const model = payload.model || PROVIDER_CONFIGS[provider].defaultModel;
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
  });
}

async function handleSendUserMessage(req, emitEvent) {
  const sessionId = req.sessionId || req.payload?.sessionId;
  const text = req.payload?.text;

  if (!sessionId || !text) {
    return makeErrorResponse(req.requestId, 'send_user_message', 'INVALID_REQUEST', 'sessionId and text are required');
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: makeAttachToken() };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(req.requestId, 'send_user_message', 'SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
  }

  // Reject if a run is already in progress
  if (entry.activeRunId) {
    return makeErrorResponse(req.requestId, 'send_user_message', 'RUN_IN_PROGRESS', `Run ${entry.activeRunId} is already active`);
  }

  const providedToken = req.payload?.attachToken;
  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(req.requestId, 'send_user_message', 'INVALID_TOKEN', 'Invalid or missing attach token');
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
  await appendSessionEvent(state, 'user_message', { chars: text.length, preview: text.slice(0, 280) }, runId);

  const providerConfig = PROVIDER_CONFIGS[state.provider];
  let apiKey;
  try {
    apiKey = resolveApiKey(providerConfig);
  } catch (err) {
    entry.activeRunId = null;
    entry.abortController = null;
    return makeErrorResponse(req.requestId, 'send_user_message', 'PROVIDER_NOT_CONFIGURED', err.message);
  }

  // Approval function that emits approval_required and awaits client decision
  const approvalFn = async (tool, detail) => {
    const approvalId = makeApprovalId();

    const approvalPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingApproval = null;
        reject(new Error('Approval timed out'));
      }, APPROVAL_TIMEOUT_MS);

      entry.pendingApproval = { approvalId, resolve, reject, timer };
    });

    // Emit approval_required to all clients
    const approvalEvent = {
      v: PROTOCOL_VERSION,
      kind: 'event',
      sessionId,
      runId,
      seq: state.eventSeq,
      ts: Date.now(),
      type: 'approval_required',
      payload: {
        approvalId,
        kind: tool?.tool || 'tool_execution',
        title: `Approve ${tool?.tool || 'action'}`,
        summary: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
        options: ['approve', 'deny'],
      },
    };
    await appendSessionEvent(state, 'approval_required', approvalEvent.payload, runId);
    broadcastEvent(sessionId, approvalEvent);

    try {
      const decision = await approvalPromise;
      return decision === 'approve';
    } catch {
      return false;
    }
  };

  // Run in background — broadcast events to all attached clients
  (async () => {
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
        await appendSessionEvent(state, 'error', {
          code: 'INTERNAL_ERROR',
          message,
          retryable: false,
        }, runId);
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
        await appendSessionEvent(state, 'run_complete', {
          runId,
          outcome: 'failed',
          summary: message.slice(0, 500),
        }, runId);
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
      entry.pendingApproval = null;
    }
  })();

  return ack;
}

async function handleAttachSession(req, emitEvent) {
  const { sessionId, lastSeenSeq, attachToken: providedToken } = req.payload || {};
  if (!sessionId) {
    return makeErrorResponse(req.requestId, 'attach_session', 'INVALID_REQUEST', 'sessionId is required');
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: makeAttachToken() };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(req.requestId, 'attach_session', 'SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
  }

  if (!validateAttachToken(entry, providedToken)) {
    return makeErrorResponse(req.requestId, 'attach_session', 'INVALID_TOKEN', 'Invalid or missing attach token');
  }

  // Register this client for multi-client fan-out
  addSessionClient(sessionId, emitEvent);

  const { state } = entry;
  const currentSeq = state.eventSeq;
  const fromSeq = (lastSeenSeq || 0) + 1;

  // Replay missed events from disk
  try {
    const allEvents = await loadSessionEvents(sessionId);
    const missed = allEvents.filter(e => e.seq >= fromSeq && e.seq <= currentSeq);
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
    return makeErrorResponse(req.requestId, 'submit_approval', 'INVALID_REQUEST', 'sessionId, approvalId, and decision are required');
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return makeErrorResponse(req.requestId, 'submit_approval', 'SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
  }

  const pending = entry.pendingApproval;
  if (!pending || pending.approvalId !== approvalId) {
    return makeErrorResponse(req.requestId, 'submit_approval', 'APPROVAL_NOT_FOUND', `No pending approval with id: ${approvalId}`);
  }

  clearTimeout(pending.timer);
  entry.pendingApproval = null;
  pending.resolve(decision);

  // Emit approval_received to all clients
  const event = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId,
    runId: entry.activeRunId,
    seq: entry.state.eventSeq,
    ts: Date.now(),
    type: 'approval_received',
    payload: { approvalId, decision, by: 'client' },
  };
  await appendSessionEvent(entry.state, 'approval_received', event.payload, entry.activeRunId);
  broadcastEvent(sessionId, event);

  return makeResponse(req.requestId, 'submit_approval', sessionId, true, {
    accepted: true,
  });
}

async function handleCancelRun(req) {
  const { sessionId, runId } = req.payload || {};
  if (!sessionId) {
    return makeErrorResponse(req.requestId, 'cancel_run', 'INVALID_REQUEST', 'sessionId is required');
  }

  const entry = activeSessions.get(sessionId);
  if (!entry) {
    return makeErrorResponse(req.requestId, 'cancel_run', 'SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
  }

  if (!entry.activeRunId) {
    return makeErrorResponse(req.requestId, 'cancel_run', 'NO_ACTIVE_RUN', 'No active run to cancel');
  }

  if (runId && entry.activeRunId !== runId) {
    return makeErrorResponse(req.requestId, 'cancel_run', 'NO_ACTIVE_RUN', `Run ${runId} is not the active run`);
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
};

async function handleRequest(req, emitEvent) {
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
          const sid = response.sessionId || response.payload?.sessionId || req.sessionId || req.payload?.sessionId;
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
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('/pushd.mjs') ||
  process.argv[1].endsWith('\\pushd.mjs')
);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
