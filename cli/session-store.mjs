import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const PROTOCOL_VERSION = 'push.runtime.v1';

// Session IDs must match the output of makeSessionId(): sess_<base36>_<6 hex chars>
export const SESSION_ID_RE = /^sess_[a-z0-9]+_[a-f0-9]{6}$/;

export function validateSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session id: ${typeof sessionId === 'string' ? sessionId : typeof sessionId}`);
  }
  return sessionId;
}

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
  validateSessionId(sessionId);
  const root = path.resolve(getSessionRoot());
  const dir = path.resolve(root, sessionId);
  // Belt-and-suspenders: even if the regex is bypassed, prevent path traversal
  if (!dir.startsWith(`${root}${path.sep}`) && dir !== root) {
    throw new Error('Session dir escapes session root');
  }
  return dir;
}

function getStatePath(sessionId) {
  return path.join(getSessionDir(sessionId), 'state.json');
}

function getEventsPath(sessionId) {
  return path.join(getSessionDir(sessionId), 'events.jsonl');
}

async function ensureSessionDir(sessionId) {
  const dir = getSessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Ensure permissions even if dir already existed with looser perms
  await fs.chmod(dir, 0o700);
}

export async function saveSessionState(state) {
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId);
  await fs.writeFile(getStatePath(state.sessionId), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
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
  await fs.appendFile(getEventsPath(state.sessionId), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function loadSessionState(sessionId) {
  const raw = await fs.readFile(getStatePath(sessionId), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) {
    throw new Error(`Invalid session state: ${sessionId}`);
  }
  return parsed;
}

export async function loadSessionEvents(sessionId) {
  const eventsPath = getEventsPath(sessionId);
  try {
    const raw = await fs.readFile(eventsPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function listSessions() {
  const root = getSessionRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip entries that don't match valid session id format
      if (!SESSION_ID_RE.test(entry.name)) continue;
      try {
        const statePath = getStatePath(entry.name);
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
