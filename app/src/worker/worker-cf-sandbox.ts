/**
 * HTTP handler for /api/sandbox-cf/* — Cloudflare Sandbox SDK backend.
 *
 * Provides the Cloudflare backend for /api/sandbox-cf/* and, when selected,
 * the provider-dispatched /api/sandbox/* route. Request and response shapes
 * match Modal's snake_case wire format (sandbox_id,
 * owner_token, github_identity, workspace_revision, exit_code, ...) so the
 * Worker-side provider toggle can switch backends without any client change.
 *
 * Architecture:
 *   browser/CLI → Worker (this handler) → getSandbox(env.Sandbox, id) → DO → container
 *
 * Known MVP gaps (tracked as follow-up PRs):
 *   - workspace_revision and file version (SHA) are best-effort — the SDK
 *     doesn't expose monotonic revisions the way Modal's app.py does.
 *
 * Auth: every route except `create` requires an owner_token matching the
 * one issued at sandbox creation time. The hot path verifies against a
 * tiny token file inside the live sandbox itself so auth follows the same
 * strongly-consistent DO path as exec/read/write instead of depending on
 * eventually-consistent KV reads across PoPs. `SANDBOX_TOKENS` remains as
 * cleanup metadata / fallback storage.
 */

import type { ExecutionContext } from '@cloudflare/workers-types';
import { getSandbox } from '@cloudflare/sandbox';
import type { DirectoryBackup } from '@cloudflare/sandbox';
import type { Env } from './worker-middleware';
import {
  validateOrigin,
  getClientIp,
  wlog,
  readBodyText,
  MAX_BODY_SIZE_BYTES,
  RESTORE_MAX_BODY_SIZE_BYTES,
} from './worker-middleware';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from '../lib/request-id';
import {
  issueToken,
  MAX_TOKEN_BYTES,
  readOwnerToken,
  revokeToken,
  timingSafeEqual,
  verifyToken,
  type VerifyResult,
} from './sandbox-token-store';
import {
  putSnapshot,
  touchSnapshot,
  deleteSnapshot,
  getSnapshot,
  DEFAULT_TTL_SECONDS,
} from './snapshot-index';

const ROUTES = new Set([
  'create',
  'connect',
  'cleanup',
  'ping',
  'exec',
  'exec-start',
  'exec-status',
  'exec-logs',
  'exec-kill',
  'read',
  'write',
  'upload',
  'batch-write',
  'delete',
  'list',
  'diff',
  'download',
  'restore',
  'probe',
  'hibernate',
  'restore-snapshot',
  'delete-snapshot',
]);

const MAX_READ_BYTES = 5_000_000;
// Upper bound for a single download (tar.gz archive or raw file). Mirrors the
// Modal backend's MAX_ARCHIVE_BYTES so both providers reject the same payloads.
const MAX_ARCHIVE_BYTES = 100_000_000;
const OWNER_TOKEN_PATH = '/tmp/push-owner-token';

// CF Sandbox containers sleep after 10 min of inactivity by DEFAULT and lose
// filesystem state on the next request. For this single-user deployment that's
// the "sandbox vanished while I was just idling in the app" bug — reading,
// thinking, and composing don't hit the sandbox, so the container wipes out
// from under a foregrounded session. Raise the idle-sleep window well past
// realistic think/read pauses. We use sleepAfter (auto-reclaim) rather than
// keepAlive (never sleeps → orphaned-container cost leak if the client fails to
// destroy). The client idle reaper still snapshots before this as the safety
// net for the eventual reclaim. Tunable in one place.
const SANDBOX_SLEEP_AFTER = '1h';

/**
 * Get the sandbox handle with Push's idle-sleep policy applied. Every accessor
 * routes through here so the container's sleep window is consistent across
 * create / exec / snapshot / etc. — not the SDK's 10-min default.
 *
 * RPC is the SDK's recommended transport and replaces the deprecated HTTP/WS
 * transports removed upstream after July 9, 2026. Default sessions are also
 * disabled: Push never relies on implicit cross-call cwd or environment state
 * (every exec passes explicit cwd, `git -C`, or absolute paths — audited
 * call-by-call), and the SDK deprecated that state because it confused agent
 * workloads.
 */
function sandboxFor(env: Env, sandboxId: string) {
  return getSandbox(env.Sandbox!, sandboxId, {
    sleepAfter: SANDBOX_SLEEP_AFTER,
    transport: 'rpc',
    enableDefaultSession: false,
  });
}

function githubRepoUrl(repo: string, token?: string): string {
  return token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

function publicGitHubRepoUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

// Upper bound for a single `sandbox.exec` call. The Cloudflare Sandbox SDK's
// exec has no abort path — if the container is wedged (commonly after a heavy
// FS write like `npm install`), the returned promise never resolves, the
// surrounding route handler hangs, and `callSandboxHandler` waits the full
// outer 180s before it fires the kernel-facing timeout. This per-exec deadline
// fires first (150s) so routes that issue multiple execs can fail fast with a
// route-specific `TIMEOUT` response instead of burning the outer budget on a
// single stuck call.
//
// Pairs with `CONTAINER_EXEC_TIMEOUT_SECONDS` below: the container-side shell
// `timeout` kills the process a few seconds earlier so the SDK call returns
// cleanly (exit_code=124) instead of being abandoned. The SDK-level deadline
// is still the safety net for the case where the gRPC connection itself is
// wedged and no amount of in-container killing can make bytes flow back.
export const SANDBOX_EXEC_TIMEOUT_MS = 150_000;

// Local-dev override for SANDBOX_EXEC_TIMEOUT_MS. Production containers are
// pre-warmed by CF infra and 150s is generous; local wrangler builds the
// sandbox container from Dockerfile.sandbox on demand and first cold-start
// routinely overshoots 150s. Rather than thread env through every
// withExecDeadline caller (15+ sites), we keep a per-isolate mutable that
// handleCloudflareSandbox re-applies on each request entry from
// env.SANDBOX_DEV_LONG_DEADLINE. Production leaves this at 150_000.
const DEV_LONG_EXEC_TIMEOUT_MS = 300_000;
let currentExecDeadlineMs = SANDBOX_EXEC_TIMEOUT_MS;

export function applyEnvExecDeadline(env: Env): void {
  currentExecDeadlineMs =
    env.SANDBOX_DEV_LONG_DEADLINE === '1' ? DEV_LONG_EXEC_TIMEOUT_MS : SANDBOX_EXEC_TIMEOUT_MS;
}

// Container-side wall-clock cap for a single user exec. Kept a few seconds
// below SANDBOX_EXEC_TIMEOUT_MS so the shell's `timeout` reliably fires first
// and the SDK call returns with exit_code=124 + whatever partial stdout the
// command had produced, instead of the worker-side deadline abandoning the
// process and leaving it running inside the container. `-k 5` escalates to
// SIGKILL five seconds after the initial SIGTERM so a command that ignores
// termination can't outlast the outer deadline either.
const CONTAINER_EXEC_TIMEOUT_SECONDS = 140;
const CONTAINER_EXEC_KILL_GRACE_SECONDS = 5;

// Resource caps applied to every user exec (foreground and detached). The
// container has a fixed memory budget, but tools size their worker pools for
// the host: node --test and vitest fan out per `availableParallelism()`, which
// inside a container reflects host CPUs, not the cgroup quota. An uncapped
// test-suite run OOMs the container, and the kernel killing it takes the
// sandbox — and the session riding on it — down mid-run. SDK exec `env`
// overlays the container env for the duration of the command only, and a
// caller can still override per-invocation with a shell prefix
// (`NODE_OPTIONS=… npm test`). `--test-concurrency` is not NODE_OPTIONS-safe
// (Node rejects it), so node --test parallelism is bounded indirectly by the
// per-process heap cap plus Node 20.3+'s cgroup-aware availableParallelism.
const SANDBOX_EXEC_RESOURCE_ENV: Record<string, string> = {
  NODE_OPTIONS: '--max-old-space-size=1024',
  // Vitest 4 reads only VITEST_MAX_WORKERS; the THREADS/FORKS pair is what
  // vitest 1–3 read. Sandboxed repos can pin any of them, so set all three.
  VITEST_MAX_WORKERS: '2',
  VITEST_MAX_THREADS: '2',
  VITEST_MIN_THREADS: '1',
  VITEST_MAX_FORKS: '2',
  VITEST_MIN_FORKS: '1',
};

export class SandboxExecDeadlineError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`sandbox exec exceeded ${timeoutMs}ms deadline`);
    this.name = 'SandboxExecDeadlineError';
    this.timeoutMs = timeoutMs;
  }
}

class CloneRecoveryGitError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = 'CloneRecoveryGitError';
    this.stage = stage;
  }
}

type CloneRecoveryErrorKind = 'executor_exit' | 'timeout' | 'transport' | 'git' | 'unknown';

function workspaceResetFailureMessage(res: { exitCode?: number; stderr?: string }): string {
  const stderr = (res.stderr ?? '').trim();
  return `workspace reset failed (exit code ${res.exitCode ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`;
}

function classifyCloneRecoveryError(err: unknown): {
  retryable: boolean;
  kind: CloneRecoveryErrorKind;
} {
  if (err instanceof CloneRecoveryGitError) return { retryable: false, kind: 'git' };
  if (err instanceof SandboxExecDeadlineError) return { retryable: true, kind: 'timeout' };

  const message = err instanceof Error ? err.message : String(err);
  // Terminal git failures must win over the broad transport vocabulary below.
  // In particular, "repository not found" is not a dead executor just because
  // the operation happened over a remote transport.
  if (
    /repository(?: .*?)? not found|remote branch .* not found|couldn't find remote ref|authentication failed|permission denied|access denied|does not appear to be a git repository/i.test(
      message,
    )
  ) {
    return { retryable: false, kind: 'git' };
  }
  if (
    /executor process exited unexpectedly|executor .* exited|process exited unexpectedly|exit(?:ed)?(?: code)? 13[4-9]\b|\bkilled\b|\bsignal\b/i.test(
      message,
    )
  ) {
    return { retryable: true, kind: 'executor_exit' };
  }
  if (/timed out|timeout|deadline exceeded/i.test(message)) {
    return { retryable: true, kind: 'timeout' };
  }
  if (
    /\btransport\b|\brpc\b|\bgrpc\b|connection (?:reset|closed|refused|timed out)|failed to connect|econnreset|econnrefused|etimedout|ehostunreach|socket hang up|network error|fetch failed|service unavailable|temporarily unavailable|early eof|unexpected disconnect|remote end hung up|gnutls|tls connection|http\/2 stream|could not resolve host|temporary failure in name resolution|\b(?:500|502|503|504)\b|container .*?(?:exited|crashed|unreachable|unavailable)/i.test(
      message,
    )
  ) {
    return { retryable: true, kind: 'transport' };
  }
  return { retryable: false, kind: 'unknown' };
}

