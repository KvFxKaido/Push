/**
 * file-operation-handlers.ts — daemon-backed read/write/list/diff handlers.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 2). Path
 * normalization, allowlist authorization, sensitive-path refusal, filesystem
 * error sanitization, and output bounds stay with the handlers they protect.
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { isSensitivePath as isDaemonSensitivePath } from '../../lib/sensitive-paths.js';
import { isPathAllowed, snapshotAllowlist } from '../pushd-allowlist.js';
import { makeErrorResponse, makeResponse, type DaemonResponse } from './envelopes.js';
import type { DaemonEmitEvent, DaemonRequest } from './handler-types.js';

const SANDBOX_FILE_MAX_BYTES = 1_000_000;
const SANDBOX_FILE_MAX_LINES = 50_000;
// Ranged reads use a higher cap so callers can reach deep into multi-MB logs.
// Buffer-and-split preserves the whole-file path's totalLines semantics.
const SANDBOX_RANGED_READ_MAX_BYTES = 32_000_000;
const SANDBOX_LIST_MAX_ENTRIES = 1_000;
const SANDBOX_DIFF_MAX_BYTES = 1_000_000;
const SANDBOX_GIT_TIMEOUT_MS = 30_000;
const GIT_EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface FsFailure {
  code?: unknown;
}

/** Resolve a model-supplied path against the daemon's workspace cwd. */
function resolveDaemonPath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return '';
  const cwd = process.cwd();
  if (value.startsWith('/workspace/')) {
    const resolved = path.resolve(cwd, value.slice('/workspace/'.length));
    return isContainedIn(resolved, cwd) ? resolved : null;
  }
  if (value === '/workspace') return cwd;
  if (path.isAbsolute(value)) return value;
  // Bare relative path: resolve against cwd AND enforce containment.
  // A model-emitted `../outside` would resolve to a sibling of cwd
  // and let the daemon read/write outside the paired workspace root
  // — pairing consents to cwd, not to traversal. Absolute paths are
  // still honored because pairing gates that explicitly; this only
  // tightens the relative-path surface. Copilot PR #516.
  const resolved = path.resolve(cwd, value);
  return isContainedIn(resolved, cwd) ? resolved : null;
}

