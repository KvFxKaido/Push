/**
 * pushd-allowlist.ts — Repo/root allowlist for the daemon.
 *
 * Phase 3 of the remote-sessions track (item #2 in the decision doc's
 * "Permission and Audit Model" minimum model). The allowlist gates
 * which filesystem roots a paired device may resolve paths against.
 * Today the device-token model authorizes the WS upgrade but says
 * nothing about which paths the holder can touch — `resolveDaemonPath`
 * containment-checks relative paths against cwd but honors absolute
 * paths unconditionally. The allowlist closes that gap.
 *
 * Storage: `~/.push/run/pushd.allowlist` (override via
 * `PUSHD_ALLOWLIST_PATH`). NDJSON, one record per line, mode 0600 /
 * dir mode 0700 — same posture as the device-tokens file.
 *
 * Default content: when the file does NOT exist, the daemon's cwd at
 * startup acts as an implicit single-entry allowlist. The moment a
 * user explicitly adds or removes an entry, the file is created and
 * from then on enforcement is "ONLY the listed roots" — cwd is no
 * longer implicit. This keeps the existing pair-and-go UX working
 * with zero config while making opt-in tightening explicit.
 *
 * Invariants:
 *  - Every stored path is absolute and normalized. We refuse to add
 *    relative paths, paths with `..` segments, or empty strings.
 *  - Paths are NOT followed through symlinks at storage time. The
 *    enforcement path (`isPathAllowed`) compares lexically against
 *    `path.resolve(p)`, which handles `..` segments but does NOT
 *    realpath. That's a deliberate trade-off: symlink chasing would
 *    mean filesystem stat() on every request, and our threat model
 *    is "stolen bearer used against this daemon" — not "attacker
 *    plants a symlink on the user's machine first."
 *  - The empty list ALWAYS allows cwd (the implicit-default mode).
 *    Mutations that would leave the file present but empty fall
 *    back to "delete the file" so the implicit default re-engages.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export interface AllowlistEntry {
  /** Absolute, normalized filesystem path. Never contains `..`. */
  path: string;
  /** Unix-ms when the entry was added; for UI/audit display. */
  addedAt: number;
}

function getAllowlistPath(): string {
  if (process.env.PUSHD_ALLOWLIST_PATH) return process.env.PUSHD_ALLOWLIST_PATH;
  return path.join(os.homedir(), '.push', 'run', 'pushd.allowlist');
}

function getAllowlistDir(): string {
  return path.dirname(getAllowlistPath());
}

async function ensureAllowlistDir(): Promise<void> {
  const dir = getAllowlistDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // chmod can fail on platforms without POSIX perms; the recursive
    // mkdir above is best-effort, and the file-level perms below are
    // the real gate (mirrors pushd-device-tokens.ts).
  }
}

/**
 * Validate + normalize a candidate path. Rejects relative paths,
 * non-strings, and paths whose normalization changes them in
 * security-meaningful ways (this is rare with absolute inputs but
 * catches e.g. `/foo/../../etc` which resolves outside `/foo`).
 *
 * Returns the normalized absolute path on success, or null on
 * rejection. The caller surfaces a user-facing error.
 */
export function normalizeAllowlistPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!path.isAbsolute(raw)) return null;
  const normalized = path.resolve(raw);
  // path.resolve also collapses `..` — `/foo/..` becomes `/`. That
  // can be surprising to a user who typed `/foo/..` thinking they
  // meant the literal string. We accept it (the resolved path is
  // what enforcement compares against), but reject any residual
  // `..` segments that survived resolve (shouldn't happen for
  // absolute inputs).
  if (normalized.split(path.sep).includes('..')) return null;
  return normalized;
}

interface ReadResult {
  entries: AllowlistEntry[];
  /**
   * `true` when the underlying file does NOT exist, meaning the
   * implicit-cwd default applies. Callers distinguish this from
   * "file exists but happens to be empty" — the latter is treated
   * as "all roots denied" rather than "cwd implicit."
   */
  isImplicitDefault: boolean;
}

async function readAllowlistFile(): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(getAllowlistPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], isImplicitDefault: true };
    }
    throw err;
  }
  const entries: AllowlistEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<AllowlistEntry>;
      if (typeof parsed.path === 'string' && typeof parsed.addedAt === 'number') {
        const normalized = normalizeAllowlistPath(parsed.path);
        if (normalized !== null) {
          entries.push({ path: normalized, addedAt: parsed.addedAt });
        }
      }
    } catch {
      // Skip malformed lines rather than crash the daemon. Same
      // forgiving posture as pushd-device-tokens.ts.
    }
  }
  return { entries, isImplicitDefault: false };
}

