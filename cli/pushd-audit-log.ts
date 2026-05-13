/**
 * pushd-audit-log.ts — Append-only audit log for the daemon. Phase 3
 * slice 3 of the remote-sessions track.
 *
 * Captures structured records of every consequential event on the
 * pushd surface: WS auth (upgrade, mint, revoke), sandbox tool calls
 * (exec / read / write / list / diff), and delegation + session
 * lifecycle. Each record carries the provenance fields the decision
 * doc enumerates as the minimum model: `surface`, `deviceId` (parent
 * device tokenId from WS auth), `sessionId`, `runId`, and the tool
 * name. The file lives on the user's PC and is mode 0600, same
 * posture as `pushd.tokens` and `pushd.allowlist`.
 *
 * Privacy posture: structural metadata only by default. `sandbox_
 * exec` records DO NOT include the command text — shell commands
 * routinely contain bearer tokens (`curl -H Authorization: ...`),
 * API keys, and secrets in env-var assignments. Opt in to verbatim
 * commands with `PUSHD_AUDIT_LOG_COMMANDS=1` when forensics demands
 * it. Even with that env set, command text is truncated at
 * `AUDIT_COMMAND_MAX_LEN` (1KB) so a `cat /etc/passwd` doesn't
 * dump the file into the log.
 *
 * Storage: NDJSON, one event per line, atomic appendFile per event.
 * No background batching — loopback latency on a single fs.appendFile
 * is well under a millisecond, batching would add complexity for
 * marginal throughput improvement on a surface that fires at human
 * pace.
 *
 * Rotation: size-based. When the live file's size exceeds
 * `PUSHD_AUDIT_MAX_BYTES` (default 10MB), it rotates to
 * `pushd.audit.log.1`, existing `.1..N-1` shift up, and entries
 * beyond `PUSHD_AUDIT_MAX_FILES` (default 5) are dropped. The check
 * runs at the START of each append so a single oversized line can
 * still land in the live file before the next append triggers
 * rotation; that's acceptable for an audit log (no record is lost)
 * and avoids the cost of stat+rotate on every event.
 *
 * Kill switch: `PUSHD_AUDIT_ENABLED=0` disables the logger entirely
 * (`appendAuditEvent` becomes a no-op). Use during incident
 * response when the daemon must stop touching its own audit file
 * (e.g. recovering from disk-full).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Surface that originated the action. */
export type AuditSurface =
  | 'ws' // WS-authenticated client (web / wscat)
  | 'unix-socket'; // local CLI talking through the Unix socket

/** Auth principal kind at the time of the action — only set on WS surface. */
export type AuditAuthKind = 'device' | 'attach';

/**
 * Canonical event types. New types should append rather than rename so
 * older log readers can still parse them.
 */
export type AuditEventType =
  // Auth lifecycle
  | 'auth.upgrade'
  | 'auth.mint_attach'
  | 'auth.revoke_device'
  | 'auth.revoke_attach'
  // Sandbox tool calls
  | 'tool.sandbox_exec'
  | 'tool.sandbox_read_file'
  | 'tool.sandbox_write_file'
  | 'tool.sandbox_list_dir'
  | 'tool.sandbox_diff'
  // Delegation
  | 'delegate.coder'
  | 'delegate.explorer'
  | 'delegate.reviewer'
  // Session lifecycle
  | 'session.start'
  | 'session.cancel_run';

/**
 * Single audit record shape. Versioned via `v` so future schema
 * changes can coexist with older entries in the log.
 */
export interface AuditEvent {
  v: 'push.audit.v1';
  ts: number;
  type: AuditEventType;
  surface: AuditSurface;
  /** Parent device tokenId (from WS auth). Absent for unix-socket. */
  deviceId?: string;
  /** Attach tokenId, when the WS authed via attach. */
  attachTokenId?: string;
  authKind?: AuditAuthKind;
  /** Engine session id when the event is scoped to one. */
  sessionId?: string;
  /** Run id when the event is scoped to one (e.g. sandbox_exec runId). */
  runId?: string;
  /**
   * Event-specific payload. Always JSON-serializable. By convention:
   *  - tool events: `{ tool, cwd?, path?, exitCode?, durationMs?, truncated?, cancelled?, ok? }`
   *  - auth events: `{ tokenId?, parentTokenId?, closedConnections?, revokedAttachTokens? }`
   *  - delegate events: `{ kind, taskExcerpt? }`
   *  - session events: `{ accepted?, reason? }`
   */
  payload?: Record<string, unknown>;
}