function isContainedIn(absChild: string, absParent: string): boolean {
  const relative = path.relative(absParent, absChild);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveAndAuthorize(rawPath: unknown): Promise<string | null> {
  const resolved = resolveDaemonPath(rawPath);
  if (resolved === null || resolved === '') return null;
  const snapshot = await snapshotAllowlist(process.cwd());
  return isPathAllowed(resolved, snapshot) ? resolved : null;
}

function safeFsErrorPayload(err: unknown, requestedPath: string): { code: string; error: string } {
  const rawCode = (err as FsFailure | null | undefined)?.code;
  const code = typeof rawCode === 'string' ? rawCode : 'READ_FAILED';
  let message: string;
  if (code === 'ENOENT') message = 'No such file or directory';
  else if (code === 'EACCES') message = 'Permission denied';
  else if (code === 'EISDIR') message = 'Path is a directory, not a file';
  else if (code === 'ENOTDIR') message = 'Path is not a directory';
  else if (code === 'EBUSY') message = 'Resource busy or locked';
  else if (code === 'EMFILE' || code === 'ENFILE') message = 'Too many open files';
  else message = 'Filesystem operation failed';
  return { code, error: `${message}: ${requestedPath}` };
}

export async function handleSandboxReadFile(
  req: DaemonRequest,
  _emitEvent: DaemonEmitEvent,
): Promise<DaemonResponse> {
  const payload = req.payload || {};
  const rawPath = typeof payload.path === 'string' ? payload.path : '';
  if (!rawPath) {
    return makeErrorResponse(
      req.requestId,
      'sandbox_read_file',
      'INVALID_REQUEST',
      'sandbox_read_file requires a non-empty `path` string in payload.',
    );
  }
  if (isDaemonSensitivePath(rawPath)) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: '',
      truncated: false,
      error: 'sensitive path refused by daemon',
      code: 'SENSITIVE_PATH',
    });
  }
  const resolved = await resolveAndAuthorize(rawPath);
  if (resolved === null) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: '',
      truncated: false,
      error: `path escapes workspace root: ${rawPath}`,
      code: 'PATH_OUTSIDE_WORKSPACE',
    });
  }
  const startLine = Number.isInteger(payload.startLine) ? (payload.startLine as number) : undefined;
  const endLine = Number.isInteger(payload.endLine) ? (payload.endLine as number) : undefined;
  const isRangeRead = startLine !== undefined || endLine !== undefined;

  if (isRangeRead) {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
        content: '',
        truncated: false,
        ...safeFsErrorPayload(err, rawPath),
      });
    }
    if (stat.size > SANDBOX_RANGED_READ_MAX_BYTES) {
      return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
        content: '',
        truncated: true,
        error: `file exceeds ${SANDBOX_RANGED_READ_MAX_BYTES} byte cap for ranged reads`,
        code: 'FILE_TOO_LARGE',
      });
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(resolved);
    } catch (err) {
      return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
        content: '',
        truncated: false,
        ...safeFsErrorPayload(err, rawPath),
      });
    }
    const allLines = buffer.toString('utf8').split('\n');
    const totalLines = allLines.length;
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(totalLines, Math.max(start, endLine ?? totalLines));
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: allLines.slice(start - 1, end).join('\n'),
      truncated: false,
      totalLines,
    });
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(resolved);
  } catch (err) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: '',
      truncated: false,
      ...safeFsErrorPayload(err, rawPath),
    });
  }
  if (buffer.length > SANDBOX_FILE_MAX_BYTES) {
    return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
      content: buffer.slice(0, SANDBOX_FILE_MAX_BYTES).toString('utf8'),
      truncated: true,
    });
  }
  const allText = buffer.toString('utf8');
  const allLines = allText.split('\n');
  const totalLines = allLines.length;
  return makeResponse(req.requestId, 'sandbox_read_file', null, true, {
    content:
      totalLines > SANDBOX_FILE_MAX_LINES
        ? allLines.slice(0, SANDBOX_FILE_MAX_LINES).join('\n')
        : allText,
    truncated: totalLines > SANDBOX_FILE_MAX_LINES,
    totalLines,
  });
}

export async function handleSandboxWriteFile(
  req: DaemonRequest,
  _emitEvent: DaemonEmitEvent,
): Promise<DaemonResponse> {
  const payload = req.payload || {};
  const rawPath = typeof payload.path === 'string' ? payload.path : '';
  const content = typeof payload.content === 'string' ? payload.content : null;
  if (!rawPath || content === null) {
    return makeErrorResponse(
      req.requestId,
      'sandbox_write_file',
      'INVALID_REQUEST',
      'sandbox_write_file requires `path` and `content` strings in payload.',
    );
  }
  if (isDaemonSensitivePath(rawPath)) {
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: false,
      error: 'sensitive path refused by daemon',
    });
  }
  const resolved = await resolveAndAuthorize(rawPath);
  if (resolved === null) {
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: false,
      error: `path escapes workspace root: ${rawPath}`,
    });
  }
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf8');
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: true,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    });
  } catch (err) {
    const { error } = safeFsErrorPayload(err, rawPath);
    return makeResponse(req.requestId, 'sandbox_write_file', null, true, {
      ok: false,
      error,
    });
  }
}

export async function handleSandboxListDir(
  req: DaemonRequest,
  _emitEvent: DaemonEmitEvent,
): Promise<DaemonResponse> {
  const payload = req.payload || {};
  const rawPath = typeof payload.path === 'string' && payload.path ? payload.path : '.';
  if (isDaemonSensitivePath(rawPath)) {
    return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
      entries: [],
      truncated: false,
      error: 'sensitive path refused by daemon',
    });
  }
  const resolved = await resolveAndAuthorize(rawPath);
  if (resolved === null) {
    return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
      entries: [],
      truncated: false,
      error: `path escapes workspace root: ${rawPath}`,
    });
  }

  let dirents: Dirent<string>[];
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    const { error } = safeFsErrorPayload(err, rawPath);
    return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
      entries: [],
      truncated: false,
      error,
    });
  }
  const truncated = dirents.length > SANDBOX_LIST_MAX_ENTRIES;
  const entries = await Promise.all(
    (truncated ? dirents.slice(0, SANDBOX_LIST_MAX_ENTRIES) : dirents).map(async (dirent) => {
      const type = dirent.isFile()
        ? 'file'
        : dirent.isDirectory()
          ? 'directory'
          : dirent.isSymbolicLink()
            ? 'symlink'
            : 'other';
      let size: number | undefined;
      if (type === 'file') {
        try {
          size = (await fs.stat(path.join(resolved, dirent.name))).size;
        } catch {
          // Best-effort — leave size undefined.
        }
      }
      return { name: dirent.name, type, size };
    }),
  );
  return makeResponse(req.requestId, 'sandbox_list_dir', null, true, {
    entries,
    truncated,
  });
}