function withExecDeadline<T>(
  exec: Promise<T>,
  timeoutMs: number = currentExecDeadlineMs,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SandboxExecDeadlineError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([exec, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// Backoff schedule between liveness-probe attempts. Two short retries: a
// genuine network blip or DO handoff recovers within a second, while a dead
// container fails all three attempts in under a second of added latency.
const LIVENESS_PROBE_BACKOFF_MS = [200, 600];

export type SandboxLivenessResult =
  | { alive: true; attempts: number }
  | { alive: false; reason: 'wedged' | 'dead'; attempts: number; error: string };

/**
 * Probe a sandbox with a trivial exec, retrying transient failures before
 * declaring it gone. Consumers treat "dead" as authorization to recreate the
 * sandbox — which orphans the container and its uncommitted work if it was
 * actually alive — so a single transient failure must never produce "dead".
 *
 * A deadline expiry is reported as "wedged" without retrying: the container
 * is stalled rather than blipping, retries would stack more long waits onto
 * an already-burned request budget, and recovery (wait / retry later) differs
 * from recovery for a dead container (recreate).
 */
export async function probeSandboxLiveness(
  env: Env,
  sandboxId: string,
  opts?: { deadlineMs?: number },
): Promise<SandboxLivenessResult> {
  const sandbox = sandboxFor(env, sandboxId);
  const maxAttempts = LIVENESS_PROBE_BACKOFF_MS.length + 1;
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = (await withExecDeadline(sandbox.exec('true'), opts?.deadlineMs)) as {
        exitCode?: number;
      };
      if ((res.exitCode ?? 1) === 0) return { alive: true, attempts: attempt };
      lastError = `liveness probe exited ${res.exitCode}`;
    } catch (err) {
      if (err instanceof SandboxExecDeadlineError) {
        return { alive: false, reason: 'wedged', attempts: attempt, error: err.message };
      }
      lastError = err instanceof Error ? err.message : String(err);
    }
    const delayMs = LIVENESS_PROBE_BACKOFF_MS[attempt - 1];
    if (delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { alive: false, reason: 'dead', attempts: maxAttempts, error: lastError };
}

type Json = Record<string, unknown>;

export async function handleCloudflareSandbox(
  request: Request,
  env: Env,
  requestUrl: URL,
  route: string,
  // Accepted for parity with handleSandbox's signature; the CF path does not
  // currently use ExecutionContext (no waitUntil-dependent flushes yet).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx?: ExecutionContext,
): Promise<Response> {
  applyEnvExecDeadline(env);
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'sandbox-cf');

  if (!ROUTES.has(route)) {
    return Response.json({ error: `Unknown sandbox-cf route: ${route}` }, { status: 404 });
  }

  if (!env.Sandbox) {
    return Response.json(
      {
        error: 'Cloudflare Sandbox not configured',
        code: 'CF_NOT_CONFIGURED',
        details:
          'Sandbox DO binding missing. Check wrangler.jsonc containers/durable_objects/migrations.',
      },
      { status: 503 },
    );
  }

  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', {
      requestId,
      ip: getClientIp(request),
      path: `api/sandbox-cf/${route}`,
    });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const maxBodyBytes =
    route === 'restore' || route === 'batch-write' || route === 'upload'
      ? RESTORE_MAX_BODY_SIZE_BYTES
      : MAX_BODY_SIZE_BYTES;
  const bodyResult = await readBodyText(request, maxBodyBytes);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let body: Json;
  try {
    body = JSON.parse(bodyResult.text) as Json;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  return runSandboxRoute(env, route, body, requestId);
}

/**
 * Owner-token gate + route dispatch — the trusted core shared by the public
 * HTTP handler (after its browser gates) and `dispatchSandboxRouteInternal`.
 */
async function runSandboxRoute(
  env: Env,
  route: string,
  body: Json,
  requestId: string,
): Promise<Response> {
  // Owner-token gate — every route except the exempt set below must present a
  // valid token matching the one issued at sandbox creation time. `create` is
  // exempt (that's where tokens are minted); `restore-snapshot` and
  // `delete-snapshot` are exempt because there is no live sandbox to verify
  // against — they authenticate with the snapshot's restore_token, checked
  // against the R2 object's metadata inside their handlers.
  // The primary verifier reads the token from the sandbox itself. That
  // avoids false "expired" sessions caused by Workers KV propagation lag
  // when a request lands in a different PoP than the one that created the
  // sandbox. `cleanup` keeps a KV fallback so a dead sandbox can still be
  // torn down if the token file is no longer reachable.
  if (route !== 'create' && route !== 'restore-snapshot' && route !== 'delete-snapshot') {
    const sandboxId = typeof body.sandbox_id === 'string' ? body.sandbox_id : '';
    const providedToken = typeof body.owner_token === 'string' ? body.owner_token : '';
    let auth: VerifyResult;
    try {
      auth = await verifySandboxOwnerToken(env, sandboxId, providedToken);
    } catch (err) {
      if (route === 'cleanup') {
        wlog('warn', 'cf_sandbox_cleanup_auth_fallback', {
          requestId,
          route,
          message: err instanceof Error ? err.message : String(err),
        });
        auth = await verifyToken(env.SANDBOX_TOKENS, sandboxId, providedToken);
      } else if (err instanceof SandboxExecDeadlineError) {
        // A wedged container making the owner-token probe time out is
        // not a configuration failure — it's the same class of stall
        // that the per-exec deadline exists to surface. Report it as
        // TIMEOUT/504 so callers handle it with their retry path
        // instead of treating it as a provisioning error.
        wlog('warn', 'cf_sandbox_auth_timeout', {
          requestId,
          route,
          deadline: true,
          message: err.message,
        });
        return Response.json({ error: err.message, code: 'TIMEOUT' }, { status: 504 });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const code = classifyCfError(err);
        wlog('error', 'cf_sandbox_auth_throw', {
          requestId,
          route,
          message,
          code,
        });
        // The token file was unreachable, so it never proved this caller owns
        // the sandbox. Fall back to the durable token record before exposing
        // backend state; otherwise this auth gate becomes a sandbox-id oracle.
        let fallbackAuth: VerifyResult;
        try {
          fallbackAuth = await verifyToken(env.SANDBOX_TOKENS, sandboxId, providedToken);
        } catch (fallbackErr) {
          wlog('error', 'cf_sandbox_auth_fallback_throw', {
            requestId,
            route,
            message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          return Response.json(
            { error: 'Sandbox request failed', code: 'CF_ERROR' },
            { status: 500 },
          );
        }
        if (!fallbackAuth.ok) {
          return Response.json(
            { error: authErrorMessage(fallbackAuth.code), code: fallbackAuth.code },
            { status: fallbackAuth.status },
          );
        }

        // Ownership is proven out-of-band. Preserve the real sandbox/backend
        // classification for the legitimate caller's recovery path.
        return Response.json({ error: message, code }, { status: 500 });
      }
    }
    if (!auth.ok && route === 'cleanup') {
      const kvAuth = await verifyToken(env.SANDBOX_TOKENS, sandboxId, providedToken);
      if (kvAuth.ok) auth = kvAuth;
    }
    if (!auth.ok) {
      return Response.json(
        { error: authErrorMessage(auth.code), code: auth.code },
        { status: auth.status },
      );
    }
  }

  try {
    switch (route) {
      case 'create':
        return await routeCreate(env, body);
      case 'connect':
        return await routeConnect(env, body);
      case 'cleanup':
        return await routeCleanup(env, body);
      case 'ping':
        return routePing();
      case 'exec':
        return await routeExec(env, body);
      case 'exec-start':
        return await routeExecStart(env, body);
      case 'exec-status':
        return await routeExecStatus(env, body);
      case 'exec-logs':
        return await routeExecLogs(env, body);
      case 'exec-kill':
        return await routeExecKill(env, body);
      case 'read':
        return await routeRead(env, body);
      case 'write':
        return await routeWrite(env, body);
      case 'upload':
        return await routeUpload(env, body);
      case 'batch-write':
        return await routeBatchWrite(env, body);
      case 'delete':
        return await routeDelete(env, body);
      case 'list':
        return await routeList(env, body);
      case 'diff':
        return await routeDiff(env, body);
      case 'download':
        return await routeDownload(env, body);
      case 'restore':
        return await routeHydrate(env, body);
      case 'probe':
        return await routeProbe(env, body);
      case 'hibernate':
        return await routeHibernate(env, body);
      case 'restore-snapshot':
        return await routeRestoreSnapshot(env, body);
      case 'delete-snapshot':
        return await routeDeleteSnapshot(env, body);
      default:
        return Response.json({ error: 'Unknown route' }, { status: 404 });
    }
  } catch (err) {
    const isDeadline = err instanceof SandboxExecDeadlineError;
    wlog(isDeadline ? 'warn' : 'error', 'cf_sandbox_error', {
      requestId,
      route,
      deadline: isDeadline,
      message: err instanceof Error ? err.message : String(err),
    });
    const code = isDeadline ? 'TIMEOUT' : classifyCfError(err);
    const status = isDeadline
      ? 504
      : code === 'FILE_NOT_FOUND'
        ? 404
        : code === 'INVALID_BACKUP_CONFIG'
          ? 503
          : 500;
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        code,
      },
      // 504 for deadline so callers can distinguish "we stopped waiting"
      // from "backend crashed". callSandboxHandler already treats any
      // status >= 500 as retryable, so the kernel surfaces retry-friendly
      // structured errors for both cases. FILE_NOT_FOUND is a 4xx so the
      // client does NOT burn 5 retries on a path that will never exist.
      { status },
    );
  }
}

/**
 * Internal, gate-free entry to the sandbox-cf route logic for TRUSTED
 * server-side callers (e.g. the PR-review Durable Object) already inside the
 * trust boundary. Skips the browser-facing gates `handleCloudflareSandbox`
 * applies — session auth, Origin/Referer, rate-limit, client-IP, request-body
 * size — which are meaningless for a Worker-internal caller (and the session
 * gate, in `worker.ts`, would reject it outright). Owner-token enforcement on
 * non-create routes is preserved (it lives in `runSandboxRoute`). Server-side
 * only — never expose this on a public path.
 */
export async function dispatchSandboxRouteInternal(
  env: Env,
  route: string,
  body: Json,
): Promise<Response> {
  if (!ROUTES.has(route)) {
    return Response.json({ error: `Unknown sandbox-cf route: ${route}` }, { status: 404 });
  }
  if (!env.Sandbox) {
    return Response.json(
      { error: 'Cloudflare Sandbox not configured', code: 'CF_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  applyEnvExecDeadline(env);
  const requestId = getOrCreateRequestId(null, 'sandbox-cf-internal');
  return runSandboxRoute(env, route, body, requestId);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function routeCreate(env: Env, body: Json): Promise<Response> {
  // Fail closed at create time too: if SANDBOX_TOKENS isn't bound, we can't
  // mint a verifiable token, and issuing a sandbox without one would leave
  // it unauth'd for its entire lifetime. Require the binding instead.
  if (!env.SANDBOX_TOKENS) {
    return Response.json(
      {
        error: 'SANDBOX_TOKENS KV binding not configured',
        code: 'NOT_CONFIGURED',
        details: 'Create a KV namespace via wrangler and bind it as SANDBOX_TOKENS.',
      },
      { status: 503 },
    );
  }

  const repo = str(body.repo) ?? '';
  const branch = str(body.branch) ?? 'main';
  const defaultBranch = str(body.default_branch);
  const githubToken = str(body.github_token);
  const githubIdentity = body.github_identity as { name?: string; email?: string } | undefined;
  const seedFiles = (body.seed_files as Array<{ path: string; content: string }> | undefined) ?? [];
  const ownerHint = str(body.owner_hint);

  const sandboxId = crypto.randomUUID();
  let sandbox = sandboxFor(env, sandboxId);

  // Per-phase ready-state timing. Emitted once at the tail of routeCreate (or
  // in the failure path) as `cf_sandbox_create_timing` so we can see whether
  // clone or cache-populate dominates cold start before deciding what to
  // optimize next. All values are millisecond wall clock from Date.now().
  //
  // `repo` is hashed (first 12 hex of sha256) so the log is correlatable —
  // grep for the hash of a known repo to find its sessions — without
  // exposing owner/repo strings to wherever Worker logs end up. `branch` is
  // omitted entirely: it carries little signal without the repo and shares
  // the same leakage concern. `sandbox_id` remains the primary correlation
  // key. Hashing happens once up front so the finally block stays cheap.
  const createStart = Date.now();
  const repoHash = repo ? await sha256Hex(repo, 12) : '';
  const phases = {
    git_identity: 0,
    clone: 0,
    cache_populate: 0,
    seed_files: 0,
    probe: 0,
    token_issue: 0,
  };
  let failedPhase: keyof typeof phases | null = null;
  const time = async <T>(phase: keyof typeof phases, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await fn();
    } catch (err) {
      failedPhase = phase;
      throw err;
    } finally {
      phases[phase] += Date.now() - start;
    }
  };

  const configureGitIdentity = async (): Promise<void> => {
    if (githubIdentity?.name && githubIdentity?.email) {
      // Single-quote via shellSingleQuote, not JSON.stringify. Double quotes
      // still evaluate $VAR, backticks, and $(...), so a crafted identity
      // could trigger command substitution during `git config`. Same
      // discipline as routeRead's path interpolation.
      const idName = githubIdentity.name;
      const idEmail = githubIdentity.email;
      await time('git_identity', () =>
        withExecDeadline(
          sandbox.exec(
            `git config --global user.name ${shellSingleQuote(idName)} && ` +
              `git config --global user.email ${shellSingleQuote(idEmail)}`,
          ),
        ),
      );
    }
  };

  try {
    await configureGitIdentity();

    if (repo && repo.length > 0) {
      const cloneUrl = githubRepoUrl(repo, githubToken);
      // Shallow clone — Push sessions are scoped to a single branch tip and
      // never inspect history beyond the current commit, so the full pack is
      // pure cold-start tax. `depth: 1` is SDK-supported; deeper history can
      // still be fetched on demand if a tool needs it.
      let directCloneSucceeded = false;
      try {
        await time('clone', () =>
          sandbox.gitCheckout(cloneUrl, { branch, targetDir: '/workspace', depth: 1 }),
        );
        directCloneSucceeded = true;
      } catch (branchCloneErr) {
        // The requested branch may not exist on origin — e.g. a branch-on-first-
        // prompt branch that only ever lived locally in a since-gone sandbox and
        // was never pushed (gate-at-push keeps it local until the first commit).
        // A `--branch <missing>` clone hard-fails, which used to strand the
        // session entirely ("can't start a sandbox on this branch"). Recover by
        // cloning the remote's default HEAD, but ONLY recreate the branch once
        // we've confirmed it's genuinely absent on origin — a transient failure
        // on a branch that *does* exist must not be silently recreated off the
        // default HEAD, which would base the session branch on the wrong commit.
        //
        // A clone failure can leave the sandbox with a `.git/config` whose origin
        // still carries the tokenized clone URL. Every failed recovery attempt
        // destroys that container before either retrying on a fresh provision or
        // surfacing the original clone error (fail-closed, mirroring #987).
        const destroyRecoverySandbox = async (attempt: 'initial' | 'retry'): Promise<boolean> => {
          try {
            if (!sandbox.destroy) {
              console.log(
                JSON.stringify({
                  level: 'error',
                  event: 'cf_sandbox_recovery_destroy_failed',
                  sandbox_id: sandboxId,
                  repo: repoHash,
                  attempt,
                  error_kind: 'destroy_unavailable',
                }),
              );
              return false;
            }
            await withExecDeadline(sandbox.destroy());
            return true;
          } catch (destroyErr) {
            console.log(
              JSON.stringify({
                level: 'warn',
                event: 'cf_sandbox_recovery_destroy_failed',
                sandbox_id: sandboxId,
                repo: repoHash,
                attempt,
                error_kind: classifyCloneRecoveryError(destroyErr).kind,
              }),
            );
            return false;
          }
        };

        let recoveryStage = 'workspace_reset';
        const recoverAbsentBranch = async (): Promise<boolean> => {
          recoveryStage = 'workspace_reset';
          const reset = (await withExecDeadline(
            sandbox.exec('rm -rf /workspace && mkdir -p /workspace'),
          )) as { exitCode?: number; stderr?: string };
          if ((reset.exitCode ?? 0) !== 0) {
            // Not a git operation — throw a plain Error carrying the exit code
            // and stderr so classifyCloneRecoveryError can decide. An executor
            // killed mid-reset surfaces as a signal exit (e.g. 137) and MUST
            // stay retryable; a genuine local failure (permission denied) still
            // classifies terminal via the git-error vocabulary.
            throw new Error(workspaceResetFailureMessage(reset));
          }

          recoveryStage = 'default_head_clone';
          await time('clone', () =>
            withExecDeadline(sandbox.gitCheckout(cloneUrl, { targetDir: '/workspace', depth: 1 })),
          );

          // Consult origin via the *configured* remote (token read from
          // `.git/config`, never placed on the command line) to disambiguate
          // "branch absent" from "transient clone failure".
          recoveryStage = 'ls_remote';
          const lsRemote = (await withExecDeadline(
            sandbox.exec(
              `cd /workspace && git ls-remote --heads origin ${shellSingleQuote(branch)}`,
            ),
          )) as { stdout?: string; stderr?: string; exitCode?: number };
          if ((lsRemote.exitCode ?? 1) !== 0) {
            const lsRemoteError = new Error(
              (lsRemote.stderr ?? '').trim() || 'git ls-remote failed',
            );
            if (classifyCloneRecoveryError(lsRemoteError).retryable) throw lsRemoteError;
            throw new CloneRecoveryGitError(recoveryStage, 'git ls-remote failed');
          }
          if ((lsRemote.stdout ?? '').trim().length > 0) {
            // The branch exists on origin — the `--branch` clone failed for a
            // real or transient reason, not absence. Never recreate it at the
            // default HEAD.
            throw new CloneRecoveryGitError(recoveryStage, 'branch exists on origin');
          }

          // Genuinely absent on origin. Prefer restoring a durable R2 snapshot
          // for this repo+branch — it recovers the unpushed tree and commits, not
          // just the branch name. Missing/failed snapshots fall through to the
          // empty-branch fallback.
          recoveryStage = 'snapshot_restore';
          const restoreOutcome = env.SNAPSHOT_INDEX
            ? await time('clone', () => restoreSnapshotIntoSandbox(env, sandbox, repo, branch))
            : 'absent';

          if (restoreOutcome === 'restored') return true;
          if (restoreOutcome === 'wiped') {
            // A restore attempt emptied /workspace before failing — re-establish
            // the default-HEAD checkout so the empty-branch fallback has a base.
            recoveryStage = 'post_restore_workspace_reset';
            const postRestoreReset = (await withExecDeadline(
              sandbox.exec('rm -rf /workspace && mkdir -p /workspace'),
            )) as { exitCode?: number; stderr?: string };
            if ((postRestoreReset.exitCode ?? 0) !== 0) {
              // Same classification contract as the workspace_reset stage above.
              throw new Error(workspaceResetFailureMessage(postRestoreReset));
            }
            recoveryStage = 'post_restore_default_head_clone';
            await time('clone', () =>
              withExecDeadline(
                sandbox.gitCheckout(cloneUrl, { targetDir: '/workspace', depth: 1 }),
              ),
            );
          }
          // Recreate locally off the default HEAD. Skip the `checkout -b` only
          // when the default checkout already *is* the requested branch — compared
          // via `symbolic-ref HEAD` (the actual current branch) rather than
          // `rev-parse <branch>`, which would also resolve a same-named tag and
          // wrongly skip the create.
          recoveryStage = 'branch_recreate';
          const recreate = (await withExecDeadline(
            sandbox.exec(
              `cd /workspace && (test "$(git symbolic-ref --short HEAD 2>/dev/null)" = ${shellSingleQuote(branch)} || ` +
                `git checkout -b ${shellSingleQuote(branch)})`,
            ),
          )) as { exitCode?: number; stderr?: string };
          if ((recreate.exitCode ?? 0) !== 0) {
            throw new CloneRecoveryGitError(recoveryStage, 'git checkout -b failed');
          }
          return false;
        };

        // Recovery-stage failures normally surface the ORIGINAL clone error
        // (the informative one). A structured SDK error (e.g. an
        // INVALID_BACKUP_CONFIG from the snapshot restore) must propagate
        // as-is instead — the route's error mapping turns its code into an
        // actionable 503, and replacing it with the generic clone failure
        // would bury the operator signal (PR #1572 Codex P2).
        const recoveryThrowable = (recoveryErr: unknown): unknown =>
          backupErrorCode(recoveryErr) !== undefined ? recoveryErr : branchCloneErr;

        let restoredFromSnapshot: boolean;
        try {
          restoredFromSnapshot = await recoverAbsentBranch();
        } catch (recoveryErr) {
          const classification = classifyCloneRecoveryError(recoveryErr);
          const destroyed = await destroyRecoverySandbox('initial');
          if (!classification.retryable) {
            console.log(
              JSON.stringify({
                level: 'warn',
                event: 'cf_sandbox_recovery_not_retried',
                sandbox_id: sandboxId,
                repo: repoHash,
                stage:
                  recoveryErr instanceof CloneRecoveryGitError ? recoveryErr.stage : recoveryStage,
                error_kind: classification.kind,
              }),
            );
            throw recoveryThrowable(recoveryErr);
          }
          if (!destroyed) {
            console.log(
              JSON.stringify({
                level: 'error',
                event: 'cf_sandbox_recovery_retry_failed',
                sandbox_id: sandboxId,
                repo: repoHash,
                stage: 'destroy_before_retry',
                error_kind: 'destroy_failed',
              }),
            );
            throw branchCloneErr;
          }

          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'cf_sandbox_recovery_retried',
              sandbox_id: sandboxId,
              repo: repoHash,
              stage: recoveryStage,
              error_kind: classification.kind,
            }),
          );
          // destroy() retires the credential-bearing container. Re-acquire the
          // stable DO handle so the second attempt provisions a clean executor,
          // then restore the global identity that lived in the destroyed rootfs.
          sandbox = sandboxFor(env, sandboxId);
          try {
            await configureGitIdentity();
            restoredFromSnapshot = await recoverAbsentBranch();
          } catch (retryErr) {
            const retryClassification = classifyCloneRecoveryError(retryErr);
            await destroyRecoverySandbox('retry');
            console.log(
              JSON.stringify({
                level: 'error',
                event: 'cf_sandbox_recovery_retry_failed',
                sandbox_id: sandboxId,
                repo: repoHash,
                stage: retryErr instanceof CloneRecoveryGitError ? retryErr.stage : recoveryStage,
                error_kind: retryClassification.kind,
              }),
            );
            throw recoveryThrowable(retryErr);
          }
        }
        // The recovery succeeded, so the 'clone' phase is no longer a failure even
        // though the first attempt threw and set it.
        failedPhase = null;
        console.log(
          JSON.stringify({
            level: 'info',
            event: restoredFromSnapshot
              ? 'cf_sandbox_branch_restored_from_snapshot'
              : 'cf_sandbox_branch_recreated',
            sandbox_id: sandboxId,
            repo: repoHash,
            reason: 'branch_absent_on_origin',
          }),
        );
      }

      // On-origin branch (the `--branch` clone succeeded): the fresh clone has the
      // *pushed* tip but not any work the prior sandbox left unpushed (local
      // commits / uncommitted tree). If a durable R2 snapshot exists for this
      // repo+branch, restore it OVER the clone to recover that work — but only
      // when it's safe. The guard: origin's current tip must be *reachable from*
      // the restored HEAD — `git merge-base --is-ancestor <originTip> HEAD`, i.e.
      // history membership, not mere object existence (a bare `cat-file -e` would
      // pass if the new tip is only in the object DB while HEAD doesn't contain
      // it). If it's an ancestor, the snapshot is "origin's tip + your unpushed
      // work" and restoring loses nothing. If it isn't, origin advanced past the
      // snapshot (you pushed elsewhere, a merge landed, …) and restoring would
      // silently shadow real commits — so we keep the fresh clone instead.
      // Default-branch sessions should cold-start from origin. On-origin snapshot
      // recovery is for feature branches with local-only work; running it on
      // `main`/`master` makes every ordinary startup hydrate, guard, and often
      // re-clone a stale snapshot before the sandbox can become ready.
      const branchLooksDefault =
        branch === defaultBranch || (!defaultBranch && (branch === 'main' || branch === 'master'));
      if (directCloneSucceeded && !branchLooksDefault && env.SNAPSHOT_INDEX) {
        const tipResult = (await withExecDeadline(
          sandbox.exec('git -C /workspace rev-parse HEAD'),
        ).catch(() => ({ stdout: '', exitCode: 1 }))) as { stdout?: string; exitCode?: number };
        const originTip = (tipResult.stdout ?? '').trim();
        if (originTip) {
          const outcome = await time('clone', () =>
            restoreUnpushedWorkOverClone(env, sandbox, repo, branch, originTip),
          );
          if (outcome === 'restored') {
            console.log(
              JSON.stringify({
                level: 'info',
                event: 'cf_sandbox_unpushed_work_restored',
                sandbox_id: sandboxId,
                repo: repoHash,
              }),
            );
          } else if (outcome === 'needs-reclone') {
            // A snapshot was hydrated then rejected (diverged) or failed to
            // extract, emptying /workspace — re-establish the fresh clone.
            await withExecDeadline(sandbox.exec('rm -rf /workspace && mkdir -p /workspace')).catch(
              () => {},
            );
            await time('clone', () =>
              sandbox.gitCheckout(cloneUrl, { branch, targetDir: '/workspace', depth: 1 }),
            );
          }
        }
      }
      if (githubToken) {
        // gitCheckout uses the tokenized URL for private clone auth. Immediately
        // rewrite origin to the public URL so raw sandbox_exec commands cannot
        // reuse a credential persisted in .git/config. Typed PushGit operations
        // add auth transiently when they intentionally talk to GitHub.
        const stripResult = await time('clone', () =>
          withExecDeadline(
            sandbox.exec(
              `git -C /workspace remote set-url origin ${shellSingleQuote(publicGitHubRepoUrl(repo))} && ` +
                '(git -C /workspace config --unset-all remote.origin.pushurl >/dev/null 2>&1 || true)',
            ),
          ),
        );
        // Fail CLOSED (#987): if the strip didn't succeed, the tokenized clone
        // URL may still be in .git/config — a reusable credential a raw
        // sandbox_exec could push with. Destroy the sandbox now (mirroring
        // Modal's terminate-on-cleanup-failure) so a credential-bearing
        // container doesn't linger until the idle reaper, then abort the create.
        // The error text carries no token (the command targets the public URL).
        const stripExit = (stripResult as { exitCode?: number }).exitCode ?? 0;
        if (stripExit !== 0) {
          const stripErr = (stripResult as { stderr?: string }).stderr ?? '';
          await sandbox.destroy?.().catch(() => {});
          throw new Error(
            `Failed to strip clone credentials from sandbox remote (exit ${stripExit})${
              stripErr ? `: ${stripErr}` : ''
            }`,
          );
        }
      }

      // Pre-populate /workspace/**/node_modules from the image-baked cache via
      // hardlink copy. Dockerfile.sandbox stages the whole pnpm workspace
      // (root + app + mcp/github-server) at /opt/push-cache during build;
      // `cp -al` creates new directory entries that share inodes with the
      // cache, so a fresh sandbox gets instant access to deps without paying
      // the ~100s cold-install wall-clock — the heavy FS write that was the
      // primary trigger for the stalls patched by #374/#375.
      //
      // Write-isolated by construction: a later `rm -rf node_modules` or
      // `pnpm add <pkg>` in the sandbox writes to new inodes on the workspace
      // side; the baked cache's inodes are untouched, so concurrent sandboxes
      // never stomp each other.
      //
      // Gated on a byte-exact `pnpm-lock.yaml` match (`cmp -s`) between the
      // baked cache and the cloned repo. One lockfile now governs all three
      // packages (npm needed one per manifest). Any mismatch — different
      // project, or Push itself on a branch whose deps have shifted from the
      // image — falls through and lets downstream flows install against the
      // correct lockfile. Critical because `handleCheckTypes` in
      // `sandbox-verification-handlers.ts` uses `node_modules` existence as its
      // "install already ran" signal; populating with mismatched deps would
      // silently regress typecheck results.
      //
      // All-or-nothing by construction: pnpm's per-package node_modules are
      // symlinks into the ROOT .pnpm virtual store via *relative* paths
      // (`../../node_modules/.pnpm/...`). Copying app/ or mcp/ without the root
      // would leave every one of those links dangling, so the per-package
      // copies are nested inside the root's success branch and the cleanup
      // arm removes all three together.
      //
      // Wrapped in `timeout 30` because wrangler's local container runtime
      // has been observed to silently wedge `cp -al` across overlay layers
      // (prod CF infra is unaffected). Without the bound, the copy would
      // burn the full 150s/300s `withExecDeadline` budget and 504 the whole
      // create. On timeout (shell exit 124), the `|| { ... }` branch cleans
      // up any partial node_modules directory so the cold install that runs
      // downstream (e.g. typecheck verification) sees a clean slate and not a
      // half-populated tree. Final `true` keeps the overall exit status 0 —
      // the cache is an optimization, never a correctness dependency.
      await time('cache_populate', () =>
        withExecDeadline(
          sandbox.exec(
            "timeout -k 5 30 bash -c '" +
              'src=/opt/push-cache; ' +
              'if [ -f "$src/pnpm-lock.yaml" ] && ' +
              'cmp -s "$src/pnpm-lock.yaml" /workspace/pnpm-lock.yaml 2>/dev/null && ' +
              '[ -d "$src/node_modules" ] && [ ! -e /workspace/node_modules ]; then ' +
              'cp -al "$src/node_modules" /workspace/node_modules; ' +
              'if [ -d "$src/app/node_modules" ] && [ -d /workspace/app ] && ' +
              '[ ! -e /workspace/app/node_modules ]; then ' +
              'cp -al "$src/app/node_modules" /workspace/app/node_modules; fi; ' +
              'if [ -d "$src/mcp/github-server/node_modules" ] && ' +
              '[ -d /workspace/mcp/github-server ] && ' +
              '[ ! -e /workspace/mcp/github-server/node_modules ]; then ' +
              'cp -al "$src/mcp/github-server/node_modules" ' +
              '/workspace/mcp/github-server/node_modules; fi; ' +
              'fi' +
              "' || { rm -rf /workspace/node_modules /workspace/app/node_modules " +
              '/workspace/mcp/github-server/node_modules 2>/dev/null; true; }',
          ),
        ),
      );
    }

    await time('seed_files', async () => {
      for (const seed of seedFiles) {
        await sandbox.writeFile(seed.path, seed.content);
      }
    });

    const environment = await time('probe', () => probeEnvironment(sandbox));

    // Mint the owner token AFTER all setup has succeeded. If provisioning
    // fails before this point the sandbox dies without ever being reachable,
    // so there's no partial-state to clean up. If token issuance ITSELF
    // fails (transient KV failure), destroy the sandbox before returning
    // an error — otherwise we'd orphan a live, un-verifiable, unreachable
    // container that can't even be cleaned up via API (the cleanup route
    // now requires a token we never stored).
    const tokenStore = env.SANDBOX_TOKENS;
    const ownerToken = await time('token_issue', async () => {
      try {
        const t = await issueToken(tokenStore, sandboxId, ownerHint);
        await sandbox.writeFile(OWNER_TOKEN_PATH, t);
        return t;
      } catch (err) {
        await sandbox.destroy?.().catch(() => {});
        await revokeToken(tokenStore, sandboxId).catch(() => {});
        throw err;
      }
    });

    return Response.json({
      sandbox_id: sandboxId,
      owner_token: ownerToken,
      status: 'ready',
      workspace_revision: 0,
      environment,
    });
  } finally {
    wlog('info', 'cf_sandbox_create_timing', {
      sandbox_id: sandboxId,
      repo_hash: repoHash,
      has_repo: Boolean(repo && repo.length > 0),
      phases_ms: phases,
      total_ms: Date.now() - createStart,
      ...(failedPhase ? { failed_phase: failedPhase } : {}),
    });
  }
}

async function sha256Hex(input: string, hexChars: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  const byteCount = Math.ceil(hexChars / 2);
  let out = '';
  for (let i = 0; i < byteCount; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, hexChars);
}

async function routeConnect(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const sandbox = sandboxFor(env, sandboxId);

  // Liveness check: run a trivial exec and propagate failures. probeEnvironment
  // swallows exec errors (returning an empty payload) so we can't rely on it
  // to signal a dead sandbox — do the probe explicitly here and surface 404
  // when it fails so callers fall back to create/restore.
  //
  // The probe retries transient failures and reports a wedged container
  // (deadline expiry) as 504 TIMEOUT — same vocabulary as the auth gate's
  // deadline handling — instead of folding every failure into 404. Callers
  // treat 404 as "sandbox gone" and fall back to create, so a transient blip
  // here used to orphan a live container along with its uncommitted work.
  // By this point the auth gate has just read the owner-token file via exec
  // successfully, so a probe failure is more likely a blip than a death.
  const probe = await probeSandboxLiveness(env, sandboxId);
  if (!probe.alive) {
    if (probe.reason === 'wedged') {
      wlog('warn', 'cf_connect_probe_wedged', {
        sandboxId,
        attempts: probe.attempts,
        message: probe.error,
      });
      return Response.json(
        { error: 'Sandbox is not responding', code: 'TIMEOUT' },
        { status: 504 },
      );
    }
    wlog('warn', 'cf_connect_probe_dead', {
      sandboxId,
      attempts: probe.attempts,
      message: probe.error,
    });
    return Response.json({ error: 'Sandbox is not reachable', code: 'NOT_FOUND' }, { status: 404 });
  }
  if (probe.attempts > 1) {
    wlog('info', 'cf_connect_probe_recovered', { sandboxId, attempts: probe.attempts });
  }

  const environment = await probeEnvironment(sandbox);
  return Response.json({
    sandbox_id: sandboxId,
    owner_token: str(body.owner_token) ?? '',
    status: 'ready',
    workspace_revision: 0,
    environment,
  });
}

async function routeCleanup(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const sandbox = sandboxFor(env, sandboxId);
  // Sandbox SDK's `destroy()` tears down the container + DO state. Optional
  // chain keeps this idempotent if the instance is already gone.
  await sandbox.destroy?.();
  // Revoke the owner token after destroy succeeds. Order matters: if
  // destroy throws, we keep the token so the caller can retry without
  // losing auth. KV's TTL still cleans up eventually.
  await revokeToken(env.SANDBOX_TOKENS, sandboxId);
  return Response.json({ ok: true });
}

function routePing(): Response {
  // The dispatch-level owner-token gate already touched the sandbox via the
  // in-container token file and rehydrated it from KV when possible. For health
  // checks, that is the cheap liveness signal we want: no user shell wrapper,
  // no branch stamp, no extra environment probe.
  return Response.json({ ok: true });
}

async function routeExec(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const command = requireStr(body, 'command');
  const workdir = str(body.workdir);
  // Optional caller-supplied deadline. Without it the only bound is the fixed
  // container wrapper (CONTAINER_EXEC_TIMEOUT_SECONDS) + the SDK-level race —
  // neither of which a caller can shorten for a command it knows is quick.
  // Clamped to the container ceiling so it can only ever tighten, never extend
  // past the safety net. Passing it to the SDK `timeout` makes the bound a
  // contract guarantee rather than a host-side best effort.
  // Guard `> 0`: a zero/negative timeout (payload manipulation, bad client
  // config) would otherwise pass a non-positive deadline to the SDK and fire an
  // immediate timeout. Treat non-positive as "unset" and fall back to defaults.
  const timeoutMs = num(body.timeout_ms);
  const clampedTimeoutMs =
    timeoutMs !== undefined && timeoutMs > 0
      ? Math.min(timeoutMs, CONTAINER_EXEC_TIMEOUT_SECONDS * 1000)
      : undefined;

  const sandbox = sandboxFor(env, sandboxId);
  // Wrap the user command in `timeout -k <grace> <seconds> bash -c '<cmd>'`
  // so the container kills a stuck process instead of leaving it running
  // after our SDK-level deadline abandons the call. `timeout` lives in
  // coreutils and is present in every container image we ship. `bash -c`
  // is deliberate, not `sh -c`: existing callers rely on bashisms like
  // `set -o pipefail`, `[[ ... ]]`, and arrays (see
  // `sandbox-read-only-inspection-handlers.ts` search pipeline), which
  // POSIX sh rejects. The SDK's own default execution path is bash-based,
  // so keeping bash preserves the pre-wrapper semantic. On timeout fire
  // the SDK call returns with exit_code=124 + partial stdout so the
  // caller can see how far the command got.
  const wrappedCommand =
    `timeout -k ${CONTAINER_EXEC_KILL_GRACE_SECONDS} ` +
    `${CONTAINER_EXEC_TIMEOUT_SECONDS} ` +
    `bash -c ${shellSingleQuote(command)}`;
  const execOptions = {
    env: SANDBOX_EXEC_RESOURCE_ENV,
    ...(workdir ? { cwd: workdir } : {}),
    ...(clampedTimeoutMs !== undefined ? { timeout: clampedTimeoutMs } : {}),
  };
  const result = await withExecDeadline(
    sandbox.exec(wrappedCommand, execOptions),
    // When the caller asked for a shorter deadline, fire the worker-side race at
    // that bound too so a wedged gRPC connection can't outlast the request.
    clampedTimeoutMs !== undefined ? clampedTimeoutMs + 2_000 : undefined,
  );

  const stdout = (result as { stdout?: string }).stdout ?? '';
  const stderr = (result as { stderr?: string }).stderr ?? '';
  const exitCode = (result as { exitCode?: number }).exitCode ?? 0;
  const branch = await readCurrentBranchStamp(sandbox as SandboxExecLike, {
    sandboxId,
    route: 'exec',
  });

  return Response.json({
    stdout: truncate(stdout, 500_000),
    stderr: truncate(stderr, 100_000),
    exit_code: exitCode,
    truncated: stdout.length > 500_000 || stderr.length > 100_000,
    workspace_revision: 0,
    ...(branch ? { branch } : {}),
  });
}

// ---------------------------------------------------------------------------
// Background execution (detached process + resumable cursor logs)
//
// Unlike `routeExec` (single buffered call, output returned at completion),
// this family detaches the command via the SDK's process API so a long-running
// command (npm install, test suite, dev server) survives the HTTP request that
// started it. Output is fetched incrementally by cursor so a client that drops
// mid-run — the mobile-disconnect case — can reconnect and resume reading from
// where it left off instead of losing the stream (and the process) the way SSE
// would. The contract mirrors OpenSandbox's execd /command{background:true} +
// /command/{id}/logs?cursor pattern, rebuilt on @cloudflare/sandbox primitives.
//
// `autoCleanup: false` is load-bearing: the SDK defaults to purging the process
// record on exit, which would drop final status + logs the instant a command
// finishes. Keeping the record means a post-completion reconnect can still read
// the exit code and tail. `routeExecKill` (or container teardown) is the
// reclaim path.
// ---------------------------------------------------------------------------

interface ProcessLike {
  readonly id: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly startTime?: Date;
  readonly endTime?: Date;
}

function isRunningStatus(status: string): boolean {
  return status === 'starting' || status === 'running';
}

interface SandboxExecLike {
  exec(command: string, options?: Record<string, unknown>): Promise<unknown>;
}

async function readCurrentBranchStamp(
  sandbox: SandboxExecLike,
  context: { sandboxId: string; route: string; processId?: string },
): Promise<string | undefined> {
  try {
    // `symbolic-ref` rather than `rev-parse --abbrev-ref`: unborn/orphan
    // branches (e.g. `git switch --orphan gh-pages` before the first commit)
    // have no commit for rev-parse to resolve, but their HEAD symref already
    // names the branch. With `-q`, exit 1 + empty stdout specifically means
    // detached HEAD; other failures (corrupt repo, missing workspace) exit
    // 128 with stderr and omit the stamp.
    const result = (await withExecDeadline(
      sandbox.exec('git -C /workspace symbolic-ref --short -q HEAD', {
        env: SANDBOX_EXEC_RESOURCE_ENV,
        timeout: 5_000,
      }),
      7_000,
    )) as { stdout?: string; stderr?: string; exitCode?: number };
    const exitCode = result.exitCode ?? 0;
    const branch = (result.stdout ?? '').trim();
    if (exitCode === 0) {
      if (!branch) {
        wlog('warn', 'sandbox_exec_branch_stamp_failed', {
          ...context,
          exitCode,
          message: 'branch stamp command returned empty stdout',
        });
        return undefined;
      }
      return branch;
    }
    if (exitCode === 1 && !branch) {
      return 'HEAD';
    }
    wlog('warn', 'sandbox_exec_branch_stamp_failed', {
      ...context,
      exitCode,
      message: (result.stderr || result.stdout || 'branch stamp command failed').trim(),
    });
    return undefined;
  } catch (err) {
    wlog('warn', 'sandbox_exec_branch_stamp_failed', {
      ...context,
      message: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function routeExecStart(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const command = requireStr(body, 'command');
  const workdir = str(body.workdir);
  // Only apply a strictly-positive timeout; a zero/negative value would fire an
  // immediate timeout in the SDK, so treat non-positive as "unbounded".
  const timeoutMs = num(body.timeout_ms);

  const sandbox = sandboxFor(env, sandboxId);
  // The start call itself should return a handle promptly; guard it with the
  // SDK-level deadline so a wedged container surfaces TIMEOUT instead of
  // hanging the route. The process's own runtime is NOT bounded here — that's
  // the point of detaching — except by the optional caller-supplied timeout.
  const proc = (await withExecDeadline(
    sandbox.startProcess(command, {
      env: SANDBOX_EXEC_RESOURCE_ENV,
      ...(workdir ? { cwd: workdir } : {}),
      ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      autoCleanup: false,
    }),
  )) as ProcessLike;

  return Response.json({
    process_id: proc.id,
    status: proc.status,
    running: isRunningStatus(proc.status),
    started_at: proc.startTime ? proc.startTime.toISOString() : null,
  });
}

async function routeExecStatus(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const processId = requireStr(body, 'process_id');

  const sandbox = sandboxFor(env, sandboxId);
  const proc = (await withExecDeadline(sandbox.getProcess(processId))) as ProcessLike | null;

  if (!proc) {
    // Distinguish "process never existed / was reclaimed" from "still running":
    // a null here is terminal for this id, so callers must stop polling.
    wlog('warn', 'cf_exec_status_not_found', { sandboxId, processId });
    return Response.json({ error: 'Process not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const running = isRunningStatus(proc.status);
  const branch = running
    ? undefined
    : await readCurrentBranchStamp(sandbox as SandboxExecLike, {
        sandboxId,
        route: 'exec-status',
        processId,
      });

  return Response.json({
    process_id: proc.id,
    status: proc.status,
    running,
    exit_code: proc.exitCode ?? null,
    started_at: proc.startTime ? proc.startTime.toISOString() : null,
    ended_at: proc.endTime ? proc.endTime.toISOString() : null,
    ...(branch ? { branch } : {}),
  });
}

async function routeExecLogs(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const processId = requireStr(body, 'process_id');
  // Character offsets (UTF-16 code units, NOT bytes) into the accumulated
  // stdout/stderr. Omit for a full read. The SDK only exposes whole-log reads,
  // so the cursor is layered here: we fetch the full buffer and slice from the
  // caller's offset, returning the new length as the next cursor. Cheap for
  // npm-install/test-run-sized logs; if buffers grow huge this is the seam to
  // swap for a tail-only fetch.
  const cursorStdout = Math.max(0, num(body.cursor_stdout) ?? 0);
  const cursorStderr = Math.max(0, num(body.cursor_stderr) ?? 0);

  const sandbox = sandboxFor(env, sandboxId);
  let logs: { stdout?: string; stderr?: string };
  try {
    logs = (await withExecDeadline(sandbox.getProcessLogs(processId))) as {
      stdout?: string;
      stderr?: string;
    };
  } catch (err) {
    // getProcessLogs throws for an unknown id; map to the same terminal
    // NOT_FOUND the status route returns so callers have one stop signal.
    wlog('warn', 'cf_exec_logs_not_found', {
      sandboxId,
      processId,
      message: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: 'Process not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  const fullStdout = logs.stdout ?? '';
  const fullStderr = logs.stderr ?? '';
  // Guard against a cursor past the buffer (e.g. process record reset): clamp
  // so we return an empty slice + a corrected cursor rather than throwing.
  const fromStdout = Math.min(cursorStdout, fullStdout.length);
  const fromStderr = Math.min(cursorStderr, fullStderr.length);
  const stdoutChunk = fullStdout.slice(fromStdout);
  const stderrChunk = fullStderr.slice(fromStderr);

  const STDOUT_CAP = 500_000;
  const STDERR_CAP = 100_000;
  // Emit at most CAP code units, but never cut mid-surrogate-pair — a lone
  // surrogate would corrupt the resumed stream and break JSON rendering. The
  // cursor advances by exactly what we emit, so a capped read stays resumable.
  const stdoutEmit = safeCutLength(stdoutChunk, STDOUT_CAP);
  const stderrEmit = safeCutLength(stderrChunk, STDERR_CAP);
  const stdoutTruncated = stdoutEmit < stdoutChunk.length;
  const stderrTruncated = stderrEmit < stderrChunk.length;

  return Response.json({
    process_id: processId,
    // Return the raw slice with NO inline "[truncated]" marker: the cursor
    // advances by exactly what we emit, so the next poll fetches the rest — a
    // marker would be persisted mid-stream in the caller's concatenated output.
    // The `truncated` boolean already signals a capped slice for any UI use.
    stdout: stdoutChunk.slice(0, stdoutEmit),
    stderr: stderrChunk.slice(0, stderrEmit),
    // Advance only by what we actually returned so a truncated read is
    // resumable: the next poll picks up exactly where this chunk was cut.
    next_cursor_stdout: fromStdout + stdoutEmit,
    next_cursor_stderr: fromStderr + stderrEmit,
    truncated: stdoutTruncated || stderrTruncated,
  });
}

async function routeExecKill(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const processId = requireStr(body, 'process_id');
  const signal = str(body.signal);

  const sandbox = sandboxFor(env, sandboxId);
  try {
    await withExecDeadline(sandbox.killProcess(processId, signal));
  } catch (err) {
    // Idempotent: killing an already-gone process is success from the
    // caller's perspective. Log so a genuinely failing kill is still visible.
    wlog('warn', 'cf_exec_kill_noop', {
      sandboxId,
      processId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return Response.json({ ok: true });
}

async function routeRead(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const path = requireStr(body, 'path');
  const startLine = num(body.start_line);
  const endLine = num(body.end_line);
  const isLineRangeRead = startLine !== undefined || endLine !== undefined;
  const requestedStartLine = Math.max(1, startLine ?? 1);
  const requestedEndLine =
    endLine !== undefined ? Math.max(requestedStartLine, endLine) : undefined;
  const quotedPath = shellSingleQuote(path);

  // Ask for MAX_READ_BYTES + 1 so we can detect truncation unambiguously:
  // if we receive more than MAX_READ_BYTES bytes, the file exceeded the cap.
  // Equal or fewer means we got the whole thing. Previously `>=` marked
  // exactly-at-cap files as truncated — a false positive.
  const CAP = MAX_READ_BYTES;
  const PROBE_BYTES = CAP + 1;

  const sandbox = sandboxFor(env, sandboxId);
  const contentCommand = isLineRangeRead
    ? `sed -n '${requestedStartLine},${requestedEndLine ?? '$'}p' -- ${quotedPath} | head -c ${PROBE_BYTES}`
    : `head -c ${PROBE_BYTES} -- ${quotedPath}`;
  // Keep the hash command a single pipeline — no command substitution.
  // Pipelines' exit status in bash reflects the last stage; here that's awk,
  // which exits 0 whenever sha256sum produces any output. We handle the
  // missing-file case via the parallel `stat` probe below, so a silent
  // success here is fine (it'll just produce an empty digest string that we
  // treat as null version).
  const hashCommand = `sha256sum -- ${quotedPath} | awk '{print $1}'`;
  // awk 'END{print NR}' counts logical records (handles files without a
  // trailing newline correctly, which `wc -l` undercounts).
  const lineCountCommand = `awk 'END{print NR}' -- ${quotedPath}`;
  // stat gives us the authoritative byte size without reading the file —
  // used for the NOT_FOUND probe and for accurate remaining_bytes on
  // byte-capped reads.
  const statCommand = `stat -c %s -- ${quotedPath}`;

  const [contentResult, hashResult, lineCountResult, statResult] = (await Promise.all([
    withExecDeadline(sandbox.exec(contentCommand)),
    withExecDeadline(sandbox.exec(hashCommand)),
    isLineRangeRead ? withExecDeadline(sandbox.exec(lineCountCommand)) : Promise.resolve(null),
    withExecDeadline(sandbox.exec(statCommand)),
  ])) as [
    { stdout?: string; stderr?: string; exitCode?: number },
    { stdout?: string; stderr?: string; exitCode?: number },
    { stdout?: string; stderr?: string; exitCode?: number } | null,
    { stdout?: string; stderr?: string; exitCode?: number },
  ];

  // stat's exit code is the authoritative existence probe — it fails fast
  // and without reading the file, so it's a stronger NOT_FOUND signal than
  // sha256sum or sed.
  if ((statResult.exitCode ?? 0) !== 0) {
    return Response.json({
      error:
        (statResult.stderr || statResult.stdout || `Failed to read file: ${path}`).trim() ||
        `Failed to read file: ${path}`,
      code: 'NOT_FOUND',
      content: '',
      truncated: false,
      version: null,
      workspace_revision: 0,
    });
  }

  if ((contentResult.exitCode ?? 0) !== 0) {
    return Response.json({
      error:
        (contentResult.stderr || contentResult.stdout || `Failed to read file: ${path}`).trim() ||
        `Failed to read file: ${path}`,
      code: 'NOT_FOUND',
      content: '',
      truncated: false,
      version: null,
      workspace_revision: 0,
    });
  }

  const rawContent = contentResult.stdout ?? '';
  const rawBytes = new TextEncoder().encode(rawContent);
  const byteTruncated = rawBytes.length > CAP;
  const content = byteTruncated ? new TextDecoder().decode(rawBytes.slice(0, CAP)) : rawContent;

  const lineCount =
    lineCountResult && (lineCountResult.exitCode ?? 0) === 0
      ? Number.parseInt((lineCountResult.stdout ?? '').trim(), 10)
      : undefined;
  const normalizedLineCount =
    lineCount !== undefined && Number.isFinite(lineCount) && lineCount >= 0 ? lineCount : undefined;

  // Don't clamp the reported range against the measured line count. The sed
  // command was built from the *requested* range, so echoing a clamped range
  // back would desync metadata from the returned content (e.g., request
  // start_line past EOF → sed returns empty → clamped start_line would say
  // "you read from line N" for empty content). Echo the request verbatim.
  const responseStartLine = isLineRangeRead ? requestedStartLine : undefined;
  const responseEndLine = isLineRangeRead ? requestedEndLine : undefined;

  const lineTruncated =
    isLineRangeRead &&
    requestedEndLine !== undefined &&
    normalizedLineCount !== undefined &&
    requestedEndLine < normalizedLineCount;
  const truncated = byteTruncated || lineTruncated;

  const fileSize = Number.parseInt((statResult.stdout ?? '').trim(), 10);
  const normalizedFileSize = Number.isFinite(fileSize) && fileSize >= 0 ? fileSize : undefined;
  // remaining_bytes is only meaningful for byte-capped unbounded reads —
  // for line-range reads we don't know how many bytes beyond the range
  // remain without reading them. Compute from the authoritative stat
  // result, not the content buffer (which is capped).
  const remainingBytes =
    !isLineRangeRead && byteTruncated && normalizedFileSize !== undefined
      ? Math.max(0, normalizedFileSize - CAP)
      : undefined;

  const rawVersion = hashResult.stdout?.trim();
  const version = rawVersion && rawVersion.length > 0 ? rawVersion : null;

  return Response.json({
    content,
    truncated,
    truncated_at_line: lineTruncated ? requestedEndLine + 1 : undefined,
    remaining_bytes: remainingBytes,
    version,
    start_line: responseStartLine,
    end_line: responseEndLine,
    workspace_revision: 0,
  });
}

async function routeWrite(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const path = requireStr(body, 'path');
  const content = requireStr(body, 'content');
  const expectedVersion = str(body.expected_version);

  const sandbox = sandboxFor(env, sandboxId);

  if (expectedVersion !== undefined) {
    const existing = (await sandbox.readFile(path).catch(() => null)) as {
      content?: string;
    } | null;
    const existingContent = existing?.content ?? '';
    const existingVersion = existing ? await hashSha256(existingContent) : null;
    if (existingVersion !== expectedVersion) {
      return Response.json({
        ok: false,
        code: 'STALE_FILE',
        error: 'File changed since last read',
        expected_version: expectedVersion,
        current_version: existingVersion,
      });
    }
  }

  await sandbox.writeFile(path, content);
  const newVersion = await hashSha256(content);

  return Response.json({
    ok: true,
    bytes_written: new TextEncoder().encode(content).length,
    new_version: newVersion,
    workspace_revision: 0,
  });
}

// Large-file upload to /workspace. The standard `write` route is capped at
// MAX_BODY_SIZE_BYTES (~5 MB); this route sits in the RESTORE_MAX_BODY_SIZE_BYTES
// (12 MB) body tier (see the dispatch body-limit) so a native-checkpoint restore
// archive — ~9 MB of base64 for Push's ~7 MB working tree — can round-trip.
// Writes the payload verbatim via the SDK (`sandbox.writeFile`, uncapped at the
// SDK level — the same path `hydrateBase64IntoSandbox` uses), confined to
// /workspace. No version/CAS check: callers (checkpoint restore) write a private
// temp path, not a tracked file.
async function routeUpload(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const requestedPath = requireStr(body, 'path');
  const content = requireStr(body, 'content');

  if (!requestedPath.startsWith('/workspace/')) {
    return Response.json({ ok: false, error: 'Path must be within /workspace' });
  }

  const sandbox = sandboxFor(env, sandboxId);

  // The target file may not exist yet, so canonicalize with `realpath -m` (no
  // existence requirement). It still resolves `..` and any *existing* symlink
  // component, so `/workspace/../etc/x` or an in-tree symlink can't escape — the
  // resolved path is then re-checked against /workspace (the confinement
  // boundary, mirroring routeDownload).
  const realpathResult = (await withExecDeadline(
    sandbox.exec(`realpath -m -- ${shellSingleQuote(requestedPath)}`),
  )) as { stdout?: string; exitCode?: number };
  if ((realpathResult.exitCode ?? 0) !== 0) {
    return Response.json({ ok: false, error: `Invalid path: ${requestedPath}` });
  }
  const path = (realpathResult.stdout ?? '').trim();
  if (!path.startsWith('/workspace/')) {
    return Response.json({ ok: false, error: 'Path must be within /workspace' });
  }

  await sandbox.writeFile(path, content);
  return Response.json({
    ok: true,
    bytes_written: new TextEncoder().encode(content).length,
  });
}

async function routeBatchWrite(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const files = body.files as Array<{
    path: string;
    content: string;
    expected_version?: string;
  }>;

  const sandbox = sandboxFor(env, sandboxId);
  const results: Array<Record<string, unknown>> = [];
  let overallOk = true;

  for (const f of files) {
    if (f.expected_version !== undefined) {
      const existing = (await sandbox.readFile(f.path).catch(() => null)) as {
        content?: string;
      } | null;
      const existingContent = existing?.content ?? '';
      const existingVersion = existing ? await hashSha256(existingContent) : null;
      if (existingVersion !== f.expected_version) {
        overallOk = false;
        results.push({
          path: f.path,
          ok: false,
          code: 'STALE_FILE',
          error: 'File changed since last read',
          expected_version: f.expected_version,
          current_version: existingVersion,
        });
        continue;
      }
    }
    await sandbox.writeFile(f.path, f.content);
    results.push({
      path: f.path,
      ok: true,
      bytes_written: new TextEncoder().encode(f.content).length,
      new_version: await hashSha256(f.content),
    });
  }

  return Response.json({
    ok: overallOk,
    results,
    workspace_revision: 0,
  });
}

async function routeDelete(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const path = requireStr(body, 'path');
  const sandbox = sandboxFor(env, sandboxId);
  await sandbox.deleteFile(path);
  return Response.json({ workspace_revision: 0 });
}

async function routeList(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const path = requireStr(body, 'path');
  const sandbox = sandboxFor(env, sandboxId);
  const result = (await sandbox.listFiles(path)) as {
    entries?: Array<{ name: string; type?: string; isDirectory?: boolean; size?: number }>;
    files?: Array<{ name: string; type?: string; isDirectory?: boolean; size?: number }>;
  };

  const raw = result.entries ?? result.files ?? [];
  const entries = raw.map((e) => ({
    name: e.name,
    type: (e.isDirectory ? 'directory' : (e.type ?? 'file')) as 'file' | 'directory' | 'symlink',
    size: e.size,
  }));

  return Response.json({ entries });
}

async function routeDiff(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  // Optional pre-Coder ref so the Auditor can see committed work even
  // after the working tree is clean (PR #604 — fix for the post-commit
  // empty-diff false-positive in #601). Only a 7-40 hex SHA shape is
  // accepted to keep this off the shell-injection surface; anything
  // else is silently ignored and the response omits diff_since_ref.
  const sinceRefRaw = typeof body.since_ref === 'string' ? body.since_ref.trim() : '';
  const sinceRef = /^[0-9a-f]{7,40}$/i.test(sinceRefRaw) ? sinceRefRaw : '';
  const sandbox = sandboxFor(env, sandboxId);

  const diffRes = (await withExecDeadline(sandbox.exec('git -C /workspace diff HEAD'))) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  const statusRes = (await withExecDeadline(
    sandbox.exec('git -C /workspace status --porcelain'),
  )) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  const headRes = (await withExecDeadline(sandbox.exec('git -C /workspace rev-parse HEAD'))) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };

  // Distinguish "no changes" (git succeeds, empty stdout) from "git failed"
  // (non-zero exit, likely "/workspace not a git repo"). Callers need this
  // because they interpret empty stdout as a clean tree.
  if ((diffRes.exitCode ?? 0) !== 0 || (statusRes.exitCode ?? 0) !== 0) {
    return Response.json({
      diff: '',
      truncated: false,
      git_status: '',
      error: (diffRes.stderr || statusRes.stderr || 'git command failed').trim(),
    });
  }

  const diff = diffRes.stdout ?? '';
  const MAX = 1_000_000;

  let diffSinceRef = '';
  if (sinceRef) {
    const rangedRes = (await withExecDeadline(
      sandbox.exec(`git -C /workspace diff ${sinceRef}..HEAD`),
    )) as { stdout?: string; stderr?: string; exitCode?: number };
    if ((rangedRes.exitCode ?? 0) === 0) {
      diffSinceRef = rangedRes.stdout ?? '';
    }
    // Ranged-diff failure (bad ref, etc.) is non-fatal — the caller
    // falls back to the working-tree diff and the LLM auditor.
  }

  const headSha = (headRes.exitCode ?? 0) === 0 ? (headRes.stdout ?? '').trim() : undefined;

  return Response.json({
    diff: diff.length > MAX ? `${diff.slice(0, MAX)}\n…[truncated]` : diff,
    truncated: diff.length > MAX,
    git_status: statusRes.stdout ?? '',
    ...(headSha ? { head_sha: headSha } : {}),
    ...(diffSinceRef
      ? {
          diff_since_ref:
            diffSinceRef.length > MAX
              ? `${diffSinceRef.slice(0, MAX)}\n…[truncated]`
              : diffSinceRef,
        }
      : {}),
  });
}

// Directory tar excludes mirror the Modal backend (sandbox/app.py
// create_archive) so a "download your work" archive is the same payload on
// both providers — no VCS metadata or rebuildable dependency trees.
const ARCHIVE_DIR_EXCLUDES = [
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'dist',
  'build',
] as const;

async function routeDownload(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const requestedPath = (str(body.path) ?? '/workspace').replace(/\/+$/g, '') || '/workspace';
  const format = str(body.format) ?? 'tar.gz';

  // Wire contract is shared with Modal (sandbox/app.py create_archive): the
  // browser/CLI clients read `ok`, `archive_base64`/`file_base64`, `filename`,
  // `content_type`, `size_bytes`, and `format` straight off this JSON. App-level
  // failures return `{ ok: false, error }` with HTTP 200 so the client surfaces
  // `error` rather than a transport error.
  if (format !== 'tar.gz' && format !== 'raw') {
    return Response.json({ ok: false, error: 'Unsupported format' });
  }
  if (!requestedPath.startsWith('/')) {
    return Response.json({ ok: false, error: 'Path must be absolute' });
  }
  // Cheap lexical pre-filter to reject obviously out-of-tree paths without
  // spawning an exec. NOT the security boundary — `/workspace/../etc/passwd`
  // passes this but is caught by the realpath canonicalization below.
  if (requestedPath !== '/workspace' && !requestedPath.startsWith('/workspace/')) {
    return Response.json({ ok: false, error: 'Path must be within /workspace' });
  }

  const sandbox = sandboxFor(env, sandboxId);

  // Canonicalize in-container before doing anything with the path. `realpath -e`
  // resolves `..` segments and follows symlinks (requiring every component to
  // exist), so this is the actual /workspace confinement boundary: a lexical
  // check alone lets `/workspace/../etc/passwd` or an in-tree symlink escape and
  // exfiltrate bytes, since this route returns raw file/archive contents. We
  // then re-validate the *resolved* path and run every subsequent command
  // against it. Mirrors the Modal backend's os.path.realpath guard.
  const realpathResult = (await withExecDeadline(
    sandbox.exec(`realpath -e -- ${shellSingleQuote(requestedPath)}`),
  )) as { stdout?: string; stderr?: string; exitCode?: number };
  if ((realpathResult.exitCode ?? 0) !== 0) {
    return Response.json({ ok: false, error: `Path not found: ${requestedPath}` });
  }
  const path = (realpathResult.stdout ?? '').trim();
  if (path !== '/workspace' && !path.startsWith('/workspace/')) {
    return Response.json({ ok: false, error: 'Path must be within /workspace' });
  }
  const quotedPath = shellSingleQuote(path);

  // Classify the resolved target. `%F` reports "regular file"/"directory" (and
  // since `path` is already symlink-resolved, symlink targets surface as their
  // real kind); `%s` is the authoritative byte size for the raw-file cap.
  const statResult = (await withExecDeadline(sandbox.exec(`stat -c '%F|%s' -- ${quotedPath}`))) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  if ((statResult.exitCode ?? 0) !== 0) {
    return Response.json({ ok: false, error: `Path not found: ${path}` });
  }
  const statParts = (statResult.stdout ?? '').trim().split('|');
  const kind = statParts[0] ?? '';
  const sizeRaw = statParts[1] ?? '';
  const isFile = kind === 'regular file';
  const isDirectory = kind === 'directory';
  const name = path.split('/').filter(Boolean).pop() || 'workspace';

  if (format === 'raw') {
    if (!isFile) {
      return Response.json({ ok: false, error: 'Raw download is only supported for files' });
    }
    const statSize = Number.parseInt(sizeRaw, 10);
    if (Number.isFinite(statSize) && statSize > MAX_ARCHIVE_BYTES) {
      return Response.json({
        ok: false,
        error: `File exceeds max size of ${MAX_ARCHIVE_BYTES} bytes`,
      });
    }

    const fileResult = (await withExecDeadline(sandbox.exec(`base64 -w0 -- ${quotedPath}`))) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    if ((fileResult.exitCode ?? 0) !== 0) {
      return Response.json({
        ok: false,
        error:
          (fileResult.stderr || 'Raw file download failed').trim() || 'Raw file download failed',
      });
    }

    const fileBase64 = fileResult.stdout?.trim() ?? '';
    return Response.json({
      ok: true,
      filename: name,
      content_type: guessContentType(name),
      size_bytes: Number.isFinite(statSize) ? statSize : decodedBase64Size(fileBase64),
      file_base64: fileBase64,
      format: 'raw',
    });
  }

  // format === 'tar.gz'. A file is tarred relative to its parent so the archive
  // contains just the file; a directory is tarred from within with the shared
  // excludes applied. The archive is written to a temp file (not piped straight
  // to base64) so we can stat its real compressed size and reject oversized
  // archives BEFORE materializing a huge base64 blob in worker memory — matching
  // Modal's create_archive, which writes /tmp/archive.tar.gz then size-checks.
  let tarCommand: string;
  if (isFile) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    tarCommand = `tar -czf %TMP% -C ${shellSingleQuote(parent)} -- ${shellSingleQuote(name)}`;
  } else if (isDirectory) {
    const excludes = ARCHIVE_DIR_EXCLUDES.map((e) => `--exclude=${shellSingleQuote(e)}`).join(' ');
    tarCommand = `tar -czf %TMP% ${excludes} -C ${quotedPath} .`;
  } else {
    return Response.json({ ok: false, error: `Unsupported path kind: ${kind || 'unknown'}` });
  }

  const tmpArchive = `/tmp/push-download-${crypto.randomUUID()}.tar.gz`;
  const quotedTmp = shellSingleQuote(tmpArchive);
  try {
    const tarResult = (await withExecDeadline(
      sandbox.exec(tarCommand.replace('%TMP%', quotedTmp)),
    )) as { stderr?: string; exitCode?: number };
    if ((tarResult.exitCode ?? 0) !== 0) {
      return Response.json({
        ok: false,
        error: `Archive creation failed: ${tarResult.stderr ?? ''}`.trim(),
      });
    }

    const sizeResult = (await withExecDeadline(sandbox.exec(`stat -c %s -- ${quotedTmp}`))) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    const archiveSize = Number.parseInt((sizeResult.stdout ?? '').trim(), 10);
    // Fail closed: if we can't read the archive's size, do NOT fall through to
    // base64 — that would let an unmeasured (possibly oversized) archive bypass
    // the cap, defeating the whole temp-file-then-measure approach.
    if ((sizeResult.exitCode ?? 0) !== 0 || !Number.isFinite(archiveSize)) {
      return Response.json({
        ok: false,
        error:
          (sizeResult.stderr || 'Failed to measure archive size').trim() ||
          'Failed to measure archive size',
      });
    }
    if (archiveSize > MAX_ARCHIVE_BYTES) {
      return Response.json({
        ok: false,
        error: `Archive exceeds max size of ${MAX_ARCHIVE_BYTES} bytes`,
      });
    }

    const b64Result = (await withExecDeadline(sandbox.exec(`base64 -w0 -- ${quotedTmp}`))) as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    if ((b64Result.exitCode ?? 0) !== 0) {
      return Response.json({
        ok: false,
        error: (b64Result.stderr || 'Archive creation failed').trim() || 'Archive creation failed',
      });
    }

    return Response.json({
      ok: true,
      archive_base64: b64Result.stdout?.trim() ?? '',
      size_bytes: archiveSize,
      format: 'tar.gz',
    });
  } finally {
    await withExecDeadline(sandbox.exec(`rm -f ${quotedTmp}`)).catch(() => {});
  }
}

// Decode a base64 tar.gz and extract it into `path` inside a sandbox. Shared by
// the `restore` (hydrateArchive) route and the snapshot `restore-snapshot`
// route so the path-traversal defense lives in exactly one place.
async function hydrateBase64IntoSandbox(
  sandbox: SandboxStub,
  archive: string,
  path: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // Write the base64 archive to a tmp file via the SDK instead of passing it
  // through the shell command line. ARG_MAX on Linux is typically ~2 MB, and
  // RESTORE_MAX_BODY_SIZE_BYTES allows up to 12 MB — inline piping would fail
  // well before the body limit is exercised.
  const tmpB64 = `/tmp/push-restore-${crypto.randomUUID()}.b64`;
  const tmpTar = `${tmpB64}.tar.gz`;
  await sandbox.writeFile(tmpB64, archive);

  const cleanup = () =>
    withExecDeadline(
      sandbox.exec(`rm -f ${shellSingleQuote(tmpB64)} ${shellSingleQuote(tmpTar)}`),
    ).catch(() => {});

  const mkdir = (await withExecDeadline(sandbox.exec(`mkdir -p ${shellSingleQuote(path)}`))) as {
    exitCode?: number;
    stderr?: string;
  };
  if ((mkdir.exitCode ?? 0) !== 0) {
    // No cleanup here: tmpTar doesn't exist yet and the only stray file is the
    // tmp .b64, which a torn-down container discards anyway. Matches the
    // pre-refactor behavior the route's tests pin.
    return {
      ok: false,
      status: 500,
      error: `Failed to create target directory: ${(mkdir.stderr ?? '').trim()}`,
    };
  }

  const decode = (await withExecDeadline(
    sandbox.exec(`base64 -d ${shellSingleQuote(tmpB64)} > ${shellSingleQuote(tmpTar)}`),
  )) as {
    exitCode?: number;
    stderr?: string;
  };
  if ((decode.exitCode ?? 0) !== 0) {
    await cleanup();
    return {
      ok: false,
      status: 400,
      error: `Failed to decode archive: ${(decode.stderr ?? '').trim()}`,
    };
  }

  // Defense in depth against path traversal: list archive members first and
  // refuse if any entry is absolute or contains "..". Even with internal
  // traffic we trust, this keeps a bad producer from escaping the target
  // directory during hydrate.
  const list = (await withExecDeadline(sandbox.exec(`tar -tzf ${shellSingleQuote(tmpTar)}`))) as {
    stdout?: string;
    exitCode?: number;
    stderr?: string;
  };
  if ((list.exitCode ?? 0) !== 0) {
    await cleanup();
    return { ok: false, status: 400, error: `Invalid archive: ${(list.stderr ?? '').trim()}` };
  }
  const members = (list.stdout ?? '').split('\n').filter(Boolean);
  const unsafe = members.find((m) => m.startsWith('/') || m.split('/').some((seg) => seg === '..'));
  if (unsafe) {
    await cleanup();
    return { ok: false, status: 400, error: `Archive member rejected (path traversal): ${unsafe}` };
  }

  const extract = (await withExecDeadline(
    sandbox.exec(
      `tar -xzf ${shellSingleQuote(tmpTar)} -C ${shellSingleQuote(path)} --no-same-owner`,
    ),
  )) as { exitCode?: number; stderr?: string };
  await cleanup();

  if ((extract.exitCode ?? 0) !== 0) {
    return {
      ok: false,
      status: 500,
      error: `Archive extraction failed: ${(extract.stderr ?? '').trim()}`,
    };
  }
  return { ok: true };
}

async function routeHydrate(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const archive = requireStr(body, 'archive');
  const path = (str(body.path) ?? '/workspace').replace(/\/+$/g, '') || '/workspace';
  const sandbox = sandboxFor(env, sandboxId);

  const result = await hydrateBase64IntoSandbox(sandbox, archive, path);
  if (!result.ok) {
    return Response.json({ error: result.error, code: 'CF_ERROR' }, { status: result.status });
  }
  return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Snapshots (Sandbox SDK backups) — the Cloudflare equivalent of Modal's
// filesystem snapshots. hibernate asks the SDK to archive /workspace directly
// to R2, then frees the container. restore-snapshot materializes that backup
// into a fresh sandbox. The wire
// contract matches the Modal /api/sandbox/hibernate + /restore-snapshot shape
// ({ ok, snapshot_id, restore_token } / { ok, sandbox_id, owner_token, ... })
// so client code (idle-hibernate + reconnect-restore) works unchanged.
// ---------------------------------------------------------------------------

// `gitignore: true` keeps .git itself while excluding gitignored content such
// as node_modules. The retired hand-rolled path also unconditionally excluded
// __pycache__, .venv, dist, and build; repositories that do not gitignore those
// names may now include them. That is the intentional SDK-semantics delta.
export const SNAPSHOT_KEY_PREFIX = 'cf-snapshots/';
const BACKUP_DESCRIPTOR_PREFIX = 'cf-backups/';
// A large tree may take substantially longer than an ordinary exec to archive
// or materialize. Keep this dedicated budget independent of user-exec tuning.
const BACKUP_OPERATION_TIMEOUT_MS = 120_000;
// Seven days matches the snapshot-index inactivity TTL. The SDK's default is
// only three days, which would leave live index entries pointing at expiry.
const BACKUP_TTL_SECONDS = DEFAULT_TTL_SECONDS;

// Legacy base64 snapshots could not cross the 32 MiB DO RPC boundary. The SDK
// backup path has no Push-side size cap; this constant is consulted only when
// restoring a pre-upgrade `imageId` entry.
const DO_RPC_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = Math.floor((DO_RPC_MAX_BYTES * 3) / 4) - 1024 * 1024;

interface BackupDescriptor {
  v: 1;
  backupHandle: DirectoryBackup;
}

function backupDescriptorKey(backupId: string): string {
  return `${BACKUP_DESCRIPTOR_PREFIX}${backupId}`;
}

function isBackupHandle(raw: unknown): raw is DirectoryBackup {
  if (!raw || typeof raw !== 'object') return false;
  const handle = raw as Partial<DirectoryBackup>;
  return (
    typeof handle.id === 'string' &&
    handle.id.length > 0 &&
    typeof handle.dir === 'string' &&
    handle.dir.startsWith('/') &&
    (handle.localBucket === undefined || typeof handle.localBucket === 'boolean')
  );
}

function parseBackupDescriptor(raw: string): BackupDescriptor | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BackupDescriptor>;
    return parsed.v === 1 && isBackupHandle(parsed.backupHandle)
      ? { v: 1, backupHandle: parsed.backupHandle }
      : null;
  } catch {
    return null;
  }
}

function backupErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function invalidBackupConfigError(message: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_BACKUP_CONFIG' });
}

function backupRestoreFailure(error: unknown): {
  status: number;
  code: string;
  error: string;
} {
  if (error instanceof SandboxExecDeadlineError) {
    return { status: 504, code: 'TIMEOUT', error: error.message };
  }
  const sdkCode = backupErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  switch (sdkCode) {
    case 'BACKUP_EXPIRED':
    case 'BACKUP_NOT_FOUND':
      return { status: 404, code: 'SNAPSHOT_NOT_FOUND', error: 'Snapshot not found' };
    case 'INVALID_BACKUP_CONFIG':
      return { status: 503, code: 'INVALID_BACKUP_CONFIG', error: message };
    case 'BACKUP_RESTORE_FAILED':
      return { status: 500, code: 'SNAPSHOT_FAILED', error: message };
    default:
      return { status: 500, code: 'SNAPSHOT_FAILED', error: message };
  }
}

/**
 * restoreBackup() is an ephemeral FUSE overlay in production. Restore into a
 * generated staging directory, copy every entry (including .git) into the real
 * workspace, then unmount/remove staging so later container sleep cannot erase
 * the agent's working tree. Local dev extracts into the same staging path and
 * follows the identical copy/cleanup contract.
 */
async function materializeBackupIntoWorkspace(
  sandbox: SandboxStub,
  backupHandle: DirectoryBackup,
): Promise<void> {
  const startedAt = Date.now();
  const stagingDir = `/tmp/push-backup-restore-${crypto.randomUUID()}`;
  const quotedStaging = shellSingleQuote(stagingDir);
  try {
    const prepared = (await withExecDeadline(
      sandbox.exec(`rm -rf -- ${quotedStaging} && mkdir -p -- ${quotedStaging}`),
      BACKUP_OPERATION_TIMEOUT_MS,
    )) as { exitCode?: number; stderr?: string };
    if ((prepared.exitCode ?? 0) !== 0) {
      throw Object.assign(new Error(`Backup staging failed: ${(prepared.stderr ?? '').trim()}`), {
        code: 'BACKUP_RESTORE_FAILED',
      });
    }

    const restored = await withExecDeadline(
      sandbox.restoreBackup({ ...backupHandle, dir: stagingDir }),
      BACKUP_OPERATION_TIMEOUT_MS,
    );
    if (!restored.success) {
      throw Object.assign(new Error('Sandbox backup restore reported failure'), {
        code: 'BACKUP_RESTORE_FAILED',
      });
    }

    const copied = (await withExecDeadline(
      sandbox.exec(`mkdir -p /workspace && cp -a -- ${quotedStaging}/. /workspace/`),
      BACKUP_OPERATION_TIMEOUT_MS,
    )) as { exitCode?: number; stderr?: string };
    if ((copied.exitCode ?? 0) !== 0) {
      throw Object.assign(
        new Error(`Backup materialization failed: ${(copied.stderr ?? '').trim()}`),
        { code: 'BACKUP_RESTORE_FAILED' },
      );
    }
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'cf_backup_materialized',
        backup_id: backupHandle.id,
        duration_ms: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'cf_backup_materialize_failed',
        backup_id: backupHandle.id,
        code: backupErrorCode(error) ?? 'UNKNOWN',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
    const cleanup = (await withExecDeadline(
      sandbox.exec(
        `if mountpoint -q ${quotedStaging}; then ` +
          `/usr/bin/fusermount3 -uz ${quotedStaging} 2>/dev/null || ` +
          `fusermount -uz ${quotedStaging} 2>/dev/null || umount -l ${quotedStaging} 2>/dev/null || true; ` +
          `fi; rm -rf -- ${quotedStaging}`,
      ),
      BACKUP_OPERATION_TIMEOUT_MS,
    ).catch(() => ({ exitCode: 1 }))) as { exitCode?: number; stderr?: string };
    console.log(
      JSON.stringify({
        level: (cleanup.exitCode ?? 0) === 0 ? 'info' : 'warn',
        event:
          (cleanup.exitCode ?? 0) === 0 ? 'cf_backup_stage_cleaned' : 'cf_backup_cleanup_failed',
        backup_id: backupHandle.id,
        ...((cleanup.exitCode ?? 0) === 0 ? {} : { error: (cleanup.stderr ?? '').trim() }),
      }),
    );
  }
}

export type CreateSnapshotResult =
  | { ok: true; snapshotId: string; restoreToken: string; sizeBytes?: number }
  | { ok: false; error: string; status: number; code?: string };

/**
 * Outcome of an in-place cold-start restore into an existing sandbox:
 *  - `restored`: the snapshot was hydrated; `/workspace` holds the recovered tree.
 *  - `absent`:   no snapshot to restore; `/workspace` is left untouched.
 *  - `wiped`:    a restore was attempted and emptied `/workspace` before failing,
 *                so the caller must re-establish a base before continuing.
 */
export type ColdRestoreOutcome = 'restored' | 'absent' | 'wiped';

/**
 * Restore the durable snapshot for `repoFullName`/`branch` into an
 * already-created sandbox (the cold-start counterpart to `restoreWorkspaceSnapshot`,
 * which mints its own sandbox). Current entries carry an SDK `backupHandle`;
 * legacy entries carry the old R2 `imageId`. There is no restore-token check,
 * because this is the worker restoring into its own freshly-created container,
 * not an externally-presented restore. The
 * snapshot's `.git/config` origin is the public URL (it was stripped before the
 * snapshot was ever captured), so no credential travels in the restored tree.
 *
 * Best-effort: every failure is a structured log + a non-throwing outcome so the
 * caller falls back to a normal clone. Returns `wiped` once `/workspace` has been
 * emptied for hydrate, so the caller knows it must re-clone before reusing it.
 */
async function restoreSnapshotIntoSandbox(
  env: Env,
  sandbox: SandboxStub,
  repoFullName: string,
  branch: string,
): Promise<ColdRestoreOutcome> {
  if (!env.SNAPSHOT_INDEX) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'cf_sandbox_cold_restore_miss',
        reason: 'snapshot_index_unavailable',
      }),
    );
    return 'absent';
  }
  let workspaceWiped = false;
  try {
    const entry = await getSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch);
    if (!entry) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'cf_sandbox_cold_restore_miss',
          reason: 'snapshot_index_absent',
        }),
      );
      return 'absent';
    }

    if (entry.backupHandle && !env.BACKUP_BUCKET) {
      throw invalidBackupConfigError('Sandbox backup storage is not configured');
    }
    // Bound the archive before pulling it into the isolate as a JS string,
    // but only for a pre-upgrade base64 object. SDK backups never cross the DO
    // RPC boundary and intentionally have no Push-side size rejection.
    if (entry.imageId && entry.sizeBytes != null && entry.sizeBytes > MAX_SNAPSHOT_BYTES) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_sandbox_cold_restore_failed',
          reason: 'snapshot_too_large',
          sizeBytes: entry.sizeBytes,
        }),
      );
      return 'absent';
    }
    let legacyArchive: string | undefined;
    if (entry.imageId) {
      if (!env.SNAPSHOTS) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'cf_sandbox_cold_restore_failed',
            reason: 'legacy_snapshot_storage_unavailable',
          }),
        );
        return 'absent';
      }
      const object = await env.SNAPSHOTS.get(entry.imageId);
      if (!object) {
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'cf_sandbox_cold_restore_miss',
            reason: 'snapshot_object_absent',
          }),
        );
        return 'absent';
      }
      legacyArchive = await object.text();
    }
    // Clean slate: discard the default-HEAD clone used for the origin probe so it
    // can't blend with the restored tree/.git. If the wipe fails, do NOT hydrate
    // over the surviving clone (that would blend trees / .git into a corrupt
    // workspace) — the default checkout is still intact, so report `absent` and
    // let the caller recreate the branch on it.
    const wipe = (await withExecDeadline(
      sandbox.exec('rm -rf /workspace && mkdir -p /workspace'),
    ).catch(() => ({ exitCode: 1 }))) as { exitCode?: number; stderr?: string };
    if ((wipe.exitCode ?? 0) !== 0) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_sandbox_cold_restore_failed',
          reason: 'workspace_wipe_failed',
          error: (wipe.stderr ?? '').trim(),
        }),
      );
      return 'absent';
    }
    workspaceWiped = true;

    if (entry.backupHandle) {
      await materializeBackupIntoWorkspace(sandbox, entry.backupHandle);
    } else if (entry.imageId && legacyArchive !== undefined) {
      // LEGACY (remove after 2026-08-01): hydrate the old base64 R2 object while
      // pre-upgrade seven-day index entries age out.
      const hydrated = await hydrateBase64IntoSandbox(sandbox, legacyArchive, '/workspace');
      if (!hydrated.ok) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'cf_sandbox_cold_restore_failed',
            reason: 'hydrate_failed',
            error: hydrated.error,
          }),
        );
        return 'wiped';
      }
    } else {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_sandbox_cold_restore_failed',
          reason: 'snapshot_transport_unavailable',
        }),
      );
      return 'wiped';
    }
    // Advisory: reset the snapshot's TTL so an actively-resumed branch survives
    // eviction (mirrors restoreWorkspaceSnapshot's index touch).
    await touchSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch).catch(() => {});
    return 'restored';
  } catch (err) {
    if (backupErrorCode(err) === 'INVALID_BACKUP_CONFIG') {
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'cf_backup_restore_failed',
          code: 'INVALID_BACKUP_CONFIG',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await sandbox.destroy?.().catch(() => {});
      throw err;
    }
    // The throw may be before or after the wipe; report `wiped` (conservative —
    // a redundant re-clone of an intact tree is correct, a skipped one is not).
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'cf_sandbox_cold_restore_failed',
        reason: 'exception',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return workspaceWiped ? 'wiped' : 'absent';
  }
}

