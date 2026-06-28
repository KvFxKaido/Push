/**
 * Sandbox tools for the autonomous PR reviewer.
 *
 * The review Durable Object reviews from the GitHub-API diff only; this lets it
 * grep/read across the *checked-out PR head* so it can trace a changed symbol
 * into non-diff files (the gap that let the #1219 normalizer strip slip past
 * review). It provisions a sandbox with the PR head checked out and dispatches a
 * small tool set (search/read/ls/typecheck) into the reviewer's tool loop.
 *
 * Security posture — deliberately reuses the existing read-only inspection
 * handlers (`handleSearch`/`handleReadFile`/`handleListDir`) rather than calling
 * sandbox routes raw, so the reviewer inherits the SAME redaction the web
 * Coder/Explorer get: sensitive-path hiding + secret-value redaction
 * (`handleSearch`) and envelope-boundary escaping (`handleReadFile`). The raw
 * `sandbox_exec` route is NEVER exposed. The only executable verifier is
 * `sandbox_check_types`, and its command is supplied by the Durable Object from
 * trusted base-ref instructions, never from the model or the checked-out PR.
 *
 * Reachability uses the internal, gate-free `dispatchSandboxRouteInternal`
 * (proved by the reachability spike): the DO is inside the trust boundary and
 * the public `/api/sandbox-cf/*` path would reject it. Auth on every non-create
 * route is the owner token minted at create time.
 *
 * Imports are TYPE-ONLY at module scope; the runtime deps (`worker-cf-sandbox`,
 * which pulls the CF Sandbox SDK's `cloudflare:`-scheme imports, and the
 * inspection handlers, and detached runner) are loaded via dynamic `import()`
 * inside the functions so this module — and `pr-review-job-do` which statically
 * imports it — stay off the vitest/node graph that can't resolve `cloudflare:`
 * (same reason the reachability spike was dynamically imported).
 */

import type {
  DetachedExecPrimitives,
  DetachedTerminalReason,
} from '@push/lib/detached-exec-runner';
import type { ExecResult, FileEntry, FileReadResult } from '@/lib/sandbox-client';
import type { ReadOnlyInspectionHandlerContext } from '@/lib/sandbox-read-only-inspection-handlers';
import type { SandboxToolCall } from '@/lib/sandbox-tool-detection';
import type { ToolExecutionResult } from '@/types';
import type { Env } from './worker-middleware';

/** v1 sandbox tools wired into the reviewer. Advertised set and
 *  executor switch derive from this ONE list so they can't drift. */
export const REVIEW_SANDBOX_TOOLS = ['search', 'read', 'ls', 'typecheck'] as const;
/** Public names string for the reviewer tool-protocol `- Sandbox:` line. */
export const REVIEW_SANDBOX_TOOL_NAMES = REVIEW_SANDBOX_TOOLS.join(', ');

const REVIEW_TYPECHECK_DEADLINE_MS = 480_000;
const FALLBACK_STREAM_CAP_CHARS = 80_000;

export interface ReviewSandbox {
  sandboxId: string;
  ownerToken: string;
}

interface ReviewDetachedExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
  error?: string;
  terminalReason?: DetachedTerminalReason;
}

function log(event: string, ctx: Record<string, unknown>): void {
  // Worker surface → console.log per the structured-log convention.
  console.log(JSON.stringify({ level: 'info', event, ...ctx }));
}

async function callRoute(
  env: Env,
  route: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  // Dynamic import keeps the CF Sandbox SDK (`cloudflare:` scheme) off the
  // static import graph of every module that imports this one.
  const { dispatchSandboxRouteInternal } = await import('./worker-cf-sandbox');
  const res = await dispatchSandboxRouteInternal(env, route, body);
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body — status alone still classifies success/failure.
  }
  return { status: res.status, json };
}

const okStatus = (s: number): boolean => s >= 200 && s < 300;

function routeError(route: string, status: number, json: Record<string, unknown> | null): Error {
  const detail = typeof json?.error === 'string' ? json.error : `HTTP ${status}`;
  const err = new Error(`sandbox ${route} failed: ${detail}`);
  const code = typeof json?.code === 'string' ? json.code : undefined;
  Object.assign(err, { statusCode: status, ...(code ? { code } : {}) });
  return err;
}