export async function handleSandboxDiff(
  req: DaemonRequest,
  _emitEvent: DaemonEmitEvent,
): Promise<DaemonResponse> {
  const { runCommandInResolvedShell } = await import('../shell.js');
  const cwd = process.cwd();
  const cwdSnapshot = await snapshotAllowlist(cwd);
  if (!isPathAllowed(cwd, cwdSnapshot)) {
    return makeResponse(req.requestId, 'sandbox_diff', null, true, {
      diff: '',
      truncated: false,
      error: `daemon cwd is not in the allowlist: ${cwd}`,
    });
  }

  let diffText = '';
  let statusText = '';
  let diffError: unknown;
  let diffBase = 'HEAD';
  try {
    await runCommandInResolvedShell('git rev-parse --verify HEAD', {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: 64_000,
    });
  } catch {
    diffBase = GIT_EMPTY_TREE;
  }
  try {
    const output = await runCommandInResolvedShell(`git diff ${diffBase}`, {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: SANDBOX_DIFF_MAX_BYTES + 64_000,
    });
    diffText = String(output.stdout || '');
  } catch (err) {
    const failure = err as { stderr?: unknown; message?: unknown };
    diffError = failure.stderr || failure.message || 'git diff failed';
  }
  try {
    const output = await runCommandInResolvedShell('git status --porcelain', {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: 256_000,
    });
    statusText = String(output.stdout || '');
  } catch {
    // Status is advisory.
  }

  let headSha: string | undefined;
  try {
    const output = await runCommandInResolvedShell('git rev-parse HEAD', {
      cwd,
      timeout: SANDBOX_GIT_TIMEOUT_MS,
      maxBuffer: 64_000,
    });
    const trimmed = String(output.stdout || '').trim();
    if (trimmed) headSha = trimmed;
  } catch {
    // HEAD may not exist in a fresh repo.
  }

  let diffSinceRef = '';
  const rawSinceRef =
    typeof req.payload?.since_ref === 'string' ? req.payload.since_ref.trim() : '';
  const sinceRef = /^[0-9a-f]{7,40}$/i.test(rawSinceRef) ? rawSinceRef : '';
  if (sinceRef) {
    try {
      const output = await runCommandInResolvedShell(`git diff ${sinceRef}..HEAD`, {
        cwd,
        timeout: SANDBOX_GIT_TIMEOUT_MS,
        maxBuffer: SANDBOX_DIFF_MAX_BYTES + 64_000,
      });
      diffSinceRef = String(output.stdout || '');
    } catch {
      // Ranged-diff failure is non-fatal; retain the working-tree response.
    }
  }

  const truncated = diffText.length > SANDBOX_DIFF_MAX_BYTES;
  const truncatedSinceRef = diffSinceRef.length > SANDBOX_DIFF_MAX_BYTES;
  return makeResponse(req.requestId, 'sandbox_diff', null, true, {
    diff: truncated ? `${diffText.slice(0, SANDBOX_DIFF_MAX_BYTES)}\n…[truncated]` : diffText,
    truncated,
    gitStatus: statusText,
    ...(headSha ? { headSha } : {}),
    ...(diffSinceRef
      ? {
          diffSinceRef: truncatedSinceRef
            ? `${diffSinceRef.slice(0, SANDBOX_DIFF_MAX_BYTES)}\n…[truncated]`
            : diffSinceRef,
        }
      : {}),
    error: diffError,
  });
}
