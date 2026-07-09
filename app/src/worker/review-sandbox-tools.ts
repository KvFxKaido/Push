/**
 * Sandbox tools for the autonomous PR reviewer.
 *
 * The review Durable Object reviews from the GitHub-API diff only; this lets it
 * grep/read across the *checked-out PR head* so it can trace a changed symbol
 * into non-diff files (the gap that let the #1219 normalizer strip slip past
 * review). It provisions a sandbox with the PR head checked out and dispatches a
 * small tool set (search/read/ls/typecheck/tests) into the reviewer's tool loop.
 *
 * Security posture — deliberately reuses the existing read-only inspection
 * handlers (`handleSearch`/`handleReadFile`/`handleListDir`) rather than calling
 * sandbox routes raw, so the reviewer inherits the SAME redaction the web
 * Coder/Explorer get: sensitive-path hiding + secret-value redaction
 * (`handleSearch`) and envelope-boundary escaping (`handleReadFile`). The raw
 * `sandbox_exec` route is NEVER exposed. The only executable verifiers are
 * `sandbox_check_types` and `sandbox_run_tests`, and their commands are
 * supplied by the Durable Object from trusted base-ref instructions, never
 * from the model or the checked-out PR.
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

/** Sandbox tools wired into the reviewer. Advertised set and
 *  executor switch derive from this ONE list so they can't drift. Entries are
 *  the registry PUBLIC names (`sandbox_run_tests` → `test`, singular) — the
 *  detector resolves only canonical/public/alias names, so advertising
 *  anything else produces calls that silently never execute (Codex P2,
 *  PR #1385). */
export const REVIEW_SANDBOX_TOOLS = ['search', 'read', 'ls', 'typecheck', 'test'] as const;
/** Full public names string (every tool, tests included). */
export const REVIEW_SANDBOX_TOOL_NAMES = REVIEW_SANDBOX_TOOLS.join(', ');

/**
 * Public names for the reviewer tool-protocol `- Sandbox:` line, narrowed to
 * what this review can actually serve: `tests` is advertised only when the
 * repo declares a test command (AGENTS.md `# test:` hint at the base ref) —
 * there is no safe universal default the way typecheck has `npx tsc --noEmit`.
 */
export function reviewSandboxToolNames(testsAvailable: boolean): string {
  return (
    testsAvailable ? REVIEW_SANDBOX_TOOLS : REVIEW_SANDBOX_TOOLS.filter((t) => t !== 'test')
  ).join(', ');
}

/** Verifier commands the DO resolves from trusted base-ref instructions.
 *  `tests: null` = no repo test command → the tests tool is unavailable.
 *  `setup` runs once before the first verifier (repo `# setup:` hint, else
 *  the conditional root-install default). */
export interface ReviewVerifierCommands {
  typecheck: string;
  tests: string | null;
  setup: string;
}

/**
 * Default environment setup when the repo declares no `# setup:` hint —
 * the coder-side `handleCheckTypes` precedent (install root deps when a
 * package.json exists and node_modules doesn't), made conditional so it's a
 * no-op on warm sandboxes and non-Node repos. Monorepos with nested installs
 * (like Push itself: root + app/ + mcp/) need the explicit hint.
 */
export const REVIEW_DEFAULT_SETUP_COMMAND =
  'if [ -f package.json ] && [ ! -d node_modules ]; then npm install; fi';

/** Outcome of the one-time environment setup run. */
export interface ReviewSetupResult {
  ok: boolean;
  /** Reduced stdout/stderr for the failure path (model- and log-facing). */
  text: string;
}

/** Structured verifier outcome riding a verification tool's result, so the
 *  executor can record pass/fail without parsing the model-facing text. */
export interface ReviewVerificationOutcome {
  kind: 'typecheck' | 'tests';
  pass: boolean;
}

/** Tool result plus optional verification metadata (verifier tools only). */
export type ReviewSandboxToolResult = ToolExecutionResult & {
  verification?: ReviewVerificationOutcome;
};

// One deadline per verifier: test suites routinely run longer than tsc, but
// both must fit inside the review's 15-min no-progress budget with headroom.
// Setup + one verifier run back-to-back inside a single tool round, so their
// deadlines must sum comfortably under that budget (300s + 480s ≈ 13 min).
const REVIEW_TYPECHECK_DEADLINE_MS = 480_000;
const REVIEW_TESTS_DEADLINE_MS = 480_000;
const REVIEW_SETUP_DEADLINE_MS = 300_000;
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
  deadlineMs: number,
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
      overallTimeoutMs: deadlineMs,
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
      stderr: `Detached verifier transport failed: ${message}`,
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
 * Run a base-ref-selected verifier command (typecheck or tests) against the
 * checked-out PR head. NEVER throws: failures are returned as model-facing
 * tool results so the review loop can keep going and reason about pass/fail.
 * The structured `verification` field carries the same pass/fail for the
 * executor's tracking (timeouts/transport failures are `pass: false`).
 */
