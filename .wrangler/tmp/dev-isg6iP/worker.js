var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// app/worker.ts
var MAX_BODY_SIZE_BYTES = 512 * 1024;
var RATE_LIMIT_WINDOW_MS = 6e4;
var RATE_LIMIT_MAX = 30;
var rateLimitStore = /* @__PURE__ */ new Map();
var SANDBOX_ROUTES = {
  create: "create",
  exec: "exec-command",
  read: "file-ops",
  write: "file-ops",
  diff: "get-diff",
  cleanup: "cleanup",
  list: "file-ops",
  delete: "file-ops",
  "browser-screenshot": "browser-screenshot"
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return handleHealthCheck(env);
    }
    if (url.pathname === "/api/github/app-token" && request.method === "POST") {
      return handleGitHubAppToken(request, env);
    }
    if (url.pathname === "/api/github/app-oauth" && request.method === "POST") {
      return handleGitHubAppOAuth(request, env);
    }
    if (url.pathname === "/api/kimi/chat" && request.method === "POST") {
      return handleKimiChat(request, env);
    }
    if (url.pathname === "/api/ollama/chat" && request.method === "POST") {
      return handleOllamaChat(request, env);
    }
    if (url.pathname === "/api/mistral/chat" && request.method === "POST") {
      return handleMistralChat(request, env);
    }
    if (url.pathname.startsWith("/api/sandbox/") && request.method === "POST") {
      const route = url.pathname.replace("/api/sandbox/", "");
      return handleSandbox(request, env, url, route);
    }
    return env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
  }
};
function normalizeOrigin(value) {
  if (!value || value === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
__name(normalizeOrigin, "normalizeOrigin");
function getAllowedOrigins(requestUrl, env) {
  const allowed = /* @__PURE__ */ new Set([requestUrl.origin]);
  const raw = env.ALLOWED_ORIGINS;
  if (raw) {
    for (const entry of raw.split(",")) {
      const normalized = normalizeOrigin(entry.trim());
      if (normalized) {
        allowed.add(normalized);
      }
    }
  }
  return allowed;
}
__name(getAllowedOrigins, "getAllowedOrigins");
function validateOrigin(request, requestUrl, env) {
  const origin = normalizeOrigin(request.headers.get("Origin"));
  const refererOrigin = normalizeOrigin(request.headers.get("Referer"));
  const candidates = [origin, refererOrigin].filter(Boolean);
  if (candidates.length === 0) {
    return { ok: false, error: "Missing or invalid Origin/Referer" };
  }
  const allowedOrigins = getAllowedOrigins(requestUrl, env);
  const allowed = candidates.some((candidate) => allowedOrigins.has(candidate));
  if (!allowed) {
    return { ok: false, error: "Origin not allowed" };
  }
  return { ok: true };
}
__name(validateOrigin, "validateOrigin");
function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}
__name(getClientIp, "getClientIp");
function cleanupRateLimitStore(now) {
  if (rateLimitStore.size < 1e3) return;
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(ip);
    }
  }
}
__name(cleanupRateLimitStore, "cleanupRateLimitStore");
function checkRateLimit(ip, now) {
  const entry = rateLimitStore.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return { allowed: true, retryAfter: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1e3);
    return { allowed: false, retryAfter };
  }
  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}