/** Input to `appendAuditEvent` — `ts` and `v` are filled in by the logger. */
export type AuditEventInput = Omit<AuditEvent, 'v' | 'ts'>;

const SCHEMA_VERSION = 'push.audit.v1' as const;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const AUDIT_COMMAND_MAX_LEN = 1024;

export function getAuditLogPath(): string {
  if (process.env.PUSHD_AUDIT_LOG_PATH) return process.env.PUSHD_AUDIT_LOG_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.audit.log');
}

function getAuditLogDir(): string {
  return path.dirname(getAuditLogPath());
}

export function isAuditEnabled(): boolean {
  const raw = process.env.PUSHD_AUDIT_ENABLED;
  if (raw === undefined) return true;
  return raw !== '0' && raw !== 'false';
}

export function shouldLogCommandText(): boolean {
  const raw = process.env.PUSHD_AUDIT_LOG_COMMANDS;
  if (raw === undefined) return false;
  return raw === '1' || raw === 'true';
}

export function getAuditMaxBytes(): number {
  const raw = process.env.PUSHD_AUDIT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BYTES;
  return parsed;
}

export function getAuditMaxFiles(): number {
  const raw = process.env.PUSHD_AUDIT_MAX_FILES;
  if (!raw) return DEFAULT_MAX_FILES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_FILES;
  return parsed;
}

/**
 * Truncate a command (or any potentially-long string) at the audit
 * length cap. The truncation marker is stable so a reader can tell
 * the value is partial. Used internally by callers that pass through
 * the `PUSHD_AUDIT_LOG_COMMANDS=1` opt-in path.
 */
const AUDIT_TRUNCATION_MARKER = '…[truncated]';

export function truncateForAudit(text: string): string {
  if (text.length <= AUDIT_COMMAND_MAX_LEN) return text;
  // Reserve room for the marker so the returned string is bounded
  // by `AUDIT_COMMAND_MAX_LEN` total, not `MAX_LEN + marker`. The
  // previous shape "first 1024 chars + marker" silently allowed
  // entries past the documented cap. #520 Copilot review.
  const usable = AUDIT_COMMAND_MAX_LEN - AUDIT_TRUNCATION_MARKER.length;
  return `${text.slice(0, usable)}${AUDIT_TRUNCATION_MARKER}`;
}

async function ensureAuditDir(): Promise<void> {
  const dir = getAuditLogDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // see pushd-device-tokens.ts for why chmod-after-mkdir is tolerated
  }
}

/**
 * Rotate the live log to `.1` and shift older entries. Bounded by
 * `PUSHD_AUDIT_MAX_FILES` — entries beyond the cap are deleted.
 * Returns silently when there's nothing to rotate (live file doesn't
 * exist yet).
 *
 * The rotation walks from highest index down to avoid clobbering
 * intermediate files (rename `.4 → .5` first, then `.3 → .4`, etc.).
 */
