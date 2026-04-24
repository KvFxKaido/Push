/**
 * HTTP handler for /api/sandbox-cf/* — Cloudflare Sandbox SDK backend.
 *
 * Provides the Cloudflare counterpart to /api/sandbox/* (Modal). Request and
 * response shapes match Modal's snake_case wire format (sandbox_id,
 * owner_token, github_identity, workspace_revision, exit_code, ...) so the
 * Worker-side provider toggle can switch backends without any client change.
 *
 * Architecture:
 *   browser/CLI → Worker (this handler) → getSandbox(env.Sandbox, id) → DO → container
 *
 * Known MVP gaps (tracked as follow-up PRs):
 *   - No filesystem snapshots (hibernate/restore-snapshot return 501).
 *     Follow-up will back these with R2 tar.gz archives.
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
  revokeToken,
  timingSafeEqual,
  verifyToken,
  type VerifyResult,
} from './sandbox-token-store';

const ROUTES = new Set([
  'create',
  'connect',
  'cleanup',
  'exec',
  'read',
  'write',
  'batch-write',
  'delete',
  'list',
  'diff',
  'download',
  'restore',
  'probe',
  'hibernate',
  'restore-snapshot',
]);

const MAX_READ_BYTES = 5_000_000;
const OWNER_TOKEN_PATH = '/tmp/push-owner-token';

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

export class SandboxExecDeadlineError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`sandbox exec exceeded ${timeoutMs}ms deadline`);
    this.name = 'SandboxExecDeadlineError';
    this.timeoutMs = timeoutMs;
  }
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
    route === 'restore' || route === 'batch-write'
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

  // Owner-token gate — every route except `create` must present a valid
  // token matching the one issued at sandbox creation time. `create` is
  // the only exemption (that's where tokens are minted). Snapshot stubs
  // stay gated too so real implementations inherit auth for free.
  // The primary verifier reads the token from the sandbox itself. That
  // avoids false "expired" sessions caused by Workers KV propagation lag
  // when a request lands in a different PoP than the one that created the
  // sandbox. `cleanup` keeps a KV fallback so a dead sandbox can still be
  // torn down if the token file is no longer reachable.
  if (route !== 'create') {
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
        wlog('error', 'cf_sandbox_auth_throw', {
          requestId,
          route,
          message: err instanceof Error ? err.message : String(err),
        });
        return Response.json(
          { error: 'Auth check failed', code: 'NOT_CONFIGURED' },
          { status: 503 },
        );
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
      case 'exec':
        return await routeExec(env, body);
      case 'read':
        return await routeRead(env, body);
      case 'write':
        return await routeWrite(env, body);
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
      case 'restore-snapshot':
        return Response.json(
          {
            error: 'Snapshots not supported on the Cloudflare provider yet',
            code: 'SNAPSHOT_NOT_SUPPORTED',
          },
          { status: 501 },
        );
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
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        code: isDeadline ? 'TIMEOUT' : classifyCfError(err),
      },
      // 504 for deadline so callers can distinguish "we stopped waiting"
      // from "backend crashed". callSandboxHandler already treats any
      // status >= 500 as retryable, so the kernel surfaces retry-friendly
      // structured errors for both cases.
      { status: isDeadline ? 504 : 500 },
    );
  }
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
  const githubToken = str(body.github_token);
  const githubIdentity = body.github_identity as { name?: string; email?: string } | undefined;
  const seedFiles = (body.seed_files as Array<{ path: string; content: string }> | undefined) ?? [];
  const ownerHint = str(body.owner_hint);

  const sandboxId = crypto.randomUUID();
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  if (githubIdentity?.name && githubIdentity?.email) {
    // Single-quote via shellSingleQuote, not JSON.stringify. Double quotes
    // still evaluate $VAR, backticks, and $(...), so a crafted identity
    // could trigger command substitution during `git config`. Same
    // discipline as routeRead's path interpolation.
    await withExecDeadline(
      sandbox.exec(
        `git config --global user.name ${shellSingleQuote(githubIdentity.name)} && ` +
          `git config --global user.email ${shellSingleQuote(githubIdentity.email)}`,
      ),
    );
  }

  if (repo && repo.length > 0) {
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${repo}.git`
      : `https://github.com/${repo}.git`;
    await sandbox.gitCheckout(cloneUrl, { branch, targetDir: '/workspace' });

    // Pre-populate /workspace/{,app/}node_modules from the image-baked
    // cache via hardlink copy. Dockerfile.sandbox stages root and app
    // deps at /opt/push-cache/{,app}/node_modules during build; `cp -al`
    // creates new directory entries that share inodes with the cache,
    // so a fresh sandbox gets instant access to deps without paying the
    // ~100s cold `npm install` wall-clock — the heavy FS write that was
    // the primary trigger for the stalls patched by #374/#375.
    //
    // Write-isolated by construction: a later `rm -rf node_modules` or
    // `npm install <pkg>` in the sandbox writes to new inodes on the
    // workspace side; the baked cache's inodes are untouched, so
    // concurrent sandboxes never stomp each other.
    //
    // Gated on a byte-exact lockfile match (`cmp -s`) between the baked
    // cache and the cloned repo. Any mismatch — different project, or
    // Push itself on a branch whose deps have shifted from the image —
    // falls through and lets downstream flows run `npm install` against
    // the correct lockfile. Critical because `handleCheckTypes` in
    // `sandbox-verification-handlers.ts` uses `node_modules` existence
    // as its "install already ran" signal; populating with mismatched
    // deps would silently regress typecheck results.
    //
    // Wrapped in `timeout 30` because wrangler's local container runtime
    // has been observed to silently wedge `cp -al` across overlay layers
    // (prod CF infra is unaffected). Without the bound, the copy would
    // burn the full 150s/300s `withExecDeadline` budget and 504 the whole
    // create. On timeout (shell exit 124), the `|| { ... }` branch cleans
    // up any partial node_modules directory so the cold `npm install`
    // that runs downstream (e.g. typecheck verification) sees a clean
    // slate and not a half-populated tree. Final `true` keeps the overall
    // exit status 0 — the cache is an optimization, never a correctness
    // dependency.
    await withExecDeadline(
      sandbox.exec(
        "timeout 30 bash -c '" +
          'src=/opt/push-cache; ' +
          'if [ -f "$src/package-lock.json" ] && ' +
          'cmp -s "$src/package-lock.json" /workspace/package-lock.json 2>/dev/null && ' +
          '[ -d "$src/node_modules" ] && [ ! -e /workspace/node_modules ]; then ' +
          'cp -al "$src/node_modules" /workspace/node_modules; fi; ' +
          'if [ -f "$src/app/package-lock.json" ] && [ -d /workspace/app ] && ' +
          'cmp -s "$src/app/package-lock.json" /workspace/app/package-lock.json 2>/dev/null && ' +
          '[ -d "$src/app/node_modules" ] && [ ! -e /workspace/app/node_modules ]; then ' +
          'cp -al "$src/app/node_modules" /workspace/app/node_modules; fi' +
          "' || { rm -rf /workspace/node_modules /workspace/app/node_modules 2>/dev/null; true; }",
      ),
    );
  }

  for (const seed of seedFiles) {
    await sandbox.writeFile(seed.path, seed.content);
  }

  const environment = await probeEnvironment(sandbox);

  // Mint the owner token AFTER all setup has succeeded. If provisioning
  // fails before this point the sandbox dies without ever being reachable,
  // so there's no partial-state to clean up. If token issuance ITSELF
  // fails (transient KV failure), destroy the sandbox before returning
  // an error — otherwise we'd orphan a live, un-verifiable, unreachable
  // container that can't even be cleaned up via API (the cleanup route
  // now requires a token we never stored).
  let ownerToken: string;
  try {
    ownerToken = await issueToken(env.SANDBOX_TOKENS, sandboxId, ownerHint);
    await sandbox.writeFile(OWNER_TOKEN_PATH, ownerToken);
  } catch (err) {
    await sandbox.destroy?.().catch(() => {});
    await revokeToken(env.SANDBOX_TOKENS, sandboxId).catch(() => {});
    throw err;
  }

  return Response.json({
    sandbox_id: sandboxId,
    owner_token: ownerToken,
    status: 'ready',
    workspace_revision: 0,
    environment,
  });
}

async function routeConnect(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  // Liveness check: run a trivial exec and propagate failures. probeEnvironment
  // swallows exec errors (returning an empty payload) so we can't rely on it
  // to signal a dead sandbox — do the probe explicitly here and surface 404
  // when it fails so callers fall back to create/restore.
  const liveness = (await withExecDeadline(sandbox.exec('true')).catch((err) => ({
    __error: err,
  }))) as { exitCode?: number } | { __error: unknown };
  if ('__error' in liveness || (liveness as { exitCode?: number }).exitCode !== 0) {
    return Response.json({ error: 'Sandbox is not reachable', code: 'NOT_FOUND' }, { status: 404 });
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
  const sandbox = getSandbox(env.Sandbox!, sandboxId);
  // Sandbox SDK's `destroy()` tears down the container + DO state. Optional
  // chain keeps this idempotent if the instance is already gone.
  await sandbox.destroy?.();
  // Revoke the owner token after destroy succeeds. Order matters: if
  // destroy throws, we keep the token so the caller can retry without
  // losing auth. KV's TTL still cleans up eventually.
  await revokeToken(env.SANDBOX_TOKENS, sandboxId);
  return Response.json({ ok: true });
}

async function routeExec(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const command = requireStr(body, 'command');
  const workdir = str(body.workdir);

  const sandbox = getSandbox(env.Sandbox!, sandboxId);
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
  const result = await withExecDeadline(
    sandbox.exec(wrappedCommand, workdir ? { cwd: workdir } : undefined),
  );

  const stdout = (result as { stdout?: string }).stdout ?? '';
  const stderr = (result as { stderr?: string }).stderr ?? '';
  const exitCode = (result as { exitCode?: number }).exitCode ?? 0;

  return Response.json({
    stdout: truncate(stdout, 500_000),
    stderr: truncate(stderr, 100_000),
    exit_code: exitCode,
    truncated: stdout.length > 500_000 || stderr.length > 100_000,
    workspace_revision: 0,
  });
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

  const sandbox = getSandbox(env.Sandbox!, sandboxId);
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

  const sandbox = getSandbox(env.Sandbox!, sandboxId);

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

async function routeBatchWrite(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const files = body.files as Array<{
    path: string;
    content: string;
    expected_version?: string;
  }>;

  const sandbox = getSandbox(env.Sandbox!, sandboxId);
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
  const sandbox = getSandbox(env.Sandbox!, sandboxId);
  await sandbox.deleteFile(path);
  return Response.json({ workspace_revision: 0 });
}

async function routeList(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const path = requireStr(body, 'path');
  const sandbox = getSandbox(env.Sandbox!, sandboxId);
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
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

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
  return Response.json({
    diff: diff.length > MAX ? `${diff.slice(0, MAX)}\n…[truncated]` : diff,
    truncated: diff.length > MAX,
    git_status: statusRes.stdout ?? '',
  });
}

async function routeDownload(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const path = (str(body.path) ?? '/workspace').replace(/\/+$/g, '') || '/workspace';
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  // Produce a base64 tar.gz on stdout via the container.
  const tarResult = (await withExecDeadline(
    sandbox.exec(`tar -czf - -C ${JSON.stringify(path)} . | base64 -w0`),
  )) as { stdout?: string };

  const archive = tarResult.stdout?.trim() ?? '';
  // Approximate decoded size — base64 expands 4:3.
  const size = Math.floor((archive.length * 3) / 4);
  return Response.json({ archive, size });
}

async function routeHydrate(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const archive = requireStr(body, 'archive');
  const path = (str(body.path) ?? '/workspace').replace(/\/+$/g, '') || '/workspace';
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  // Write the base64 archive to a tmp file via the SDK instead of passing it
  // through the shell command line. ARG_MAX on Linux is typically ~2 MB, and
  // RESTORE_MAX_BODY_SIZE_BYTES allows up to 12 MB — inline piping would fail
  // well before the body limit is exercised.
  const tmpB64 = `/tmp/push-restore-${crypto.randomUUID()}.b64`;
  const tmpTar = `${tmpB64}.tar.gz`;
  await sandbox.writeFile(tmpB64, archive);

  const mkdir = (await withExecDeadline(sandbox.exec(`mkdir -p ${JSON.stringify(path)}`))) as {
    exitCode?: number;
    stderr?: string;
  };
  if ((mkdir.exitCode ?? 0) !== 0) {
    return Response.json(
      {
        error: `Failed to create target directory: ${mkdir.stderr ?? ''}`.trim(),
        code: 'CF_ERROR',
      },
      { status: 500 },
    );
  }

  const decode = (await withExecDeadline(sandbox.exec(`base64 -d ${tmpB64} > ${tmpTar}`))) as {
    exitCode?: number;
    stderr?: string;
  };
  if ((decode.exitCode ?? 0) !== 0) {
    await withExecDeadline(sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`)).catch(() => {});
    return Response.json(
      { error: `Failed to decode archive: ${decode.stderr ?? ''}`.trim(), code: 'CF_ERROR' },
      { status: 400 },
    );
  }

  // Defense in depth against path traversal: list archive members first and
  // refuse if any entry is absolute or contains "..". Even with internal
  // traffic we trust, this keeps a bad producer from escaping the target
  // directory during hydrate.
  const list = (await withExecDeadline(sandbox.exec(`tar -tzf ${tmpTar}`))) as {
    stdout?: string;
    exitCode?: number;
    stderr?: string;
  };
  if ((list.exitCode ?? 0) !== 0) {
    await withExecDeadline(sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`)).catch(() => {});
    return Response.json(
      { error: `Invalid archive: ${list.stderr ?? ''}`.trim(), code: 'CF_ERROR' },
      { status: 400 },
    );
  }
  const members = (list.stdout ?? '').split('\n').filter(Boolean);
  const unsafe = members.find((m) => m.startsWith('/') || m.split('/').some((seg) => seg === '..'));
  if (unsafe) {
    await withExecDeadline(sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`)).catch(() => {});
    return Response.json(
      { error: `Archive member rejected (path traversal): ${unsafe}`, code: 'CF_ERROR' },
      { status: 400 },
    );
  }

  const extract = (await withExecDeadline(
    sandbox.exec(`tar -xzf ${tmpTar} -C ${JSON.stringify(path)} --no-same-owner`),
  )) as { exitCode?: number; stderr?: string };
  await withExecDeadline(sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`)).catch(() => {});

  if ((extract.exitCode ?? 0) !== 0) {
    return Response.json(
      {
        error: `Archive extraction failed: ${extract.stderr ?? ''}`.trim(),
        code: 'CF_ERROR',
      },
      { status: 500 },
    );
  }

  return Response.json({ ok: true });
}

async function routeProbe(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandbox_id');
  const sandbox = getSandbox(env.Sandbox!, sandboxId);
  const environment = await probeEnvironment(sandbox);
  return Response.json(environment);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SandboxStub = ReturnType<typeof getSandbox>;

async function probeEnvironment(sandbox: SandboxStub): Promise<Json> {
  // Single exec dumps versions for the tools we care about. Missing tools
  // surface as empty strings; we parse and filter below.
  const script =
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

  const result = (await withExecDeadline(sandbox.exec(script)).catch(() => ({ stdout: '' }))) as {
    stdout?: string;
  };
  const out = result.stdout ?? '';
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

async function verifySandboxOwnerToken(
  env: Env,
  sandboxId: string,
  providedToken: string,
): Promise<VerifyResult> {
  if (!sandboxId || !providedToken || providedToken.length > MAX_TOKEN_BYTES) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }

  const sandbox = getSandbox(env.Sandbox!, sandboxId);
  const tokenRead = (await withExecDeadline(
    sandbox.exec(`head -c ${MAX_TOKEN_BYTES + 1} ${shellSingleQuote(OWNER_TOKEN_PATH)}`),
  ).catch((err) => ({ __error: err }))) as
    | { stdout?: string; stderr?: string; exitCode?: number }
    | { __error: unknown };
  if ('__error' in tokenRead) {
    if (classifyCfError(tokenRead.__error) === 'NOT_FOUND') {
      return { ok: false, status: 404, code: 'NOT_FOUND' };
    }
    throw tokenRead.__error;
  }
  if ((tokenRead.exitCode ?? 0) !== 0) {
    const stderr = typeof tokenRead.stderr === 'string' ? tokenRead.stderr : '';
    if (classifyCfError(stderr) === 'NOT_FOUND') {
      return { ok: false, status: 404, code: 'NOT_FOUND' };
    }
    throw new Error(stderr || 'Failed to read sandbox owner token');
  }

  const storedToken = typeof tokenRead.stdout === 'string' ? tokenRead.stdout : '';
  if (!storedToken) {
    return { ok: false, status: 404, code: 'NOT_FOUND' };
  }
  if (storedToken.length > MAX_TOKEN_BYTES) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }
  if (!timingSafeEqual(storedToken, providedToken)) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }
  return { ok: true };
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

function classifyCfError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(msg)) return 'TIMEOUT';
  if (/not found|no such/i.test(msg)) return 'NOT_FOUND';
  if (/container|crashed|unhealthy/i.test(msg)) return 'CONTAINER_ERROR';
  return 'CF_ERROR';
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