async function callRequiredRoute(
  env: Env,
  route: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { status, json } = await callRoute(env, route, body);
  if (!okStatus(status)) throw routeError(route, status, json);
  return json ?? {};
}

async function bestEffortCleanup(env: Env, sandboxId: string, ownerToken: string): Promise<void> {
  try {
    await callRoute(env, 'cleanup', { sandbox_id: sandboxId, owner_token: ownerToken });
  } catch {
    // teardown is best-effort; the 1h idle reaper is the backstop.
  }
}

/**
 * Provision a sandbox with the PR head checked out, then verify HEAD matches the
 * commit we intend to review. Returns null (review falls back to diff-only) when
 * create fails, the workspace is empty (cross-fork / dead ref), or HEAD drifted
 * from `expectedHeadSha` between webhook and clone. Tears down on a verify
 * failure so a half-provisioned sandbox never leaks. NEVER throws.
 */
export async function provisionReviewSandbox(
  env: Env,
  repoFullName: string,
  headRef: string,
  expectedHeadSha: string,
  githubToken: string,
): Promise<ReviewSandbox | null> {
  let sandboxId = '';
  let ownerToken = '';
  try {
    const created = await callRoute(env, 'create', {
      repo: repoFullName,
      branch: headRef,
      github_token: githubToken,
    });
    sandboxId = typeof created.json?.sandbox_id === 'string' ? created.json.sandbox_id : '';
    ownerToken = typeof created.json?.owner_token === 'string' ? created.json.owner_token : '';
    if (!okStatus(created.status) || !sandboxId || !ownerToken) {
      log('review_sandbox_provision_failed', {
        stage: 'create',
        httpStatus: created.status,
        hasId: Boolean(sandboxId),
      });
      // create may have produced a sandbox even on a non-2xx tail; best-effort kill.
      if (sandboxId && ownerToken) await bestEffortCleanup(env, sandboxId, ownerToken);
      return null;
    }

    // Verify the checkout landed on the RIGHT commit. `routeDiff` reports the
    // workspace HEAD; a missing value means an empty workspace (cross-fork /
    // dead ref) and a mismatch means the branch advanced post-webhook — either
    // way the sandbox can't faithfully back a review of `expectedHeadSha`.
    const diff = await callRoute(env, 'diff', { sandbox_id: sandboxId, owner_token: ownerToken });
    const headSha = typeof diff.json?.head_sha === 'string' ? diff.json.head_sha : '';
    if (!headSha) {
      log('review_sandbox_provision_failed', { stage: 'verify', reason: 'no_head_sha' });
      await bestEffortCleanup(env, sandboxId, ownerToken);
      return null;
    }
    if (expectedHeadSha && headSha !== expectedHeadSha) {
      log('review_sandbox_provision_failed', {
        stage: 'verify',
        reason: 'head_mismatch',
        expected: expectedHeadSha.slice(0, 12),
        actual: headSha.slice(0, 12),
      });
      await bestEffortCleanup(env, sandboxId, ownerToken);
      return null;
    }

    log('review_sandbox_provisioned', { headSha: headSha.slice(0, 12) });
    return { sandboxId, ownerToken };
  } catch (err) {
    log('review_sandbox_provision_failed', {
      stage: 'exception',
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    if (sandboxId && ownerToken) await bestEffortCleanup(env, sandboxId, ownerToken);
    return null;
  }
}

/** Best-effort teardown. NEVER throws. */
export async function cleanupReviewSandbox(env: Env, sandbox: ReviewSandbox): Promise<void> {
  await bestEffortCleanup(env, sandbox.sandboxId, sandbox.ownerToken);
  log('review_sandbox_cleanup', { ok: true });
}

/**
 * Build a read-only inspection context whose transport dispatches to the
 * review's sandbox via the internal route entry. Client-side cache/ledger hooks
 * are no-ops — the DO has no per-session workspace cache to keep coherent.
 */
function buildReviewInspectionContext(
  env: Env,
  sandbox: ReviewSandbox,
): ReadOnlyInspectionHandlerContext {
  const auth = { sandbox_id: sandbox.sandboxId, owner_token: sandbox.ownerToken };
  return {
    sandboxId: sandbox.sandboxId,
    readFromSandbox: async (_id, path, startLine, endLine): Promise<FileReadResult> => {
      const body: Record<string, unknown> = { ...auth, path };
      if (startLine !== undefined) body.start_line = startLine;
      if (endLine !== undefined) body.end_line = endLine;
      const { json } = await callRoute(env, 'read', body);
      return (json ?? { error: 'read failed' }) as unknown as FileReadResult;
    },
    execInSandbox: async (_id, command): Promise<ExecResult> => {
      const { json } = await callRoute(env, 'exec', { ...auth, command, workdir: '/workspace' });
      return {
        stdout: typeof json?.stdout === 'string' ? json.stdout : '',
        stderr: typeof json?.stderr === 'string' ? json.stderr : '',
        exitCode: typeof json?.exit_code === 'number' ? json.exit_code : 1,
        truncated: json?.truncated === true,
        error: typeof json?.error === 'string' ? json.error : undefined,
      };
    },
    listDirectory: async (_id, path = '/workspace'): Promise<FileEntry[]> => {
      const { json } = await callRoute(env, 'list', { ...auth, path });
      if (json?.error) throw new Error(String(json.error));
      const base = path.replace(/\/+$/, '');
      const entries = Array.isArray(json?.entries)
        ? (json.entries as Array<Record<string, unknown>>)
        : [];
      return entries.map((entry) => ({
        ...(entry as unknown as FileEntry),
        path:
          typeof entry.path === 'string' && entry.path
            ? entry.path
            : `${base}/${String(entry.name ?? '')}`,
      }));
    },
    // Symbols/refs are not in the v1 reviewer tool set; never invoked because
    // executeReviewSandboxTool routes only search/read/ls/typecheck. Throw defensively.
    readSymbolsFromSandbox: async () => {
      throw new Error('sandbox_read_symbols is not available in PR review');
    },
    findReferencesInSandbox: async () => {
      throw new Error('sandbox_find_references is not available in PR review');
    },
    // Client-side coherence caches — no-ops in the DO.
    syncReadSnapshot: () => {},
    invalidateWorkspaceSnapshots: () => 0,
    deleteFileVersion: () => {},
    recordReadFileMetric: () => {},
    recordLedgerRead: () => {},
    lookupCachedSymbols: () => undefined,
    storeCachedSymbols: () => {},
  };
}

async function runDetachedReviewExec(
  env: Env,
  sandbox: ReviewSandbox,
  command: string,
): Promise<ReviewDetachedExecResult> {
  const auth = { sandbox_id: sandbox.sandboxId, owner_token: sandbox.ownerToken };
  const primitives: DetachedExecPrimitives = {
    start: async (cmd, opts) => {
      const raw = await callRequiredRoute(env, 'exec-start', {
        ...auth,
        command: cmd,
        workdir: opts.workdir,
      });
      const processId = typeof raw.process_id === 'string' ? raw.process_id : '';
      if (!processId) throw new Error('sandbox exec-start did not return process_id');
      return { processId };
    },
    status: async (processId) => {
      const raw = await callRequiredRoute(env, 'exec-status', {
        ...auth,
        process_id: processId,
      });
      if (typeof raw.running !== 'boolean') {
        throw new Error('sandbox exec-status did not return running');
      }
      const exitCode =
        typeof raw.exit_code === 'number' || raw.exit_code === null ? raw.exit_code : null;
      return {
        running: raw.running,
        exitCode,
        ...(typeof raw.branch === 'string' ? { branch: raw.branch } : {}),
      };
    },
    logs: async (processId, cursors) => {
      const raw = await callRequiredRoute(env, 'exec-logs', {
        ...auth,
        process_id: processId,
        cursor_stdout: cursors.cursorStdout,
        cursor_stderr: cursors.cursorStderr,
      });
      if (
        typeof raw.next_cursor_stdout !== 'number' ||
        typeof raw.next_cursor_stderr !== 'number'
      ) {
        throw new Error('sandbox exec-logs did not return log cursors');
      }
      return {
        stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
        stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
        nextCursorStdout: raw.next_cursor_stdout,
        nextCursorStderr: raw.next_cursor_stderr,
      };
    },
    interrupt: async (processId) => {
      await callRequiredRoute(env, 'exec-kill', { ...auth, process_id: processId });
    },
  };

  try {
    const { runDetachedToCompletion } = await import('@push/lib/detached-exec-runner');
    const result = await runDetachedToCompletion(primitives, command, {
      workdir: '/workspace',
      overallTimeoutMs: REVIEW_TYPECHECK_DEADLINE_MS,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      truncated: result.truncated,
      timedOut: result.terminalReason === 'deadline',
      terminalReason: result.terminalReason,
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return {
      stdout: '',
      stderr: `Detached typecheck transport failed: ${message}`,
      exitCode: -1,
      truncated: false,
      timedOut: false,
      error: message,
      terminalReason: 'start-unconfirmed',
    };
  }
}

function capFallbackStream(text: string): string {
  if (text.length <= FALLBACK_STREAM_CAP_CHARS) return text;
  return `${text.slice(0, FALLBACK_STREAM_CAP_CHARS)}\n[...truncated]`;
}

async function reduceReviewTypecheckOutput(
  command: string,
  result: ReviewDetachedExecResult,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { reduceToolOutput } = await import('@push/lib/tool-output-reducers');
    const reduced = reduceToolOutput({
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    return { stdout: reduced.stdout, stderr: reduced.stderr };
  } catch {
    return {
      stdout: capFallbackStream(result.stdout),
      stderr: capFallbackStream(result.stderr),
    };
  }
}

/**
 * Run the base-ref-selected typecheck command against the checked-out PR head.
 * NEVER throws: failures are returned as model-facing tool results so the review
 * loop can keep going and reason about pass/fail.
 */
export async function runReviewTypecheck(
  env: Env,
  sandbox: ReviewSandbox,
  command: string,
): Promise<ToolExecutionResult> {
  const trimmedCommand = command.trim() || 'npx tsc --noEmit';
  const executedCommand = `cd /workspace && ${trimmedCommand}`;
  const result = await runDetachedReviewExec(env, sandbox, executedCommand);
  const reduced = await reduceReviewTypecheckOutput(trimmedCommand, result);
  const { sanitizeUntrustedSource } = await import('@push/lib/untrusted-content');

  const lines: string[] = [
    '[Tool Result — typecheck]',
    `Command: ${trimmedCommand}`,
    `Exit code: ${result.exitCode}`,
    `Result: ${result.exitCode === 0 ? 'PASS' : 'FAIL'}`,
  ];
  if (reduced.stdout) lines.push(`\nStdout:\n${sanitizeUntrustedSource(reduced.stdout)}`);
  if (reduced.stderr) lines.push(`\nStderr:\n${sanitizeUntrustedSource(reduced.stderr)}`);
  if (result.truncated) lines.push('\n[Output truncated]');
  if (result.timedOut) {
    lines.push(`\n[Timed out after ${REVIEW_TYPECHECK_DEADLINE_MS}ms]`);
  }
  if (result.error) lines.push(`\n[Note] ${sanitizeUntrustedSource(result.error)}`);

  return { text: lines.join('\n') };
}

/**
 * Execute an allowlisted sandbox tool call against the review's sandbox. Only
 * the v1 set (search/read/ls/typecheck) is honored; anything else returns a
 * model-readable error rather than reaching the sandbox. Inspection tools reuse
 * the redacting handlers, and typecheck runs only the command supplied by the
 * Durable Object from trusted base-ref instructions.
 */
export async function executeReviewSandboxTool(
  env: Env,
  sandbox: ReviewSandbox,
  call: SandboxToolCall,
  typecheckCommand: string,
): Promise<ToolExecutionResult> {
  switch (call.tool) {
    case 'sandbox_search': {
      const ctx = buildReviewInspectionContext(env, sandbox);
      const { handleSearch } = await import('@/lib/sandbox-read-only-inspection-handlers');
      return handleSearch(ctx, call.args);
    }
    case 'sandbox_read_file': {
      const ctx = buildReviewInspectionContext(env, sandbox);
      const { handleReadFile } = await import('@/lib/sandbox-read-only-inspection-handlers');
      return handleReadFile(ctx, call.args);
    }
    case 'sandbox_list_dir': {
      const ctx = buildReviewInspectionContext(env, sandbox);
      const { handleListDir } = await import('@/lib/sandbox-read-only-inspection-handlers');
      return handleListDir(ctx, call.args);
    }
    case 'sandbox_check_types':
      return runReviewTypecheck(env, sandbox, typecheckCommand);
    default:
      return {
        text: `[Tool Error] ${call.tool} is not available in automated PR review (sandbox tools: ${REVIEW_SANDBOX_TOOL_NAMES}).`,
      };
  }
}
