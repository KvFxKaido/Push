import type { ExecutionContext } from '@cloudflare/workers-types';
import type { Env } from './worker-middleware';
import {
  validateOrigin,
  getClientIp,
  wlog,
  readBodyText,
  MAX_BODY_SIZE_BYTES,
  RESTORE_MAX_BODY_SIZE_BYTES,
} from './worker-middleware';
import { SANDBOX_ROUTES, resolveModalSandboxBase } from '../lib/sandbox-routes';
import { hasServerCredentials } from './worker-provider-capabilities';
import { recordSnapshotEvent } from './snapshot-index';
import { REQUEST_ID_HEADER, getOrCreateRequestId } from '../lib/request-id';
import { buildSessionClearCookie, buildSessionSetCookie, mintSessionToken } from './worker-session';
import {
  createSpanContext,
  buildTraceparent,
  createChildContext,
  formatSpanForLog,
  type WorkerSpan,
} from './worker-tracing';

/**
 * The GitHub App's slug — the handle a user types to @-mention the app in a PR
 * comment (`@push-agent`). Exported so the webhook comment-trigger path can use
 * it as the default mention target (overridable via `PR_REVIEW_BOT_HANDLE`).
 */
export const GITHUB_APP_SLUG = 'push-agent';

export async function handleSandbox(
  request: Request,
  env: Env,
  requestUrl: URL,
  route: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'sandbox');
  const spanCtx = createSpanContext(request, requestId);
  const modalFunction = SANDBOX_ROUTES[route];
  if (!modalFunction) {
    return Response.json({ error: `Unknown sandbox route: ${route}` }, { status: 404 });
  }

  const baseUrl = env.MODAL_SANDBOX_BASE_URL;
  if (!baseUrl) {
    return Response.json(
      {
        error: 'Sandbox not configured',
        code: 'MODAL_NOT_CONFIGURED',
        details:
          'MODAL_SANDBOX_BASE_URL secret is not set. Run: npx wrangler secret put MODAL_SANDBOX_BASE_URL',
      },
      { status: 503 },
    );
  }

  const resolvedBase = resolveModalSandboxBase(baseUrl);
  if ('code' in resolvedBase) {
    return Response.json(
      {
        error: 'Sandbox misconfigured',
        code: resolvedBase.code,
        details: resolvedBase.details,
      },
      { status: 503 },
    );
  }

  // Validate origin
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  // Rate limit
  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', {
      requestId,
      ip: getClientIp(request),
      path: `api/sandbox/${route}`,
    });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  // Read and forward body. `upload` shares the large-body tier with restore so
  // the policy is provider-consistent. On Modal the route has no dedicated
  // function, so it's forwarded to file-ops as a `write` (see the enrichment
  // block below) — keeping the native-checkpoint restore working on Modal
  // exactly as it did before the dedicated CF upload route existed.
  const maxBodyBytes =
    route === 'restore' || route === 'batch-write' || route === 'upload'
      ? RESTORE_MAX_BODY_SIZE_BYTES
      : MAX_BODY_SIZE_BYTES;
  const bodyResult = await readBodyText(request, maxBodyBytes);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  // Route-specific payload enrichment without changing client contracts.
  let forwardBodyText = bodyResult.text;
  if (
    route === 'read' ||
    route === 'write' ||
    route === 'upload' ||
    route === 'batch-write' ||
    route === 'list' ||
    route === 'delete' ||
    route === 'restore'
  ) {
    try {
      const payload = JSON.parse(bodyResult.text) as Record<string, unknown>;

      if (route === 'read') payload.action = 'read';
      if (route === 'write') payload.action = 'write';
      // `upload` (CF large-body write) maps onto Modal's file-ops write; its
      // payload is a write payload minus the optional optimistic-concurrency
      // fields, so the same action handles it.
      if (route === 'upload') payload.action = 'write';
      if (route === 'batch-write') payload.action = 'batch_write';
      if (route === 'list') payload.action = 'list';
      if (route === 'delete') payload.action = 'delete';
      if (route === 'restore') payload.action = 'hydrate';

      forwardBodyText = JSON.stringify(payload);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // Forward to Modal web endpoint
  // Modal web endpoints follow pattern: {base}-{function_name}.modal.run
  const modalUrl = `${resolvedBase.base}-${modalFunction}.modal.run`;

  // exec can run arbitrary shell commands (npm install, test suites, builds) that
  // legitimately take 2+ minutes. Modal's exec_command waits up to 110s internally,
  // so give it 120s here to receive that response. All other routes stay at 60s.
  const routeTimeoutMs =
    route === 'exec'
      ? 120_000
      : route === 'hibernate' || route === 'restore-snapshot'
        ? 120_000
        : 60_000;

  // Create child context for the sandbox upstream call
  const sandboxUpstreamCtx = createChildContext(spanCtx);
  const sandboxStartTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), routeTimeoutMs);

    try {
      const upstream = await fetch(modalUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          traceparent: buildTraceparent(sandboxUpstreamCtx),
        },
        body: forwardBodyText,
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => '');
        wlog('error', 'modal_error', {
          requestId,
          route,
          status: upstream.status,
          body: errBody.slice(0, 500),
          trace_id: spanCtx.traceId,
        });

        // Provide actionable error messages based on status code
        let code = 'MODAL_ERROR';
        let details = errBody.slice(0, 200);
        const lowerBody = errBody.toLowerCase();

        if (upstream.status === 404) {
          code = 'MODAL_NOT_FOUND';
          details = `Modal endpoint not found. The app may not be deployed. Run: cd sandbox && modal deploy app.py`;
        } else if (upstream.status === 401 || upstream.status === 403) {
          code = 'MODAL_AUTH_FAILED';
          details =
            'Modal authentication failed. Check that your Modal tokens are valid and the app is deployed under the correct account.';
        } else if (upstream.status === 500) {
          // Parse 500 error bodies for known patterns to give more specific codes
          if (
            lowerBody.includes('not found') ||
            lowerBody.includes('does not exist') ||
            lowerBody.includes('no such') ||
            lowerBody.includes('expired')
          ) {
            code = 'MODAL_NOT_FOUND';
            details = 'Sandbox not found or expired. The container may have been terminated.';
          } else if (
            lowerBody.includes('terminated') ||
            lowerBody.includes('closed') ||
            lowerBody.includes('no longer running')
          ) {
            code = 'MODAL_NOT_FOUND';
            details = 'Sandbox has been terminated. Start a new sandbox session.';
          } else if (lowerBody.includes('timeout') || lowerBody.includes('timed out')) {
            code = 'MODAL_TIMEOUT';
            details = 'Modal operation timed out internally.';
          } else if (lowerBody.includes('unauthorized') || lowerBody.includes('forbidden')) {
            code = 'MODAL_AUTH_FAILED';
            details = 'Sandbox access was denied. The session token may be invalid.';
          } else {
            details = errBody.slice(0, 200) || 'Internal Server Error';
          }
        } else if (upstream.status === 502 || upstream.status === 503) {
          code = 'MODAL_UNAVAILABLE';
          details =
            'Modal is temporarily unavailable. The container may be cold-starting. Try again in a few seconds.';
        } else if (upstream.status === 504) {
          code = 'MODAL_TIMEOUT';
          details = 'Modal request timed out. The operation took too long to complete.';
        }

        return Response.json(
          { error: `Sandbox error (${upstream.status})`, code, details },
          { status: upstream.status },
        );
      }

      const data: unknown = await upstream.json();

      // Update the snapshot index — best-effort and off the critical path.
      // Runs behind ctx.waitUntil so the client response isn't blocked on a
      // KV round-trip. Falls back to awaiting inline when no ctx is provided
      // (e.g. tests that want to assert the post-write state).
      // See docs/decisions/Modal Sandbox Snapshots Design.md §6.
      if (route === 'hibernate' || route === 'restore-snapshot') {
        const indexTask = async () => {
          try {
            const status = await recordSnapshotEvent(
              env.SNAPSHOT_INDEX,
              route,
              bodyResult.text,
              data,
            );
            wlog('info', 'snapshot_index_event', { requestId, route, status });
          } catch (kvErr) {
            wlog('warn', 'snapshot_index_error', {
              requestId,
              route,
              message: kvErr instanceof Error ? kvErr.message : String(kvErr),
            });
          }
        };
        if (ctx) {
          ctx.waitUntil(indexTask());
        } else {
          await indexTask();
        }
      }

      // Log completed sandbox span
      const sandboxSpan: WorkerSpan = {
        context: sandboxUpstreamCtx,
        name: `sandbox.${route}`,
        startTime: sandboxStartTime,
        attributes: {
          'push.sandbox.route': route,
          'push.sandbox.timeout_ms': routeTimeoutMs,
          'push.sandbox.status': upstream.status,
        },
        status: 'ok',
      };
      wlog('info', 'span_complete', formatSpanForLog(sandboxSpan));

      return Response.json(data);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    wlog('error', 'sandbox_error', {
      requestId,
      route,
      message,
      timeout: isTimeout,
      trace_id: spanCtx.traceId,
    });

    if (isTimeout) {
      return Response.json(
        {
          error: 'Sandbox request timed out',
          code: 'MODAL_TIMEOUT',
          details: `The sandbox took longer than ${routeTimeoutMs / 1000} seconds to respond. Try a simpler operation or check Modal dashboard for issues.`,
        },
        { status: 504 },
      );
    }

    // Check for common network errors
    const isNetworkError =
      message.includes('fetch failed') ||
      message.includes('ECONNREFUSED') ||
      message.includes('network');
    if (isNetworkError) {
      return Response.json(
        {
          error: 'Cannot reach Modal',
          code: 'MODAL_NETWORK_ERROR',
          details: `Network error connecting to Modal. Check that the MODAL_SANDBOX_BASE_URL is correct and Modal is not experiencing outages. (${message})`,
        },
        { status: 502 },
      );
    }

    return Response.json(
      {
        error: 'Sandbox error',
        code: 'MODAL_UNKNOWN_ERROR',
        details: message,
      },
      { status: 500 },
    );
  }
}