async function rotateIfNeeded(): Promise<void> {
  const livePath = getAuditLogPath();
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(livePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.size < getAuditMaxBytes()) return;
  const maxFiles = getAuditMaxFiles();
  // Walk from oldest to newest so each rename's source is intact.
  // For maxFiles=5: drop `.5` if it exists, then `.4 → .5`, `.3 → .4`,
  // `.2 → .3`, `.1 → .2`, finally live → `.1`.
  const oldestPath = `${livePath}.${maxFiles}`;
  await fs.rm(oldestPath, { force: true });
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = `${livePath}.${i}`;
    const to = `${livePath}.${i + 1}`;
    try {
      await fs.rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  try {
    await fs.rename(livePath, `${livePath}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// Serialize appends within the process — concurrent appendFile calls
// against the same fd can interleave bytes and corrupt NDJSON. Cross-
// process serialization is handled by appendFile's underlying open
// flags (O_APPEND on POSIX is atomic for writes ≤ PIPE_BUF). The
// queue is unbounded by design: callers fire-and-forget, and back-
// pressure on a write to a local file is unlikely on a desktop daemon.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

/**
 * Append one event to the audit log. Fire-and-forget from the caller's
 * POV — the returned promise is observed only by tests; production
 * callers `void appendAuditEvent(...)`. Failures are swallowed to
 * stderr because losing audit lines must NEVER block the operation
 * being audited. (If the disk is full enough that we can't append a
 * 200-byte JSON line, the user has bigger problems than the missing
 * audit entry.)
 */
export async function appendAuditEvent(input: AuditEventInput): Promise<void> {
  if (!isAuditEnabled()) return;
  const event: AuditEvent = {
    v: SCHEMA_VERSION,
    ts: Date.now(),
    ...input,
  };
  try {
    // JSON.stringify lives INSIDE the try block so a caller that
    // accidentally hands us a non-JSON-serializable payload (BigInt,
    // circular structure, etc.) doesn't blow past the "audit never
    // blocks" guarantee. Without this, the throw escapes to the
    // event loop as an unhandled rejection. #520 Copilot review.
    const line = `${JSON.stringify(event)}\n`;
    await serialize(async () => {
      await ensureAuditDir();
      await rotateIfNeeded();
      // O_APPEND + mode 0600 on first create. The mode argument is only
      // honored when the file is created; subsequent appends keep the
      // existing perms (which we re-assert below as a defense against
      // a hand-edited file dropping back to 0644 mid-life).
      await fs.appendFile(getAuditLogPath(), line, { mode: 0o600 });
      try {
        await fs.chmod(getAuditLogPath(), 0o600);
      } catch {
        // platforms without POSIX perms ignore
      }
    });
  } catch (err) {
    process.stderr.write(
      `pushd-audit-log: append failed (${(err as Error).message ?? err}); event dropped.\n`,
    );
  }
}

export interface ReadAuditOptions {
  /** Return only the last N events (after time/type filters). */
  tail?: number;
  /** Filter to events with ts >= this epoch-ms value. */
  sinceMs?: number;
  /** Filter to events whose `type` matches this exact string. */
  type?: AuditEventType;
  /**
   * When true, also read rotated files (`.1`, `.2`, ...). Default
   * true — operators usually want the full window. Set to false in
   * tests that only care about the live file's contents.
   */
  includeRotated?: boolean;
}

/**
 * Read events from the live + rotated logs, applying filters. Returns
 * events sorted by `ts` ascending. NB: this loads the matched events
 * into memory; for very large logs callers should set `tail` to bound
 * the read. The decision doc's spec is "operator-grade inspection,"
 * not "streaming high-throughput export," so a single in-memory pass
 * is the right shape today.
 */
export async function readAuditEvents(opts: ReadAuditOptions = {}): Promise<AuditEvent[]> {
  const livePath = getAuditLogPath();
  const includeRotated = opts.includeRotated ?? true;
  const paths: string[] = [livePath];
  if (includeRotated) {
    const maxFiles = getAuditMaxFiles();
    for (let i = 1; i <= maxFiles; i++) {
      paths.push(`${livePath}.${i}`);
    }
  }
  const all: AuditEvent[] = [];
  for (const p of paths) {
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Other errors are surfaced — a corrupted audit file should
      // not silently disappear from the inspection surface.
      throw err;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // skip corrupted lines silently in the read path
      }
      const candidate = parsed as Partial<AuditEvent>;
      if (
        candidate &&
        candidate.v === SCHEMA_VERSION &&
        typeof candidate.ts === 'number' &&
        typeof candidate.type === 'string'
      ) {
        all.push(candidate as AuditEvent);
      }
    }
  }
  const filtered = all.filter((e) => {
    if (opts.sinceMs !== undefined && e.ts < opts.sinceMs) return false;
    if (opts.type !== undefined && e.type !== opts.type) return false;
    return true;
  });
  filtered.sort((a, b) => a.ts - b.ts);
  if (opts.tail !== undefined && opts.tail > 0 && filtered.length > opts.tail) {
    return filtered.slice(filtered.length - opts.tail);
  }
  return filtered;
}

/** Exposed for tests; do not call from production paths. */
export const __test__ = {
  SCHEMA_VERSION,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  AUDIT_COMMAND_MAX_LEN,
};
