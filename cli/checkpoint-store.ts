/**
 * Checkpoint store — Nano-style snapshot/rollback for the CLI.
 *
 * Captures three things per checkpoint into `<workspace>/.push/checkpoints/<name>/`:
 *
 *  - `meta.json`        — name, createdAt, provider, model, sessionId, branch,
 *                         head sha, file count, message count, and the list
 *                         of relative paths that were snapshotted.
 *  - `messages.jsonl`   — copy of the session's `messages.jsonl` at create time
 *                         (informational v1 — see `loadCheckpoint` below).
 *  - `files/<rel-path>` — file snapshots for paths that differ from HEAD
 *                         (modified/added/untracked, excluding deleted ones).
 *                         Capped at MAX_FILE_BYTES per file to avoid binary
 *                         blowups; oversized files are listed in `meta.skippedFiles`.
 *
 * Restore semantics (intentional v1, matches Nano):
 *
 *  - Files are written back immediately; conversation rollback is not applied
 *    in-process (mutating live `state.messages` mid-session is a footgun that
 *    intersects compaction, run-in-flight checks, and the message-log writer).
 *    The CLI tells the user they can resume the captured `sessionId` after
 *    `/exit` to get the conversation back.
 *
 * Path-traversal hardening:
 *
 *  - Names are validated against a strict regex and resolved through the
 *    workspace `.push/checkpoints/` root with a startsWith guard, mirroring
 *    `cli/session-store.ts`'s defense-in-depth pattern.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_FILE_BYTES = 1_000_000;
const CHECKPOINT_DIR_NAME = 'checkpoints';
const META_FILENAME = 'meta.json';
const MESSAGES_FILENAME = 'messages.jsonl';
const FILES_SUBDIR = 'files';

export interface CheckpointMeta {
  name: string;
  createdAt: string;
  provider?: string | null;
  model?: string | null;
  sessionId?: string | null;
  branch?: string | null;
  head?: string | null;
  messageCount: number;
  fileCount: number;
  files: string[];
  skippedFiles?: { path: string; reason: string }[];
}

export interface CreateCheckpointOptions {
  workspaceRoot: string;
  name?: string;
  sessionId: string;
  /**
   * In-memory session messages to snapshot as JSONL. Snapshotting from
   * the in-memory state (rather than the on-disk path) sidesteps
   * `cli/session-store.ts`'s legacy cwd-local read path, which can
   * silently leave `messages.jsonl` empty for resumed sessions whose log
   * lives outside the default session root.
   */
  messages?: readonly unknown[];
  provider?: string | null;
  model?: string | null;
}

export interface LoadResult {
  restoredFiles: string[];
  skippedFiles: { path: string; reason: string }[];
  meta: CheckpointMeta;
}

// ---------------------------------------------------------------------------
// Name validation + path resolution
// ---------------------------------------------------------------------------