// --- Health check endpoint ---

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    worker: { status: 'ok' };
    ollama: { status: 'ok' | 'unconfigured'; configured: boolean };
    openrouter: { status: 'ok' | 'unconfigured'; configured: boolean };
    cloudflare: { status: 'ok' | 'unconfigured'; configured: boolean };
    zen: { status: 'ok' | 'unconfigured'; configured: boolean };
    nvidia: { status: 'ok' | 'unconfigured'; configured: boolean };
    fireworks: { status: 'ok' | 'unconfigured'; configured: boolean };
    anthropic: { status: 'ok' | 'unconfigured'; configured: boolean };
    openai: { status: 'ok' | 'unconfigured'; configured: boolean };
    google: { status: 'ok' | 'unconfigured'; configured: boolean };
    sandbox: {
      status: 'ok' | 'unconfigured' | 'misconfigured';
      configured: boolean;
      error?: string;
    };
    github_app: { status: 'ok' | 'unconfigured'; configured: boolean };
    github_app_oauth: { status: 'ok' | 'unconfigured'; configured: boolean };
  };
  version: string;
}

export async function handleHealthCheck(env: Env, request?: Request): Promise<Response> {
  const healthStartTime = Date.now();
  // "Configured" means a server-resolvable credential — Worker secret, the
  // Workers AI binding, or gateway BYOK — not a bare env-key probe, which
  // reported BYOK providers "unconfigured" once their secrets retired.
  const ollamaConfigured = hasServerCredentials('ollama', env);
  const openRouterConfigured = hasServerCredentials('openrouter', env);
  const cloudflareConfigured = hasServerCredentials('cloudflare', env);
  const zenConfigured = hasServerCredentials('zen', env);
  const nvidiaConfigured = hasServerCredentials('nvidia', env);
  const fireworksConfigured = hasServerCredentials('fireworks', env);
  const anthropicConfigured = hasServerCredentials('anthropic', env);
  const openaiConfigured = hasServerCredentials('openai', env);
  const googleConfigured = hasServerCredentials('google', env);
  const sandboxUrl = env.MODAL_SANDBOX_BASE_URL;

  let sandboxStatus: 'ok' | 'unconfigured' | 'misconfigured' = 'unconfigured';
  let sandboxError: string | undefined;

  if (sandboxUrl) {
    const resolvedBase = resolveModalSandboxBase(sandboxUrl);
    if (!('code' in resolvedBase)) {
      sandboxStatus = 'ok';
    } else {
      sandboxStatus = 'misconfigured';
      sandboxError = resolvedBase.details;
    }
  }

  const hasAnyLlm =
    ollamaConfigured ||
    openRouterConfigured ||
    cloudflareConfigured ||
    zenConfigured ||
    nvidiaConfigured ||
    fireworksConfigured ||
    anthropicConfigured ||
    openaiConfigured ||
    googleConfigured;
  const overallStatus: 'healthy' | 'degraded' | 'unhealthy' =
    hasAnyLlm && sandboxStatus === 'ok'
      ? 'healthy'
      : hasAnyLlm || sandboxStatus === 'ok'
        ? 'degraded'
        : 'unhealthy';

  const health: HealthStatus = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    services: {
      worker: { status: 'ok' },
      ollama: { status: ollamaConfigured ? 'ok' : 'unconfigured', configured: ollamaConfigured },
      openrouter: {
        status: openRouterConfigured ? 'ok' : 'unconfigured',
        configured: openRouterConfigured,
      },
      cloudflare: {
        status: cloudflareConfigured ? 'ok' : 'unconfigured',
        configured: cloudflareConfigured,
      },
      zen: { status: zenConfigured ? 'ok' : 'unconfigured', configured: zenConfigured },
      nvidia: { status: nvidiaConfigured ? 'ok' : 'unconfigured', configured: nvidiaConfigured },
      fireworks: {
        status: fireworksConfigured ? 'ok' : 'unconfigured',
        configured: fireworksConfigured,
      },
      anthropic: {
        status: anthropicConfigured ? 'ok' : 'unconfigured',
        configured: anthropicConfigured,
      },
      openai: {
        status: openaiConfigured ? 'ok' : 'unconfigured',
        configured: openaiConfigured,
      },
      google: {
        status: googleConfigured ? 'ok' : 'unconfigured',
        configured: googleConfigured,
      },
      sandbox: { status: sandboxStatus, configured: Boolean(sandboxUrl), error: sandboxError },
      github_app: {
        status: env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? 'ok' : 'unconfigured',
        configured: Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY),
      },
      github_app_oauth: {
        status: env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET ? 'ok' : 'unconfigured',
        configured: Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET),
      },
    },
    version: '1.0.0',
  };

  wlog('info', 'health_check', {
    status: overallStatus,
    duration_ms: Date.now() - healthStartTime,
    ...(request ? { trace_id: createSpanContext(request, 'health').traceId } : {}),
  });

  return Response.json(health, {
    status: overallStatus === 'unhealthy' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}

// --- GitHub App OAuth auto-connect ---

export async function handleGitHubAppOAuth(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
  const clientIp = getClientIp(request);

  // Throttle code-exchange attempts so a leaked or guessed origin can't be
  // used to brute-force OAuth codes / installation enumeration.
  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: clientIp });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', {
      requestId,
      ip: clientIp,
      path: requestUrl.pathname,
    });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    return Response.json({ error: 'GitHub App OAuth not configured' }, { status: 500 });
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json(
      { error: 'GitHub App not configured (needed for installation token)' },
      { status: 500 },
    );
  }

  const bodyResult = await readBodyText(request, 4096);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let payload: { code?: string };
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const code = payload.code;
  if (!code || typeof code !== 'string') {
    return Response.json({ error: 'Missing code' }, { status: 400 });
  }

  try {
    // Step 1: Exchange OAuth code for user access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => '');
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'token_exchange',
        status: tokenRes.status,
        body: errBody.slice(0, 300),
      });
      return Response.json(
        { error: `GitHub OAuth token exchange failed (${tokenRes.status})` },
        { status: 502 },
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (tokenData.error || !tokenData.access_token) {
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'token_parse',
        error: tokenData.error,
        description: tokenData.error_description,
      });
      return Response.json(
        {
          error: tokenData.error_description || tokenData.error || 'OAuth token exchange failed',
        },
        { status: 400 },
      );
    }

    const userToken = tokenData.access_token;

    // Resolve the GitHub identity. This is now load-bearing, not best-effort
    // enrichment: the auth rework keys the Push session on GitHub's stable
    // numeric user id (docs/decisions/Auth Rework …). Without a verified id
    // there is nothing to anchor the allowlist on, so a failure here is fatal.
    let oauthUser: { login: string; avatar_url: string } | null = null;
    // Network and JSON-parse failures map to 502 (not the outer catch's 500):
    // this is an upstream-GitHub failure on a now-mandatory step, so it gets
    // the same gateway-error classification as a non-2xx /user response.
    let userRes: Response;
    try {
      userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Push-App/1.0.0',
        },
      });
    } catch (err) {
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'user_identity',
        reason: 'fetch_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ error: 'Failed to resolve GitHub identity' }, { status: 502 });
    }
    if (!userRes.ok) {
      const errBody = await userRes.text().catch(() => '');
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'user_identity',
        status: userRes.status,
        body: errBody.slice(0, 300),
      });
      return Response.json(
        { error: `Failed to resolve GitHub identity (${userRes.status})` },
        { status: 502 },
      );
    }
    let userData: { id?: unknown; login?: unknown; avatar_url?: unknown };
    try {
      userData = (await userRes.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
    } catch {
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'user_identity',
        reason: 'parse_failed',
      });
      return Response.json({ error: 'Failed to parse GitHub identity' }, { status: 502 });
    }
    if (typeof userData.id !== 'number' || !Number.isFinite(userData.id)) {
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'user_identity',
        reason: 'missing_id',
      });
      return Response.json(
        { error: 'GitHub identity response missing a numeric user id' },
        { status: 502 },
      );
    }
    const githubUserId = String(userData.id);
    if (typeof userData.login === 'string' && userData.login.trim()) {
      oauthUser = {
        login: userData.login,
        avatar_url: typeof userData.avatar_url === 'string' ? userData.avatar_url : '',
      };
    }

    // Step 2: Find user's installations for this app
    const installRes = await fetch('https://api.github.com/user/installations', {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    });

    if (!installRes.ok) {
      const errBody = await installRes.text().catch(() => '');
      wlog('error', 'github_oauth_error', {
        requestId,
        step: 'installations',
        status: installRes.status,
        body: errBody.slice(0, 300),
      });
      return Response.json(
        { error: `Failed to fetch installations (${installRes.status})` },
        { status: 502 },
      );
    }

    const installData = (await installRes.json()) as {
      total_count: number;
      installations: Array<{
        id: number;
        app_id: number;
        app_slug: string;
        account?: { login?: unknown; avatar_url?: unknown };
      }>;
    };

    // Find installation matching our app
    const appId = Number(env.GITHUB_APP_ID);
    const installation = installData.installations.find((inst) => inst.app_id === appId);

    if (!installation) {
      return Response.json(
        {
          error: 'No installation found',
          details:
            'You have not installed the Push Agent GitHub App. Please install it first, then try connecting again.',
          install_url: `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`,
        },
        { status: 404 },
      );
    }

    const installationId = String(installation.id);
    const installationAccount =
      installation.account && typeof installation.account.login === 'string'
        ? {
            login: installation.account.login,
            avatar_url:
              typeof installation.account.avatar_url === 'string'
                ? installation.account.avatar_url
                : '',
          }
        : null;

    // Step 3: Check allowlist (if configured)
    const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
      return Response.json({ error: 'installation_id is not allowed' }, { status: 403 });
    }

    // Step 4: Exchange for installation token (reuses existing JWT flow)
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const instTokenData = await exchangeForInstallationToken(jwt, installationId);

    const botCommitIdentity = await fetchGitHubAppBotCommitIdentity(installation.app_slug);

    // Mint the Push identity session, keyed on the verified GitHub user id. The
    // gate in worker-middleware verifies this signature per request — no
    // re-hitting GitHub. When PUSH_SESSION_SECRET is unset the mint is skipped
    // (the gate is a no-op in that config), so OAuth still succeeds end-to-end.
    const sessionSecret = env.PUSH_SESSION_SECRET?.trim();
    const responseHeaders: Record<string, string> = {};
    let sessionToken: string | undefined;
    let sessionExpiresAt: string | undefined;
    if (sessionSecret) {
      const minted = await mintSessionToken(sessionSecret, {
        sub: githubUserId,
        login: oauthUser?.login,
        installationId,
      });
      sessionToken = minted.token;
      sessionExpiresAt = minted.expiresAt;
      responseHeaders['Set-Cookie'] = buildSessionSetCookie(minted.token);
      wlog('info', 'session_minted', {
        requestId,
        sub: githubUserId,
        login: oauthUser?.login,
        installation_id: installationId,
      });
    } else {
      wlog('warn', 'session_mint_skipped', { requestId, reason: 'no_secret', sub: githubUserId });
    }

    return Response.json(
      {
        token: instTokenData.token,
        expires_at: instTokenData.expires_at,
        installation_id: installationId,
        user: oauthUser || installationAccount,
        commit_identity: botCommitIdentity,
        ...(sessionToken ? { session: sessionToken, session_expires_at: sessionExpiresAt } : {}),
      },
      { headers: responseHeaders },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const stack = err instanceof Error ? err.stack : undefined;
    wlog('error', 'github_oauth_error', {
      requestId,
      step: 'unknown',
      message,
      ...(stack ? { stack } : {}),
    });
    return Response.json({ error: 'GitHub App OAuth failed' }, { status: 500 });
  }
}