/**
 * Outcome of an over-the-clone restore for a branch that IS on origin:
 *  - `restored`: the snapshot was hydrated and verified to contain origin's tip;
 *                `/workspace` now holds the recovered tree (incl. unpushed work).
 *  - `kept`:     nothing was restored and `/workspace` is untouched (the caller's
 *                fresh clone is intact) — no snapshot, too large, or object gone.
 *  - `needs-reclone`: a snapshot was hydrated then rejected (origin diverged) or
 *                failed to extract, so `/workspace` no longer holds the clone and
 *                the caller must re-clone.
 */
type OverCloneRestoreOutcome = 'restored' | 'kept' | 'needs-reclone';

/**
 * Recover unpushed work for an ON-ORIGIN branch by restoring its snapshot over
 * the fresh clone — but only when doing so cannot shadow origin. The caller passes
 * `originTip` (the freshly-cloned HEAD sha); after hydrating the snapshot we verify
 * that commit is reachable from the restored HEAD — `git merge-base --is-ancestor`,
 * i.e. an ancestor of HEAD, not merely present in the object DB (a bare `cat-file
 * -e` can pass while HEAD still hides the commit). If it's an ancestor, the snapshot
 * is origin's tip plus the prior sandbox's unpushed commits/tree, so restoring loses
 * nothing. If it isn't, origin advanced past the snapshot and restoring would
 * silently drop real commits — so we report `needs-reclone` and let the caller
 * restore the fresh clone. Best-effort: every failure degrades to keeping/re-
 * cloning, never to a corrupt tree.
 */
