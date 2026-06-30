/**
 * Thin HTTP client for the sandbox proxy at /api/sandbox/*.
 *
 * All calls go through the Cloudflare Worker which proxies to Modal.
 * No Modal SDK or gRPC — just plain fetch().
 */

import {
  deleteFileVersion,
  fileVersionKey,
  setByKey as setFileVersionByKey,
  setWorkspaceRevisionByKey,
  setSandboxWorkspaceRevision,
} from './sandbox-file-version-cache';
import {
  runDetachedToCompletion,
  type DetachedExecPrimitives,
  type DetachedTerminalReason,
} from '@push/lib/detached-exec-runner';
import { resolveApiUrl } from './api-url';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import {
  getPushTracer,
  injectTraceHeaders,
  recordSpanError,
  setSpanAttributes,
  SpanKind,
  SpanStatusCode,
} from './tracing';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';
import { classifyTokenString } from './github-auth';
import {
  USER_TOKEN_GATE_MESSAGE,
  evaluateRepoAuth,
  hasAcknowledgedUserTokenInjection,
} from './sandbox-auth-gate';
import { notifyWorkspaceMutation } from './sandbox-mutation-signal';

// --- Types ---

export interface SandboxEnvironment {
  tools: Record<string, string>; // e.g. { node: "v20.18.1", npm: "10.8.2" }
  project_markers?: string[]; // e.g. ["package.json", "requirements.txt"]
  warnings?: string[]; // e.g. ["Low disk space: 450M"]
  disk_free?: string; // e.g. "45000M"
  scripts?: Record<string, string>; // e.g. { test: "vitest run", lint: "eslint ." }
  git_available?: boolean; // whether git works in the sandbox
  container_ttl?: string; // e.g. "30m"
  uptime_seconds?: number; // seconds since sandbox start
  writable_root?: string; // e.g. "/workspace"
  readiness?: {
    package_manager?: string;
    dependencies?: 'installed' | 'missing' | 'unknown';
    test_command?: string;
    typecheck_command?: string;
    test_runner?: string;
  };
}

export interface SandboxSession {
  sandboxId: string;
  ownerToken?: string;
  status: 'ready' | 'error';
  error?: string;
  workspaceRevision?: number;
  environment?: SandboxEnvironment;
}

export interface GitCommitIdentity {
  name: string;
  email: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** Error message from the sandbox backend (e.g. "Sandbox not found or expired"). Present when exit_code is -1 (command never dispatched). */
  error?: string;
  workspaceRevision?: number;
  /** Workspace git branch after the command completed. Omitted when unavailable. */
  branch?: string;
}

interface WorkspaceMutationExecOptions {
  markWorkspaceMutated?: boolean;
  suppressWorkspaceMutationSignal?: boolean;
}

function notifyMarkedWorkspaceMutation(
  sandboxId: string,
  options?: WorkspaceMutationExecOptions,
): void {
  if (options?.markWorkspaceMutated === true && options.suppressWorkspaceMutationSignal !== true) {
    notifyWorkspaceMutation(sandboxId);
  }
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
  error?: string;
  /** Line where truncation begins; use as the next start_line when continuing a read. */
  truncated_at_line?: number;
  /** Approximate UTF-8 bytes omitted from the returned content. */
  remaining_bytes?: number;
  /** SHA-256 of full file content at read time */
  version?: string | null;
  /** Normalized start line returned by backend for range reads */
  start_line?: number;
  /** End line returned by backend for bounded range reads */
  end_line?: number;
  /** Monotonic workspace revision at read time */
  workspace_revision?: number;
  /** Structured read failure code when the backend detected a moving target. */
  code?: string;
  expected_workspace_revision?: number;
  current_workspace_revision?: number;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
  /** Raw `git status --porcelain` output for diagnostics */
  git_status?: string;
  /**
   * Current HEAD SHA at fetch time, or undefined when the diff fetch
   * could not capture it (legacy sandbox builds, git failure). Lets
   * callers pre/post-snapshot the Coder run to detect commits even
   * when the working-tree diff is empty after a successful commit.
   * See PR #604.
   */
  head_sha?: string;
  /**
   * Diff against an alternate base ref when callers pass `since_ref`
   * to the diff endpoint. Captures committed-but-not-uncommitted work
   * (the post-commit Auditor false-positive from PR #601). The field
   * is **omitted from the response** (undefined here) when `since_ref`
   * was not supplied, the ranged diff body was empty, or the ranged
   * git command failed — callers cannot distinguish those cases from
   * each other today. Combine with `head_sha` to determine intent.
   */
  diff_since_ref?: string;
  error?: string;
}

export interface SandboxSymbol {
  name: string;
  kind: string;
  line: number;
  signature: string;
}

export interface SandboxReadSymbolsResult {
  symbols: SandboxSymbol[];
  totalLines: number;
}

export interface SandboxReference {
  file: string;
  line: number;
  context: string;
  kind: 'import' | 'call';
}

export interface SandboxFindReferencesResult {
  references: SandboxReference[];
  truncated: boolean;
}

// --- Error types ---

export interface SandboxError {
  error: string;
  code?: string;
  details?: string;
}

// User-friendly error messages for each error code
const ERROR_MESSAGES: Record<string, string> = {
  MODAL_NOT_CONFIGURED:
    'Sandbox is not configured. Ask your admin to set up MODAL_SANDBOX_BASE_URL.',
  MODAL_URL_INVALID:
    'Sandbox URL is misconfigured. The MODAL_SANDBOX_BASE_URL format is incorrect.',
  MODAL_URL_TRAILING_SLASH:
    'Sandbox URL has a trailing slash. Remove it from MODAL_SANDBOX_BASE_URL.',
  MODAL_NOT_FOUND: 'Sandbox app not deployed. Run: cd sandbox && modal deploy app.py',
  MODAL_AUTH_FAILED: 'Modal authentication failed. Your Modal tokens may have expired.',
  MODAL_UNAVAILABLE: 'Sandbox is starting up. Try again in a few seconds.',
  MODAL_TIMEOUT: 'Sandbox operation timed out. Try a simpler command.',
  MODAL_NETWORK_ERROR: 'Cannot connect to the sandbox. Check your network or Modal status.',
  MODAL_ERROR:
    'Sandbox container error. The container may be unhealthy — try restarting the sandbox.',
  CONTAINER_ERROR: 'Sandbox container is unhealthy. Restarting the sandbox may fix this.',
  MODAL_UNKNOWN_ERROR: 'An unexpected sandbox error occurred.',
  // CF worker codes (worker-cf-sandbox.ts). TIMEOUT is the worker-side exec
  // deadline — the command may still be running, which is a different
  // situation from the in-container `timeout` kill (exit 124 with partial
  // output) and from a dead sandbox.
  TIMEOUT:
    'The sandbox stopped responding before the operation finished. It may still be running — verify its effects before re-running.',
  NOT_FOUND: 'Sandbox not found or expired. Start a new sandbox to continue.',
  // A path inside a LIVE sandbox doesn't exist (e.g. listed a directory that
  // isn't there). Deliberately worded WITHOUT "sandbox not found" so the
  // friendly text can't trip `isDefinitivelyGoneMessage` and launder a benign
  // missing-path into a fatal sandbox-loss.
  FILE_NOT_FOUND: 'No such file or directory in the workspace.',
  DISK_FULL:
    'The sandbox workspace is out of disk space. Delete build artifacts or caches to free space — restarting the sandbox loses uncommitted work.',
};

function formatSandboxError(status: number, body: string): Error {
  try {
    const parsed = JSON.parse(body) as SandboxError;
    const code = parsed.code || 'UNKNOWN';
    const friendlyMessage = ERROR_MESSAGES[code] || parsed.error || 'Sandbox error';
    const details = parsed.details ? `\n\nDetails: ${parsed.details}` : '';
    return new Error(`${friendlyMessage} (${code})${details}`);
  } catch {
    // Body wasn't JSON, fall back to raw text
    return new Error(`Sandbox error (${status}): ${body.slice(0, 200)}`);
  }
}

// --- Error code mapping ---

import type { ToolErrorType } from '@/types';

/**
 * Map sandbox-client error codes (MODAL_TIMEOUT, etc.) to the unified ToolErrorType.
 */
export function mapSandboxErrorCode(code: string): ToolErrorType {
  switch (code) {
    case 'MODAL_TIMEOUT':
      return 'EXEC_TIMEOUT';
    case 'MODAL_NETWORK_ERROR':
      return 'SANDBOX_UNREACHABLE';
    case 'MODAL_NOT_CONFIGURED':
    case 'MODAL_URL_INVALID':
    case 'MODAL_URL_TRAILING_SLASH':
    case 'MODAL_NOT_FOUND':
      return 'SANDBOX_UNREACHABLE';
    case 'MODAL_AUTH_FAILED':
      return 'AUTH_FAILURE';
    case 'MODAL_UNAVAILABLE':
      return 'SANDBOX_UNREACHABLE';
    case 'MODAL_ERROR':
      return 'SANDBOX_UNREACHABLE';
    case 'CONTAINER_ERROR':
      return 'SANDBOX_UNREACHABLE';
    case 'STALE_FILE':
      return 'STALE_FILE';
    case 'WORKSPACE_CHANGED':
      return 'WORKSPACE_CHANGED';
    // CF worker codes — previously fell through to UNKNOWN, so a worker-side
    // exec deadline ("sandbox unresponsive, outcome unknown") was
    // indistinguishable from any other failure in structured tool errors.
    case 'TIMEOUT':
      return 'EXEC_TIMEOUT';
    // NOT_FOUND → SANDBOX_UNREACHABLE mirrors MODAL_NOT_FOUND above; the
    // ToolErrorType vocabulary has no "sandbox definitively gone" member.
    // This mapping is NOT the gone-detector: recovery paths decide
    // definitive-vs-transient via isDefinitivelyGoneMessage() on message
    // text, and toSandboxError (modal-sandbox-provider.ts) refines the raw
    // code back to SandboxError NOT_FOUND before callers branch on it.
    case 'NOT_FOUND':
    case 'CF_ERROR':
    case 'CF_NOT_CONFIGURED':
      return 'SANDBOX_UNREACHABLE';
    // A missing path inside a live sandbox — benign and recoverable (the model
    // tries another path), NOT a sandbox loss. Kept distinct from NOT_FOUND so
    // it never routes to SANDBOX_UNREACHABLE / the fatal gone-detector.
    case 'FILE_NOT_FOUND':
      return 'FILE_NOT_FOUND';
    case 'AUTH_FAILURE':
      return 'AUTH_FAILURE';
    case 'DISK_FULL':
      return 'WRITE_FAILED';
    default:
      return 'UNKNOWN';
  }
}