// --- GitHub App token exchange ---

export async function handleGitHubAppToken(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
  const clientIp = getClientIp(request);

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: clientIp });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', {
      requestId,
      ip: clientIp,
      path: requestUrl.pathname,
    });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: 'GitHub App not configured' }, { status: 500 });
  }

  const bodyResult = await readBodyText(request, 4096);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let payload: { installation_id?: string };
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const installationId = payload.installation_id;
  if (!installationId || typeof installationId !== 'string') {
    return Response.json({ error: 'Missing installation_id' }, { status: 400 });
  }

  // Validate installation_id is a positive integer
  if (!/^\d+$/.test(installationId)) {
    return Response.json({ error: 'Invalid installation_id format' }, { status: 400 });
  }

  // Prevent overly long IDs (DoS protection)
  if (installationId.length > 20) {
    return Response.json({ error: 'installation_id too long' }, { status: 400 });
  }

  const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
    return Response.json({ error: 'installation_id is not allowed' }, { status: 403 });
  }

  try {
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const tokenData = await exchangeForInstallationToken(jwt, installationId);
    const installationMeta = await fetchInstallationMetadata(jwt, installationId);
    const botCommitIdentity = await fetchGitHubAppBotCommitIdentity(installationMeta.app_slug);

    // Mint a Push session on this path too — it's the working auth flow when the
    // App is already installed (manual installation-id entry + install callback
    // both land here, and the OAuth redirect is a no-op once installed). But this
    // path's identity proof is weaker than OAuth (it proves knowledge of an
    // installation id, not that the caller is a specific human), so we mint only
    // when BOTH hold:
    //   1. account.type === 'User' — so `sub` is a real user id (same id space as
    //      GET /user), never an Organization id that could never match
    //      GITHUB_ALLOWED_USER_IDS (and would otherwise let an hourly refresh
    //      overwrite a valid OAuth user session with an org-id one).
    //   2. the installation is operator-vouched — GITHUB_ALLOWED_INSTALLATION_IDS
    //      is configured (and, via the 403 gate above, includes this one), so a
    //      session keyed on an allowlisted identity can't be issued from a merely
    //      guessable installation id once the deployment token retires.
    const sessionSecret = env.PUSH_SESSION_SECRET?.trim();
    const account = installationMeta.account;
    const installationVouched = allowedInstallationIds.length > 0;
    const responseHeaders: Record<string, string> = {};
    let sessionToken: string | undefined;
    let sessionExpiresAt: string | undefined;
    if (!sessionSecret) {
      wlog('warn', 'session_mint_skipped', {
        requestId,
        reason: 'no_secret',
        via: 'app-token',
        installation_id: installationId,
      });
    } else if (account?.type === 'User' && account.id !== null && installationVouched) {
      const minted = await mintSessionToken(sessionSecret, {
        sub: String(account.id),
        login: account.login,
        installationId,
      });
      sessionToken = minted.token;
      sessionExpiresAt = minted.expiresAt;
      responseHeaders['Set-Cookie'] = buildSessionSetCookie(minted.token);
      wlog('info', 'session_minted', {
        requestId,
        sub: String(account.id),
        login: account.login,
        installation_id: installationId,
        via: 'app-token',
      });
    } else {
      wlog('warn', 'session_mint_skipped', {
        requestId,
        reason: !installationVouched
          ? 'installation_not_scoped'
          : account?.type !== 'User'
            ? 'non_user_account'
            : 'no_account_id',
        via: 'app-token',
        installation_id: installationId,
      });
    }

    return Response.json(
      {
        ...tokenData,
        // Keep account.id / account.type server-internal — the client user shape
        // stays { login, avatar_url }.
        user: account ? { login: account.login, avatar_url: account.avatar_url } : null,
        commit_identity: botCommitIdentity,
        ...(sessionToken ? { session: sessionToken, session_expires_at: sessionExpiresAt } : {}),
      },
      { headers: responseHeaders },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const stack = err instanceof Error ? err.stack : undefined;
    wlog('error', 'github_token_error', {
      requestId,
      message,
      ...(stack ? { stack } : {}),
    });
    return Response.json({ error: 'GitHub App authentication failed' }, { status: 500 });
  }
}

