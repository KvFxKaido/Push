import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { DelegationOutcome } from '../lib/runtime-contract.ts';

// ─── Interfaces ──────────────────────────────────────────────────

export interface RoleRoutingEntry {
  provider: string;
  model: string;
}

export interface DelegationOutcomeRecord {
  subagentId: string;
  outcome: DelegationOutcome;
}

export interface SessionState {
  sessionId: string;
  messages: unknown[];
  eventSeq: number;
  updatedAt: number;
  cwd: string;
  provider: string;
  model: string;
  rounds: number;
  sessionName: string;
  workingMemory: unknown;
  roleRouting?: Record<string, RoleRoutingEntry>;
  delegationOutcomes?: DelegationOutcomeRecord[];
  /**
   * Per-session attach token, persisted so that clients survive daemon
   * restarts. Minted at `start_session` time; disk-loaded sessions restore
   * this value into the in-memory entry instead of generating a fresh
   * token (which would invalidate the caller's stored token).
   *
   * Optional for migration: sessions created before this field existed
   * will load without it, and `validateAttachToken`'s legacy bypass accepts
   * any provided token for entries whose `attachToken` is falsy.
   */
  attachToken?: string;
  [key: string]: unknown;
}

export interface SessionEvent {
  v: string;
  kind: 'event';
  sessionId: string;
  runId?: string;
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface RunMarker {
  runId: string;
  startedAt: number;
  [key: string]: unknown;
}

export interface SessionListEntry {
  sessionId: string;
  updatedAt: number;
  provider: string;
  model: string;
  cwd: string;
  sessionName: string;
}

export interface InterruptedSession {
  sessionId: string;
  marker: RunMarker;
}

// ─── Constants ───────────────────────────────────────────────────

export const PROTOCOL_VERSION = 'push.runtime.v1';
const SESSION_ROOT_SYMBOL: unique symbol = Symbol('push.sessionRoot');

// Session IDs must match the output of makeSessionId(): sess_<base36>_<6 hex chars>
export const SESSION_ID_RE = /^sess_[a-z0-9]+_[a-f0-9]{6}$/;

// ─── Helpers ─────────────────────────────────────────────────────

export function validateSessionId(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `Invalid session id: ${typeof sessionId === 'string' ? sessionId : typeof sessionId}`,
    );
  }
  return sessionId;
}

export function makeSessionId(): string {
  return `sess_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function makeRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function getSessionRoot(): string {
  return process.env.PUSH_SESSION_DIR || path.join(os.homedir(), '.push', 'sessions');
}

function getLegacySessionRoot(): string {
  return path.join(process.cwd(), '.push', 'sessions');
}

function getSessionRootsForRead(): string[] {
  if (process.env.PUSH_SESSION_DIR) {
    return [path.resolve(process.env.PUSH_SESSION_DIR)];
  }
  // Backward-compatible read path: global store + legacy cwd-local store.
  const roots = [path.resolve(getSessionRoot()), path.resolve(getLegacySessionRoot())];
  return [...new Set(roots)];
}

function getSessionDirInRoot(root: string, sessionId: string): string {
  validateSessionId(sessionId);
  const resolvedRoot = path.resolve(root);
  const dir = path.resolve(resolvedRoot, sessionId);
  // Belt-and-suspenders: even if the regex is bypassed, prevent path traversal
  if (!dir.startsWith(`${resolvedRoot}${path.sep}`) && dir !== resolvedRoot) {
    throw new Error('Session dir escapes session root');
  }
  return dir;
}

export function getSessionDir(sessionId: string): string {
  return getSessionDirInRoot(getSessionRoot(), sessionId);
}

function getStatePathInRoot(root: string, sessionId: string): string {
  return path.join(getSessionDirInRoot(root, sessionId), 'state.json');
}

function getEventsPathInRoot(root: string, sessionId: string): string {
  return path.join(getSessionDirInRoot(root, sessionId), 'events.jsonl');
}

function attachSessionRoot(state: unknown, root: string): void {
  if (!state || typeof state !== 'object') return;
  Object.defineProperty(state, SESSION_ROOT_SYMBOL, {
    value: path.resolve(root),
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function getAttachedSessionRoot(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const root = (state as any)[SESSION_ROOT_SYMBOL];
  return typeof root === 'string' ? root : null;
}

function getStateSessionRoot(state: SessionState): string {
  return getAttachedSessionRoot(state) || path.resolve(getSessionRoot());
}

async function ensureSessionDir(sessionId: string, root: string): Promise<void> {
  const dir = getSessionDirInRoot(root, sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Ensure permissions even if dir already existed with looser perms
  await fs.chmod(dir, 0o700);
}

// ─── State persistence ──────────────────────────────────────────

export async function saveSessionState(state: SessionState): Promise<void> {
  const root = getStateSessionRoot(state);
  attachSessionRoot(state, root);
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId, root);
  await fs.writeFile(getStatePathInRoot(root, state.sessionId), JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function appendSessionEvent(
  state: SessionState,
  type: string,
  payload: unknown,
  runId: string | null = null,
): Promise<void> {
  const root = getStateSessionRoot(state);
  attachSessionRoot(state, root);
  state.eventSeq += 1;
  state.updatedAt = Date.now();
  const event: SessionEvent = {
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
  await fs.appendFile(getEventsPathInRoot(root, state.sessionId), `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function resolveSessionRootForRead(sessionId: string): Promise<string | null> {
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

export async function loadSessionState(sessionId: string): Promise<SessionState> {
  validateSessionId(sessionId);
  const root = (await resolveSessionRootForRead(sessionId)) || path.resolve(getSessionRoot());
  const raw = await fs.readFile(getStatePathInRoot(root, sessionId), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as SessionState).sessionId !== sessionId ||
    !Array.isArray((parsed as SessionState).messages)
  ) {
    throw new Error(`Invalid session state: ${sessionId}`);
  }
  attachSessionRoot(parsed, root);
  return parsed as SessionState;
}

export async function loadSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  validateSessionId(sessionId);
  const root = (await resolveSessionRootForRead(sessionId)) || path.resolve(getSessionRoot());
  const eventsPath = getEventsPathInRoot(root, sessionId);
  try {
    const raw = await fs.readFile(eventsPath, 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line: string) => JSON.parse(line) as SessionEvent);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export async function deleteSession(sessionId: string): Promise<number> {
  validateSessionId(sessionId);
  const roots = getSessionRootsForRead();
  let deleted = 0;

  for (const root of roots) {
    const dir = getSessionDirInRoot(root, sessionId);
    try {
      await fs.rm(dir, { recursive: true, force: false });
      deleted += 1;
    } catch (err: unknown) {
      if (
        err &&
        ((err as NodeJS.ErrnoException).code === 'ENOENT' ||
          (err as NodeJS.ErrnoException).code === 'ENOTDIR')
      ) {
        continue;
      }
      throw err;
    }
  }

  return deleted;
}

// ─── Run markers (crash recovery) ────────────────────────────────
// A run marker is a small file written when a run starts and deleted when it
// finishes. If pushd crashes mid-run, the marker survives on disk and lets
// the next startup detect interrupted sessions.

export async function writeRunMarker(
  sessionId: string,
  runId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  validateSessionId(sessionId);
  const root = getSessionRoot();
  await ensureSessionDir(sessionId, root);
  const markerPath = path.join(getSessionDirInRoot(root, sessionId), 'run.json');
  const marker: RunMarker = {
    runId,
    startedAt: Date.now(),
    ...metadata,
  };
  await fs.writeFile(markerPath, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 });
}