// --- Helpers ---

const SANDBOX_BASE = '/api/sandbox';
const DEFAULT_TIMEOUT_MS = 30_000; // 30s for most operations
// 165s for command execution in production. Must stay above the Worker's
// per-exec deadline (`SANDBOX_EXEC_TIMEOUT_MS = 150_000` in
// worker-cf-sandbox.ts) so a wedged container surfaces as the Worker's
// structured 504 (`code: 'TIMEOUT'`) instead of a client-side AbortError.
// The container shell `timeout` is set at 140s, the Worker deadline at 150s;
// this client ceiling adds ~15s of network + JSON round-trip slack on top so
// the inner deadlines reliably fire first and the outer one is only ever a
// safety net.
//
// In local Vite dev the Worker can raise its own deadline to 300s via
// `SANDBOX_DEV_LONG_DEADLINE` (cold-built wrangler containers routinely
// overshoot 150s on first start). Allow the client ceiling to be raised
// in lockstep via `VITE_SANDBOX_EXEC_TIMEOUT_MS` so cold starts surface
// the Worker's structured response instead of a premature client abort.
// The override is gated on `import.meta.env.DEV` and bad values fall back
// to the production-safe default. The optional-chained access mirrors the
// pattern in github-auth.ts: anything in the Worker dependency graph can
// transitively hit this module, and `import.meta.env` is undefined on the
// Worker runtime — referencing it directly would crash deploy validation.
const EXEC_TIMEOUT_MS_FALLBACK = 165_000;
const sandboxClientMetaEnv = (
  import.meta as ImportMeta & {
    env?: { DEV?: boolean; VITE_SANDBOX_EXEC_TIMEOUT_MS?: string };
  }
).env;
const execTimeoutOverride =
  sandboxClientMetaEnv?.DEV === true
    ? Number.parseInt(sandboxClientMetaEnv.VITE_SANDBOX_EXEC_TIMEOUT_MS ?? '', 10)
    : Number.NaN;
const EXEC_TIMEOUT_MS =
  Number.isFinite(execTimeoutOverride) && execTimeoutOverride > 0
    ? execTimeoutOverride
    : EXEC_TIMEOUT_MS_FALLBACK;
let sandboxOwnerToken: string | null = null;
const sandboxOwnerTokensById = new Map<string, string>();

// --- Idle tracking (used by useSandbox for hibernation timer) ---

let lastSandboxCallAt = 0;
let suppressActivityTouchCount = 0;
let inFlightSandboxCalls = 0;

function touchSandboxActivity(): void {
  lastSandboxCallAt = Date.now();
}

/**
 * Consume one pending suppression, if any. Called at `sandboxFetch` ENTRY —
 * synchronously, before the first await — so a `suppressIdleTouch()` placed
 * immediately before a maintenance call can't be stolen by a concurrent
 * call's completion, and the suppressed call is excluded from idle
 * accounting for its whole lifetime (no stamp, no in-flight count).
 */
function consumeIdleTouchSuppression(): boolean {
  if (suppressActivityTouchCount > 0) {
    suppressActivityTouchCount--;
    return true;
  }
  return false;
}

/** Returns ms since the last completed sandbox API call (success or failure), or Infinity if no call has been made. */
export function msSinceLastSandboxCall(): number {
  return lastSandboxCallAt ? Date.now() - lastSandboxCallAt : Infinity;
}

/**
 * True while any sandbox API call is awaiting a response. The idle hibernation
 * timer must treat in-flight work as activity — a long-running exec (or one
 * riding retry backoff) can hold a single call open past the idle threshold
 * without ever stamping the clock.
 */
export function hasInFlightSandboxCalls(): boolean {
  return inFlightSandboxCalls > 0;
}

/**
 * Mark the next N sandboxFetch calls as maintenance traffic, invisible to
 * idle accounting: they neither stamp the idle clock nor count as in-flight
 * work for the hibernation reaper. Used for health-check probes (which must
 * not defeat idle hibernation) and the reaper's own hibernate call (whose
 * failure must not push the retry out by a full idle window). Suppression is
 * consumed synchronously at call entry — call this immediately before the
 * maintenance call.
 */
export function suppressIdleTouch(count = 1): void {
  suppressActivityTouchCount += count;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const SANDBOX_TS_ARROW_FUNCTION_REGEX = String.raw`^(?:export\s+)?(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>`;

const SANDBOX_READ_SYMBOLS_SCRIPT = `
import sys, json, os

path = sys.argv[1]
ext = os.path.splitext(path)[1].lower()
symbols = []

try:
    with open(path, 'r', errors='replace') as f:
        content = f.read()
        lines = content.split('\\n')
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)

if ext == '.py':
    import ast
    try:
        tree = ast.parse(content, filename=path)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
                args = ', '.join(a.arg for a in node.args.args)
                prefix = 'async ' if isinstance(node, ast.AsyncFunctionDef) else ''
                symbols.append({"name": node.name, "kind": "function", "line": node.lineno, "signature": f"{prefix}def {node.name}({args})"})
            elif isinstance(node, ast.ClassDef):
                bases = ', '.join(getattr(b, 'id', '?') if hasattr(b, 'id') else '?' for b in node.bases)
                symbols.append({"name": node.name, "kind": "class", "line": node.lineno, "signature": f"class {node.name}({bases})" if bases else f"class {node.name}"})
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                if isinstance(node, ast.ImportFrom):
                    names = ', '.join(a.name for a in node.names)
                    symbols.append({"name": node.module or '', "kind": "import", "line": node.lineno, "signature": f"from {node.module} import {names}"})
                else:
                    for alias in node.names:
                        symbols.append({"name": alias.name, "kind": "import", "line": node.lineno, "signature": f"import {alias.name}"})
    except SyntaxError as e:
        symbols.append({"name": "PARSE_ERROR", "kind": "error", "line": e.lineno or 0, "signature": str(e)})
else:
    import re
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        m = re.match(r'^export\\s+(default\\s+)?(async\\s+)?function\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(3), "kind": "function", "line": i, "signature": stripped.split('{')[0].strip().rstrip(':')})
            continue
        m = re.match(r'^(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "class", "line": i, "signature": stripped.split('{')[0].strip()})
            continue
        m = re.match(r'^(?:export\\s+)?interface\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "interface", "line": i, "signature": stripped.split('{')[0].strip()})
            continue
        m = re.match(r'^(?:export\\s+)?type\\s+(\\w+)\\s*[=<]', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "type", "line": i, "signature": stripped.split('=')[0].strip()})
            continue
        m = re.match(r'${SANDBOX_TS_ARROW_FUNCTION_REGEX}', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "function", "line": i, "signature": stripped.split('=')[0].strip().rstrip(':')})
            continue
        m = re.match(r'^(?:export\\s+)?(const|let|var)\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(2), "kind": "variable", "line": i, "signature": stripped.split('=')[0].strip().rstrip(':')})
            continue
        m = re.match(r'^(async\\s+)?function\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(2), "kind": "function", "line": i, "signature": stripped.split('{')[0].strip().rstrip(':')})
            continue

print(json.dumps({"symbols": symbols, "total_lines": len(lines)}))
`.trim();

/**
 * Regex-based fallback for symbol extraction when the Python AST extractor
 * fails (timeout, signal, parse error). Reads the file line-by-line and matches
 * top-level declarations. Less accurate than AST but resilient to syntax errors.
 * The file path is passed as the first positional argument after `--`.
 */
const SANDBOX_REGEX_FALLBACK_SCRIPT = `
const fs = require('fs');
const readline = require('readline');
const filePath = process.argv[1];
if (!fs.existsSync(filePath)) process.exit(1);
const rl = readline.createInterface({ input: fs.createReadStream(filePath), terminal: false });
let lineCount = 0;
const symbols = [];
const regex = /^(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(function|class|interface|type|const|let|var)\\s+([a-zA-Z0-9_]+)/;
rl.on('line', (line) => {
  lineCount++;
  const match = line.match(regex);
  if (match) {
    symbols.push({
      name: match[2],
      kind: match[1].trim(),
      line: lineCount,
      signature: line.trim().split('{')[0].trim()
    });
  }
});
rl.on('close', () => {
  console.log(JSON.stringify({ symbols, total_lines: lineCount }));
});
`.trim();

const SANDBOX_FIND_REFERENCES_SCRIPT = `
import sys, json, os, subprocess

symbol = sys.argv[1]
scope = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else '/workspace'

try:
    max_results = int(sys.argv[3]) if len(sys.argv) > 3 else 30
except Exception:
    max_results = 30

if max_results < 1:
    max_results = 30

workspace_root = '/workspace'
search_scope = scope

if scope == workspace_root:
    search_scope = '.'
elif scope.startswith(workspace_root + '/'):
    search_scope = os.path.relpath(scope, workspace_root)

proc = subprocess.Popen(
    ['rg', '-rnw', '--json', symbol, search_scope],
    cwd=workspace_root,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    errors='replace',
)

references = []
truncated = False
skip_remaining = False

for raw in proc.stdout or []:
    if skip_remaining:
        continue

    try:
        message = json.loads(raw)
    except Exception:
        continue

    if message.get('type') != 'match':
        continue

    data = message.get('data') or {}
    path = ((data.get('path') or {}).get('text')) or ''
    line_number = data.get('line_number')
    context = (((data.get('lines') or {}).get('text')) or '').rstrip('\\r\\n')
    context_lower = context.lower()
    kind = 'import' if ('import' in context_lower or 'require' in context_lower) else 'call'

    if len(references) >= max_results:
        truncated = True
        proc.kill()
        break

    references.append({
        'file': path,
        'line': line_number,
        'context': context,
        'kind': kind,
    })

try:
    proc.wait(timeout=2)
except Exception:
    proc.kill()
    proc.wait()
exit_code = proc.returncode or 0

stderr = ''
try:
    stderr = (proc.stderr.read().strip() if proc.stderr else '') or ''
except Exception:
    pass

if exit_code not in (0, 1, -9):
    print(json.dumps({'error': stderr or f'rg exited with code {exit_code}'}))
    sys.exit(0)

print(json.dumps({'references': references, 'truncated': truncated}))
`.trim();

export function setSandboxOwnerToken(token: string | null, sandboxId?: string): void {
  const normalized = token && token.trim() ? token.trim() : null;
  if (sandboxId) {
    if (normalized) sandboxOwnerTokensById.set(sandboxId, normalized);
    else sandboxOwnerTokensById.delete(sandboxId);
  }
  if (sandboxId === undefined) {
    sandboxOwnerToken = normalized;
  }
}

export function getSandboxOwnerToken(sandboxId?: string): string | null {
  if (sandboxId) return sandboxOwnerTokensById.get(sandboxId) || null;
  return sandboxOwnerToken;
}

// --- Sandbox environment (module-level cache keyed by sandbox id) ---

const sandboxEnvironmentsById = new Map<string, SandboxEnvironment>();
let activeSandboxEnvironmentId: string | null = null;

export function getSandboxEnvironment(sandboxId?: string): SandboxEnvironment | null {
  const targetId = sandboxId ?? activeSandboxEnvironmentId;
  if (!targetId) return null;
  return sandboxEnvironmentsById.get(targetId) || null;
}

export interface SandboxLifecycleEvent {
  timestamp: number;
  message: string;
}

const sandboxLifecycleEventsById = new Map<string, SandboxLifecycleEvent[]>();
const SANDBOX_LIFECYCLE_EVENTS_STORAGE_PREFIX = 'sandbox_lifecycle_events:';

function buildSandboxLifecycleStorageKey(sandboxId: string): string {
  return `${SANDBOX_LIFECYCLE_EVENTS_STORAGE_PREFIX}${encodeURIComponent(sandboxId)}`;
}

function parsePersistedSandboxLifecycleEvents(raw: string | null): SandboxLifecycleEvent[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SandboxLifecycleEvent =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as SandboxLifecycleEvent).timestamp === 'number' &&
          typeof (item as SandboxLifecycleEvent).message === 'string',
      )
      .slice(-20);
  } catch {
    return [];
  }
}