// --- GitHub App repo-coverage probe ---

/**
 * Answer "does the Push GitHub App installation cover this repo?" so the client
 * can confirm repo-auth BEFORE spinning up a sandbox and attempting a clone —
 * turning a cryptic deep-in-the-sandbox git failure into an actionable
 * install/update prompt (auth rework step 2).
 *
 * Uses the App JWT to call `GET /repos/{owner}/{repo}/installation`:
 *   - 200 → installed + covers the repo (`covered: true`), unless the resolved
 *     installation isn't on GITHUB_ALLOWED_INSTALLATION_IDS (then not covered).
 *   - 404 → the App doesn't cover the repo (not installed, or repo not in the
 *     installation's selected set — GitHub returns 404 for both).
 *
 * `install_url` is always returned so the client has a single CTA target that
 * GitHub routes to either first-install or configure-repos as appropriate.
 */
export async function handleRepoCoverage(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
  const clientIp = getClientIp(request);

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: clientIp });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', { requestId, ip: clientIp, path: requestUrl.pathname });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const installUrl = `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`;

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: 'GitHub App not configured' }, { status: 500 });
  }

  const bodyResult = await readBodyText(request, 4096);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let payload: { repo?: string; installation_id?: string };
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const repo = typeof payload.repo === 'string' ? payload.repo.trim() : '';
  // owner/name, each a conservative GitHub-name charset. Rejects path tricks
  // (extra slashes, `?`/`#`) before the value reaches the GitHub URL.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return Response.json({ error: 'Invalid repo (expected owner/name)' }, { status: 400 });
  }
  const [owner, name] = repo.split('/');
  const encodedRepo = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // Optional: the caller's active installation id. When present, coverage is
  // confirmed against THIS installation (the one whose token will be injected),
  // not merely against any installation of the App that covers the repo.
  const activeInstallationId =
    typeof payload.installation_id === 'string' ? payload.installation_id.trim() : '';
  if (activeInstallationId && !/^\d{1,20}$/.test(activeInstallationId)) {
    return Response.json({ error: 'Invalid installation_id' }, { status: 400 });
  }

  try {
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const response = await fetch(`https://api.github.com/repos/${encodedRepo}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    });

    if (response.status === 404) {
      wlog('info', 'repo_coverage', { requestId, repo, covered: false, reason: 'not_covered' });
      return Response.json({ covered: false, reason: 'not_covered', install_url: installUrl });
    }
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      wlog('error', 'repo_coverage_error', {
        requestId,
        repo,
        status: response.status,
        body: errBody.slice(0, 200),
      });
      return Response.json(
        { error: `Failed to resolve repo installation (${response.status})` },
        { status: 502 },
      );
    }

    const data = (await response.json()) as { id?: number };
    // A 200 without a numeric id is an upstream anomaly — `covered: true` must
    // imply a real installation id (we compare + allowlist on it), so fail it.
    if (typeof data.id !== 'number' || !Number.isFinite(data.id)) {
      wlog('error', 'repo_coverage_error', { requestId, repo, reason: 'missing_installation_id' });
      return Response.json({ error: 'GitHub returned no installation id' }, { status: 502 });
    }
    const installationId = String(data.id);

    // The repo is covered by a different installation than the caller's active
    // one — its injected token wouldn't be able to clone this repo.
    if (activeInstallationId && activeInstallationId !== installationId) {
      wlog('info', 'repo_coverage', {
        requestId,
        repo,
        covered: false,
        reason: 'installation_mismatch',
      });
      return Response.json({
        covered: false,
        reason: 'installation_mismatch',
        install_url: installUrl,
      });
    }

    const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
      wlog('info', 'repo_coverage', {
        requestId,
        repo,
        covered: false,
        reason: 'installation_not_allowed',
      });
      return Response.json({
        covered: false,
        reason: 'installation_not_allowed',
        install_url: installUrl,
      });
    }

    wlog('info', 'repo_coverage', {
      requestId,
      repo,
      covered: true,
      installation_id: installationId,
    });
    return Response.json({
      covered: true,
      installation_id: installationId,
      install_url: installUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    wlog('error', 'repo_coverage_error', { requestId, repo, message });
    return Response.json({ error: 'Repo coverage check failed' }, { status: 500 });
  }
}

// --- GitHub App logout ---

/**
 * Revoke a user's installation access token via GitHub's
 * `DELETE /installation/token` endpoint, which authenticates with the token
 * itself. Routing this through the Worker (instead of letting the client
 * call GitHub directly) gives Push a single chokepoint to log/audit logout
 * events and aligns with the "logout invalidates server-side state" rule.
 *
 * GitHub returns 204 on success. 401/404 mean the token was already invalid
 * (revoked elsewhere or expired); we treat those as success too so logout
 * is idempotent — the desired end state is "this token doesn't work", and
 * it doesn't.
 */
export async function handleGitHubAppLogout(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }

  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER), 'worker');
  const clientIp = getClientIp(request);

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: clientIp });
  if (!rateLimitOk) {
    wlog('warn', 'rate_limited', {
      requestId,
      ip: clientIp,
      path: requestUrl.pathname,
    });
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const bodyResult = await readBodyText(request, 4096);
  if ('error' in bodyResult) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }

  let payload: { token?: string };
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const token = payload.token;
  if (!token || typeof token !== 'string') {
    return Response.json({ error: 'Missing token' }, { status: 400 });
  }
  // Hard cap so a malformed client can't make us stream megabytes upstream.
  if (token.length > 256) {
    return Response.json({ error: 'Token too long' }, { status: 400 });
  }
  // Reject anything outside printable ASCII (0x21-0x7E) before it reaches
  // fetch() — header construction throws on whitespace/control chars
  // (\r, \n, NUL, DEL, ...), which would otherwise surface as a misleading
  // generic 500 from the catch block.
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) {
      return Response.json({ error: 'Invalid token' }, { status: 400 });
    }
  }

  try {
    const ghRes = await fetch('https://api.github.com/installation/token', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    });

    if (ghRes.ok || ghRes.status === 401 || ghRes.status === 404) {
      // Expire the HttpOnly push_session cookie server-side — the client can't
      // clear it from JS, and the fetch wrapper now sends it with every
      // first-party /api request, so without this the session would keep
      // authorizing the gated surface until its Max-Age elapsed (Codex P1).
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': buildSessionClearCookie() },
      });
    }

    const errBody = await ghRes.text().catch(() => '');
    wlog('error', 'github_logout_error', {
      requestId,
      status: ghRes.status,
      body: errBody.slice(0, 300),
    });
    return Response.json(
      { error: `GitHub token revocation failed (${ghRes.status})` },
      { status: 502 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const stack = err instanceof Error ? err.stack : undefined;
    wlog('error', 'github_logout_error', {
      requestId,
      message,
      ...(stack ? { stack } : {}),
    });
    return Response.json({ error: 'GitHub App logout failed' }, { status: 500 });
  }
}

// --- GitHub App JWT and helpers ---

export async function generateGitHubAppJWT(appId: string, privateKeyPEM: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encodeBase64Url = (data: string | Uint8Array): string => {
    let base64: string;
    if (typeof data === 'string') {
      base64 = btoa(data);
    } else {
      const bytes = Array.from(data, (b) => String.fromCharCode(b)).join('');
      base64 = btoa(bytes);
    }
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Normalize PEM: dotenv may store literal \n or truncate multiline values.
  // Also handle both PKCS#1 (BEGIN RSA PRIVATE KEY) and PKCS#8 (BEGIN PRIVATE KEY).
  // The production Cloudflare runtime accepts PKCS#1 via importKey('pkcs8'),
  // but the local workerd dev runtime does not — so we wrap PKCS#1 in PKCS#8.
  const normalizedPEM = privateKeyPEM.replace(/\\n/g, '\n');
  const isPkcs1 = normalizedPEM.includes('BEGIN RSA PRIVATE KEY');
  const pemHeader = isPkcs1 ? '-----BEGIN RSA PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY-----';
  const pemFooter = isPkcs1 ? '-----END RSA PRIVATE KEY-----' : '-----END PRIVATE KEY-----';
  const pemContents = normalizedPEM
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\s/g, '');

  if (!pemContents || pemContents.length < 100) {
    throw new Error(
      `Private key appears empty or truncated (${pemContents.length} base64 chars). ` +
        'If using .dev.vars, wrap the PEM value in double quotes for multiline support.',
    );
  }

  const derBytes = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const pkcs8Bytes = isPkcs1 ? wrapPkcs1InPkcs8(derBytes) : derBytes;
  const keyBytes = Uint8Array.from(pkcs8Bytes);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Wrap a PKCS#1 RSA private key in a PKCS#8 ASN.1 envelope */
function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // PKCS#8 structure:
  //   SEQUENCE {
  //     INTEGER 0 (version),
  //     SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL },
  //     OCTET STRING { <PKCS#1 DER bytes> }
  //   }
  function asn1Length(len: number): Uint8Array {
    if (len < 0x80) return new Uint8Array([len]);
    if (len < 0x100) return new Uint8Array([0x81, len]);
    return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  }

  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetTag = new Uint8Array([0x04]);
  const octetLen = asn1Length(pkcs1Der.length);

  const innerLen =
    version.length + rsaOid.length + octetTag.length + octetLen.length + pkcs1Der.length;
  const seqTag = new Uint8Array([0x30]);
  const seqLen = asn1Length(innerLen);

  const result = new Uint8Array(seqTag.length + seqLen.length + innerLen);
  let off = 0;
  for (const part of [seqTag, seqLen, version, rsaOid, octetTag, octetLen, pkcs1Der]) {
    result.set(part, off);
    off += part.length;
  }
  return result;
}

export async function exchangeForInstallationToken(
  jwt: string,
  installationId: string,
): Promise<{ token: string; expires_at: string }> {
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API ${response.status}: ${error}`);
  }

  return (await response.json()) as { token: string; expires_at: string };
}

