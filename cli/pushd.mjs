#!/usr/bin/env node
/**
 * pushd — Push daemon skeleton (W4)
 *
 * Minimal local IPC daemon that reuses the same engine as the CLI.
 * Transport: Unix domain socket, NDJSON (one JSON object per line).
 *
 * Supported request types:
 *   hello            — handshake + capability negotiation
 *   start_session    — create a new session
 *   send_user_message — start a run from user input
 *   attach_session   — attach to existing session (replay stub)
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
  listSessions,
  PROTOCOL_VERSION,
} from './session-store.mjs';
import { buildSystemPrompt, runAssistantLoop, DEFAULT_MAX_ROUNDS } from './engine.mjs';

const VERSION = '0.1.0';
const CAPABILITIES = ['stream_tokens', 'approvals'];

// ─── Socket path ─────────────────────────────────────────────────

function getSocketPath() {
  if (process.env.PUSHD_SOCKET) return process.env.PUSHD_SOCKET;
  const pushDir = path.join(os.homedir(), '.push', 'run');
  return path.join(pushDir, 'pushd.sock');
}

async function ensureSocketDir(socketPath) {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
}

async function cleanStaleSocket(socketPath) {
  try {
    await fs.unlink(socketPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ─── Request ID ──────────────────────────────────────────────────

function makeRequestId() {
  return `req_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function makeAttachToken() {
  return `att_${randomBytes(8).toString('hex')}`;
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

// ─── Session registry (in-memory) ────────────────────────────────

const activeSessions = new Map(); // sessionId → { state, attachToken }

// ─── Request handlers ────────────────────────────────────────────

async function handleHello(req) {
  return makeResponse(req.requestId, 'hello', null, true, {
    runtimeName: 'pushd',
    runtimeVersion: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: CAPABILITIES,
  });
}

async function handleStartSession(req) {
  const payload = req.payload || {};
  const provider = payload.provider || 'ollama';
  if (!PROVIDER_CONFIGS[provider]) {
    return makeErrorResponse(req.requestId, 'start_session', 'PROVIDER_NOT_CONFIGURED', `Unknown provider: ${provider}`);
  }

  const cwd = payload.repo?.rootPath || process.cwd();
  const model = PROVIDER_CONFIGS[provider].defaultModel;
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
    messages: [{ role: 'system', content: buildSystemPrompt(cwd) }],
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
  const { sessionId, text } = req.payload || {};
  if (!sessionId || !text) {
    return makeErrorResponse(req.requestId, 'send_user_message', 'INVALID_REQUEST', 'sessionId and text are required');
  }

  let entry = activeSessions.get(sessionId);
  if (!entry) {
    // Try loading from disk
    try {
      const state = await loadSessionState(sessionId);
      entry = { state, attachToken: makeAttachToken() };
      activeSessions.set(sessionId, entry);
    } catch {
      return makeErrorResponse(req.requestId, 'send_user_message', 'SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
  }

  const { state } = entry;
  const runId = makeRunId();

  // Acknowledge immediately
  const ack = makeResponse(req.requestId, 'send_user_message', sessionId, true, {
    runId,
    accepted: true,
  });

  // Run the assistant loop asynchronously
  state.messages.push({ role: 'user', content: text });
  await appendSessionEvent(state, 'user_message', { chars: text.length, preview: text.slice(0, 280) }, runId);

  const providerConfig = PROVIDER_CONFIGS[state.provider];
  let apiKey;
  try {
    apiKey = resolveApiKey(providerConfig);
  } catch (err) {
    return makeErrorResponse(req.requestId, 'send_user_message', 'PROVIDER_NOT_CONFIGURED', err.message);
  }

  // Run in background — emit events as they happen
  (async () => {
    try {
      const result = await runAssistantLoop(state, providerConfig, apiKey, DEFAULT_MAX_ROUNDS, false);
      await saveSessionState(state);
      // Emit run_complete event to attached clients
      emitEvent({
        v: PROTOCOL_VERSION,
        kind: 'event',
        sessionId,
        runId,
        seq: state.eventSeq + 1,
        ts: Date.now(),
        type: 'run_complete',
        payload: {
          runId,
          outcome: result.outcome === 'success' ? 'success' : 'failed',
          summary: result.finalAssistantText.slice(0, 500),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await appendSessionEvent(state, 'error', {
        code: 'INTERNAL_ERROR',
        message,
        retryable: false,
      }, runId);
      await saveSessionState(state);
    }
  })();

  return ack;
}

async function handleAttachSession(req) {
  const { sessionId, lastSeenSeq } = req.payload || {};
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

  const { state } = entry;
  const currentSeq = state.eventSeq;
  const fromSeq = (lastSeenSeq || 0) + 1;

  return makeResponse(req.requestId, 'attach_session', sessionId, true, {
    sessionId,
    state: 'idle',
    replay: {
      fromSeq,
      toSeq: currentSeq,
      completed: true,
      gap: fromSeq > currentSeq + 1,
    },
  });
}

// ─── Request dispatcher ──────────────────────────────────────────

const HANDLERS = {
  hello: handleHello,
  start_session: handleStartSession,
  send_user_message: handleSendUserMessage,
  attach_session: handleAttachSession,
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

  // Event emitter for this connection
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

  socket.on('error', () => {
    // silently close on error
  });
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const socketPath = getSocketPath();
  await ensureSocketDir(socketPath);
  await cleanStaleSocket(socketPath);

  const server = net.createServer(handleConnection);

  server.listen(socketPath, () => {
    process.stdout.write(`pushd listening on ${socketPath}\n`);
    process.stdout.write(`protocol: ${PROTOCOL_VERSION}\n`);
    process.stdout.write(`version: ${VERSION}\n`);
  });

  // Set owner-only permissions on socket
  server.on('listening', async () => {
    try {
      await fs.chmod(socketPath, 0o600);
    } catch {
      // non-fatal
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    process.stdout.write('\nshutting down...\n');
    server.close();
    await cleanStaleSocket(socketPath);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err) => {
    process.stderr.write(`Server error: ${err.message}\n`);
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