function persistSandboxLifecycleEvents(sandboxId: string, events: SandboxLifecycleEvent[]): void {
  safeStorageSet(buildSandboxLifecycleStorageKey(sandboxId), JSON.stringify(events.slice(-20)));
}

function loadSandboxLifecycleEvents(sandboxId: string): SandboxLifecycleEvent[] {
  return parsePersistedSandboxLifecycleEvents(
    safeStorageGet(buildSandboxLifecycleStorageKey(sandboxId)),
  );
}

export function recordSandboxLifecycleEvent(sandboxId: string, message: string): void {
  const events = [...getSandboxLifecycleEvents(sandboxId)];
  events.push({ timestamp: Date.now(), message });
  if (events.length > 20) events.shift();
  sandboxLifecycleEventsById.set(sandboxId, events);
  persistSandboxLifecycleEvents(sandboxId, events);
}

export function getSandboxLifecycleEvents(sandboxId?: string): SandboxLifecycleEvent[] {
  const targetId = sandboxId ?? activeSandboxEnvironmentId;
  if (!targetId) return [];
  const cached = sandboxLifecycleEventsById.get(targetId);
  if (cached) return cached;

  const persisted = loadSandboxLifecycleEvents(targetId);
  if (persisted.length > 0) {
    sandboxLifecycleEventsById.set(targetId, persisted);
    return persisted;
  }
  return [];
}

export function setSandboxEnvironment(sandboxId: string, env: SandboxEnvironment | null): void {
  if (env) sandboxEnvironmentsById.set(sandboxId, env);
  else sandboxEnvironmentsById.delete(sandboxId);
}

export function setActiveSandboxEnvironment(sandboxId: string | null): void {
  activeSandboxEnvironmentId = sandboxId;
}

export function clearSandboxEnvironment(sandboxId?: string): void {
  if (sandboxId) {
    sandboxLifecycleEventsById.delete(sandboxId);
    safeStorageRemove(buildSandboxLifecycleStorageKey(sandboxId));
    sandboxEnvironmentsById.delete(sandboxId);
    if (activeSandboxEnvironmentId === sandboxId) {
      activeSandboxEnvironmentId = null;
    }
    return;
  }

  if (activeSandboxEnvironmentId) {
    sandboxLifecycleEventsById.delete(activeSandboxEnvironmentId);
    safeStorageRemove(buildSandboxLifecycleStorageKey(activeSandboxEnvironmentId));
    sandboxEnvironmentsById.delete(activeSandboxEnvironmentId);
    activeSandboxEnvironmentId = null;
  }
}

/**
 * Parse raw stdout from the environment probe shell script.
 * Used for client-side re-probing on reconnect.
 */