/**
 * Resolve the GitHub App installation id for a repo, authoritatively, via the
 * app JWT (`GET /repos/{repo}/installation`). Used by the manual PR-review
 * trigger so the installation is derived from the repo server-side rather than
 * asserted by the client. Throws on lookup failure (e.g. app not installed).
 */
export async function resolveRepoInstallationId(jwt: string, repo: string): Promise<string> {
  // Encode owner/name path segments so a crafted repo string can't alter the
  // endpoint (e.g. `?`/`#` dropping `/installation`).
  const [owner, name] = repo.split('/');
  const encodedRepo = `${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`;
  const response = await fetch(`https://api.github.com/repos/${encodedRepo}/installation`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Push-App/1.0.0',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} resolving installation for ${repo}`);
  }
  const data = (await response.json()) as { id?: number };
  if (typeof data.id !== 'number') {
    throw new Error(`No installation id returned for ${repo}`);
  }
  return String(data.id);
}

export async function fetchInstallationMetadata(
  jwt: string,
  installationId: string,
): Promise<{
  account: { login: string; avatar_url: string; id: number | null; type: string | null } | null;
  app_slug: string | null;
}> {
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    },
  );
  if (!response.ok) {
    return { account: null, app_slug: null };
  }

  const data = (await response.json()) as {
    app_slug?: unknown;
    account?: { login?: unknown; avatar_url?: unknown; id?: unknown; type?: unknown };
  };
  const account =
    data.account && typeof data.account.login === 'string' && data.account.login.trim()
      ? {
          login: data.account.login,
          avatar_url: typeof data.account.avatar_url === 'string' ? data.account.avatar_url : '',
          // The installation account's numeric id is in the same id space as the
          // GitHub user id (`GET /user`) — but only when the account is a User.
          // For an Organization install this is the org id, which is not a human
          // identity and must not be minted as a session `sub` (the `type`
          // discriminator gates that in handleGitHubAppToken).
          id:
            typeof data.account.id === 'number' && Number.isFinite(data.account.id)
              ? data.account.id
              : null,
          type: typeof data.account.type === 'string' ? data.account.type : null,
        }
      : null;
  const appSlug = typeof data.app_slug === 'string' && data.app_slug.trim() ? data.app_slug : null;
  return { account, app_slug: appSlug };
}

export async function fetchGitHubAppBotCommitIdentity(
  appSlug: string | null | undefined,
): Promise<{ name: string; email: string; login: string; avatar_url: string } | null> {
  if (!appSlug || !appSlug.trim()) return null;
  const botLogin = `${appSlug}[bot]`;
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(botLogin)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Push-App/1.0.0',
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
    if (typeof data.id !== 'number' || !Number.isFinite(data.id)) return null;
    const login = typeof data.login === 'string' && data.login.trim() ? data.login : botLogin;
    return {
      name: login,
      email: `${data.id}+${login}@users.noreply.github.com`,
      login,
      avatar_url: typeof data.avatar_url === 'string' ? data.avatar_url : '',
    };
  } catch {
    return null;
  }
}
