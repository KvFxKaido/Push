import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const PROTOCOL_VERSION = 'push.runtime.v1';

export function makeSessionId() {
  return `sess_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function makeRunId() {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function getSessionRoot() {
  return process.env.PUSH_SESSION_DIR || path.join(process.cwd(), '.push', 'sessions');
}

export function getSessionDir(sessionId) {
  return path.join(getSessionRoot(), sessionId);
}

function getStatePath(sessionId) {
  return path.join(getSessionDir(sessionId), 'state.json');
}

function getEventsPath(sessionId) {
  return path.join(getSessionDir(sessionId), 'events.jsonl');
}

async function ensureSessionDir(sessionId) {
  await fs.mkdir(getSessionDir(sessionId), { recursive: true });
}

export async function saveSessionState(state) {
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId);
  await fs.writeFile(getStatePath(state.sessionId), JSON.stringify(state, null, 2), 'utf8');
}

export async function appendSessionEvent(state, type, payload, runId = null) {
  state.eventSeq += 1;
  state.updatedAt = Date.now();
  const event = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    sessionId: state.sessionId,
    ...(runId ? { runId } : {}),
    seq: state.eventSeq,
    ts: Date.now(),
    type,
    payload,
  };
  await ensureSessionDir(state.sessionId);
  await fs.appendFile(getEventsPath(state.sessionId), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function loadSessionState(sessionId) {
  const raw = await fs.readFile(getStatePath(sessionId), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) {
    throw new Error(`Invalid session state: ${sessionId}`);
  }
  return parsed;
}

export async function listSessions() {
  const root = getSessionRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(root, entry.name, 'state.json');
      try {
        const raw = await fs.readFile(statePath, 'utf8');
        const state = JSON.parse(raw);
        rows.push({
          sessionId: state.sessionId,
          updatedAt: state.updatedAt,
          provider: state.provider,
          model: state.model,
          cwd: state.cwd,
        });
      } catch {
        // ignore malformed sessions
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