export function parseEnvironmentProbe(stdout: string): SandboxEnvironment | null {
  if (!stdout) return null;

  const sections: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('---') && trimmed.endsWith('---') && trimmed.length > 6) {
      current = trimmed.replace(/^-+|-+$/g, '');
      sections[current] = [];
    } else if (current && trimmed) {
      sections[current].push(trimmed);
    }
  }

  const tools: Record<string, string> = {};
  const warnings: string[] = [];

  for (const item of sections['VERSIONS'] || []) {
    const colonIdx = item.indexOf(':');
    if (colonIdx < 0) continue;
    const name = item.slice(0, colonIdx);
    const version = item.slice(colonIdx + 1);
    if (version === 'MISSING') {
      warnings.push(`${name} not available`);
    } else {
      tools[name] = version;
    }
  }

  const diskLines = sections['DISK'] || [];
  const diskFree = diskLines[0] || undefined;
  if (diskFree) {
    const mb = parseInt(diskFree.replace(/M$/, ''), 10);
    if (!isNaN(mb) && mb < 500) {
      warnings.push(`Low disk space: ${diskFree}`);
    }
  }

  const markers = sections['MARKERS'] || [];
  const readinessSignals = sections['READINESS'] || [];

  const scripts: Record<string, string> = {};
  for (const item of sections['SCRIPTS'] || []) {
    const colonIdx = item.indexOf(':');
    if (colonIdx < 0) continue;
    const name = item.slice(0, colonIdx).trim();
    const cmd = item.slice(colonIdx + 1).trim();
    if (name && cmd) scripts[name] = cmd;
  }

  const gitAvailable = 'git' in tools;
  const markerSet = new Set(markers);

  const detectPackageManager = (): string | undefined => {
    if (markerSet.has('pnpm-lock.yaml')) return 'pnpm';
    if (markerSet.has('yarn.lock')) return 'yarn';
    if (markerSet.has('package-lock.json') || markerSet.has('package.json')) return 'npm';
    if (
      markerSet.has('pyproject.toml') ||
      markerSet.has('requirements.txt') ||
      markerSet.has('setup.py')
    )
      return 'python';
    if (markerSet.has('Cargo.toml')) return 'cargo';
    if (markerSet.has('go.mod')) return 'go';
    if (markerSet.has('pom.xml')) return 'maven';
    if (markerSet.has('Gemfile')) return 'bundler';
    if (markerSet.has('Makefile')) return 'make';
    return undefined;
  };

  const buildScriptCommand = (
    packageManager: string | undefined,
    scriptName: string,
  ): string | undefined => {
    if (!packageManager) return undefined;
    if (packageManager === 'npm') {
      return scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`;
    }
    if (packageManager === 'yarn') return `yarn ${scriptName}`;
    if (packageManager === 'pnpm') return `pnpm ${scriptName}`;
    return undefined;
  };

  const inferTestRunner = (testScript: string | undefined): string | undefined => {
    const normalized = testScript?.toLowerCase() ?? '';
    if (!normalized) return undefined;
    if (normalized.includes('vitest')) return 'vitest';
    if (normalized.includes('jest')) return 'jest';
    if (normalized.includes('playwright')) return 'playwright';
    if (normalized.includes('pytest')) return 'pytest';
    if (normalized.includes('cargo test')) return 'cargo test';
    if (normalized.includes('go test')) return 'go test';
    return undefined;
  };

  const packageManager = detectPackageManager();
  const readiness: NonNullable<SandboxEnvironment['readiness']> = {};
  if (packageManager) readiness.package_manager = packageManager;

  if (packageManager === 'npm' || packageManager === 'yarn' || packageManager === 'pnpm') {
    const dependencySignal = readinessSignals.find((item) => item.startsWith('js_dependencies:'));
    readiness.dependencies = dependencySignal?.endsWith(':installed')
      ? 'installed'
      : dependencySignal?.endsWith(':missing')
        ? 'missing'
        : 'unknown';
  }

  if (scripts.test) {
    readiness.test_command = buildScriptCommand(packageManager, 'test') ?? scripts.test;
    readiness.test_runner = inferTestRunner(scripts.test);
  }
  if (scripts.typecheck) {
    readiness.typecheck_command =
      buildScriptCommand(packageManager, 'typecheck') ?? scripts.typecheck;
  } else if (
    scripts.check &&
    /\b(tsc|typecheck|type-check|pyright|mypy|cargo test|go test)\b/i.test(scripts.check)
  ) {
    readiness.typecheck_command = buildScriptCommand(packageManager, 'check') ?? scripts.check;
  }

  if (
    readiness.dependencies === 'missing' &&
    (readiness.test_command || readiness.typecheck_command || scripts.build)
  ) {
    warnings.push(
      'Dependencies not installed (node_modules missing); test/typecheck/build scripts may fail until install.',
    );
  }

  const uptimeLines = sections['UPTIME'] || [];
  const uptimeRaw = uptimeLines[0];
  let uptimeSeconds: number | undefined;
  if (uptimeRaw && uptimeRaw !== 'MISSING') {
    uptimeSeconds = Math.floor(parseFloat(uptimeRaw.split(' ')[0]));
  }

  const result: SandboxEnvironment = { tools };
  if (markers.length) result.project_markers = markers;
  if (warnings.length) result.warnings = warnings;
  if (diskFree) result.disk_free = diskFree;
  if (Object.keys(scripts).length) result.scripts = scripts;
  result.git_available = gitAvailable;
  result.container_ttl = '30m'; // placeholder; probeSandboxEnvironment preserves the authoritative TTL
  result.writable_root = '/workspace';
  if (uptimeSeconds !== undefined) result.uptime_seconds = uptimeSeconds;
  if (Object.keys(readiness).length > 0) result.readiness = readiness;
  return result;
}

/** Probe script — mirrors _run_environment_probe() in app.py */
const ENVIRONMENT_PROBE_SCRIPT =
  'echo "---VERSIONS---";' +
  'echo "node:$(node -v 2>/dev/null || echo MISSING)";' +
  'echo "npm:$(npm -v 2>/dev/null || echo MISSING)";' +
  'echo "git:$(command -v git >/dev/null 2>&1 && git --version 2>/dev/null | head -c 40 || echo MISSING)";' +
  'echo "python:$(python3 -V 2>/dev/null || echo MISSING)";' +
  'echo "---DISK---";' +
  "df -BM /workspace 2>/dev/null | tail -1 | awk '{print $4}';" +
  'echo "---UPTIME---";' +
  'cat /proc/uptime 2>/dev/null || echo MISSING;' +
  'echo "---MARKERS---";' +
  'cd /workspace 2>/dev/null && for f in package.json package-lock.json yarn.lock pnpm-lock.yaml' +
  ' requirements.txt pyproject.toml setup.py Cargo.toml go.mod pom.xml Gemfile Makefile; do' +
  ' [ -f "$f" ] && echo "$f"; done;' +
  'echo "---SCRIPTS---";' +
  'cd /workspace 2>/dev/null && if [ -f package.json ]; then' +
  ' python3 -c "import json,sys;' +
  " d=json.load(open('package.json'));" +
  " s=d.get('scripts');" +
  ' s=s if isinstance(s,dict) else {};' +
  ' [print(f\\"{k}:{str(v).replace(chr(10),\' \')}\\") for k,v in s.items()' +
  " if k in ('test','lint','typecheck','build','dev','start','check','format')]" +
  '" 2>/dev/null; fi;' +
  'echo "---READINESS---";' +
  'cd /workspace 2>/dev/null && if [ -f package.json ]; then' +
  ' if [ -d node_modules ]; then echo "js_dependencies:installed"; else echo "js_dependencies:missing"; fi;' +
  ' fi;' +
  'echo "---END---"';

/**
 * Run environment probe on an existing sandbox (used on reconnect).
 * Best-effort — returns null on any failure.
 */
export async function probeSandboxEnvironment(
  sandboxId: string,
): Promise<SandboxEnvironment | null> {
  try {
    // Health probes should not reset the idle-hibernation clock.
    suppressIdleTouch();
    const result = await execInSandbox(sandboxId, ENVIRONMENT_PROBE_SCRIPT);
    const env = parseEnvironmentProbe(result.stdout);
    if (env) {
      // The shell probe can't know the backend's real container lifetime, so
      // parseEnvironmentProbe fills in a placeholder container_ttl. Don't let a
      // re-probe clobber the authoritative value captured from create/restore
      // (e.g. Modal's derived 2h) with that guess.
      const priorTtl = getSandboxEnvironment(sandboxId)?.container_ttl;
      if (priorTtl) env.container_ttl = priorTtl;
      setSandboxEnvironment(sandboxId, env);
    }
    return env;
  } catch {
    return null;
  }
}

function withOwnerToken(
  body: Record<string, unknown>,
  sandboxId?: string,
): Record<string, unknown> {
  const token = (sandboxId ? sandboxOwnerTokensById.get(sandboxId) : null) || sandboxOwnerToken;
  if (!token) {
    throw new Error('Sandbox access token missing. Start or reconnect the sandbox session.');
  }
  return { ...body, owner_token: token };
}

export function isMissingOwnerTokenError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === 'Sandbox access token missing. Start or reconnect the sandbox session.'
  );
}

function withSnapshotIndexContext(
  body: Record<string, unknown>,
  context: { repoFullName?: string | null; branch?: string | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (context.repoFullName) out.repo_full_name = context.repoFullName;
  if (context.branch) out.branch = context.branch;
  return out;
}

// --- Retry configuration ---

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000; // 2s, 4s, 8s, 16s exponential backoff

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determines if an error is retryable (network issues, timeouts, 5xx errors).
 * Non-retryable: 4xx client errors, configuration errors, dead sandbox errors.
 *
 * `endpoint` is consulted to opt `exec` out of timeout retries. A wedged
 * sandbox container (gRPC channel stuck after a heavy FS write) doesn't
 * recover on its own, so blindly replaying four `exec` calls with 2/4/8/16s
 * backoff just hides the failure for ~12 minutes. Other endpoints
 * (read/write/list/diff) are cheap and idempotent, so we keep retrying them.
 */
function isRetryableError(err: unknown, statusCode?: number, endpoint?: string): boolean {
  // `exec` and `exec-start` LAUNCH a command, so they share the wedged-container
  // hazard: replaying a timed-out launch against a stuck container just hides
  // the failure for ~12 minutes (and a duplicate launch is wasteful). Opt them
  // out of timeout/504 retries. The other background routes (exec-status/-logs/
  // -kill) are cheap idempotent reads/controls like read/list, so they keep the
  // normal retry policy — a transient blip on a status poll should recover.
  const isExec = endpoint === 'exec' || endpoint === 'exec-start';

  // Timeout errors (original AbortError). Not retryable for exec — see above.
  if (err instanceof DOMException && err.name === 'AbortError') {
    return !isExec;
  }

  // Timeout errors converted to generic Error (check message pattern).
  if (err instanceof Error && err.message.includes('timed out')) {
    return !isExec;
  }

  // Network errors (fetch failed entirely) are retryable
  if (err instanceof TypeError && err.message.includes('fetch')) {
    return true;
  }

  // 5xx server errors are retryable, but not if the sandbox is gone —
  // the Worker returns MODAL_NOT_FOUND for dead/expired sandboxes even
  // on 500 status codes, and retrying won't bring them back.
  if (statusCode && statusCode >= 500) {
    if (err instanceof Error && err.message.includes('MODAL_NOT_FOUND')) {
      return false;
    }
    // Worker's per-exec deadline fires as 504 with `code: 'TIMEOUT'`. Same
    // reasoning as AbortError above: replaying against a wedged container
    // is futile, so surface it to the caller immediately.
    if (isExec && statusCode === 504) {
      return false;
    }
    return true;
  }

  // 4xx client errors and other errors are not retryable
  return false;
}

/**
 * Wraps a fetch call with exponential backoff retry logic.
 * Retries up to MAX_RETRIES times with delays: 2s, 4s, 8s, 16s.
 *
 * @param onRetries — optional callback invoked with the total retry count
 *   (0 if first attempt succeeded) just before returning or throwing.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  endpoint: string,
  onRetries?: (retries: number) => void,
  maxRetries: number = MAX_RETRIES,
  onRetryAttempt?: (attempt: number, delayMs: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      onRetries?.(attempt); // attempt 0 = first try succeeded, 1 = 1 retry, etc.
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check for statusCode property (attached in sandboxFetch) or extract from message
      const errWithStatus = err as Error & { statusCode?: number };
      let statusCode = errWithStatus.statusCode;
      if (!statusCode) {
        const statusMatch = lastError.message.match(/\((\d{3})\)/);
        statusCode = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
      }

      // Don't retry non-retryable errors
      if (!isRetryableError(err, statusCode, endpoint)) {
        onRetries?.(attempt);
        throw lastError;
      }

      // Don't retry after the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Exponential backoff: 2s, 4s, 8s, 16s
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      console.log(
        `[sandbox-client] ${endpoint} attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`,
      );
      onRetryAttempt?.(attempt + 1, delayMs, lastError);
      await sleep(delayMs);
    }
  }

  onRetries?.(maxRetries);
  throw new Error(
    `Sandbox ${endpoint} failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
  );
}