async function restoreUnpushedWorkOverClone(
  env: Env,
  sandbox: SandboxStub,
  repoFullName: string,
  branch: string,
  originTip: string,
): Promise<OverCloneRestoreOutcome> {
  if (!env.SNAPSHOT_INDEX) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'cf_sandbox_cold_restore_miss',
        reason: 'snapshot_index_unavailable',
      }),
    );
    return 'kept';
  }
  let workspaceWiped = false;
  try {
    const entry = await getSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch);
    if (!entry) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'cf_sandbox_cold_restore_miss',
          reason: 'snapshot_index_absent',
        }),
      );
      return 'kept';
    }
    if (entry.backupHandle && !env.BACKUP_BUCKET) {
      throw invalidBackupConfigError('Sandbox backup storage is not configured');
    }
    if (entry.imageId && entry.sizeBytes != null && entry.sizeBytes > MAX_SNAPSHOT_BYTES) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_sandbox_cold_restore_failed',
          reason: 'snapshot_too_large',
          sizeBytes: entry.sizeBytes,
        }),
      );
      return 'kept';
    }
    let legacyArchive: string | undefined;
    if (entry.imageId) {
      if (!env.SNAPSHOTS) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'cf_sandbox_cold_restore_failed',
            reason: 'legacy_snapshot_storage_unavailable',
          }),
        );
        return 'kept';
      }
      const object = await env.SNAPSHOTS.get(entry.imageId);
      if (!object) {
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'cf_sandbox_cold_restore_miss',
            reason: 'snapshot_object_absent',
          }),
        );
        return 'kept';
      }
      legacyArchive = await object.text();
    }
    // Clean slate so the snapshot tree/.git can't blend with the clone. If the
    // wipe fails the clone survives, so keep it rather than hydrate over it.
    const wipe = (await withExecDeadline(
      sandbox.exec('rm -rf /workspace && mkdir -p /workspace'),
    ).catch(() => ({ exitCode: 1 }))) as { exitCode?: number };
    if ((wipe.exitCode ?? 0) !== 0) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_sandbox_cold_restore_failed',
          reason: 'workspace_wipe_failed',
        }),
      );
      return 'kept';
    }
    workspaceWiped = true;
    if (entry.backupHandle) {
      await materializeBackupIntoWorkspace(sandbox, entry.backupHandle);
    } else if (entry.imageId && legacyArchive !== undefined) {
      // LEGACY (remove after 2026-08-01): old base64 R2 transport.
      const hydrated = await hydrateBase64IntoSandbox(sandbox, legacyArchive, '/workspace');
      if (!hydrated.ok) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'cf_sandbox_cold_restore_failed',
            reason: 'hydrate_failed',
            error: hydrated.error,
          }),
        );
        return 'needs-reclone';
      }
    } else {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_sandbox_cold_restore_failed',
          reason: 'snapshot_transport_unavailable',
        }),
      );
      return 'needs-reclone';
    }
    // Guard: origin's current tip must be REACHABLE from the restored HEAD —
    // i.e. an ancestor of it — not merely present in the object database. A
    // snapshot whose sandbox had `git fetch`ed the advanced origin (so the new
    // tip is a loose object) without merging it would pass an existence check
    // (`cat-file -e`) while still hiding that commit; `merge-base --is-ancestor`
    // tests history membership. Non-zero (not an ancestor, or unresolvable on a
    // shallow graft) ⇒ treat as diverged and keep the fresh clone.
    const reachable = (await withExecDeadline(
      sandbox.exec(
        `git -C /workspace merge-base --is-ancestor ${shellSingleQuote(originTip)} HEAD 2>/dev/null`,
      ),
    )) as { exitCode?: number };
    if ((reachable.exitCode ?? 1) !== 0) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'cf_sandbox_cold_restore_diverged',
          reason: 'origin_advanced_past_snapshot',
        }),
      );
      return 'needs-reclone';
    }
    await touchSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch).catch(() => {});
    return 'restored';
  } catch (err) {
    if (backupErrorCode(err) === 'INVALID_BACKUP_CONFIG') {
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'cf_backup_restore_failed',
          code: 'INVALID_BACKUP_CONFIG',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      await sandbox.destroy?.().catch(() => {});
      throw err;
    }
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'cf_sandbox_cold_restore_failed',
        reason: 'exception',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return workspaceWiped ? 'needs-reclone' : 'kept';
  }
}

