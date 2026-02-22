import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const PROTOCOL_VERSION = 'push.runtime.v1';
const SESSION_ROOT_SYMBOL = Symbol('push.sessionRoot');

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
  return process.env.PUSH_SESSION_DIR || path.join(os.homedir(), '.push', 'sessions');
}

function getLegacySessionRoot() {
  return path.join(process.cwd(), '.push', 'sessions');
}

function getSessionRootsForRead() {
  if (process.env.PUSH_SESSION_DIR) {
    return [path.resolve(process.env.PUSH_SESSION_DIR)];
  }
  // Backward-compatible read path: global store + legacy cwd-local store.
  const roots = [path.resolve(getSessionRoot()), path.resolve(getLegacySessionRoot())];
  return [...new Set(roots)];
}

function getSessionDirInRoot(root, sessionId) {
  validateSessionId(sessionId);
  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(resolvedRoot, sessionId);
  // Belt-and-suspenders: even if the regex is bypassed, prevent path traversal
  if (!dir.startsWith(`${resolvedRoot}${path.sep}`) && dir !== resolvedRoot) {
    throw new Error('Session dir escapes session root');
  }
  return dir;
}

export function getSessionDir(sessionId) {
  return getSessionDirInRoot(getSessionRoot(), sessionId);
}

function getStatePathInRoot(root, sessionId) {
  return path.join(getSessionDirInRoot(root, sessionId), 'state.json');
}

function getEventsPathInRoot(root, sessionId) {
  return path.join(getSessionDirInRoot(root, sessionId), 'events.jsonl');
}

function attachSessionRoot(state, root) {
  if (!state || typeof state !== 'object') return;
  Object.defineProperty(state, SESSION_ROOT_SYMBOL, {
    value: path.resolve(root),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function getAttachedSessionRoot(state) {
  if (!state || typeof state !== 'object') return null;
  const root = state[SESSION_ROOT_SYMBOL];
  return typeof root === 'string' ? root : null;
}

function getStateSessionRoot(state) {
  return getAttachedSessionRoot(state) || path.resolve(getSessionRoot());
}

async function ensureSessionDir(sessionId, root) {
  const dir = getSessionDirInRoot(root, sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Ensure permissions even if dir already existed with looser perms
  await fs.chmod(dir, 0o700);
}

export async function saveSessionState(state) {
  const root = getStateSessionRoot(state);
  attachSessionRoot(state, root);
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId, root);
  await fs.writeFile(getStatePathInRoot(root, state.sessionId), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export async function appendSessionEvent(state, type, payload, runId = null) {
  const root = getStateSessionRoot(state);
  attachSessionRoot(state, root);
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
  await ensureSessionDir(state.sessionId, root);
  await fs.appendFile(getEventsPathInRoot(root, state.sessionId), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function resolveSessionRootForRead(sessionId) {
  const roots = getSessionRootsForRead();
  for (const root of roots) {
    const statePath = getStatePathInRoot(root, sessionId);
    try {
      await fs.access(statePath);
      return root;
    } catch {
      // continue
    }
  }
  return null;
}

export async function loadSessionState(sessionId) {
  validateSessionId(sessionId);
  const root = await resolveSessionRootForRead(sessionId) || path.resolve(getSessionRoot());
  const raw = await fs.readFile(getStatePathInRoot(root, sessionId), 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) {
    throw new Error(`Invalid session state: ${sessionId}`);
  }
  attachSessionRoot(parsed, root);
  return parsed;
}

export async function loadSessionEvents(sessionId) {
  validateSessionId(sessionId);
  const root = await resolveSessionRootForRead(sessionId) || path.resolve(getSessionRoot());
  const eventsPath = getEventsPathInRoot(root, sessionId);
  try {
    const raw = await fs.readFile(eventsPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function deleteSession(sessionId) {
  validateSessionId(sessionId);
  const roots = getSessionRootsForRead();
  let deleted = 0;

  for (const root of roots) {
    const dir = getSessionDirInRoot(root, sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: false });
      deleted += 1;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        continue;
      }
      throw err;
    }
  }

  return deleted;
}

export async function listSessions() {
  const roots = getSessionRootsForRead();
  const byId = new Map();

  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SESSION_ID_RE.test(entry.name)) continue;
      try {
        const statePath = getStatePathInRoot(root, entry.name);
        const raw = await fs.readFile(statePath, 'utf8');
        const state = JSON.parse(raw);
        const sessionId = typeof state.sessionId === 'string' ? state.sessionId : entry.name;
        if (!SESSION_ID_RE.test(sessionId)) continue;

        const row = {
          sessionId,
          updatedAt: Number.isFinite(Number(state.updatedAt)) ? Number(state.updatedAt) : 0,
          provider: typeof state.provider === 'string' ? state.provider : 'unknown',
          model: typeof state.model === 'string' ? state.model : 'unknown',
          cwd: typeof state.cwd === 'string' ? state.cwd : '',
          sessionName: typeof state.sessionName === 'string' ? state.sessionName.trim() : '',
        };

        const existing = byId.get(sessionId);
        if (!existing || row.updatedAt > existing.updatedAt) {
          byId.set(sessionId, row);
        }
      } catch {
        // Ignore malformed sessions.
      }
    }
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