// Serialize all read-modify-write cycles within this process, mirroring
// the device-tokens module. Cross-process races (CLI mutate while
// daemon reads) interleave at human latency and the daemon re-reads
// on every check.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

async function writeAllowlistFileLocked(entries: AllowlistEntry[]): Promise<void> {
  await ensureAllowlistDir();
  const allowlistPath = getAllowlistPath();
  if (entries.length === 0) {
    // Delete the file rather than leave a 0-byte one behind: an empty
    // file means "explicitly deny everything" which is footgun-y, and
    // the implicit-cwd default is the sensible "I removed my last
    // entry" landing spot. unlink-ENOENT is tolerated.
    try {
      await fs.unlink(allowlistPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return;
  }
  const tmpPath = `${allowlistPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const handle = await fs.open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, allowlistPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  try {
    await fs.chmod(allowlistPath, 0o600);
  } catch {
    // see ensureAllowlistDir
  }
}

/**
 * Add a path to the allowlist. Returns `true` if a new entry was
 * created, `false` if the path was already present (idempotent).
 * Throws if `rawPath` doesn't validate.
 */
export async function addAllowedPath(rawPath: string): Promise<boolean> {
  const normalized = normalizeAllowlistPath(rawPath);
  if (normalized === null) {
    throw new Error(`Invalid allowlist path: ${rawPath} (must be absolute and free of "..")`);
  }
  return serialize(async () => {
    const { entries } = await readAllowlistFile();
    if (entries.some((e) => e.path === normalized)) return false;
    entries.push({ path: normalized, addedAt: Date.now() });
    await writeAllowlistFileLocked(entries);
    return true;
  });
}

/**
 * Remove a path from the allowlist. Returns `true` if an entry was
 * removed, `false` if no matching entry existed.
 */
export async function removeAllowedPath(rawPath: string): Promise<boolean> {
  const normalized = normalizeAllowlistPath(rawPath);
  if (normalized === null) return false;
  return serialize(async () => {
    const { entries } = await readAllowlistFile();
    const next = entries.filter((e) => e.path !== normalized);
    if (next.length === entries.length) return false;
    await writeAllowlistFileLocked(next);
    return true;
  });
}

/** List the current explicit allowlist entries (does NOT include the implicit cwd default). */
export async function listAllowedPaths(): Promise<AllowlistEntry[]> {
  const { entries } = await readAllowlistFile();
  return entries;
}

/**
 * Snapshot of the effective allowlist for enforcement. The daemon's
 * filesystem handlers call this once per request and feed it to
 * `isPathAllowed`. Caching across requests is intentionally NOT done
 * here — the file is small, NDJSON, and the user expects edits via
 * the CLI to take effect on the next request without restarting the
 * daemon. If profiling later shows this is hot, a watch-and-cache
 * layer can be added without changing the API.
 */
export interface AllowlistSnapshot {
  /**
   * Absolute, normalized paths the holder may resolve against. When
   * `isImplicitDefault` is `true`, this contains a single entry —
   * the daemon's cwd at snapshot time. Otherwise it's the explicit
   * file content (which may be empty if the user just removed the
   * last entry; we treat empty + non-implicit as "deny all" but
   * `readAllowlistFile`+`writeAllowlistFileLocked` collapse that
   * state back to implicit-default on every mutation).
   */
  allowed: readonly string[];
  /** True when no explicit allowlist file exists and cwd is being used. */
  isImplicitDefault: boolean;
}

export async function snapshotAllowlist(cwd: string = process.cwd()): Promise<AllowlistSnapshot> {
  const { entries, isImplicitDefault } = await readAllowlistFile();
  if (isImplicitDefault) {
    const resolved = path.resolve(cwd);
    return { allowed: [resolved], isImplicitDefault: true };
  }
  return { allowed: entries.map((e) => e.path), isImplicitDefault: false };
}

/**
 * Test whether `absPath` (already resolved) falls under any allowed
 * root in the snapshot. The check is lexical containment via
 * `path.relative` — same primitive `resolveDaemonPath`'s `isContainedIn`
 * uses today, so semantics match.
 *
 * The path is allowed iff it equals one of the roots OR sits under
 * one (a strict child). `..`-bearing relatives are rejected.
 */
export function isPathAllowed(absPath: string, snapshot: AllowlistSnapshot): boolean {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return false;
  if (snapshot.allowed.length === 0) return false;
  const resolved = path.resolve(absPath);
  for (const root of snapshot.allowed) {
    const rel = path.relative(root, resolved);
    if (rel === '') return true;
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/** Exposed for tests; do not call from production paths. */
export const __test__ = {
  getAllowlistPath,
};