/**
 * Ask the Sandbox SDK to archive /workspace directly to R2, record its
 * serializable handle in the repo/branch index, and write a tiny authenticated
 * descriptor for wire-compatible direct restores. Does NOT terminate the
 * container, so it serves both hibernate and mid-run checkpoints.
 */
export async function createWorkspaceSnapshot(
  env: Env,
  args: { sandboxId: string; repoFullName?: string; branch?: string },
): Promise<CreateSnapshotResult> {
  const { sandboxId, repoFullName, branch } = args;
  const backupName = repoFullName && branch ? `${repoFullName}#${branch}` : `sandbox#${sandboxId}`;
  if (!env.SNAPSHOTS || !env.BACKUP_BUCKET || !env.Sandbox) {
    const error = !env.Sandbox
      ? 'Cloudflare Sandbox is not configured'
      : 'Sandbox backup storage is not configured';
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'cf_backup_failed',
        name: backupName,
        code: 'INVALID_BACKUP_CONFIG',
        error,
      }),
    );
    return { ok: false, error, status: 503, code: 'INVALID_BACKUP_CONFIG' };
  }
  const sandbox = sandboxFor(env, sandboxId);
  const startedAt = Date.now();

  try {
    // 0.12.3 names this option `gitignore` (not the earlier-docs
    // `useGitignore`). The handle is a plain structured-clone value.
    const backupHandle = await withExecDeadline(
      sandbox.createBackup({
        dir: '/workspace',
        name: backupName,
        ttl: BACKUP_TTL_SECONDS,
        gitignore: true,
        ...(env.SANDBOX_BACKUP_LOCAL_BUCKET === '1' ? { localBucket: true } : {}),
      }),
      BACKUP_OPERATION_TIMEOUT_MS,
    );
    const snapshotId = backupDescriptorKey(backupHandle.id);
    const restoreToken = crypto.randomUUID();

    // Direct checkpoint restore callers do not carry repo/branch context. Keep
    // this descriptor tiny: workspace bytes remain wholly in the SDK's
    // server-side backup objects, avoiding the old base64/DO-RPC loss class.
    await env.SNAPSHOTS.put(
      snapshotId,
      JSON.stringify({ v: 1, backupHandle } satisfies BackupDescriptor),
      {
        customMetadata: { rt: restoreToken, repo: repoFullName ?? '', branch: branch ?? '' },
        httpMetadata: { contentType: 'application/json' },
      },
    );

    // The index keeps one entry per repo/branch, so a new snapshot supersedes
    // the prior descriptor. SDK archives themselves expire by TTL/lifecycle.
    let priorDescriptorId: string | undefined;
    let priorLegacyImageId: string | undefined;
    if (env.SNAPSHOT_INDEX && repoFullName && branch) {
      const prior = await getSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch).catch(() => null);
      priorDescriptorId = prior?.backupHandle
        ? backupDescriptorKey(prior.backupHandle.id)
        : undefined;
      priorLegacyImageId = prior?.imageId;
    }

    // Advisory repo/branch index. The direct descriptor remains the auth
    // boundary and lets context-free detached checkpoints restore too.
    let indexUpdated = false;
    if (env.SNAPSHOT_INDEX && repoFullName && branch) {
      try {
        await putSnapshot(env.SNAPSHOT_INDEX, {
          repoFullName,
          branch,
          backupHandle,
          restoreToken,
        });
        indexUpdated = true;
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'cf_backup_indexed',
            name: backupName,
            backup_id: backupHandle.id,
          }),
        );
      } catch (error) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'cf_backup_index_failed',
            name: backupName,
            backup_id: backupHandle.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    } else {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'cf_backup_index_skipped',
          name: backupName,
          reason: env.SNAPSHOT_INDEX ? 'missing_repo_context' : 'index_unavailable',
        }),
      );
    }

    if (indexUpdated) {
      if (priorDescriptorId && priorDescriptorId !== snapshotId) {
        await env.SNAPSHOTS.delete(priorDescriptorId).catch(() => {});
      }
      // LEGACY (remove after 2026-08-01): reclaim a superseded base64 object.
      if (priorLegacyImageId?.startsWith(SNAPSHOT_KEY_PREFIX)) {
        await env.SNAPSHOTS.delete(priorLegacyImageId).catch(() => {});
      }
    }

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'cf_backup_captured',
        name: backupName,
        backup_id: backupHandle.id,
        duration_ms: Date.now() - startedAt,
      }),
    );
    return { ok: true, snapshotId, restoreToken };
  } catch (err) {
    const sdkCode = backupErrorCode(err);
    const code =
      err instanceof SandboxExecDeadlineError
        ? 'TIMEOUT'
        : sdkCode === 'INVALID_BACKUP_CONFIG'
          ? 'INVALID_BACKUP_CONFIG'
          : 'SNAPSHOT_FAILED';
    const status = code === 'TIMEOUT' ? 504 : code === 'INVALID_BACKUP_CONFIG' ? 503 : 500;
    const error = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'cf_backup_failed',
        name: backupName,
        code,
        sdk_code: sdkCode ?? 'UNKNOWN',
        duration_ms: Date.now() - startedAt,
        error,
      }),
    );
    return { ok: false, error, status, code };
  }
}