async function sandboxFetch<T>(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  onRetries?: (retries: number) => void,
  maxRetries: number = MAX_RETRIES,
): Promise<T> {
  const tracer = getPushTracer('push.sandbox');
  return tracer.startActiveSpan(
    'sandbox.request',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'push.sandbox.endpoint': endpoint,
        'push.timeout_ms': timeoutMs,
        'push.max_retries': maxRetries,
      },
    },
    async (span) => {
      const requestId = createRequestId('sandbox');
      let retryCount = 0;
      const trackActivity = !consumeIdleTouchSuppression();
      if (trackActivity) inFlightSandboxCalls++;

      try {
        const result = await withRetry(
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
              const headers = injectTraceHeaders({
                'Content-Type': 'application/json',
                [REQUEST_ID_HEADER]: requestId,
              });

              const res = await fetch(resolveApiUrl(`${SANDBOX_BASE}/${endpoint}`), {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
              });
              span.setAttribute('http.response.status_code', res.status);

              if (!res.ok) {
                const text = await res.text().catch(() => '');
                // Attach status code for retry logic
                const error = formatSandboxError(res.status, text);
                (error as Error & { statusCode?: number }).statusCode = res.status;
                throw error;
              }

              return res.json();
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') {
                throw new Error(
                  `Sandbox ${endpoint} timed out after ${Math.round(timeoutMs / 1000)}s — the server may be slow or unreachable.`,
                  { cause: err },
                );
              }
              throw err;
            } finally {
              clearTimeout(timer);
            }
          },
          endpoint,
          (retries) => {
            retryCount = retries;
            onRetries?.(retries);
          },
          maxRetries,
          (attempt, delayMs, error) => {
            span.addEvent('sandbox.retry', {
              'push.retry.attempt': attempt,
              'push.retry.delay_ms': delayMs,
              'push.retry.message': error.message,
            });
          },
        );

        setSpanAttributes(span, {
          'push.request_id': requestId,
          'push.retry_count': retryCount,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordSpanError(span, error, {
          'push.request_id': requestId,
          'push.retry_count': retryCount,
        });
        throw error;
      } finally {
        if (trackActivity) {
          inFlightSandboxCalls--;
          // Stamp on completion regardless of outcome — a failed or timed-out
          // call is still activity. Success-only stamping let a streak of
          // timed-out long execs read as 8 minutes of idleness, so the reaper
          // hibernated the container out from under an active round.
          touchSandboxActivity();
        }
        span.end();
      }
    },
  );
}

// --- Public API ---

export async function createSandbox(
  repo: string,
  branch?: string,
  githubToken?: string,
  githubIdentity?: GitCommitIdentity,
  defaultBranch?: string,
): Promise<SandboxSession> {
  // Defense in depth: the React `useSandbox.start` path gates durable
  // user-scoped tokens before it ever reaches here, but `createSandbox` is also
  // the chokepoint for non-hook callers (e.g. the Modal provider) and is
  // reachable directly. Re-evaluate the gate at the point the token is actually
  // baked into the clone URL so no caller can bypass it. Origin context is gone
  // by this layer, so we classify by token shape — which fails safe (an
  // unrecognized shape reads as durable and requires acknowledgment).
  if (repo && githubToken) {
    const kind = classifyTokenString(githubToken);
    // Defense-in-depth re-check: durable-token bypass prevention only. Repo
    // coverage for the installation-token path is enforced upstream in
    // useSandbox (which has the repo + can probe), so pass coverage 'unknown'
    // here — installation tokens fail open, durable tokens still need the ack.
    const gate = evaluateRepoAuth({
      kind,
      hasRepo: true,
      coverage: 'unknown',
      acknowledged: hasAcknowledgedUserTokenInjection(),
    });
    if (!gate.allow) {
      // Structured console line keeps parity with the React hook's gate (repo
      // convention: console.log(JSON.stringify({ level, event, ...ctx }))).
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'sandbox_client_blocked_user_token',
          reason: gate.reason,
          tokenKind: kind,
        }),
      );
      // Also emit a span so this security-relevant block surfaces in backend
      // observability (CF/prod), not just the browser console — a console-only
      // record of a credential-injection block is easy to lose.
      getPushTracer().startActiveSpan(
        'sandbox.create.blocked_user_token',
        { kind: SpanKind.CLIENT },
        (span) => {
          setSpanAttributes(span, {
            'push.gate.reason': gate.reason,
            'push.github.token_kind': kind,
          });
          span.addEvent('sandbox_client_blocked_user_token');
          span.end();
        },
      );
      return { sandboxId: '', status: 'error', error: USER_TOKEN_GATE_MESSAGE };
    }
  }

  const data = await sandboxFetch<{
    sandbox_id: string | null;
    owner_token?: string;
    status?: string;
    error?: string;
    workspace_revision?: number;
    environment?: SandboxEnvironment | null;
  }>('create', {
    repo,
    branch: branch || 'main',
    default_branch: defaultBranch,
    github_token: githubToken || '',
    github_identity: githubIdentity
      ? { name: githubIdentity.name, email: githubIdentity.email }
      : undefined,
  });

  if (!data.sandbox_id || !data.owner_token) {
    return { sandboxId: '', status: 'error', error: data.error || 'Unknown error' };
  }

  setSandboxOwnerToken(data.owner_token);
  setSandboxOwnerToken(data.owner_token, data.sandbox_id);
  if (typeof data.workspace_revision === 'number') {
    setSandboxWorkspaceRevision(data.sandbox_id, data.workspace_revision);
  }

  // Capture environment probe results
  const environment = data.environment || undefined;
  if (environment) setSandboxEnvironment(data.sandbox_id, environment);

  recordSandboxLifecycleEvent(data.sandbox_id, 'Workspace created');

  return {
    sandboxId: data.sandbox_id,
    ownerToken: data.owner_token,
    status: 'ready',
    workspaceRevision: data.workspace_revision,
    environment,
  };
}

export async function execInSandbox(
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: WorkspaceMutationExecOptions,
): Promise<ExecResult> {
  let requestAttempted = false;
  try {
    const body = withOwnerToken(
      {
        sandbox_id: sandboxId,
        command,
        workdir: workdir || '/workspace',
        mark_workspace_mutated: options?.markWorkspaceMutated === true,
      },
      sandboxId,
    );
    requestAttempted = true;
    // API returns snake_case, we need camelCase
    const raw = await sandboxFetch<{
      stdout: string;
      stderr: string;
      exit_code: number;
      truncated: boolean;
      error?: string;
      workspace_revision?: number;
      branch?: string;
    }>('exec', body, EXEC_TIMEOUT_MS);
    if (typeof raw.workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, raw.workspace_revision);
    }
    return {
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exit_code,
      truncated: raw.truncated,
      error: raw.error,
      workspaceRevision: raw.workspace_revision,
      branch: raw.branch,
    };
  } finally {
    // Fire on ATTEMPT, not success (Codex P2 on #996): a marked (mutating)
    // exec that times out or whose response is lost may still have mutated
    // server-side. Signaling here — even when `sandboxFetch` threw — keeps
    // auto-back able to capture it before a later sandbox loss, restoring the
    // dispatcher's old fire-on-attempt coverage. A redundant signal is a cheap
    // no-op (the backup capture's tree/HEAD comparison is the authoritative
    // filter, #995). Only fires for marked, non-suppressed execs.
    if (requestAttempted) notifyMarkedWorkspaceMutation(sandboxId, options);
  }
}

