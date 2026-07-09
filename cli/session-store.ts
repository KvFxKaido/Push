import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { PROTOCOL_VERSION } from '../lib/protocol-schema.js';
import type { DelegationOutcome } from '../lib/runtime-contract.ts';
import { renameWithRetry } from './fs-atomic.ts';
import { PROVIDER_CONFIGS, redirectDeprecatedProvider } from './provider.js';

// PROTOCOL_VERSION moved to lib/protocol-schema.ts (the canonical
// owner of the wire contract). Re-exported here so the ~6 CLI files
// that previously read it from session-store keep working without
// touching their imports.
export { PROTOCOL_VERSION };

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
   * Optional for migration: sessions created before this field existed load
   * without it. Such a legacy session is claimed on its first `attach_session`
   * (bootstrap grace) — the implicit "tokenless = open" bypass is gone
   * (Universal Session Bearer), so a tokenless session is no longer open by
   * accident; "open" is now an explicit opt-out (`openAttach` / `PUSHD_OPEN_ATTACH`).
   */
  attachToken?: string;
  /**
   * Origin surface for the session, set at session-creation time —
   * either by the daemon's `handleStartSession` (from the client's
   * request payload, mirrored into the `session_started` event) or
   * by the CLI's inline creation paths (`cli/cli.ts:initSession` for
   * REPL/headless, `cli/tui.ts:createFreshSessionState` for TUI).
   * Today's known values: `'tui'` (CLI full screen), `'interactive'`
   * (CLI REPL / unspecified default), `'headless'` (`./push run`).
   * Mobile shells will set their own tag when they begin issuing
   * `start_session`.
   *
   * Optional for migration: legacy sessions written before this field
   * existed load without it; `listSessions()` defaults to
   * `'interactive'` for those rows so consumers can rely on the column.
   */
  mode?: string;
  /**
   * Set when the session is rooted in an opt-in git-worktree sandbox
   * (`push run --worktree`). `cwd` points at `worktree.path`, so every tool
   * operates inside the worktree instead of the real checkout. Persisted so a
   * resumed session knows where its sandbox lives and can be torn down. Absent
   * for ordinary sessions that work the real tree directly. See `cli/worktree.ts`.
   */
  worktree?: {
    path: string;
    branch: string;
    baseSha: string;
    repoRoot: string;
  };
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
  /**
   * Last human-authored user message from the session's message log,
   * if any. Empty string when the session has no human turns yet or
   * when the most recent `user` entries are all internal envelopes
   * (tool results, session markers, etc.). Used as a preview hint in
   * the resume pickers; not truncated or sanitized — callers render.
   */
  lastUserMessage: string;
  /**
   * Origin surface (`'tui'` | `'interactive'` | `'headless'` | …) the
   * session was created with. Always populated: legacy sessions whose
   * `state.json` predates the field fall back to `'interactive'` so
   * mobile drawers and other consumers can bucket without branching on
   * undefined. Mirrors `SessionState.mode`.
   */
  mode: string;
}

export interface InterruptedSession {
  sessionId: string;
  marker: RunMarker;
}

// ─── Constants ───────────────────────────────────────────────────

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

/**
 * Mint a per-session attach token — the bearer a client presents to attach
 * to a daemon session (loopback WS locally, relay/phone remotely).
 *
 * Promoted here from `cli/pushd.ts` so that ALL session-creation paths can
 * mint at birth (Universal Session Bearer, docs/decisions). Previously this
 * lived only in the daemon and was called only by `start_session`, which is
 * why TUI/CLI-created sessions were born tokenless. Centralizing the mint is
 * what makes "every session carries a token from birth" an invariant by
 * construction rather than a per-call-site convention.
 */
export function makeAttachToken(): string {
  return `att_${randomBytes(8).toString('hex')}`;
}

/**
 * Options accepted by {@link createSessionState}. Each creation site passes
 * the fields it owns; the factory supplies the identity + the attach token.
 * Site-specific fields (workingMemory, restartPolicy, roleRouting, …) are
 * intentionally NOT modeled here — callers spread them onto the returned base
 * so the factory stays the single source of truth for the token without
 * having to absorb every per-surface shape difference.
 */