async function routeHibernate(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const repoFullName = str(body.repo_full_name);
  const branch = str(body.branch);
  // keep_warm: take the durability snapshot but DON'T free the container. Used
  // by the idle reaper so a foregrounded-but-idle session keeps its sandbox
  // (the snapshot is a safety net for an eventual real CF reclaim), turning
  // "the sandbox vanished while I was sitting there" into a no-op. The
  // terminate was a multi-tenant cost guard; it doesn't apply to this
  // single-user deployment.
  const keepWarm = body.keep_warm === true;

  const snap = await createWorkspaceSnapshot(env, { sandboxId, repoFullName, branch });
  if (!snap.ok) {
    return Response.json(
      {
        ok: false,
        error: snap.error,
        code:
          snap.code ??
          (snap.status === 503
            ? 'CF_NOT_CONFIGURED'
            : snap.status === 413
              ? 'SNAPSHOT_TOO_LARGE'
              : 'CF_ERROR'),
      },
      { status: snap.status },
    );
  }

  // Free the container now that its state is durable — mirrors Modal's
  // snapshot-and-terminate. Best-effort; the snapshot is already safe in R2.
  // Skipped under keep_warm: the snapshot stands as the safety net while the
  // live container + its owner token survive for warm re-attach.
  if (!keepWarm) {
    const sandbox = sandboxFor(env, sandboxId);
    await sandbox.destroy?.().catch(() => {});
    await revokeToken(env.SANDBOX_TOKENS, sandboxId).catch(() => {});
  }

  return Response.json({
    ok: true,
    snapshot_id: snap.snapshotId,
    restore_token: snap.restoreToken,
    size_bytes: snap.sizeBytes,
    kept_warm: keepWarm,
  });
}