export async function clearRunMarker(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  const roots = getSessionRootsForRead();
  for (const root of roots) {
    const markerPath = path.join(getSessionDirInRoot(root, sessionId), 'run.json');
    try {
      await fs.unlink(markerPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export async function readRunMarker(sessionId: string): Promise<RunMarker | null> {
  validateSessionId(sessionId);
  const roots = getSessionRootsForRead();
  for (const root of roots) {
    const markerPath = path.join(getSessionDirInRoot(root, sessionId), 'run.json');
    try {
      const raw = await fs.readFile(markerPath, 'utf8');
      return JSON.parse(raw) as RunMarker;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Malformed JSON (e.g. partial write during crash) — clean up and skip
      if (err instanceof SyntaxError) {
        try {
          await fs.unlink(markerPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * Scan all sessions for run markers (interrupted runs).
 * Returns an array of { sessionId, marker } for each interrupted session.
 */
export async function scanInterruptedSessions(): Promise<InterruptedSession[]> {
  const roots = getSessionRootsForRead();
  const results: InterruptedSession[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SESSION_ID_RE.test(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);

      const markerPath = path.join(getSessionDirInRoot(root, entry.name), 'run.json');
      try {
        const raw = await fs.readFile(markerPath, 'utf8');
        const marker = JSON.parse(raw) as RunMarker;
        results.push({ sessionId: entry.name, marker });
      } catch {
        // No marker or malformed — skip
      }
    }
  }

  return results;
}

export async function listSessions(): Promise<SessionListEntry[]> {
  const roots = getSessionRootsForRead();
  const byId = new Map<string, SessionListEntry>();

  for (const root of roots) {
    let entries: import('node:fs').Dirent[];
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
        const state: unknown = JSON.parse(raw);
        const stateObj = state as Record<string, unknown>;
        const sessionId = typeof stateObj.sessionId === 'string' ? stateObj.sessionId : entry.name;
        if (!SESSION_ID_RE.test(sessionId)) continue;

        const row: SessionListEntry = {
          sessionId,
          updatedAt: Number.isFinite(Number(stateObj.updatedAt)) ? Number(stateObj.updatedAt) : 0,
          provider: typeof stateObj.provider === 'string' ? stateObj.provider : 'unknown',
          model: typeof stateObj.model === 'string' ? stateObj.model : 'unknown',
          cwd: typeof stateObj.cwd === 'string' ? stateObj.cwd : '',
          sessionName:
            typeof stateObj.sessionName === 'string' ? (stateObj.sessionName as string).trim() : '',
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