export interface CreateSessionStateOptions {
  provider: string;
  model: string;
  cwd: string;
  /** Pre-built message log — daemon uses async `buildSystemPrompt`, TUI/CLI use the sync base builder, so the caller builds it. */
  messages: unknown[];
  /** Origin surface tag (`'tui'` | `'interactive'` | `'headless'` | …); defaults to `'interactive'`. */
  mode?: string;
  /** Override the generated session id (e.g. tests, or a caller that pre-minted one). */
  sessionId?: string;
  /** Override the creation/update timestamp (tests / deterministic fixtures). */
  now?: number;
  /**
   * Explicit attach-token override. Defaults to a freshly minted token. An
   * empty/whitespace string is treated as "unset" and still mints — a caller
   * cannot accidentally birth a tokenless session through this factory.
   */
  attachToken?: string;
}

/**
 * The base shape returned by {@link createSessionState}. Deliberately omits
 * `sessionName` and `workingMemory`: no creation site sets `sessionName` at
 * birth (the loader/`listSessions` default it to `''`), and `workingMemory`
 * is site-specific (TUI/CLI seed it; the daemon does not). Callers spread the
 * base and add their own fields, exactly as the pre-factory literals did — so
 * routing through the factory is shape-preserving, not a behavior change.
 */
export type NewSessionBaseState = Pick<
  SessionState,
  | 'sessionId'
  | 'updatedAt'
  | 'provider'
  | 'model'
  | 'cwd'
  | 'rounds'
  | 'eventSeq'
  | 'messages'
  | 'mode'
> & {
  createdAt: number;
  // Required (not the optional `SessionState.attachToken`): the factory always
  // mints, so the return type ENFORCES the bearer-at-birth invariant this whole
  // change rests on — a caller can't observe a factory-built state without one.
  attachToken: string;
};

/**
 * Build the base state for a brand-new session, ALWAYS carrying a freshly
 * minted attach token (Universal Session Bearer). The three creation points —
 * `handleStartSession` (daemon), `createFreshSessionState` (TUI) and
 * `initSession` (CLI) — route through here so no session is ever born
 * tokenless. Callers spread their site-specific fields onto the result.
 *
 * The factory never mints a session id when one is supplied, and never
 * returns a falsy `attachToken`: passing `attachToken: ''` (or omitting it)
 * mints, so "tokenless by construction" is unreachable from this path.
 */