export type RestoreSnapshotResult =
  | { ok: true; sandboxId: string; ownerToken: string; environment: Json }
  | { ok: false; error: string; status: number; code: string };

/**
 * Restore a snapshot into a FRESH sandbox: verify the restore token against the
 * descriptor/legacy object's R2 metadata, materialize /workspace, mint a new
 * owner token, and probe.
 * Returns a result (never throws) so both the route and the DO resume path can
 * consume it. Does not delete the snapshot — the caller decides retention.
 */
export async function restoreWorkspaceSnapshot(
  env: Env,
  args: { snapshotId: string; restoreToken: string; repoFullName?: string; branch?: string },
): Promise<RestoreSnapshotResult> {
  if (!env.SNAPSHOTS) {
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'cf_backup_restore_failed',
        code: 'CF_NOT_CONFIGURED',
        reason: 'snapshot_descriptor_storage_unavailable',
      }),
    );
    return {
      ok: false,
      error: 'Snapshot storage (R2) is not configured',
      status: 503,
      code: 'CF_NOT_CONFIGURED',
    };
  }
  if (!env.SANDBOX_TOKENS) {
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'cf_backup_restore_failed',
        code: 'CF_NOT_CONFIGURED',
        reason: 'sandbox_token_store_unavailable',
      }),
    );
    return {
      ok: false,
      error: 'Sandbox token store is not configured',
      status: 503,
      code: 'CF_NOT_CONFIGURED',
    };
  }
  if (!env.Sandbox) {
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'cf_backup_restore_failed',
        code: 'CF_NOT_CONFIGURED',
        reason: 'sandbox_binding_unavailable',
      }),
    );
    return {
      ok: false,
      error: 'Cloudflare Sandbox is not configured',
      status: 503,
      code: 'CF_NOT_CONFIGURED',
    };
  }
  const { snapshotId, restoreToken, repoFullName, branch } = args;

  // Bound the token before any R2 work or constant-time compare — an unbounded
  // restore_token would otherwise force arbitrarily large UTF-8 encode/compare.
  if (restoreToken.length > MAX_TOKEN_BYTES) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'cf_backup_restore_failed',
        snapshot_id: snapshotId,
        code: 'AUTH_FAILURE',
        reason: 'restore_token_too_long',
      }),
    );
    return { ok: false, error: 'Invalid restore token', status: 403, code: 'AUTH_FAILURE' };
  }

  // Track resources created mid-restore so the catch can roll them back instead
  // of orphaning a live sandbox / minted token if a later step throws.
  let createdSandbox: SandboxStub | undefined;
  let createdSandboxId: string | undefined;
  let tokenIssued = false;
  let restoringBackup = false;

  try {
    const object = await env.SNAPSHOTS.get(snapshotId);
    if (!object) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'cf_backup_restore_failed',
          snapshot_id: snapshotId,
          code: 'SNAPSHOT_NOT_FOUND',
          reason: 'descriptor_or_legacy_object_absent',
        }),
      );
      return { ok: false, error: 'Snapshot not found', status: 404, code: 'SNAPSHOT_NOT_FOUND' };
    }
    // Auth: the restore token must match the one stamped on the R2 object at
    // snapshot time. Constant-time compare, same as owner-token verification.
    const expected = object.customMetadata?.rt ?? '';
    if (!expected || !timingSafeEqual(expected, restoreToken)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'cf_backup_restore_failed',
          snapshot_id: snapshotId,
          code: 'AUTH_FAILURE',
          reason: 'restore_token_mismatch',
        }),
      );
      return { ok: false, error: 'Invalid restore token', status: 403, code: 'AUTH_FAILURE' };
    }
    const storedPayload = await object.text();
    const descriptor = snapshotId.startsWith(BACKUP_DESCRIPTOR_PREFIX)
      ? parseBackupDescriptor(storedPayload)
      : null;
    if (snapshotId.startsWith(BACKUP_DESCRIPTOR_PREFIX) && !descriptor) {
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'cf_backup_restore_failed',
          snapshot_id: snapshotId,
          code: 'SNAPSHOT_FAILED',
          reason: 'invalid_backup_descriptor',
        }),
      );
      return {
        ok: false,
        error: 'Snapshot descriptor is invalid',
        status: 500,
        code: 'SNAPSHOT_FAILED',
      };
    }
    if (descriptor && !env.BACKUP_BUCKET) {
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'cf_backup_restore_failed',
          snapshot_id: snapshotId,
          code: 'INVALID_BACKUP_CONFIG',
          reason: 'backup_bucket_unavailable',
        }),
      );
      return {
        ok: false,
        error: 'Sandbox backup storage is not configured',
        status: 503,
        code: 'INVALID_BACKUP_CONFIG',
      };
    }
    restoringBackup = descriptor !== null;

    const sandboxId = crypto.randomUUID();
    const sandbox = sandboxFor(env, sandboxId);
    createdSandbox = sandbox;
    createdSandboxId = sandboxId;

    // The archive carries /workspace including .git, but global git identity
    // (~/.gitconfig) lives outside it — set a default so post-restore commits
    // don't fail with "empty ident". Mirrors routeCreate's git config step.
    await withExecDeadline(
      sandbox.exec(
        "git config --global user.name 'Push User' && git config --global user.email 'sandbox@diff.app'",
      ),
    ).catch(() => {});

    if (descriptor) {
      const wipe = (await withExecDeadline(
        sandbox.exec('rm -rf /workspace && mkdir -p /workspace'),
      )) as { exitCode?: number; stderr?: string };
      if ((wipe.exitCode ?? 0) !== 0) {
        throw Object.assign(new Error(`Workspace wipe failed: ${(wipe.stderr ?? '').trim()}`), {
          code: 'BACKUP_RESTORE_FAILED',
        });
      }
      await materializeBackupIntoWorkspace(sandbox, descriptor.backupHandle);
    } else {
      // LEGACY (remove after 2026-08-01): token-verified base64 R2 archive.
      const hydrated = await hydrateBase64IntoSandbox(sandbox, storedPayload, '/workspace');
      if (!hydrated.ok) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'cf_backup_restore_failed',
            snapshot_id: snapshotId,
            code: 'CF_ERROR',
            reason: 'legacy_hydrate_failed',
            error: hydrated.error,
          }),
        );
        await sandbox.destroy?.().catch(() => {});
        return { ok: false, error: hydrated.error, status: hydrated.status, code: 'CF_ERROR' };
      }
    }

    // Mint a fresh owner token for the new sandbox (the old one died with its
    // container). Fail closed: destroy the sandbox if issuance fails so we don't
    // orphan an unreachable, un-cleanable container.
    let ownerToken: string;
    try {
      ownerToken = await issueToken(env.SANDBOX_TOKENS, sandboxId);
      await sandbox.writeFile(OWNER_TOKEN_PATH, ownerToken);
    } catch (err) {
      if (descriptor) {
        console.log(
          JSON.stringify({
            level: 'error',
            event: 'cf_backup_restore_failed',
            snapshot_id: snapshotId,
            code: 'CF_ERROR',
            reason: 'owner_token_issue_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      await sandbox.destroy?.().catch(() => {});
      await revokeToken(env.SANDBOX_TOKENS, sandboxId).catch(() => {});
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: 500,
        code: 'CF_ERROR',
      };
    }
    tokenIssued = true;

    const environment = await probeEnvironment(sandbox);

    // Advisory: refresh the index access time so the restored snapshot's TTL
    // resets (matches Modal's restore-snapshot index touch).
    if (env.SNAPSHOT_INDEX && repoFullName && branch) {
      await touchSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch).catch(() => {});
    }

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'cf_backup_restored',
        snapshot_id: snapshotId,
        transport: descriptor ? 'sdk_backup' : 'legacy_base64',
        ...(descriptor ? { backup_id: descriptor.backupHandle.id } : {}),
      }),
    );

    return { ok: true, sandboxId, ownerToken, environment };
  } catch (err) {
    // Roll back a half-created sandbox / minted token so a late throw (hydrate,
    // probe, …) doesn't orphan a live, un-cleanable container.
    await createdSandbox?.destroy?.().catch(() => {});
    if (tokenIssued && createdSandboxId) {
      await revokeToken(env.SANDBOX_TOKENS, createdSandboxId).catch(() => {});
    }
    if (restoringBackup) {
      const failure = backupRestoreFailure(err);
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'cf_backup_restore_failed',
          snapshot_id: snapshotId,
          code: failure.code,
          sdk_code: backupErrorCode(err) ?? 'UNKNOWN',
          error: failure.error,
        }),
      );
      return { ok: false, ...failure };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 500,
      code: 'CF_ERROR',
    };
  }
}

