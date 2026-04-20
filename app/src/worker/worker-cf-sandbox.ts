/**
 * HTTP handler for /api/sandbox-cf/* — Cloudflare Sandbox SDK backend.
 *
 * Provides the Cloudflare counterpart to /api/sandbox/* (Modal). Route
 * coverage and high-level behaviour are intended to match, but the request /
 * response shapes are not guaranteed byte-identical — each provider's
 * client-side adapter owns its own wire format (camelCase here vs
 * Modal's snake_case in a few places).
 *
 * Architecture:
 *   browser/CLI → Worker (this handler) → getSandbox(env.Sandbox, id) → DO → container
 *
 * Known MVP gaps (tracked as follow-up PRs):
 *   - No filesystem snapshots (hibernate/restore-snapshot return 501).
 *     Follow-up will back these with R2 tar.gz archives.
 *   - workspaceRevision and file version (SHA) are best-effort — the SDK
 *     doesn't expose monotonic revisions the way Modal's app.py does.
 *
 * Auth: every route except `create` requires an ownerToken matching the
 * one issued at sandbox creation time. See `sandbox-token-store.ts`.
 * Fails closed when SANDBOX_TOKENS KV binding is missing.
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
import { issueToken, revokeToken, verifyToken } from './sandbox-token-store';

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
  // Fails closed on every failure mode: missing binding, missing input,
  // missing record, mismatch, or unexpected runtime throw.
  if (route !== 'create') {
    const sandboxId = typeof body.sandboxId === 'string' ? body.sandboxId : '';
    const providedToken = typeof body.ownerToken === 'string' ? body.ownerToken : '';
    let auth;
    try {
      auth = await verifyToken(env.SANDBOX_TOKENS, sandboxId, providedToken);
    } catch (err) {
      wlog('error', 'cf_sandbox_auth_throw', {
        requestId,
        route,
        message: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Auth check failed', code: 'NOT_CONFIGURED' }, { status: 503 });
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
    wlog('error', 'cf_sandbox_error', {
      requestId,
      route,
      message: err instanceof Error ? err.message : String(err),
    });
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
        code: classifyCfError(err),
      },
      { status: 500 },
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
  const githubToken = str(body.githubToken);
  const gitIdentity = body.gitIdentity as { name?: string; email?: string } | undefined;
  const seedFiles = (body.seedFiles as Array<{ path: string; content: string }> | undefined) ?? [];
  const ownerHint = str(body.ownerHint);

  const sandboxId = crypto.randomUUID();
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  if (gitIdentity?.name && gitIdentity?.email) {
    await sandbox.exec(
      `git config --global user.name ${JSON.stringify(gitIdentity.name)} && ` +
        `git config --global user.email ${JSON.stringify(gitIdentity.email)}`,
    );
  }

  if (repo && repo.length > 0) {
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${repo}.git`
      : `https://github.com/${repo}.git`;
    await sandbox.gitCheckout(cloneUrl, { branch, targetDir: '/workspace' });
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
  } catch (err) {
    await sandbox.destroy?.().catch(() => {});
    throw err;
  }

  return Response.json({
    sandboxId,
    ownerToken,
    status: 'ready',
    workspaceRevision: 0,
    environment,
  });
}

async function routeConnect(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandboxId');
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  // Liveness check: run a trivial exec and propagate failures. probeEnvironment
  // swallows exec errors (returning an empty payload) so we can't rely on it
  // to signal a dead sandbox — do the probe explicitly here and surface 404
  // when it fails so callers fall back to create/restore.
  const liveness = (await sandbox.exec('true').catch((err) => ({ __error: err }))) as
    | { exitCode?: number }
    | { __error: unknown };
  if ('__error' in liveness || (liveness as { exitCode?: number }).exitCode !== 0) {
    return Response.json({ error: 'Sandbox is not reachable', code: 'NOT_FOUND' }, { status: 404 });
  }

  const environment = await probeEnvironment(sandbox);
  return Response.json({
    sandboxId,
    ownerToken: str(body.ownerToken) ?? '',
    status: 'ready',
    workspaceRevision: 0,
    environment,
  });
}

async function routeCleanup(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandboxId');
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
  const sandboxId = requireStr(body, 'sandboxId');
  const command = requireStr(body, 'command');
  const workdir = str(body.workdir);

  const sandbox = getSandbox(env.Sandbox!, sandboxId);
  const result = await sandbox.exec(command, workdir ? { cwd: workdir } : undefined);

  const stdout = (result as { stdout?: string }).stdout ?? '';
  const stderr = (result as { stderr?: string }).stderr ?? '';
  const exitCode = (result as { exitCode?: number }).exitCode ?? 0;

  return Response.json({
    stdout: truncate(stdout, 500_000),
    stderr: truncate(stderr, 100_000),
    exitCode,
    truncated: stdout.length > 500_000 || stderr.length > 100_000,
    workspaceRevision: 0,
  });
}

async function routeRead(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandboxId');
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
    sandbox.exec(contentCommand),
    sandbox.exec(hashCommand),
    isLineRangeRead ? sandbox.exec(lineCountCommand) : Promise.resolve(null),
    sandbox.exec(statCommand),
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
  const sandboxId = requireStr(body, 'sandboxId');
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
  const sandboxId = requireStr(body, 'sandboxId');
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
  const sandboxId = requireStr(body, 'sandboxId');
  const path = requireStr(body, 'path');
  const sandbox = getSandbox(env.Sandbox!, sandboxId);
  await sandbox.deleteFile(path);
  return Response.json({ workspace_revision: 0 });
}

async function routeList(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandboxId');
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
  const sandboxId = requireStr(body, 'sandboxId');
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  const diffRes = (await sandbox.exec('git -C /workspace diff HEAD')) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  const statusRes = (await sandbox.exec('git -C /workspace status --porcelain')) as {
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
  const sandboxId = requireStr(body, 'sandboxId');
  const path = (str(body.path) ?? '/workspace').replace(/\/+$/g, '') || '/workspace';
  const sandbox = getSandbox(env.Sandbox!, sandboxId);

  // Produce a base64 tar.gz on stdout via the container.
  const tarResult = (await sandbox.exec(
    `tar -czf - -C ${JSON.stringify(path)} . | base64 -w0`,
  )) as { stdout?: string };

  const archive = tarResult.stdout?.trim() ?? '';
  // Approximate decoded size — base64 expands 4:3.
  const size = Math.floor((archive.length * 3) / 4);
  return Response.json({ archive, size });
}

async function routeHydrate(env: Env, body: Json): Promise<Response> {
  const sandboxId = requireStr(body, 'sandboxId');
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

  const mkdir = (await sandbox.exec(`mkdir -p ${JSON.stringify(path)}`)) as {
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

  const decode = (await sandbox.exec(`base64 -d ${tmpB64} > ${tmpTar}`)) as {
    exitCode?: number;
    stderr?: string;
  };
  if ((decode.exitCode ?? 0) !== 0) {
    await sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`).catch(() => {});
    return Response.json(
      { error: `Failed to decode archive: ${decode.stderr ?? ''}`.trim(), code: 'CF_ERROR' },
      { status: 400 },
    );
  }

  // Defense in depth against path traversal: list archive members first and
  // refuse if any entry is absolute or contains "..". Even with internal
  // traffic we trust, this keeps a bad producer from escaping the target
  // directory during hydrate.
  const list = (await sandbox.exec(`tar -tzf ${tmpTar}`)) as {
    stdout?: string;
    exitCode?: number;
    stderr?: string;
  };
  if ((list.exitCode ?? 0) !== 0) {
    await sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`).catch(() => {});
    return Response.json(
      { error: `Invalid archive: ${list.stderr ?? ''}`.trim(), code: 'CF_ERROR' },
      { status: 400 },
    );
  }
  const members = (list.stdout ?? '').split('\n').filter(Boolean);
  const unsafe = members.find((m) => m.startsWith('/') || m.split('/').some((seg) => seg === '..'));
  if (unsafe) {
    await sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`).catch(() => {});
    return Response.json(
      { error: `Archive member rejected (path traversal): ${unsafe}`, code: 'CF_ERROR' },
      { status: 400 },
    );
  }

  const extract = (await sandbox.exec(
    `tar -xzf ${tmpTar} -C ${JSON.stringify(path)} --no-same-owner`,
  )) as { exitCode?: number; stderr?: string };
  await sandbox.exec(`rm -f ${tmpB64} ${tmpTar}`).catch(() => {});

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
  const sandboxId = requireStr(body, 'sandboxId');
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

  const result = (await sandbox.exec(script).catch(() => ({ stdout: '' }))) as {
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