export async function pingSandbox(sandboxId: string): Promise<boolean> {
  const raw = await sandboxFetch<{
    ok?: boolean;
    exit_code?: number;
    error?: string;
  }>(
    'ping',
    withOwnerToken(
      {
        sandbox_id: sandboxId,
        // Modal forwards `ping` to exec-command, so keep the payload valid for
        // that backend. CF ignores these fields after its auth-gated route.
        command: 'true',
        workdir: '/workspace',
      },
      sandboxId,
    ),
  );

  if (raw.ok === false) {
    throw new Error(raw.error || 'Sandbox ping failed');
  }
  if (typeof raw.exit_code === 'number' && raw.exit_code !== 0) {
    throw new Error(raw.error || `Sandbox ping failed with exit code ${raw.exit_code}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Background execution (detached process + resumable cursor logs)
//
// Thin fetch wrappers over the provider-selected /api/sandbox/exec-* routes
// (implemented by the CF handler; Modal's handler 404s them), plus
// `execLongRunningInSandbox` which drives the shared `runDetachedToCompletion`
// kernel and falls back to buffered `execInSandbox` when the backend lacks
// the routes. Used for commands that can outrun the buffered per-exec
// deadline, e.g. a long test suite or a cold `npm install`.
// ---------------------------------------------------------------------------

async function execStartInSandbox(
  sandboxId: string,
  command: string,
  opts?: { workdir?: string; timeoutMs?: number },
): Promise<{ processId: string }> {
  const raw = await sandboxFetch<{ process_id: string }>(
    'exec-start',
    withOwnerToken(
      {
        sandbox_id: sandboxId,
        command,
        workdir: opts?.workdir,
        timeout_ms: opts?.timeoutMs,
      },
      sandboxId,
    ),
  );
  return { processId: raw.process_id };
}

async function execStatusInSandbox(
  sandboxId: string,
  processId: string,
): Promise<{ running: boolean; exitCode: number | null; branch?: string }> {
  const raw = await sandboxFetch<{ running: boolean; exit_code: number | null; branch?: string }>(
    'exec-status',
    withOwnerToken({ sandbox_id: sandboxId, process_id: processId }, sandboxId),
  );
  return { running: raw.running, exitCode: raw.exit_code, branch: raw.branch };
}

async function execLogsInSandbox(
  sandboxId: string,
  processId: string,
  cursors: { cursorStdout: number; cursorStderr: number },
): Promise<{
  stdout: string;
  stderr: string;
  nextCursorStdout: number;
  nextCursorStderr: number;
}> {
  const raw = await sandboxFetch<{
    stdout: string;
    stderr: string;
    next_cursor_stdout: number;
    next_cursor_stderr: number;
  }>(
    'exec-logs',
    withOwnerToken(
      {
        sandbox_id: sandboxId,
        process_id: processId,
        cursor_stdout: cursors.cursorStdout,
        cursor_stderr: cursors.cursorStderr,
      },
      sandboxId,
    ),
  );
  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    nextCursorStdout: raw.next_cursor_stdout,
    nextCursorStderr: raw.next_cursor_stderr,
  };
}

async function execInterruptInSandbox(sandboxId: string, processId: string): Promise<void> {
  await sandboxFetch<{ ok: boolean }>(
    'exec-kill',
    withOwnerToken({ sandbox_id: sandboxId, process_id: processId }, sandboxId),
  );
}

/**
 * Run a long command detached, blocking until it finishes — returns the same
 * `ExecResult` shape as `execInSandbox`. Removes the buffered per-exec deadline
 * for genuinely long commands. Falls back to buffered `execInSandbox` when the
 * active backend has no background routes (the start call 404s).
 */
export async function execLongRunningInSandbox(
  sandboxId: string,
  command: string,
  opts?: {
    workdir?: string;
    markWorkspaceMutated?: boolean;
    suppressWorkspaceMutationSignal?: boolean;
    overallTimeoutMs?: number;
    /**
     * Cooperative cancel for the detached path (interrupt + drain + exit
     * 124). The buffered fallback cannot cancel mid-run — an abort there
     * surfaces only when the call completes, same as before this option.
     */
    abortSignal?: AbortSignal;
    onProgress?: (chunk: { stdout: string; stderr: string }) => void;
  },
): Promise<ExecResult & { terminalReason?: DetachedTerminalReason }> {
  const primitives: DetachedExecPrimitives = {
    start: (cmd, o) => execStartInSandbox(sandboxId, cmd, { workdir: o.workdir }),
    status: (processId) => execStatusInSandbox(sandboxId, processId),
    logs: (processId, cursors) => execLogsInSandbox(sandboxId, processId, cursors),
    interrupt: (processId) => execInterruptInSandbox(sandboxId, processId),
  };
  try {
    const result = await runDetachedToCompletion(primitives, command, {
      workdir: opts?.workdir,
      overallTimeoutMs: opts?.overallTimeoutMs,
      abortSignal: opts?.abortSignal,
      onProgress: opts?.onProgress,
    });
    notifyMarkedWorkspaceMutation(sandboxId, opts);
    return result;
  } catch (err) {
    // runDetachedToCompletion throws ONLY when the start call failed. What we
    // do next depends on how it failed:
    if (isMissingOwnerTokenError(err)) throw err;

    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);

    // The user cancelled while start was in flight — never fall back, that
    // would run the command they just cancelled.
    if (opts?.abortSignal?.aborted) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'background_exec_start_cancelled',
          sandboxId,
          statusCode: statusCode ?? null,
        }),
      );
      return {
        stdout: '',
        stderr: '',
        exitCode: 124,
        truncated: false,
        error: 'command was cancelled before it started',
        terminalReason: 'cancelled',
      };
    }

    // Only a definitive 404 is safe to retry buffered: either the backend has
    // no background routes (Modal) or the sandbox is gone (buffered exec then
    // fails with the same not-found, producing the right unreachable result).
    // Any OTHER start failure — timeout, 5xx, network — is AMBIGUOUS: the
    // worker may have launched the process before the response was lost, and
    // re-running via buffered exec would execute the command twice. Surface
    // the ambiguity instead.
    if (statusCode !== 404) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'background_exec_start_unconfirmed',
          sandboxId,
          statusCode: statusCode ?? null,
          message,
        }),
      );
      notifyMarkedWorkspaceMutation(sandboxId, opts);
      return {
        stdout: '',
        stderr: '',
        exitCode: -1,
        truncated: false,
        error: `background exec start failed without confirmation: ${message}`,
        terminalReason: 'start-unconfirmed',
      };
    }

    // Log the downgrade (symmetric-structured-logs): a silent fallback would
    // hide both a misconfigured CF backend that never uses the detached path
    // AND the loss of live progress for the caller's onProgress.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'background_exec_fallback',
        sandboxId,
        statusCode,
        hadProgressListener: Boolean(opts?.onProgress),
        message,
      }),
    );
    return await execInSandbox(sandboxId, command, opts?.workdir, {
      markWorkspaceMutated: opts?.markWorkspaceMutated,
      suppressWorkspaceMutationSignal: opts?.suppressWorkspaceMutationSignal,
    });
  }
}

export async function readSymbolsFromSandbox(
  sandboxId: string,
  path: string,
): Promise<SandboxReadSymbolsResult> {
  let result;
  let primaryFailed = false;
  try {
    result = await execInSandbox(
      sandboxId,
      `python3 -c ${shellEscape(SANDBOX_READ_SYMBOLS_SCRIPT)} ${shellEscape(path)}`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const lowerMsg = msg.toLowerCase();
    const isTransient =
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('timed out') ||
      lowerMsg.includes('signal') ||
      lowerMsg.includes('aborterror');
    if (!isTransient) {
      throw error;
    }
    // Python extractor hit a timeout or was killed by a signal (e.g. OOM on
    // very large files). Mark as failed so the lightweight regex fallback runs
    // instead of returning empty symbols.
    primaryFailed = true;
  }

  let parsed: {
    error?: string;
    symbols?: Array<{ name?: string; kind?: string; line?: number; signature?: string }>;
    total_lines?: number;
  } = {};

  if (result && result.exitCode === 0) {
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      primaryFailed = true;
    }
  }

  // If the AST extractor failed, timed out, or produced no symbols, try the
  // lightweight regex fallback. The fallback script is a named constant
  // (SANDBOX_REGEX_FALLBACK_SCRIPT) for auditability — path is the only
  // external input, passed via shellEscape after a `--` separator.
  if (primaryFailed || !parsed.symbols || parsed.symbols.length === 0) {
    const fallbackCmd = `node -e ${shellEscape(SANDBOX_REGEX_FALLBACK_SCRIPT)} -- ${shellEscape(path)}`;
    try {
      const fbResult = await execInSandbox(sandboxId, fallbackCmd);
      if (fbResult.exitCode === 0 && fbResult.stdout.trim()) {
        parsed = JSON.parse(fbResult.stdout.trim());
      }
    } catch {
      // Regex fallback also failed — continue with empty symbols rather than
      // failing the entire tool call. The caller still gets a valid result.
    }
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const symbols = Array.isArray(parsed.symbols)
    ? parsed.symbols
        .filter(
          (symbol): symbol is { name: string; kind: string; line: number; signature: string } =>
            typeof symbol?.name === 'string' &&
            typeof symbol.kind === 'string' &&
            typeof symbol.line === 'number' &&
            Number.isFinite(symbol.line) &&
            typeof symbol.signature === 'string',
        )
        .map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          line: symbol.line,
          signature: symbol.signature,
        }))
    : [];

  return {
    symbols,
    totalLines:
      typeof parsed.total_lines === 'number' && Number.isFinite(parsed.total_lines)
        ? parsed.total_lines
        : 0,
  };
}

export async function findReferencesInSandbox(
  sandboxId: string,
  symbol: string,
  scope: string = '/workspace',
  maxResults: number = 30,
): Promise<SandboxFindReferencesResult> {
  const result = await execInSandbox(
    sandboxId,
    `python3 -c ${shellEscape(SANDBOX_FIND_REFERENCES_SCRIPT)} ${shellEscape(symbol)} ${shellEscape(scope)} ${shellEscape(String(maxResults))}`,
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.error || 'Failed to find references');
  }

  let parsed: {
    error?: string;
    truncated?: boolean;
    references?: Array<{ file?: string; line?: number; context?: string; kind?: string }>;
  };

  try {
    parsed = JSON.parse(result.stdout.trim() || '{}');
  } catch {
    throw new Error(`Failed to parse reference output: ${result.stdout.slice(0, 500)}`);
  }

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const references = Array.isArray(parsed.references)
    ? parsed.references
        .filter(
          (reference): reference is SandboxReference =>
            typeof reference?.file === 'string' &&
            typeof reference.line === 'number' &&
            Number.isFinite(reference.line) &&
            typeof reference.context === 'string' &&
            (reference.kind === 'import' || reference.kind === 'call'),
        )
        .map((reference) => ({
          file: reference.file,
          line: reference.line,
          context: reference.context,
          kind: reference.kind,
        }))
    : [];

  return {
    references,
    truncated: parsed.truncated === true,
  };
}

export async function readFromSandbox(
  sandboxId: string,
  path: string,
  startLine?: number,
  endLine?: number,
): Promise<FileReadResult> {
  const body: Record<string, unknown> = {
    ...withOwnerToken({}, sandboxId),
    sandbox_id: sandboxId,
    path,
  };
  if (startLine !== undefined) body.start_line = startLine;
  if (endLine !== undefined) body.end_line = endLine;
  const result = await sandboxFetch<FileReadResult>('read', body);
  if (typeof result.workspace_revision === 'number') {
    setSandboxWorkspaceRevision(sandboxId, result.workspace_revision);
    if (typeof result.version === 'string' && result.version) {
      const key = fileVersionKey(sandboxId, path);
      setFileVersionByKey(key, result.version);
      setWorkspaceRevisionByKey(key, result.workspace_revision);
    } else if (!result.error) {
      deleteFileVersion(sandboxId, path);
    }
  }
  if (typeof result.current_workspace_revision === 'number') {
    setSandboxWorkspaceRevision(sandboxId, result.current_workspace_revision);
  }
  return result;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  code?: string;
  bytes_written?: number;
  expected_version?: string;
  current_version?: string | null;
  new_version?: string | null;
  workspace_revision?: number;
  expected_workspace_revision?: number;
  current_workspace_revision?: number;
}

const WRITE_TIMEOUT_MS = 60_000; // 60s for write operations (large files can be slow)

const WRITE_MAX_RETRIES = 1; // Writes retry once — not 4x. A timed-out write may have succeeded
// server-side; burning 5 × 60s on retries creates 5-min hangs.

export async function writeToSandbox(
  sandboxId: string,
  path: string,
  content: string,
  expectedVersion?: string,
  expectedWorkspaceRevision?: number,
): Promise<WriteResult> {
  let requestAttempted = false;
  try {
    const body = {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      path,
      content,
      expected_version: expectedVersion,
      expected_workspace_revision: expectedWorkspaceRevision,
    };
    requestAttempted = true;
    const result = await sandboxFetch<WriteResult>(
      'write',
      body,
      WRITE_TIMEOUT_MS,
      undefined,
      WRITE_MAX_RETRIES,
    );
    if (typeof result.workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, result.workspace_revision);
      if (result.ok && typeof result.new_version === 'string' && result.new_version) {
        const key = fileVersionKey(sandboxId, path);
        setFileVersionByKey(key, result.new_version);
        setWorkspaceRevisionByKey(key, result.workspace_revision);
      }
    }
    if (typeof result.current_workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, result.current_workspace_revision);
    }
    return result;
  } finally {
    // Fire on ATTEMPT (Codex P2 on #996): a write that times out may have
    // landed server-side (the request retries, and the server renames the temp
    // file before the revision bump), so signal even on `!ok` / a thrown
    // timeout, not just clean success. A redundant signal is a cheap no-op
    // (auto-back's tree/HEAD dedup, #995).
    if (requestAttempted) notifyWorkspaceMutation(sandboxId);
  }
}

/**
 * Upload a large file to `/workspace` via the dedicated `upload` route, which is
 * in the 12 MB body tier — vs `writeToSandbox`'s ~5 MB `write` route. Used by the
 * native checkpoint restore to land the archive base64 (a ~7 MB checkpoint is
 * ~9 MB of base64, over the standard write cap). Confined to `/workspace`
 * server-side. Signals a workspace mutation on attempt, matching `writeToSandbox`.
 */
export async function uploadFileToSandbox(
  sandboxId: string,
  path: string,
  content: string,
): Promise<{ ok: boolean; error?: string; bytes_written?: number }> {
  let requestAttempted = false;
  try {
    const body = {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      path,
      content,
    };
    requestAttempted = true;
    return await sandboxFetch<{ ok: boolean; error?: string; bytes_written?: number }>(
      'upload',
      body,
      WRITE_TIMEOUT_MS,
      undefined,
      WRITE_MAX_RETRIES,
    );
  } finally {
    if (requestAttempted) notifyWorkspaceMutation(sandboxId);
  }
}

// --- Batch write ---

export interface BatchWriteEntry {
  path: string;
  content: string;
  expected_version?: string;
}

export interface BatchWriteResultEntry {
  path: string;
  ok: boolean;
  error?: string;
  code?: string;
  bytes_written?: number;
  new_version?: string | null;
  expected_version?: string;
  current_version?: string | null;
  workspace_revision?: number;
}

export interface BatchWriteResult {
  ok: boolean;
  results: BatchWriteResultEntry[];
  error?: string;
  code?: string;
  workspace_revision?: number;
  expected_workspace_revision?: number;
  current_workspace_revision?: number;
}

const BATCH_WRITE_TIMEOUT_MS = 60_000; // 60s for batch operations

export async function batchWriteToSandbox(
  sandboxId: string,
  files: BatchWriteEntry[],
  expectedWorkspaceRevision?: number,
): Promise<BatchWriteResult> {
  let requestAttempted = false;
  try {
    const body = {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      files,
      expected_workspace_revision: expectedWorkspaceRevision,
    };
    requestAttempted = true;
    const result = await sandboxFetch<BatchWriteResult>(
      'batch-write',
      body,
      BATCH_WRITE_TIMEOUT_MS,
      undefined,
      WRITE_MAX_RETRIES,
    );
    if (typeof result.workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, result.workspace_revision);
      for (const entry of result.results) {
        if (entry.ok && typeof entry.new_version === 'string' && entry.new_version) {
          const key = fileVersionKey(sandboxId, entry.path);
          setFileVersionByKey(key, entry.new_version);
          setWorkspaceRevisionByKey(key, result.workspace_revision);
        }
      }
    }
    if (typeof result.current_workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, result.current_workspace_revision);
    }
    return result;
  } finally {
    // Fire on ATTEMPT (Codex P2 on #996): a batch write that times out may have
    // applied some entries server-side before the response was lost, so signal
    // regardless of outcome. Redundant signals are cheap no-ops (#995 dedup).
    if (requestAttempted) notifyWorkspaceMutation(sandboxId);
  }
}

/**
 * Fetch the sandbox diff. Pass `sinceRef` to also receive
 * `diff_since_ref` (changes between `sinceRef` and current HEAD),
 * which covers committed-but-no-longer-in-working-tree work — the
 * post-commit case the working-tree diff alone misses. The response
 * always includes `head_sha` when git is healthy so callers can
 * pre/post-snapshot a Coder run.
 */
export async function getSandboxDiff(
  sandboxId: string,
  options?: { sinceRef?: string },
): Promise<DiffResult> {
  return sandboxFetch<DiffResult>('diff', {
    ...withOwnerToken({}, sandboxId),
    sandbox_id: sandboxId,
    ...(options?.sinceRef ? { since_ref: options.sinceRef } : {}),
  });
}

export async function cleanupSandbox(sandboxId: string): Promise<{ ok: boolean }> {
  const tokenForSandbox = getSandboxOwnerToken(sandboxId);
  const result = await sandboxFetch<{ ok: boolean }>('cleanup', {
    ...withOwnerToken({}, sandboxId),
    sandbox_id: sandboxId,
  });
  setSandboxOwnerToken(null, sandboxId);
  if (tokenForSandbox && sandboxOwnerToken === tokenForSandbox) {
    setSandboxOwnerToken(null);
  }
  clearSandboxEnvironment(sandboxId);
  return result;
}

// --- Archive download ---

const ARCHIVE_TIMEOUT_MS = 120_000; // 120s for large archive generation
const RESTORE_TIMEOUT_MS = 180_000; // 180s for large archive upload + extraction

export interface ArchiveResult {
  ok: boolean;
  archiveBase64?: string;
  sizeBytes?: number;
  format?: string;
  error?: string;
}

export interface FileDownloadResult {
  ok: boolean;
  fileBase64?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  format?: string;
  error?: string;
}

export async function downloadFromSandbox(
  sandboxId: string,
  path: string = '/workspace',
): Promise<ArchiveResult> {
  const raw = await sandboxFetch<{
    ok: boolean;
    archive_base64?: string;
    size_bytes?: number;
    format?: string;
    error?: string;
  }>(
    'download',
    {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      path,
      format: 'tar.gz',
    },
    ARCHIVE_TIMEOUT_MS,
  );

  if (raw.ok) {
    recordSandboxLifecycleEvent(sandboxId, `Workspace tar.gz archive exported`);
  }

  return {
    ok: raw.ok,
    archiveBase64: raw.archive_base64,
    sizeBytes: raw.size_bytes,
    format: raw.format,
    error: raw.error,
  };
}

export async function downloadFileFromSandbox(
  sandboxId: string,
  path: string,
): Promise<FileDownloadResult> {
  const raw = await sandboxFetch<{
    ok: boolean;
    file_base64?: string;
    filename?: string;
    content_type?: string;
    size_bytes?: number;
    format?: string;
    error?: string;
  }>(
    'download',
    {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      path,
      format: 'raw',
    },
    ARCHIVE_TIMEOUT_MS,
  );

  if (raw.ok) {
    recordSandboxLifecycleEvent(sandboxId, `File ${path} downloaded`);
  }

  return {
    ok: raw.ok,
    fileBase64: raw.file_base64,
    filename: raw.filename,
    contentType: raw.content_type,
    sizeBytes: raw.size_bytes,
    format: raw.format,
    error: raw.error,
  };
}

export interface RestoreResult {
  ok: boolean;
  restoredFiles?: number;
  error?: string;
  workspaceRevision?: number;
}

export async function hydrateSnapshotInSandbox(
  sandboxId: string,
  archiveBase64: string,
  path: string = '/workspace',
): Promise<RestoreResult> {
  const raw = await sandboxFetch<{
    ok: boolean;
    restored_files?: number;
    error?: string;
    workspace_revision?: number;
  }>(
    'restore',
    {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      archive_base64: archiveBase64,
      path,
      format: 'tar.gz',
    },
    RESTORE_TIMEOUT_MS,
  );
  if (typeof raw.workspace_revision === 'number') {
    setSandboxWorkspaceRevision(sandboxId, raw.workspace_revision);
  }

  if (raw.ok) {
    recordSandboxLifecycleEvent(sandboxId, `Workspace state restored from snapshot`);
  }

  return {
    ok: raw.ok,
    restoredFiles: raw.restored_files,
    error: raw.error,
    workspaceRevision: raw.workspace_revision,
  };
}

// --- File browser operations ---

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
}

export async function listDirectory(
  sandboxId: string,
  path: string = '/workspace',
): Promise<FileEntry[]> {
  const data = await sandboxFetch<{
    entries: Array<Omit<FileEntry, 'path'> & { path?: string }>;
    error?: string;
  }>('list', {
    ...withOwnerToken({}, sandboxId),
    sandbox_id: sandboxId,
    path,
  });
  if (data.error) throw new Error(data.error);
  // Backends return entries with name/type/size but no `path`; derive the
  // absolute path here so the declared FileEntry contract always holds.
  const base = path.replace(/\/+$/, '');
  return (data.entries ?? []).map((entry) => ({
    ...entry,
    // `||` (not `??`): an empty path is as unusable as a missing one, so derive
    // in both cases. Names from a directory listing never contain `/`, and the
    // backend independently rejects paths outside the workspace.
    path: entry.path || `${base}/${entry.name}`,
  }));
}

export async function deleteFromSandbox(
  sandboxId: string,
  path: string,
  expectedWorkspaceRevision?: number,
): Promise<number | undefined> {
  let requestAttempted = false;
  try {
    const body = {
      ...withOwnerToken({}, sandboxId),
      sandbox_id: sandboxId,
      path,
      expected_workspace_revision: expectedWorkspaceRevision,
    };
    requestAttempted = true;
    const data = await sandboxFetch<{
      ok: boolean;
      error?: string;
      workspace_revision?: number;
      current_workspace_revision?: number;
    }>('delete', body);
    if (typeof data.workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, data.workspace_revision);
      deleteFileVersion(sandboxId, path);
    }
    if (typeof data.current_workspace_revision === 'number') {
      setSandboxWorkspaceRevision(sandboxId, data.current_workspace_revision);
    }
    if (!data.ok) throw new Error(data.error || 'Delete failed');
    return data.workspace_revision;
  } finally {
    // Fire on ATTEMPT (Codex P2 on #996): a delete that times out may have
    // removed the file server-side before the response was lost. Redundant
    // signals are cheap no-ops (#995 dedup).
    if (requestAttempted) notifyWorkspaceMutation(sandboxId);
  }
}

export async function renameInSandbox(
  sandboxId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  void sandboxId;
  void oldPath;
  void newPath;
  // Rename endpoint removed to fit Modal free tier (8 endpoint limit).
  // Re-add when plan is upgraded. The UI hides the rename action.
  throw new Error('Rename is not available on the current plan.');
}

// --- Sandbox status (Resumable Sessions Phase 2) ---

export interface SandboxStatusResult {
  head: string;
  dirtyFiles: string[];
  diffStat: string;
  changedFiles: string[];
  error?: string;
}

/**
 * Fetch lightweight sandbox status for session recovery.
 * Combines git status, HEAD, and diff info in a single exec call.
 * Used by the resume flow to reconcile checkpoint state with sandbox truth.
 */
export async function sandboxStatus(sandboxId: string): Promise<SandboxStatusResult> {
  const result = await execInSandbox(
    sandboxId,
    'cd /workspace && echo "---HEAD---" && git rev-parse --short HEAD 2>/dev/null && echo "---STATUS---" && git status --porcelain 2>/dev/null && echo "---STAT---" && git diff --stat 2>/dev/null && echo "---NAMES---" && git diff --name-only 2>/dev/null',
  );

  const output = result.stdout || '';
  const sections: Record<string, string> = {};
  let currentSection = '';

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '---HEAD---') {
      currentSection = 'head';
      continue;
    }
    if (trimmed === '---STATUS---') {
      currentSection = 'status';
      continue;
    }
    if (trimmed === '---STAT---') {
      currentSection = 'stat';
      continue;
    }
    if (trimmed === '---NAMES---') {
      currentSection = 'names';
      continue;
    }
    if (currentSection) {
      sections[currentSection] =
        (sections[currentSection] || '') + (sections[currentSection] ? '\n' : '') + line;
    }
  }

  const head = (sections.head || 'unknown').trim();
  const dirtyFiles = (sections.status || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const diffStat = (sections.stat || '').trim();
  const allChangedFiles = (sections.names || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Truncate to 50 files per design doc
  const MAX_CHANGED_FILES = 50;
  const changedFiles =
    allChangedFiles.length > MAX_CHANGED_FILES
      ? [
          ...allChangedFiles.slice(0, MAX_CHANGED_FILES),
          `(and ${allChangedFiles.length - MAX_CHANGED_FILES} more files)`,
        ]
      : allChangedFiles;

  return {
    head,
    dirtyFiles,
    diffStat,
    changedFiles,
    error: result.exitCode !== 0 ? result.stderr || 'git command failed' : undefined,
  };
}

// --- Snapshot / hibernate ---

const HIBERNATE_TIMEOUT_MS = 120_000; // 120s — snapshotting can take time
const RESTORE_SNAPSHOT_TIMEOUT_MS = 120_000; // 120s — restore + probe

export interface HibernateResult {
  ok: boolean;
  snapshotId?: string;
  /** Token required to authorize restore. Store alongside snapshotId. */
  restoreToken?: string;
  /**
   * Whether the SERVER kept the container alive (keep_warm honored). The caller
   * trusts this over its requested intent: an out-of-sync backend may terminate
   * despite the flag, in which case the container is gone and the session must
   * be treated as hibernated, not warm.
   */
  keptWarm?: boolean;
  error?: string;
}

/** Optional context for the server-side snapshot index keyed by `(repo, branch)`. */
export interface SnapshotIndexContext {
  repoFullName?: string | null;
  branch?: string | null;
}

export async function hibernateSandbox(
  sandboxId: string,
  context: SnapshotIndexContext = {},
  opts: { keepWarm?: boolean } = {},
): Promise<HibernateResult> {
  // keepWarm: take the durability snapshot but leave the container (and its
  // owner token) alive — used by the idle reaper so a foregrounded-but-idle
  // session keeps its sandbox instead of being torn down. The worker skips the
  // destroy/revoke; the client must likewise NOT clear the local token/env.
  const keepWarm = opts.keepWarm === true;
  const raw = await sandboxFetch<{
    ok: boolean;
    snapshot_id?: string;
    restore_token?: string;
    kept_warm?: boolean;
    error?: string;
  }>(
    'hibernate',
    withSnapshotIndexContext(
      withOwnerToken(
        { sandbox_id: sandboxId, ...(keepWarm ? { keep_warm: true } : {}) },
        sandboxId,
      ),
      context,
    ),
    HIBERNATE_TIMEOUT_MS,
  );

  // Trust the server's verdict, not the request: an out-of-sync backend without
  // keep_warm support terminates despite the flag, so the container is gone and
  // we MUST clear the local token/env (otherwise reconnect stalls on a dead
  // session). Only treat it as warm when the server confirms it.
  const serverKeptWarm = raw.kept_warm === true;
  if (raw.ok && raw.snapshot_id) {
    if (keepWarm && serverKeptWarm) {
      recordSandboxLifecycleEvent(
        sandboxId,
        `Idle keep-warm snapshot (sandbox stays live: ${raw.snapshot_id})`,
      );
      // Container + token survive — do NOT clear local state.
    } else {
      recordSandboxLifecycleEvent(sandboxId, `Workspace hibernated (snapshot: ${raw.snapshot_id})`);
      // Only clear local state after confirmed successful hibernate.
      // On failure the container may still be alive — clearing tokens
      // would strand an otherwise-recoverable session.
      setSandboxOwnerToken(null, sandboxId);
      clearSandboxEnvironment(sandboxId);
    }
  }

  return {
    ok: raw.ok,
    snapshotId: raw.snapshot_id,
    restoreToken: raw.restore_token,
    keptWarm: serverKeptWarm,
    error: raw.error,
  };
}

export async function restoreFromSnapshot(
  snapshotId: string,
  restoreToken: string,
  context: SnapshotIndexContext = {},
): Promise<SandboxSession> {
  const raw = await sandboxFetch<{
    ok: boolean;
    sandbox_id?: string;
    owner_token?: string;
    workspace_revision?: number;
    environment?: SandboxEnvironment | null;
    error?: string;
  }>(
    'restore-snapshot',
    withSnapshotIndexContext({ snapshot_id: snapshotId, restore_token: restoreToken }, context),
    RESTORE_SNAPSHOT_TIMEOUT_MS,
  );

  if (!raw.ok || !raw.sandbox_id || !raw.owner_token) {
    return { sandboxId: '', status: 'error', error: raw.error || 'Restore failed' };
  }

  setSandboxOwnerToken(raw.owner_token);
  setSandboxOwnerToken(raw.owner_token, raw.sandbox_id);
  if (typeof raw.workspace_revision === 'number') {
    setSandboxWorkspaceRevision(raw.sandbox_id, raw.workspace_revision);
  }

  const environment = raw.environment || undefined;
  if (environment) setSandboxEnvironment(raw.sandbox_id, environment);

  recordSandboxLifecycleEvent(raw.sandbox_id, `Workspace restored from snapshot ${snapshotId}`);

  return {
    sandboxId: raw.sandbox_id,
    ownerToken: raw.owner_token,
    status: 'ready',
    workspaceRevision: raw.workspace_revision,
    environment,
  };
}

/** Capture cap for `fetchSandboxDiffWithMeta`. Exported so UI copy
 *  ("clipped at N KB") and any future drift checks read the same
 *  number — the WorkspacePatch refusal renderer imports this rather
 *  than hard-coding "30 KB" in user-facing text. */
export const DIFF_MAX_BYTES = 30 * 1024;
const DIFF_TRUNCATION_SUFFIX = '\n...(diff truncated at 30KB)';
const SANDBOX_DIFF_CAPTURE_COMMAND = [
  'cd /workspace || exit 1',
  'git diff --no-ext-diff --binary HEAD 2>/dev/null',
  "git ls-files --others --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' path; do",
  '  git diff --no-index --binary -- /dev/null "$path" 2>/dev/null || true',
  'done',
].join('\n');

/**
 * Capture metadata returned from {@link fetchSandboxDiffWithMeta}.
 * `truncated` lets callers reject patches that can't be safely replayed
 * (see `useCommitPush.ts:unreplayableDiffReason`) without re-checking
 * for the suffix sentinel.
 */
export interface SandboxDiffCapture {
  diff: string;
  truncated: boolean;
}

/**
 * Fetch the uncommitted diff plus the truncation flag in one round trip.
 * Same capture command as {@link fetchSandboxDiff}; the wrapper just
 * surfaces whether the 30KB cap was hit so callers don't have to
 * inspect the suffix sentinel themselves.
 */
export async function fetchSandboxDiffWithMeta(sandboxId: string): Promise<SandboxDiffCapture> {
  const result = await execInSandbox(sandboxId, SANDBOX_DIFF_CAPTURE_COMMAND);
  const raw = result.stdout || '';
  // Honor the exec layer's own truncation flag, not just our byte cap. Backend
  // exec-stdout caps differ and can sit *below* DIFF_MAX_BYTES (Modal caps at
  // 10k, Cloudflare at 500k), so a diff can be silently cut upstream while
  // still landing under our 30KB check. Reporting truncated:false there would
  // let the commit-replay guard (useCommitPush.ts:unreplayableDiffReason) treat
  // an incomplete patch as safe to replay.
  if (raw.length <= DIFF_MAX_BYTES) return { diff: raw, truncated: result.truncated };
  return {
    diff:
      raw.slice(0, Math.max(0, DIFF_MAX_BYTES - DIFF_TRUNCATION_SUFFIX.length)) +
      DIFF_TRUNCATION_SUFFIX,
    truncated: true,
  };
}

/**
 * Fetch the full uncommitted diff from the sandbox for cold-resume checkpointing.
 * Truncated to 30KB if the diff is large.
 */
export async function fetchSandboxDiff(sandboxId: string): Promise<string> {
  return (await fetchSandboxDiffWithMeta(sandboxId)).diff;
}