async function runReviewVerifier(
  env: Env,
  sandbox: ReviewSandbox,
  command: string,
  kind: ReviewVerificationOutcome['kind'],
  deadlineMs: number,
): Promise<ReviewSandboxToolResult> {
  const trimmedCommand = command.trim();
  const executedCommand = `cd /workspace && ${trimmedCommand}`;
  const result = await runDetachedReviewExec(env, sandbox, executedCommand, deadlineMs);
  const reduced = await reduceReviewTypecheckOutput(trimmedCommand, result);
  const { sanitizeUntrustedSource } = await import('@push/lib/untrusted-content');

  const pass = result.exitCode === 0;
  const lines: string[] = [
    `[Tool Result — ${kind}]`,
    `Command: ${trimmedCommand}`,
    `Exit code: ${result.exitCode}`,
    `Result: ${pass ? 'PASS' : 'FAIL'}`,
  ];
  if (reduced.stdout) lines.push(`\nStdout:\n${sanitizeUntrustedSource(reduced.stdout)}`);
  if (reduced.stderr) lines.push(`\nStderr:\n${sanitizeUntrustedSource(reduced.stderr)}`);
  if (result.truncated) lines.push('\n[Output truncated]');
  if (result.timedOut) {
    lines.push(`\n[Timed out after ${deadlineMs}ms]`);
  }
  if (result.error) lines.push(`\n[Note] ${sanitizeUntrustedSource(result.error)}`);

  return { text: lines.join('\n'), verification: { kind, pass } };
}

/**
 * One-time environment setup before the verifiers — dependency installs etc.
 * Command comes from the repo's base-ref `# setup:` hint, else
 * {@link REVIEW_DEFAULT_SETUP_COMMAND}. NEVER throws; a failure is returned
 * for the caller to surface (verification then simply cannot run — that is
 * an environment outcome, not a verifier fail).
 */
export async function runReviewSetup(
  env: Env,
  sandbox: ReviewSandbox,
  command: string,
): Promise<ReviewSetupResult> {
  const trimmedCommand = command.trim() || REVIEW_DEFAULT_SETUP_COMMAND;
  const result = await runDetachedReviewExec(
    env,
    sandbox,
    `cd /workspace && ${trimmedCommand}`,
    REVIEW_SETUP_DEADLINE_MS,
  );
  const ok = result.exitCode === 0;
  log(ok ? 'review_sandbox_setup_succeeded' : 'review_sandbox_setup_failed', {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
  if (ok) return { ok, text: '' };
  const reduced = await reduceReviewTypecheckOutput(trimmedCommand, result);
  const { sanitizeUntrustedSource } = await import('@push/lib/untrusted-content');
  const detail = [reduced.stderr, reduced.stdout].filter(Boolean).join('\n').slice(0, 2_000);
  return {
    ok,
    text: `Environment setup failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}): ${sanitizeUntrustedSource(detail)}`,
  };
}

/** Typecheck verifier — falls back to the universal `npx tsc --noEmit`. */
export async function runReviewTypecheck(
  env: Env,
  sandbox: ReviewSandbox,
  command: string,
): Promise<ReviewSandboxToolResult> {
  return runReviewVerifier(
    env,
    sandbox,
    command.trim() || 'npx tsc --noEmit',
    'typecheck',
    REVIEW_TYPECHECK_DEADLINE_MS,
  );
}

/** Test verifier — command comes from the repo's base-ref `# test:` hint;
 *  callers must not invoke this without one (there is no safe default). */
export async function runReviewTests(
  env: Env,
  sandbox: ReviewSandbox,
  command: string,
): Promise<ReviewSandboxToolResult> {
  return runReviewVerifier(env, sandbox, command, 'tests', REVIEW_TESTS_DEADLINE_MS);
}

/**
 * Execute an allowlisted sandbox tool call against the review's sandbox. Only
 * the reviewer set (search/read/ls/typecheck/tests) is honored; anything else
 * returns a model-readable error rather than reaching the sandbox. Inspection
 * tools reuse the redacting handlers, and the verifiers run only commands
 * supplied by the Durable Object from trusted base-ref instructions — never
 * from the model or the checked-out PR head (the model's `framework` arg to
 * `sandbox_run_tests` is deliberately ignored for the same reason).
 */
export async function executeReviewSandboxTool(
  env: Env,
  sandbox: ReviewSandbox,
  call: SandboxToolCall,
  commands: ReviewVerifierCommands,
  /**
   * Memoized one-time environment setup, awaited by the VERIFIER cases only
   * (inspection tools don't need dependencies). Supplied by the executor so
   * one setup run covers every verifier call in the review. A failed setup
   * short-circuits the verifier with a model-readable error and NO
   * verification metadata — the verifier didn't fail, it couldn't run.
   */
  ensureSetup?: () => Promise<ReviewSetupResult>,
): Promise<ReviewSandboxToolResult> {
  const setupGate = async (): Promise<ReviewSandboxToolResult | null> => {
    if (!ensureSetup) return null;
    const setup = await ensureSetup();
    if (setup.ok) return null;
    return {
      text: `[Tool Error] ${setup.text}\nVerification cannot run in this review's sandbox — investigate via the diff and read tools, and note the review as unverified.`,
    };
  };
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
    case 'sandbox_check_types': {
      const blocked = await setupGate();
      if (blocked) return blocked;
      return runReviewTypecheck(env, sandbox, commands.typecheck);
    }
    case 'sandbox_run_tests': {
      if (!commands.tests) {
        return {
          text: '[Tool Error] This repository declares no test command (no `# test:` hint in AGENTS.md at the base ref) — tests are unavailable for this review. Use typecheck instead.',
        };
      }
      const blocked = await setupGate();
      if (blocked) return blocked;
      return runReviewTests(env, sandbox, commands.tests);
    }
    default:
      return {
        text: `[Tool Error] ${call.tool} is not available in automated PR review (sandbox tools: ${reviewSandboxToolNames(Boolean(commands.tests))}).`,
      };
  }
}