export function createSessionState(opts: CreateSessionStateOptions): NewSessionBaseState {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const attachToken =
    typeof opts.attachToken === 'string' && opts.attachToken.trim()
      ? opts.attachToken
      : makeAttachToken();
  return {
    sessionId: opts.sessionId ?? makeSessionId(),
    createdAt: now,
    updatedAt: now,
    provider: opts.provider,
    model: opts.model,
    cwd: opts.cwd,
    rounds: 0,
    eventSeq: 0,
    messages: opts.messages,
    attachToken,
    mode: opts.mode ?? 'interactive',
  };
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

function getMessagesPathInRoot(root: string, sessionId: string): string {
  return path.join(getSessionDirInRoot(root, sessionId), 'messages.jsonl');
}

/**
 * Tracks how many entries from `state.messages` have already been
 * persisted to `messages.jsonl`. Lives in-memory only; reset on every
 * load. Indexed by the `SessionState` object so multiple in-flight
 * sessions don't share counters.
 *
 * Invariant: `lastPersistedMessageCount.get(state) <= state.messages.length`
 * holds across normal append turns. When the user invokes a non-append
 * operation (e.g. /compact), `state.messages` shrinks and the next save
 * detects that via the length comparison and rewrites the log.
 */
const lastPersistedMessageCount: WeakMap<SessionState, number> = new WeakMap();

/**
 * Cheap content fingerprint paired with the count above. Catches
 * in-place edits that don't change `state.messages.length` (e.g. a
 * system-prompt refresh that overwrites `messages[0]`, or a /compact
 * that drops one message and inserts a digest at the same length). On
 * each save we recompute the fingerprint of the leading and trailing
 * entries; when length matches `lastPersistedMessageCount` but the
 * fingerprint diverges, `saveSessionState` falls through to
 * `rewriteMessagesLog` instead of leaving stale data on disk.
 *
 * The fingerprint only samples `[0]` and `[length-1]` — that's cheap
 * (O(1) per save) and covers the realistic non-append patterns. Callers
 * doing a wholesale middle-rewrite should still use `rewriteMessagesLog`
 * directly to be explicit.
 */
const lastPersistedFingerprint: WeakMap<SessionState, string> = new WeakMap();

function fingerprintMessages(messages: unknown[]): string {
  if (messages.length === 0) return '';
  if (messages.length === 1) return JSON.stringify(messages[0]);
  return `${JSON.stringify(messages[0])}|${JSON.stringify(messages[messages.length - 1])}`;
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

/**
 * Writes the slim portion of state (everything except `messages`) to
 * `state.json` atomically via tmp + rename.
 */
async function writeSlimState(state: SessionState, root: string): Promise<void> {
  const statePath = getStatePathInRoot(root, state.sessionId);
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  // Strip messages from the on-disk state — they live in messages.jsonl.
  // Spread copy so we don't mutate the live state object.
  const { messages: _messages, ...slim } = state;
  void _messages;
  try {
    await fs.writeFile(tempPath, JSON.stringify(slim, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await renameWithRetry(tempPath, statePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Persist session state. Messages live in append-only `messages.jsonl`;
 * everything else (workingMemory, eventSeq, etc.) lives in `state.json`
 * which gets rewritten on every save.
 *
 * The append-only invariant means cost per save scales with the count of
 * NEW messages since the last save, not the full transcript length.
 *
 * Four branches:
 *   - count > persisted: append the diff to messages.jsonl.
 *   - count < persisted: a non-append rewrite happened (e.g. /compact
 *     that shrank length). Truncate messages.jsonl and re-emit.
 *   - count === persisted but fingerprint of `[0]+[last]` changed:
 *     in-place edit detected (e.g. sys-prompt refresh overwrites
 *     `messages[0]`). Force a re-emit so the on-disk log doesn't go
 *     stale.
 *   - count === persisted and fingerprint matches: no-op for the log;
 *     only the slim state.json gets rewritten.
 *
 * Callers performing a wholesale rewrite (e.g. middle-of-array edit
 * that the fingerprint can't catch) should call `rewriteMessagesLog`
 * directly instead of relying on the fingerprint heuristic.
 *
 * Crash safety: append-then-write order. If the process dies between
 * the messages.jsonl append and the state.json write, the log has the
 * truth and the next save catches state.json up. The reverse order
 * would "lose" newest messages from the log, which is unrecoverable.
 */
export async function saveSessionState(state: SessionState): Promise<void> {
  const root = getStateSessionRoot(state);
  attachSessionRoot(state, root);
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId, root);

  const messages = Array.isArray(state.messages) ? state.messages : [];
  const lastWritten = lastPersistedMessageCount.get(state) ?? 0;
  const currentFingerprint = fingerprintMessages(messages);

  if (messages.length < lastWritten) {
    // Non-append rewrite (e.g. compaction shrank the array) — full re-emit.
    await rewriteMessagesLog(state);
    return;
  }

  if (messages.length === lastWritten) {
    const persistedFingerprint = lastPersistedFingerprint.get(state);
    if (persistedFingerprint !== undefined && persistedFingerprint !== currentFingerprint) {
      // Same length, different content at the head/tail boundary — an
      // in-place edit that the count check missed. Re-emit the log.
      await rewriteMessagesLog(state);
      return;
    }
    // Genuinely no message change since last save. Skip the log; only
    // the slim state.json needs updating.
    await writeSlimState(state, root);
    return;
  }

  const newOnes = messages.slice(lastWritten);
  const lines = `${newOnes.map((m) => JSON.stringify(m)).join('\n')}\n`;
  await fs.appendFile(getMessagesPathInRoot(root, state.sessionId), lines, {
    encoding: 'utf8',
    mode: 0o600,
  });
  lastPersistedMessageCount.set(state, messages.length);
  lastPersistedFingerprint.set(state, currentFingerprint);

  await writeSlimState(state, root);
}

/**
 * Truncate and re-emit `messages.jsonl` from the current `state.messages`,
 * then rewrite the slim state.json. Used by `saveSessionState` when a
 * non-append rewrite is detected, and exposed for callers that explicitly
 * want to force a re-emit (e.g. unit tests).
 *
 * Atomic via tmp + rename on the messages.jsonl write so a crash mid-rewrite
 * leaves the previous log intact.
 */
export async function rewriteMessagesLog(state: SessionState): Promise<void> {
  const root = getStateSessionRoot(state);
  attachSessionRoot(state, root);
  state.updatedAt = Date.now();
  await ensureSessionDir(state.sessionId, root);

  const messages = Array.isArray(state.messages) ? state.messages : [];
  const messagesPath = getMessagesPathInRoot(root, state.sessionId);
  const tempPath = `${messagesPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const lines = messages.length > 0 ? `${messages.map((m) => JSON.stringify(m)).join('\n')}\n` : '';
  try {
    await fs.writeFile(tempPath, lines, { encoding: 'utf8', mode: 0o600 });
    await renameWithRetry(tempPath, messagesPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  lastPersistedMessageCount.set(state, messages.length);
  lastPersistedFingerprint.set(state, fingerprintMessages(messages));

  await writeSlimState(state, root);
}

/**
 * Read messages.jsonl into an array. Returns null when the file is
 * absent — that signals a legacy session whose messages are still
 * embedded in state.json; the next save will migrate them.
 *
 * Crash tolerance: if the process died mid-`appendFile`, the last line
 * may be a partial JSON string. Drop any trailing line that fails to
 * parse so the rest of the session remains loadable. Earlier lines
 * are committed-by-newline (full lines preceding the partial one are
 * complete and parseable).
 *
 * If a non-trailing line fails to parse, the file is structurally
 * corrupt — we still throw rather than silently dropping middle
 * messages, since that would hide real data loss.
 */
async function loadMessagesLog(root: string, sessionId: string): Promise<unknown[] | null> {
  const logPath = getMessagesPathInRoot(root, sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const messages: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      messages.push(JSON.parse(lines[i]));
    } catch (err) {
      const isLastLine = i === lines.length - 1;
      // The split above filtered the empty trailing string after the
      // final newline, so the only way a line lacks a terminating
      // newline is if the write was cut short — that's specifically
      // the last entry we kept. Tolerate only this case; otherwise
      // surface the corruption.
      const fileEndsWithNewline = raw.endsWith('\n');
      if (isLastLine && !fileEndsWithNewline) continue;
      throw err;
    }
  }
  return messages;
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
  if (!parsed || typeof parsed !== 'object' || (parsed as SessionState).sessionId !== sessionId) {
    throw new Error(`Invalid session state: ${sessionId}`);
  }
  const stateObj = parsed as SessionState;

  // Retired-provider migration: persisted sessions (and their role routing)
  // can reference a provider that has since been removed from the roster.
  // Coerce on read — the single chokepoint every resume path shares (TUI
  // resume/load-session, daemon session reads) — so downstream
  // `PROVIDER_CONFIGS[state.provider]` lookups can't crash a resumable
  // session. The next save persists the redirect. Mirrors `parseProvider`'s
  // flag/env fallback (Codex P2, PR #1382); stderr because CLI stdout is
  // reserved for user output / --json payloads.
  const redirected = redirectDeprecatedProvider(stateObj.provider);
  if (redirected) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'session_provider_redirected',
        sessionId,
        from: stateObj.provider,
        to: redirected,
      }),
    );
    stateObj.provider = redirected;
    // The stale model id belongs to the removed provider — snap to the
    // replacement's default (the update_session atomic-selection rule).
    stateObj.model = PROVIDER_CONFIGS[redirected]?.defaultModel ?? stateObj.model;
  }
  if (stateObj.roleRouting) {
    for (const [role, entry] of Object.entries(stateObj.roleRouting)) {
      const roleRedirect = entry?.provider ? redirectDeprecatedProvider(entry.provider) : null;
      if (roleRedirect) {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'session_role_provider_redirected',
            sessionId,
            role,
            from: entry.provider,
            to: roleRedirect,
          }),
        );
        entry.provider = roleRedirect;
        entry.model = PROVIDER_CONFIGS[roleRedirect]?.defaultModel ?? entry.model;
      }
    }
  }

  // Hydrate messages from the append-only log. Slim state.json (post-PR 4)
  // omits `messages` entirely; legacy state.json (pre-PR 4) carries them
  // inline. When the log is absent, fall back to whatever's embedded —
  // the next save will migrate any embedded array into the log and strip
  // it from state.json. This keeps existing on-disk sessions resumable
  // and also handles fresh sessions that haven't seen any messages yet
  // (no log file, no embedded array → start empty).
  const messagesFromLog = await loadMessagesLog(root, sessionId);
  if (messagesFromLog !== null) {
    stateObj.messages = messagesFromLog;
    lastPersistedMessageCount.set(stateObj, messagesFromLog.length);
    lastPersistedFingerprint.set(stateObj, fingerprintMessages(messagesFromLog));
  } else {
    if (!Array.isArray(stateObj.messages)) stateObj.messages = [];
    // Force the next save to write all embedded messages (if any) to
    // the log so subsequent loads use the post-PR 4 path.
    lastPersistedMessageCount.set(stateObj, 0);
    lastPersistedFingerprint.set(stateObj, '');
  }

  attachSessionRoot(stateObj, root);
  return stateObj;
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

/**
 * Pull the most recent human user message out of a session's message
 * log. `messages` entries with `role: "user"` can hold tool-result
 * envelopes (`[TOOL_RESULT]...[/TOOL_RESULT]`), project-context blocks
 * (`[PROJECT_INSTRUCTIONS source="..."]...[/PROJECT_INSTRUCTIONS]`),
 * digests (`[CONTEXT DIGEST]...[/CONTEXT DIGEST]`), and other paired
 * internal envelopes — none of which make useful previews.
 *
 * Filtering rule: skip a user message only when it opens with a
 * paired envelope tag — `^[NAME ...]...[/NAME]` where NAME is
 * uppercase / underscore / space. Blanket "starts with [" would drop
 * legitimate human prompts like `[WIP] refactor auth` or markdown
 * checklists `[ ] fix flaky tests`; paired-tag matching keeps those
 * visible. Returns empty string when no suitable message exists.
 */
export function isInternalEnvelope(trimmed: string): boolean {
  if (!trimmed.startsWith('[')) return false;
  const openMatch = trimmed.match(/^\[([^\]]+)\]/);
  if (!openMatch) return false;
  // Strip HTML/XML-style attributes (name="value") to recover the bare
  // tag name. PROJECT_INSTRUCTIONS is the only production envelope
  // that uses them today, but future envelopes may follow suit.
  const tagName = openMatch[1].replace(/\s+[A-Za-z_][\w-]*="[^"]*"/g, '').trim();
  if (!/^[A-Z_][A-Z_ 0-9]*$/.test(tagName)) return false;
  return trimmed.includes(`[/${tagName}]`);
}

function extractLastHumanUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as { role?: unknown; content?: unknown };
    if (m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    const trimmed = m.content.trim();
    if (!trimmed) continue;
    if (isInternalEnvelope(trimmed)) continue;
    return trimmed;
  }
  return '';
}

/**
 * Tail-read the last `LIST_PREVIEW_TAIL_BYTES` of `messages.jsonl`,
 * parse the complete lines, and return the most recent human user
 * message. Avoids reading multi-MB transcripts during `listSessions`,
 * which is the human-interactive resume picker path.
 *
 * Returns `null` when the log file is absent (caller falls back to
 * embedded `state.json` messages for legacy sessions). Returns `''`
 * when the tail contains no qualifying user message, matching the
 * existing `extractLastHumanUserMessage` empty-state.
 *
 * Tail size is sized to comfortably hold at least the last few turns
 * of even verbose sessions; if no qualifying message lives in the
 * tail (rare on long sessions), the preview shows empty rather than
 * paying the cost of a full-file read. Acceptable tradeoff for the
 * listing path.
 */
const LIST_PREVIEW_TAIL_BYTES = 16 * 1024;

async function readLastUserMessageFromLog(root: string, sessionId: string): Promise<string | null> {
  const logPath = getMessagesPathInRoot(root, sessionId);
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fs.open(logPath, 'r');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return '';
    const start = Math.max(0, stat.size - LIST_PREVIEW_TAIL_BYTES);
    const buf = Buffer.alloc(stat.size - start);
    await handle.read(buf, 0, buf.length, start);
    let tail = buf.toString('utf8');
    if (start > 0) {
      // Drop the (likely partial) first line — the tail boundary may
      // bisect a JSON entry. Skip past the first newline.
      const firstNewline = tail.indexOf('\n');
      tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : '';
    }
    const lines = tail.split('\n').filter((l) => l.length > 0);
    const messages: unknown[] = [];
    const fileEndsWithNewline = tail.endsWith('\n');
    for (let i = 0; i < lines.length; i++) {
      try {
        messages.push(JSON.parse(lines[i]));
      } catch {
        // Tolerate a partial last line (interrupted append); skip and
        // keep walking. Same crash-recovery semantics as
        // loadMessagesLog.
        if (i === lines.length - 1 && !fileEndsWithNewline) continue;
        // Otherwise the tail boundary nicked a line awkwardly — just
        // skip it; we still have earlier lines for the preview.
      }
    }
    return extractLastHumanUserMessage(messages);
  } finally {
    await handle.close();
  }
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

        // Pull the preview message from messages.jsonl (post-PR 4 sessions)
        // by tail-reading just the last ~16KB so the picker stays fast even
        // for sessions with very long transcripts. Fall back to whatever's
        // embedded in state.json (legacy sessions whose messages haven't
        // been migrated to the log yet).
        const tailPreview = await readLastUserMessageFromLog(root, sessionId);
        const lastUserMessage =
          tailPreview !== null ? tailPreview : extractLastHumanUserMessage(stateObj.messages);

        const row: SessionListEntry = {
          sessionId,
          updatedAt: Number.isFinite(Number(stateObj.updatedAt)) ? Number(stateObj.updatedAt) : 0,
          provider: typeof stateObj.provider === 'string' ? stateObj.provider : 'unknown',
          model: typeof stateObj.model === 'string' ? stateObj.model : 'unknown',
          cwd: typeof stateObj.cwd === 'string' ? stateObj.cwd : '',
          sessionName:
            typeof stateObj.sessionName === 'string' ? (stateObj.sessionName as string).trim() : '',
          lastUserMessage,
          mode:
            typeof stateObj.mode === 'string' && (stateObj.mode as string).trim()
              ? (stateObj.mode as string).trim()
              : 'interactive',
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

// ─── Pruning (session hygiene) ───────────────────────────────────
// Retention never existed before 2026-06: session dirs accumulated
// unboundedly (2,144 dirs / 68 MB observed, ~78% leaked test fixtures),
// taxing every `listSessions()` walk the TUI resume picker does at
// startup. `pruneSessions` is the explicit cleanup primitive behind
// `push sessions prune` — selector-based, AND-combined, dry-run by
// default at the CLI layer. No automatic GC: deleting history is a
// user decision, not a side effect.

export interface PruneSelectors {
  /** Sessions with no human user message in the transcript. */
  empty?: boolean;
  /** Sessions whose `updatedAt` is older than this many days. */
  olderThanDays?: number;
  /** Match everything EXCEPT the N most-recently-updated sessions. */
  keep?: number;
  /** Regex source tested against `provider/model`. */
  matchModel?: string;
}

export interface PruneCandidate {
  sessionId: string;
  provider: string;
  model: string;
  cwd: string;
  updatedAt: number;
  /** Total bytes across the session dir's files (all read roots). */
  bytes: number;
}

export interface PruneReport {
  scanned: number;
  candidates: PruneCandidate[];
  /** Candidates excluded because a fresh run marker says a run is live. */
  skippedActive: string[];
  /** Session ids actually removed (empty on dry-run). */
  deleted: string[];
  /** Per-session deletion failures — surfaced, never swallowed. */
  failed: Array<{ sessionId: string; error: string }>;
  bytesSelected: number;
  dryRun: boolean;
}

/**
 * Run markers survive crashes by design (that's their recovery job), so a
 * marker alone can't mean "live forever" — a session that crashed mid-run
 * months ago must still be prunable. Treat a marker as ACTIVE only within
 * this window; older markers are stale crash leftovers.
 */
const ACTIVE_RUN_MARKER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function sessionDirBytes(sessionId: string): Promise<number> {
  let total = 0;
  for (const root of getSessionRootsForRead()) {
    const dir = getSessionDirInRoot(root, sessionId);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(path.join(dir, entry.name));
        total += stat.size;
      } catch {
        /* best-effort sizing */
      }
    }
  }
  return total;
}

/**
 * Authoritative emptiness check for the destructive `empty` selector. The
 * `lastUserMessage` preview from `listSessions()` tail-reads only the last
 * ~16KB of `messages.jsonl` — a real human turn buried under a large
 * tool-output/digest tail previews as `''`, which is fine for the resume
 * picker but catastrophic as a delete criterion (Codex P1, PR #906).
 * Reads the FULL transcript, falling back to the embedded `state.json`
 * messages for legacy sessions without a log. Any read failure classifies
 * as NON-empty — when in doubt, keep.
 */
async function sessionHasHumanTurn(sessionId: string): Promise<boolean> {
  for (const root of getSessionRootsForRead()) {
    try {
      const log = await loadMessagesLog(root, sessionId);
      if (log !== null) {
        if (extractLastHumanUserMessage(log)) return true;
        // Log exists in this root and provably has no human turn; other
        // read roots may still hold a divergent copy — keep scanning.
        continue;
      }
    } catch {
      return true; // corrupt log — not provably empty, keep
    }
    try {
      const raw = await fs.readFile(getStatePathInRoot(root, sessionId), 'utf8');
      const state = JSON.parse(raw) as { messages?: unknown };
      if (extractLastHumanUserMessage(state.messages)) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // not in this root
      return true; // unreadable state — not provably empty, keep
    }
  }
  return false;
}

/**
 * Select sessions by the AND of every provided selector, skip any with a
 * fresh run marker, and (unless `dryRun`) delete the rest. At least one
 * selector is required — a bare prune that matches everything is a
 * misfire, not a default.
 */
export async function pruneSessions(
  selectors: PruneSelectors,
  opts: { dryRun: boolean; now?: number },
): Promise<PruneReport> {
  const hasSelector =
    selectors.empty === true ||
    typeof selectors.olderThanDays === 'number' ||
    typeof selectors.keep === 'number' ||
    typeof selectors.matchModel === 'string';
  if (!hasSelector) {
    throw new Error(
      'pruneSessions requires at least one selector (empty / olderThanDays / keep / matchModel).',
    );
  }
  if (typeof selectors.olderThanDays === 'number' && !(selectors.olderThanDays >= 0)) {
    throw new Error('olderThanDays must be a non-negative number.');
  }
  if (
    typeof selectors.keep === 'number' &&
    !(Number.isInteger(selectors.keep) && selectors.keep >= 0)
  ) {
    throw new Error('keep must be a non-negative integer.');
  }
  const modelRe =
    typeof selectors.matchModel === 'string' ? new RegExp(selectors.matchModel) : null;

  const now = opts.now ?? Date.now();
  const sessions = await listSessions(); // newest-first
  const beyondKeep = new Set(
    typeof selectors.keep === 'number'
      ? sessions.slice(selectors.keep).map((s) => s.sessionId)
      : [],
  );

  const report: PruneReport = {
    scanned: sessions.length,
    candidates: [],
    skippedActive: [],
    deleted: [],
    failed: [],
    bytesSelected: 0,
    dryRun: opts.dryRun,
  };

  for (const session of sessions) {
    if (
      typeof selectors.olderThanDays === 'number' &&
      session.updatedAt >= now - selectors.olderThanDays * 86_400_000
    ) {
      continue;
    }
    if (typeof selectors.keep === 'number' && !beyondKeep.has(session.sessionId)) continue;
    if (modelRe && !modelRe.test(`${session.provider}/${session.model}`)) continue;
    // Emptiness last: the cheap tail preview rules sessions IN as non-empty,
    // but ruling one OUT (deletable) needs the full-transcript check — run
    // it only for sessions that already passed every other selector.
    if (selectors.empty === true) {
      if (session.lastUserMessage) continue;
      if (await sessionHasHumanTurn(session.sessionId)) continue;
    }

    const marker = await readRunMarker(session.sessionId).catch(() => null);
    if (marker && now - marker.startedAt < ACTIVE_RUN_MARKER_MAX_AGE_MS) {
      report.skippedActive.push(session.sessionId);
      continue;
    }

    report.candidates.push({
      sessionId: session.sessionId,
      provider: session.provider,
      model: session.model,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      bytes: await sessionDirBytes(session.sessionId),
    });
  }
  report.bytesSelected = report.candidates.reduce((sum, c) => sum + c.bytes, 0);

  if (!opts.dryRun) {
    for (const candidate of report.candidates) {
      try {
        await deleteSession(candidate.sessionId);
        report.deleted.push(candidate.sessionId);
      } catch (err) {
        report.failed.push({
          sessionId: candidate.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return report;
}