__name(checkRateLimit, "checkRateLimit");
async function readBodyText(request, maxBytes) {
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
  }
  if (!request.body) {
    return { ok: false, status: 400, error: "Missing request body" };
  }
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      return { ok: false, status: 413, error: "Request body too large" };
    }
    chunks.push(value);
  }
  if (received === 0) {
    return { ok: false, status: 400, error: "Empty request body" };
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}
__name(readBodyText, "readBodyText");
async function handleSandbox(request, env, requestUrl, route) {
  const modalFunction = SANDBOX_ROUTES[route];
  if (!modalFunction) {
    return Response.json({ error: `Unknown sandbox route: ${route}` }, { status: 404 });
  }
  const baseUrl = env.MODAL_SANDBOX_BASE_URL;
  if (!baseUrl) {
    return Response.json({
      error: "Sandbox not configured",
      code: "MODAL_NOT_CONFIGURED",
      details: "MODAL_SANDBOX_BASE_URL secret is not set. Run: npx wrangler secret put MODAL_SANDBOX_BASE_URL"
    }, { status: 503 });
  }
  if (!baseUrl.startsWith("https://") || !baseUrl.includes("--")) {
    return Response.json({
      error: "Sandbox misconfigured",
      code: "MODAL_URL_INVALID",
      details: `MODAL_SANDBOX_BASE_URL must be https://<username>--push-sandbox (got: ${baseUrl.slice(0, 50)}...)`
    }, { status: 503 });
  }
  if (baseUrl.endsWith("/")) {
    return Response.json({
      error: "Sandbox misconfigured",
      code: "MODAL_URL_TRAILING_SLASH",
      details: "MODAL_SANDBOX_BASE_URL must not have a trailing slash. Remove the trailing / and redeploy."
    }, { status: 503 });
  }
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }
  const now = Date.now();
  cleanupRateLimitStore(now);
  const rateLimit = checkRateLimit(getClientIp(request), now);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }
  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }
  let forwardBodyText = bodyResult.text;
  if (route === "read" || route === "write" || route === "list" || route === "delete" || route === "browser-screenshot") {
    try {
      const payload = JSON.parse(bodyResult.text);
      if (route === "read") payload.action = "read";
      if (route === "write") payload.action = "write";
      if (route === "list") payload.action = "list";
      if (route === "delete") payload.action = "delete";
      if (route === "browser-screenshot") {
        payload.browserbase_api_key = env.BROWSERBASE_API_KEY || "";
        payload.browserbase_project_id = env.BROWSERBASE_PROJECT_ID || "";
      }
      forwardBodyText = JSON.stringify(payload);
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  const modalUrl = `${baseUrl}-${modalFunction}.modal.run`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6e4);
    let upstream;
    try {
      upstream = await fetch(modalUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: forwardBodyText,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error(`[api/sandbox/${route}] Modal ${upstream.status}: ${errBody.slice(0, 500)}`);
      let code = "MODAL_ERROR";
      let details = errBody.slice(0, 200);
      if (upstream.status === 404) {
        code = "MODAL_NOT_FOUND";
        details = `Modal endpoint not found. The app may not be deployed. Run: cd sandbox && modal deploy app.py`;
      } else if (upstream.status === 401 || upstream.status === 403) {
        code = "MODAL_AUTH_FAILED";
        details = "Modal authentication failed. Check that your Modal tokens are valid and the app is deployed under the correct account.";
      } else if (upstream.status === 502 || upstream.status === 503) {
        code = "MODAL_UNAVAILABLE";
        details = "Modal is temporarily unavailable. The container may be cold-starting. Try again in a few seconds.";
      } else if (upstream.status === 504) {
        code = "MODAL_TIMEOUT";
        details = "Modal request timed out. The operation took too long to complete.";
      }
      return Response.json(
        { error: `Sandbox error (${upstream.status})`, code, details },
        { status: upstream.status }
      );
    }
    const data = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    console.error(`[api/sandbox/${route}] Error: ${message}`);
    if (isTimeout) {
      return Response.json({
        error: "Sandbox request timed out",
        code: "MODAL_TIMEOUT",
        details: "The sandbox took longer than 60 seconds to respond. Try a simpler operation or check Modal dashboard for issues."
      }, { status: 504 });
    }
    const isNetworkError = message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("network");
    if (isNetworkError) {
      return Response.json({
        error: "Cannot reach Modal",
        code: "MODAL_NETWORK_ERROR",
        details: `Network error connecting to Modal. Check that the MODAL_SANDBOX_BASE_URL is correct and Modal is not experiencing outages. (${message})`
      }, { status: 502 });
    }
    return Response.json({
      error: "Sandbox error",
      code: "MODAL_UNKNOWN_ERROR",
      details: message
    }, { status: 500 });
  }
}
__name(handleSandbox, "handleSandbox");
async function handleHealthCheck(env) {
  const kimiConfigured = Boolean(env.MOONSHOT_API_KEY);
  const ollamaConfigured = Boolean(env.OLLAMA_API_KEY);
  const mistralConfigured = Boolean(env.MISTRAL_API_KEY);
  const sandboxUrl = env.MODAL_SANDBOX_BASE_URL;
  let sandboxStatus = "unconfigured";
  let sandboxError;
  if (sandboxUrl) {
    if (!sandboxUrl.startsWith("https://") || !sandboxUrl.includes("--")) {
      sandboxStatus = "misconfigured";
      sandboxError = "MODAL_SANDBOX_BASE_URL format is invalid";
    } else if (sandboxUrl.endsWith("/")) {
      sandboxStatus = "misconfigured";
      sandboxError = "MODAL_SANDBOX_BASE_URL has trailing slash";
    } else {
      sandboxStatus = "ok";
    }
  }
  const hasAnyLlm = kimiConfigured || ollamaConfigured || mistralConfigured;
  const overallStatus = hasAnyLlm && sandboxStatus === "ok" ? "healthy" : hasAnyLlm || sandboxStatus === "ok" ? "degraded" : "unhealthy";
  const health = {
    status: overallStatus,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    services: {
      worker: { status: "ok" },
      kimi: { status: kimiConfigured ? "ok" : "unconfigured", configured: kimiConfigured },
      ollama: { status: ollamaConfigured ? "ok" : "unconfigured", configured: ollamaConfigured },
      mistral: { status: mistralConfigured ? "ok" : "unconfigured", configured: mistralConfigured },
      sandbox: { status: sandboxStatus, configured: Boolean(sandboxUrl), error: sandboxError },
      github_app: { status: env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? "ok" : "unconfigured", configured: Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) },
      github_app_oauth: { status: env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET ? "ok" : "unconfigured", configured: Boolean(env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET) }
    },
    version: "1.0.0"
  };
  return Response.json(health, {
    status: overallStatus === "unhealthy" ? 503 : 200,
    headers: { "Cache-Control": "no-store" }
  });
}
__name(handleHealthCheck, "handleHealthCheck");
async function handleKimiChat(request, env) {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }
  const now = Date.now();
  cleanupRateLimitStore(now);
  const rateLimit = checkRateLimit(getClientIp(request), now);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }
  const serverKey = env.MOONSHOT_API_KEY;
  const clientAuth = request.headers.get("Authorization");
  const authHeader = serverKey ? `Bearer ${serverKey}` : clientAuth;
  if (!authHeader) {
    return Response.json(
      { error: "Kimi API key not configured. Add it in Settings or set MOONSHOT_API_KEY on the Worker." },
      { status: 401 }
    );
  }
  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }
  console.log(`[api/kimi/chat] Forwarding request (${bodyResult.text.length} bytes)`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12e4);
    let upstream;
    try {
      upstream = await fetch("https://api.kimi.com/coding/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader,
          "User-Agent": "claude-code/1.0.0"
        },
        body: bodyResult.text,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    console.log(`[api/kimi/chat] Upstream responded: ${upstream.status}`);
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error(`[api/kimi/chat] Upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
      return Response.json(
        { error: `Kimi API error ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status }
      );
    }
    if (upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }
    const data = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? "Kimi request timed out after 120 seconds" : message;
    console.error(`[api/kimi/chat] Unhandled: ${message}`);
    return Response.json({ error }, { status });
  }
}
__name(handleKimiChat, "handleKimiChat");
async function handleOllamaChat(request, env) {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }
  const now = Date.now();
  cleanupRateLimitStore(now);
  const rateLimit = checkRateLimit(getClientIp(request), now);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }
  const serverKey = env.OLLAMA_API_KEY;
  const clientAuth = request.headers.get("Authorization");
  const authHeader = serverKey ? `Bearer ${serverKey}` : clientAuth;
  if (!authHeader) {
    return Response.json(
      { error: "Ollama Cloud API key not configured. Add it in Settings or set OLLAMA_API_KEY on the Worker." },
      { status: 401 }
    );
  }
  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }
  console.log(`[api/ollama/chat] Forwarding request (${bodyResult.text.length} bytes)`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18e4);
    let upstream;
    try {
      upstream = await fetch("https://ollama.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader
        },
        body: bodyResult.text,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    console.log(`[api/ollama/chat] Upstream responded: ${upstream.status}`);
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error(`[api/ollama/chat] Upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
      return Response.json(
        { error: `Ollama Cloud API error ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status }
      );
    }
    if (upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }
    const data = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? "Ollama Cloud request timed out after 180 seconds" : message;
    console.error(`[api/ollama/chat] Unhandled: ${message}`);
    return Response.json({ error }, { status });
  }
}
__name(handleOllamaChat, "handleOllamaChat");
async function handleMistralChat(request, env) {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }
  const now = Date.now();
  cleanupRateLimitStore(now);
  const rateLimit = checkRateLimit(getClientIp(request), now);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded. Try again later." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfter) } }
    );
  }
  const serverKey = env.MISTRAL_API_KEY;
  const clientAuth = request.headers.get("Authorization");
  const authHeader = serverKey ? `Bearer ${serverKey}` : clientAuth;
  if (!authHeader) {
    return Response.json(
      { error: "Mistral API key not configured. Add it in Settings or set MISTRAL_API_KEY on the Worker." },
      { status: 401 }
    );
  }
  const bodyResult = await readBodyText(request, MAX_BODY_SIZE_BYTES);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }
  console.log(`[api/mistral/chat] Forwarding request (${bodyResult.text.length} bytes)`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12e4);
    let upstream;
    try {
      upstream = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": authHeader
        },
        body: bodyResult.text,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    console.log(`[api/mistral/chat] Upstream responded: ${upstream.status}`);
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error(`[api/mistral/chat] Upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
      return Response.json(
        { error: `Mistral API error ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status }
      );
    }
    if (upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }
    const data = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const status = isTimeout ? 504 : 500;
    const error = isTimeout ? "Mistral request timed out after 120 seconds" : message;
    console.error(`[api/mistral/chat] Unhandled: ${message}`);
    return Response.json({ error }, { status });
  }
}
__name(handleMistralChat, "handleMistralChat");
async function handleGitHubAppOAuth(request, env) {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    return Response.json({ error: "GitHub App OAuth not configured" }, { status: 500 });
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: "GitHub App not configured (needed for installation token)" }, { status: 500 });
  }
  const bodyResult = await readBodyText(request, 4096);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }
  let payload;
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const code = payload.code;
  if (!code || typeof code !== "string") {
    return Response.json({ error: "Missing code" }, { status: 400 });
  }
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code
      })
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => "");
      console.error("[github/app-oauth] Token exchange failed:", tokenRes.status, errBody.slice(0, 300));
      return Response.json({ error: `GitHub OAuth token exchange failed (${tokenRes.status})` }, { status: 502 });
    }
    const tokenData = await tokenRes.json();
    if (tokenData.error || !tokenData.access_token) {
      console.error("[github/app-oauth] OAuth error:", tokenData.error, tokenData.error_description);
      return Response.json({
        error: tokenData.error_description || tokenData.error || "OAuth token exchange failed"
      }, { status: 400 });
    }
    const userToken = tokenData.access_token;
    const installRes = await fetch("https://api.github.com/user/installations", {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Push-App/1.0.0"
      }
    });
    if (!installRes.ok) {
      const errBody = await installRes.text().catch(() => "");
      console.error("[github/app-oauth] Installations fetch failed:", installRes.status, errBody.slice(0, 300));
      return Response.json({ error: `Failed to fetch installations (${installRes.status})` }, { status: 502 });
    }
    const installData = await installRes.json();
    const appId = Number(env.GITHUB_APP_ID);
    const installation = installData.installations.find((inst) => inst.app_id === appId);
    if (!installation) {
      return Response.json({
        error: "No installation found",
        details: "You have not installed the Push Auth GitHub App. Please install it first, then try connecting again.",
        install_url: `https://github.com/apps/push-auth/installations/new`
      }, { status: 404 });
    }
    const installationId = String(installation.id);
    const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
    if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
      return Response.json({ error: "installation_id is not allowed" }, { status: 403 });
    }
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const instTokenData = await exchangeForInstallationToken(jwt, installationId);
    return Response.json({
      token: instTokenData.token,
      expires_at: instTokenData.expires_at,
      installation_id: installationId
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[github/app-oauth] Error:", message);
    return Response.json({ error: `GitHub App OAuth failed: ${message}` }, { status: 500 });
  }
}
__name(handleGitHubAppOAuth, "handleGitHubAppOAuth");
async function handleGitHubAppToken(request, env) {
  const requestUrl = new URL(request.url);
  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return Response.json({ error: "GitHub App not configured" }, { status: 500 });
  }
  const bodyResult = await readBodyText(request, 4096);
  if (!bodyResult.ok) {
    return Response.json({ error: bodyResult.error }, { status: bodyResult.status });
  }
  let payload;
  try {
    payload = JSON.parse(bodyResult.text);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const installationId = payload.installation_id;
  if (!installationId || typeof installationId !== "string") {
    return Response.json({ error: "Missing installation_id" }, { status: 400 });
  }
  if (!/^\d+$/.test(installationId)) {
    return Response.json({ error: "Invalid installation_id format" }, { status: 400 });
  }
  if (installationId.length > 20) {
    return Response.json({ error: "installation_id too long" }, { status: 400 });
  }
  const allowedInstallationIds = (env.GITHUB_ALLOWED_INSTALLATION_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (allowedInstallationIds.length > 0 && !allowedInstallationIds.includes(installationId)) {
    return Response.json({ error: "installation_id is not allowed" }, { status: 403 });
  }
  try {
    const jwt = await generateGitHubAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const tokenData = await exchangeForInstallationToken(jwt, installationId);
    return Response.json(tokenData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[github/app-token] Error:", message);
    return Response.json({ error: `GitHub App authentication failed: ${message}` }, { status: 500 });
  }
}
__name(handleGitHubAppToken, "handleGitHubAppToken");
async function generateGitHubAppJWT(appId, privateKeyPEM) {
  const now = Math.floor(Date.now() / 1e3);
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const encodeBase64Url = /* @__PURE__ */ __name((data) => {
    let base64;
    if (typeof data === "string") {
      base64 = btoa(data);
    } else {
      const bytes = Array.from(data, (b) => String.fromCharCode(b)).join("");
      base64 = btoa(bytes);
    }
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }, "encodeBase64Url");
  const header = { alg: "RS256", typ: "JWT" };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const normalizedPEM = privateKeyPEM.replace(/\\n/g, "\n");
  const isPkcs1 = normalizedPEM.includes("BEGIN RSA PRIVATE KEY");
  const pemHeader = isPkcs1 ? "-----BEGIN RSA PRIVATE KEY-----" : "-----BEGIN PRIVATE KEY-----";
  const pemFooter = isPkcs1 ? "-----END RSA PRIVATE KEY-----" : "-----END PRIVATE KEY-----";
  const pemContents = normalizedPEM.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
  if (!pemContents || pemContents.length < 100) {
    throw new Error(
      `Private key appears empty or truncated (${pemContents.length} base64 chars). If using .dev.vars, wrap the PEM value in double quotes for multiline support.`
    );
  }
  const derBytes = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
  const pkcs8Bytes = isPkcs1 ? wrapPkcs1InPkcs8(derBytes) : derBytes;
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}
__name(generateGitHubAppJWT, "generateGitHubAppJWT");
function wrapPkcs1InPkcs8(pkcs1Der) {
  function asn1Length(len) {
    if (len < 128) return new Uint8Array([len]);
    if (len < 256) return new Uint8Array([129, len]);
    return new Uint8Array([130, len >> 8 & 255, len & 255]);
  }
  __name(asn1Length, "asn1Length");
  const version = new Uint8Array([2, 1, 0]);
  const rsaOid = new Uint8Array([
    48,
    13,
    6,
    9,
    42,
    134,
    72,
    134,
    247,
    13,
    1,
    1,
    1,
    5,
    0
  ]);
  const octetTag = new Uint8Array([4]);
  const octetLen = asn1Length(pkcs1Der.length);
  const innerLen = version.length + rsaOid.length + octetTag.length + octetLen.length + pkcs1Der.length;
  const seqTag = new Uint8Array([48]);
  const seqLen = asn1Length(innerLen);
  const result = new Uint8Array(seqTag.length + seqLen.length + innerLen);
  let off = 0;
  for (const part of [seqTag, seqLen, version, rsaOid, octetTag, octetLen, pkcs1Der]) {
    result.set(part, off);
    off += part.length;
  }
  return result;
}
__name(wrapPkcs1InPkcs8, "wrapPkcs1InPkcs8");
async function exchangeForInstallationToken(jwt, installationId) {
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Push-App/1.0.0"
      }
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API ${response.status}: ${error}`);
  }
  return await response.json();
}
__name(exchangeForInstallationToken, "exchangeForInstallationToken");

// ../../Users/ishaw/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../Users/ishaw/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-1IxSH4/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../Users/ishaw/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-1IxSH4/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