async function routeRestoreSnapshot(env: Env, body: Json): Promise<Response> {
  const snapshotId = requireStr(body, 'snapshot_id');
  const restoreToken = requireStr(body, 'restore_token');
  const repoFullName = str(body.repo_full_name);
  const branch = str(body.branch);

  const result = await restoreWorkspaceSnapshot(env, {
    snapshotId,
    restoreToken,
    repoFullName,
    branch,
  });
  if (!result.ok) {
    return Response.json(
      { ok: false, error: result.error, code: result.code },
      { status: result.status },
    );
  }
  return Response.json({
    ok: true,
    sandbox_id: result.sandboxId,
    owner_token: result.ownerToken,
    status: 'ready',
    workspace_revision: 0,
    environment: result.environment,
  });
}

async function routeDeleteSnapshot(env: Env, body: Json): Promise<Response> {
  if (!env.SNAPSHOTS) {
    return Response.json(
      { ok: false, error: 'Snapshot storage (R2) is not configured', code: 'CF_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  const snapshotId = requireStr(body, 'snapshot_id');
  const restoreToken = requireStr(body, 'restore_token');

  // Same DoS guard as restore-snapshot: this route is owner-token-gate-exempt,
  // so bound the token before the metadata lookup + constant-time compare.
  if (restoreToken.length > MAX_TOKEN_BYTES) {
    return Response.json(
      { ok: false, error: 'Invalid restore token', code: 'AUTH_FAILURE' },
      { status: 403 },
    );
  }

  // head() fetches metadata without downloading the archive body.
  const head = await env.SNAPSHOTS.head(snapshotId);
  // Idempotent: a snapshot that's already gone is a successful delete.
  if (!head) return Response.json({ ok: true });

  const expected = head.customMetadata?.rt ?? '';
  if (!expected || !timingSafeEqual(expected, restoreToken)) {
    return Response.json(
      { ok: false, error: 'Invalid restore token', code: 'AUTH_FAILURE' },
      { status: 403 },
    );
  }

  await env.SNAPSHOTS.delete(snapshotId);

  const repoFullName = str(body.repo_full_name);
  const branch = str(body.branch);
  if (env.SNAPSHOT_INDEX && repoFullName && branch) {
    await deleteSnapshot(env.SNAPSHOT_INDEX, repoFullName, branch).catch(() => {});
  }

  return Response.json({ ok: true });
}

async function routeProbe(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const sandbox = sandboxFor(env, sandboxId);
  const environment = await probeEnvironment(sandbox);
  return Response.json(environment);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SandboxStub = ReturnType<typeof getSandbox>;

async function probeEnvironment(sandbox: SandboxStub): Promise<Json> {
  const legacyProbeScript =
    'echo "__node__$(node -v 2>/dev/null || echo "")" && ' +
    'echo "__npm__$(npm -v 2>/dev/null || echo "")" && ' +
    'echo "__python__$(python3 --version 2>/dev/null || echo "")" && ' +
    'echo "__git__$(git --version 2>/dev/null || echo "")" && ' +
    'echo "__rg__$(rg --version 2>/dev/null | head -1 || echo "")" && ' +
    'echo "__jq__$(jq --version 2>/dev/null || echo "")" && ' +
    'echo "__ruff__$(ruff --version 2>/dev/null || echo "")" && ' +
    'echo "__pytest__$(pytest --version 2>/dev/null | head -1 || echo "")" && ' +
    'echo "__df__$(df -h /workspace 2>/dev/null | tail -1 | awk "{print \\$4}")" && ' +
    'ls /workspace 2>/dev/null';
  // Prefer the image-baked doctor contract. Keep the marker fallback so old
  // containers stay probeable during a rolling image update.
  const script =
    'if command -v push-sandbox-doctor >/dev/null 2>&1; then ' +
    `push-sandbox-doctor --json || { ${legacyProbeScript}; }; ` +
    `else ${legacyProbeScript}; fi`;

  const result = (await withExecDeadline(sandbox.exec(script)).catch(() => ({ stdout: '' }))) as {
    stdout?: string;
  };
  const out = result.stdout ?? '';
  const doctorEnvironment = parseDoctorEnvironment(out);
  if (doctorEnvironment) return doctorEnvironment;

  return parseLegacyProbeEnvironment(out);
}

function parseDoctorEnvironment(out: string): Json | null {
  const trimmed = out.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isJsonRecord(parsed)) return null;
  if (!isJsonRecord(parsed.tools)) parsed.tools = {};
  return parsed;
}

function isJsonRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLegacyProbeEnvironment(out: string): Json {
  const tools: Record<string, string> = {};
  const markerCandidates = [
    'package.json',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
  ];
  const lines = out.split('\n');
  let diskFree = '';
  const wsEntries: string[] = [];
  let inWsList = false;

  for (const line of lines) {
    if (line.startsWith('__node__')) tools.node = line.slice(8).trim();
    else if (line.startsWith('__npm__')) tools.npm = line.slice(7).trim();
    else if (line.startsWith('__python__')) tools.python = line.slice(10).trim();
    else if (line.startsWith('__git__')) tools.git = line.slice(7).trim();
    else if (line.startsWith('__rg__')) tools.ripgrep = line.slice(6).trim();
    else if (line.startsWith('__jq__')) tools.jq = line.slice(6).trim();
    else if (line.startsWith('__ruff__')) tools.ruff = line.slice(8).trim();
    else if (line.startsWith('__pytest__')) tools.pytest = line.slice(10).trim();
    else if (line.startsWith('__df__')) {
      diskFree = line.slice(6).trim();
      inWsList = true;
    } else if (inWsList) {
      wsEntries.push(line.trim());
    }
  }

  for (const k of Object.keys(tools)) if (!tools[k]) delete tools[k];

  const projectMarkers = markerCandidates.filter((m) => wsEntries.includes(m));

  return {
    tools,
    project_markers: projectMarkers,
    git_available: !!tools.git,
    disk_free: diskFree,
    writable_root: '/workspace',
  };
}

async function hashSha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

// Largest cut length ≤ cap that does not split a UTF-16 surrogate pair. Cutting
// between a high and low surrogate emits a lone surrogate, which corrupts the
// resumed cursor stream and can break JSON rendering. Cursors are character
// (UTF-16 code unit) offsets, so backing off by one keeps them consistent.
function safeCutLength(s: string, cap: number): number {
  if (s.length <= cap) return s.length;
  const c = s.charCodeAt(cap - 1);
  return c >= 0xd800 && c <= 0xdbff ? cap - 1 : cap;
}

async function verifySandboxOwnerToken(
  env: Env,
  sandboxId: string,
  providedToken: string,
): Promise<VerifyResult> {
  if (!sandboxId || !providedToken || providedToken.length > MAX_TOKEN_BYTES) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }

  const sandbox = sandboxFor(env, sandboxId);
  const tokenRead = (await withExecDeadline(
    sandbox.exec(`head -c ${MAX_TOKEN_BYTES + 1} ${shellSingleQuote(OWNER_TOKEN_PATH)}`),
  ).catch((err) => ({ __error: err }))) as
    | { stdout?: string; stderr?: string; exitCode?: number }
    | { __error: unknown };
  if ('__error' in tokenRead) {
    if (isMissingSessionCode(classifyCfError(tokenRead.__error))) {
      return rehydrateOrNotFound(env, sandbox, sandboxId, providedToken);
    }
    throw tokenRead.__error;
  }
  if ((tokenRead.exitCode ?? 0) !== 0) {
    const stderr = typeof tokenRead.stderr === 'string' ? tokenRead.stderr : '';
    if (isMissingSessionCode(classifyCfError(stderr))) {
      return rehydrateOrNotFound(env, sandbox, sandboxId, providedToken);
    }
    throw new Error(stderr || 'Failed to read sandbox owner token');
  }

  const storedToken = typeof tokenRead.stdout === 'string' ? tokenRead.stdout : '';
  if (!storedToken) {
    return rehydrateOrNotFound(env, sandbox, sandboxId, providedToken);
  }
  if (storedToken.length > MAX_TOKEN_BYTES) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }
  if (!timingSafeEqual(storedToken, providedToken)) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }
  return { ok: true };
}

/**
 * The in-container owner-token file (`/tmp/push-owner-token`) is gone but the
 * caller still presented a token. Attempt to re-establish the session against
 * the KV-stored token (the durable source of truth) before declaring the
 * sandbox lost. Returns `{ ok: true }` only when the session was rehydrated;
 * otherwise the original NOT_FOUND so the caller's recovery path runs.
 */
async function rehydrateOrNotFound(
  env: Env,
  sandbox: ReturnType<typeof sandboxFor>,
  sandboxId: string,
  providedToken: string,
): Promise<VerifyResult> {
  if (await tryRehydrateOwnerToken(env, sandbox, sandboxId, providedToken)) {
    return { ok: true };
  }
  return { ok: false, status: 404, code: 'NOT_FOUND' };
}

/**
 * A container can lose its ephemeral owner-token file (`/tmp` is wiped on any
 * container restart) while the Durable Object — and, crucially, the cloned
 * `/workspace` — survive. The missing file then reads as "Sandbox not found
 * or expired", which the client classifies as a fatal loss and retires the
 * live session over (`isDefinitivelyGoneMessage`), discarding uncommitted
 * work the container still holds.
 *
 * When the KV-stored token still matches the caller's, the caller IS the
 * owner: re-mint the token file onto the container so the session continues —
 * but ONLY when `/workspace` is actually intact. If the workspace is gone too
 * (a full recycle wipes `/tmp` AND `/workspace`), re-minting would hand back a
 * live-but-empty container reporting a healthy status — a silent work loss
 * worse than the visible death. In that case we decline and let the caller
 * fall through to NOT_FOUND, which routes into the snapshot-restore recovery
 * path (cold-start + R2 keep-warm restore).
 *
 * Security: re-mint is gated on a timing-safe match against the KV token, so a
 * caller without the real token cannot trigger it; the token is only written
 * server-side onto the container, never returned to the client.
 */
async function tryRehydrateOwnerToken(
  env: Env,
  sandbox: ReturnType<typeof sandboxFor>,
  sandboxId: string,
  providedToken: string,
): Promise<boolean> {
  const kvToken = await readOwnerToken(env.SANDBOX_TOKENS, sandboxId).catch(() => null);
  if (!kvToken || !timingSafeEqual(kvToken, providedToken)) {
    // No durable record, or the caller isn't the owner — not our case to heal.
    return false;
  }

  // Workspace-liveness gate: only re-mint when the clone survived. A recycled
  // container has neither `/tmp` nor `/workspace`; `.git` proves the repo is
  // still present and uncommitted work is recoverable in place.
  let workspaceIntact: boolean;
  try {
    const probe = (await withExecDeadline(
      sandbox.exec('test -e /workspace/.git && printf alive'),
    )) as { stdout?: string; exitCode?: number };
    workspaceIntact = (probe.exitCode ?? 1) === 0 && (probe.stdout ?? '').includes('alive');
  } catch (err) {
    wlog('warn', 'cf_sandbox_token_rehydrate_probe_failed', {
      sandbox_id: sandboxId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!workspaceIntact) {
    wlog('info', 'cf_sandbox_token_rehydrate_declined_no_workspace', { sandbox_id: sandboxId });
    return false;
  }

  try {
    await sandbox.writeFile(OWNER_TOKEN_PATH, kvToken);
  } catch (err) {
    wlog('warn', 'cf_sandbox_token_rehydrate_write_failed', {
      sandbox_id: sandboxId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  wlog('info', 'cf_sandbox_token_rehydrated', { sandbox_id: sandboxId });
  return true;
}

// Shell-safe quoting for arguments interpolated into `sandbox.exec` commands.
//
// JSON.stringify produces a double-quoted string, but double quotes in POSIX
// shells still evaluate $VAR, backticks, and $(...) — so a filename like
// `$(whoami)` would cause command substitution. We wrap in SINGLE quotes
// (which suppress ALL expansion) and escape any embedded single quotes via
// the `'\''` trick: close quote, escaped single quote, reopen quote.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Best-effort MIME guess for raw single-file downloads. The client only uses
// this for the Blob type and falls back to application/octet-stream, so an
// unknown extension is harmless — common text/code/image types are mapped so a
// downloaded file lands with a sensible type.
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp4: 'video/mp4',
};

function guessContentType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return 'application/octet-stream';
  const ext = filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

// Fallback decoded size when an authoritative `stat` size isn't available —
// base64 expands 3 bytes to 4 chars. Only feeds a display string.
function decodedBase64Size(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

function classifyCfError(err: unknown): string {
  const structuredCode = backupErrorCode(err);
  if (structuredCode) return structuredCode;
  const msg = err instanceof Error ? err.message : String(err);
  // Disk-full before the broader buckets: the recovery is "delete files",
  // not "restart the sandbox" (which loses uncommitted work), so folding it
  // into CONTAINER_ERROR sends users to exactly the wrong remediation.
  if (/no space left|enospc|disk quota exceeded/i.test(msg)) return 'DISK_FULL';
  if (/timeout/i.test(msg)) return 'TIMEOUT';
  // A file/directory missing *inside a live sandbox* (listFiles/readFile on a
  // bad path) is a benign, recoverable tool result — NOT a gone sandbox. Match
  // the file-op signatures explicitly and BEFORE the broad not-found arm below,
  // so a genuinely-gone container ("container not found", session lookups)
  // still falls through to NOT_FOUND/CONTAINER_ERROR. Without this split, the
  // broad `not found` regex folded "Directory not found: /workspace/src" into
  // the sandbox-gone bucket; the client then rewrote it to "Sandbox not found
  // or expired", which `isDefinitivelyGoneMessage` matched and treated as a
  // fatal sandbox loss — killing the whole turn over a missing directory.
  if (
    /FileNotFoundError|file not found|directory not found|no such file or directory|not a directory|ENOENT/i.test(
      msg,
    )
  ) {
    return 'FILE_NOT_FOUND';
  }
  if (/not found|no such/i.test(msg)) return 'NOT_FOUND';
  if (/container|crashed|unhealthy|unreachable/i.test(msg)) return 'CONTAINER_ERROR';
  return 'CF_ERROR';
}

/** A missing owner-token file means the sandbox has no valid session — the
 *  client should recreate (404 NOT_FOUND), NOT see a config error. Accept the
 *  file-op `FILE_NOT_FOUND` too: the `ENOENT`/"no such file" on
 *  `/tmp/push-owner-token` now classifies as FILE_NOT_FOUND (after the
 *  file-not-found split), but for the auth probe it's still a gone session.
 *  (Review: Codex P2 on PR #923.) */
function isMissingSessionCode(code: string): boolean {
  return code === 'NOT_FOUND' || code === 'FILE_NOT_FOUND';
}

function authErrorMessage(code: 'NOT_FOUND' | 'AUTH_FAILURE' | 'NOT_CONFIGURED'): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'Sandbox not found or expired';
    case 'AUTH_FAILURE':
      return 'Owner token does not match';
    case 'NOT_CONFIGURED':
      return 'SANDBOX_TOKENS KV binding not configured';
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function requireStr(body: Json, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing required field: ${key}`);
  }
  return v;
}
