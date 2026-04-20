/**
 * Admin-only Worker endpoints for observing Worker-owned state.
 *
 * The only route today is `GET /api/admin/snapshots`, which surfaces the
 * contents of the SNAPSHOT_INDEX KV namespace for debugging resume failures
 * and tracking index growth between daily cron summaries.
 *
 * Security model — two gates, applied in order:
 *   1. Per-IP rate limiting (throttles brute-force attempts on the token).
 *   2. `X-Admin-Token` header compared with a timing-safe equality check
 *      against the `ADMIN_TOKEN` env secret. If the secret is unset the
 *      endpoint returns 404 so it is invisible unless explicitly provisioned.
 *
 * Deliberately skipping origin validation here: these routes authenticate via
 * an explicit bearer-style header that browsers never send ambiently, so the
 * origin check protects nothing (CORS prevents a cross-origin read anyway)
 * while actively breaking curl/CLI operator use. Other proxy routes still
 * gate on origin because they accept ambient credentials (cookies, assistant
 * tokens) where CSRF matters.
 *
 * Responses redact credential-like fields (imageId, restoreToken) —
 * operators should see metadata (what exists, when it was last touched,
 * how big it is), never handles that could authorize a restore.
 */

import type { Env } from './worker-middleware';
import { wlog, getClientIp } from './worker-middleware';
import { listSnapshots, type SnapshotIndexEntry } from './snapshot-index';

const ADMIN_TOKEN_HEADER = 'X-Admin-Token';
/**
 * Defensive cap on entries materialized into the response. Protects against
 * Worker memory/response-size blowups if the index ever grows large. The
 * 7-day TTL + per-repo/branch keying keeps the realistic footprint well
 * below this, but the cron's `summarizeSnapshotIndex` is the right surface
 * for unbounded walks — this endpoint is for operator spot-checks.
 */
export const MAX_ADMIN_ENTRIES = 500;

export async function handleAdminSnapshots(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);

  // Rate limit first so brute-force attempts on the token are throttled even
  // if no token is provided.
  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  const auth = checkAdminAuth(request, env);
  if (auth === 'unconfigured') {
    // 404 (not 401) when disabled so the endpoint doesn't advertise itself.
    return new Response('Not Found', { status: 404 });
  }
  if (auth === 'denied') {
    wlog('warn', 'admin_denied', {
      ip: getClientIp(request),
      path: requestUrl.pathname,
    });
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!env.SNAPSHOT_INDEX) {
    return Response.json(
      { error: 'Snapshot index binding missing', code: 'KV_NOT_BOUND' },
      { status: 503 },
    );
  }

  const now = Date.now();
  const allEntries = await listSnapshots(env.SNAPSHOT_INDEX);
  const truncated = allEntries.length > MAX_ADMIN_ENTRIES;
  const entries = truncated ? allEntries.slice(0, MAX_ADMIN_ENTRIES) : allEntries;

  // Aggregate and redact in a single pass — one allocation instead of two,
  // and the Number.isFinite guard means corrupted timestamps can't poison
  // the min/max calculation.
  let totalSizeBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const redactedEntries: ReturnType<typeof redactEntry>[] = [];
  for (const e of entries) {
    totalSizeBytes += e.sizeBytes ?? 0;
    if (Number.isFinite(e.lastAccessedAt)) {
      if (oldest === null || e.lastAccessedAt < oldest) oldest = e.lastAccessedAt;
      if (newest === null || e.lastAccessedAt > newest) newest = e.lastAccessedAt;
    }
    redactedEntries.push(redactEntry(e, now));
  }

  return Response.json({
    generatedAt: new Date(now).toISOString(),
    summary: {
      total: allEntries.length,
      returned: entries.length,
      truncated,
      totalSizeBytes,
      // Explicit null check — `0` is a valid (if impossible here) timestamp.
      oldestAccessedAtIso: oldest !== null ? new Date(oldest).toISOString() : null,
      newestAccessedAtIso: newest !== null ? new Date(newest).toISOString() : null,
    },
    entries: redactedEntries,
  });
}

type AuthResult = 'ok' | 'denied' | 'unconfigured';

function checkAdminAuth(request: Request, env: Env): AuthResult {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return 'unconfigured';
  const provided = request.headers.get(ADMIN_TOKEN_HEADER);
  if (!provided) return 'denied';
  return timingSafeEqual(provided, expected) ? 'ok' : 'denied';
}

/**
 * Constant-time string comparison. Plain `===` leaks length info via
 * early-exit timing; this XORs every byte pair so comparison time depends
 * only on the inputs' shared length, not on the position of a mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function toIsoStringOrNull(timestamp: number): string | null {
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function redactEntry(entry: SnapshotIndexEntry, now: number) {
  const lastAccessedFinite = Number.isFinite(entry.lastAccessedAt);
  return {
    repoFullName: entry.repoFullName,
    branch: entry.branch,
    createdAtIso: toIsoStringOrNull(entry.createdAt),
    lastAccessedAtIso: toIsoStringOrNull(entry.lastAccessedAt),
    // clamp to 0 — if the stored timestamp is slightly ahead of `now` due to
    // clock skew between the Worker that wrote the entry and the one serving
    // this read, surface 0 rather than a negative "age".
    ageSeconds: lastAccessedFinite
      ? Math.max(0, Math.floor((now - entry.lastAccessedAt) / 1000))
      : null,
    sizeBytes: entry.sizeBytes ?? null,
    // Intentionally omitted: imageId, restoreToken (credentials),
    // v (internal schema version).
  };
}