export function validateCheckpointName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid checkpoint name "${name}". Use 1-64 chars, alphanumeric / dot / hyphen / underscore, starting alphanumeric.`,
    );
  }
  return name;
}

export function getCheckpointRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.push', CHECKPOINT_DIR_NAME);
}

function getCheckpointDir(workspaceRoot: string, name: string): string {
  validateCheckpointName(name);
  const root = getCheckpointRoot(workspaceRoot);
  const dir = path.resolve(root, name);
  if (!dir.startsWith(`${root}${path.sep}`) && dir !== root) {
    throw new Error('Checkpoint dir escapes checkpoint root');
  }
  return dir;
}

function defaultName(): string {
  // ISO-like, filesystem-safe with millisecond precision so two unnamed
  // creates in the same wall-second don't collide:
  //   2026-05-08_23-45-12_345
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return [
    d.getUTCFullYear(),
    '-',
    pad(d.getUTCMonth() + 1),
    '-',
    pad(d.getUTCDate()),
    '_',
    pad(d.getUTCHours()),
    '-',
    pad(d.getUTCMinutes()),
    '-',
    pad(d.getUTCSeconds()),
    '_',
    pad(d.getUTCMilliseconds(), 3),
  ].join('');
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(workspaceRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function gitTry(workspaceRoot: string, args: string[]): Promise<string | null> {
  try {
    return await git(workspaceRoot, args);
  } catch {
    return null;
  }
}

/**
 * List paths that differ from HEAD: modified, added, untracked. Deleted
 * files are excluded — we can't snapshot bytes that aren't there, and
 * surfacing them as "deletions to undo" would require a different restore
 * path. Gitignored files are excluded because `git status` honors
 * `.gitignore` (we pass `--untracked-files=all` for genuine untracked).
 *
 * Uses `--porcelain=v1 -z` (NUL-delimited) instead of newline-split. With
 * default `core.quotepath`, newline-split parsing breaks on filenames with
 * spaces (C-quoted) or unusual chars. NUL termination is the standard
 * robust path. Renames in `-z` output emit two records per entry — the
 * to-path first, then the from-path — so we step over the from-path.
 */
async function listChangedFiles(workspaceRoot: string): Promise<string[]> {
  const out = await gitTry(workspaceRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (out == null) return [];
  const tokens = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record) continue;
    if (record.length < 3) continue;
    const status = record.slice(0, 2);
    const rest = record.slice(3);
    // Porcelain v1: when X==R (rename) or X==C (copy), the next NUL-
    // terminated record is the from-path. Consume it so it isn't
    // mistakenly parsed as its own entry.
    const isRenameOrCopy = status[0] === 'R' || status[0] === 'C';
    if (isRenameOrCopy) i++;
    // Skip any deletion: X==D pairs only with Y==' ' (per git-status(1)),
    // and Y==D means the worktree no longer has the file regardless of X.
    if (status[0] === 'D' || status[1] === 'D') continue;
    paths.push(rest);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// File snapshot helpers
// ---------------------------------------------------------------------------

async function copyFileWithCap(
  src: string,
  dest: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let stat;
  try {
    stat = await fs.stat(src);
  } catch (err) {
    return { ok: false, reason: `stat failed: ${(err as Error).message}` };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, reason: `exceeds ${MAX_FILE_BYTES}-byte cap (${stat.size} bytes)` };
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return { ok: true };
}

async function ensureGitignoreEntry(workspaceRoot: string): Promise<void> {
  const giPath = path.join(workspaceRoot, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(giPath, 'utf8');
  } catch {
    // No .gitignore — write a fresh one.
  }
  const target = '.push/checkpoints/';
  // git treats `.push/checkpoints` (no trailing slash) and `.push/checkpoints/`
  // identically for our purposes; treat either as already-present so we don't
  // append a duplicate when the user has already added the no-slash form.
  const existing = new Set(content.split('\n').map((line) => line.trim()));
  if (existing.has(target) || existing.has('.push/checkpoints')) return;
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const trailer = content.length === 0 ? '' : '\n';
  await fs.writeFile(
    giPath,
    `${content}${sep}# Push CLI checkpoint snapshots\n${target}${trailer}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function createCheckpoint(opts: CreateCheckpointOptions): Promise<CheckpointMeta> {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const name = opts.name?.trim() ? validateCheckpointName(opts.name.trim()) : defaultName();
  const dir = getCheckpointDir(workspaceRoot, name);

  const existing = await fs.stat(dir).catch(() => null);
  if (existing) {
    throw new Error(`Checkpoint "${name}" already exists. Delete it first or pick a new name.`);
  }

  await fs.mkdir(path.join(dir, FILES_SUBDIR), { recursive: true });

  const branch =
    (await gitTry(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
  const head = (await gitTry(workspaceRoot, ['rev-parse', 'HEAD']))?.trim() || null;
  const changed = await listChangedFiles(workspaceRoot);

  const captured: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const rel of changed) {
    const src = path.resolve(workspaceRoot, rel);
    if (!src.startsWith(`${workspaceRoot}${path.sep}`) && src !== workspaceRoot) {
      skipped.push({ path: rel, reason: 'outside workspace' });
      continue;
    }
    const dest = path.join(dir, FILES_SUBDIR, rel);
    const result = await copyFileWithCap(src, dest);
    if (result.ok) captured.push(rel);
    else skipped.push({ path: rel, reason: result.reason });
  }

  let messageCount = 0;
  if (opts.messages && opts.messages.length > 0) {
    const lines = `${opts.messages.map((m) => JSON.stringify(m)).join('\n')}\n`;
    await fs.writeFile(path.join(dir, MESSAGES_FILENAME), lines);
    messageCount = opts.messages.length;
  }

  const meta: CheckpointMeta = {
    name,
    createdAt: new Date().toISOString(),
    provider: opts.provider ?? null,
    model: opts.model ?? null,
    sessionId: opts.sessionId,
    branch,
    head,
    messageCount,
    fileCount: captured.length,
    files: captured,
    ...(skipped.length ? { skippedFiles: skipped } : {}),
  };
  await fs.writeFile(path.join(dir, META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`);

  // Best-effort: keep snapshots out of git. Failure (read-only fs, etc.) is non-fatal.
  await ensureGitignoreEntry(workspaceRoot).catch(() => {});

  return meta;
}

export async function listCheckpoints(workspaceRoot: string): Promise<CheckpointMeta[]> {
  const root = getCheckpointRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const metas: CheckpointMeta[] = [];
  for (const name of entries) {
    if (!NAME_RE.test(name)) continue;
    const metaPath = path.join(root, name, META_FILENAME);
    try {
      const raw = await fs.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.name === name) {
        metas.push(parsed as CheckpointMeta);
      }
    } catch {
      // Corrupt or partial — skip.
    }
  }
  metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return metas;
}

export async function loadCheckpoint(workspaceRoot: string, name: string): Promise<LoadResult> {
  const dir = getCheckpointDir(workspaceRoot, name);
  const metaPath = path.join(dir, META_FILENAME);
  let meta: CheckpointMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as CheckpointMeta;
  } catch (err) {
    throw new Error(`Cannot load checkpoint "${name}": ${(err as Error).message}`);
  }
  const filesRoot = path.join(dir, FILES_SUBDIR);
  const restored: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const rel of meta.files) {
    const src = path.resolve(filesRoot, rel);
    if (!src.startsWith(`${filesRoot}${path.sep}`) && src !== filesRoot) {
      skipped.push({ path: rel, reason: 'snapshot path escapes checkpoint root' });
      continue;
    }
    const dest = path.resolve(workspaceRoot, rel);
    if (!dest.startsWith(`${workspaceRoot}${path.sep}`) && dest !== workspaceRoot) {
      skipped.push({ path: rel, reason: 'restore path escapes workspace' });
      continue;
    }
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      restored.push(rel);
    } catch (err) {
      skipped.push({ path: rel, reason: (err as Error).message });
    }
  }
  return { restoredFiles: restored, skippedFiles: skipped, meta };
}

export async function deleteCheckpoint(workspaceRoot: string, name: string): Promise<void> {
  const dir = getCheckpointDir(workspaceRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
}
