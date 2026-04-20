/**
 * Admin-only Worker endpoints for observing Worker-owned state.
 *
 * The only route today is `GET /api/admin/snapshots`, which surfaces the
 * contents of the SNAPSHOT_INDEX KV namespace for debugging resume failures
 * and tracking index growth between daily cron summaries.
 *
 * Security model — three gates, applied in order:
 *   1. Origin validation (same as every other proxy route).
 *   2. ADMIN_TOKEN env secret. If unset, these routes return 404 so the
 *      endpoint is invisible unless explicitly provisioned.
 *   3. `X-Admin-Token` header, compared with a timing-safe equality check.
 *
 * Responses redact credential-like fields (imageId, restoreToken) —
 * operators should see metadata (what exists, when it was last touched,
 * how big it is), never handles that could authorize a restore.
 */

import type { Env } from './worker-middleware';
import { validateOrigin, wlog, getClientIp } from './worker-middleware';
import { listSnapshots, type SnapshotIndexEntry } from './snapshot-index';

const ADMIN_TOKEN_HEADER = 'X-Admin-Token';

export async function handleAdminSnapshots(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);

  const originCheck = validateOrigin(request, requestUrl, env);
  if (!originCheck.ok) {
    return Response.json({ error: originCheck.error }, { status: 403 });
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

  const { success: rateLimitOk } = await env.RATE_LIMITER.limit({ key: getClientIp(request) });
  if (!rateLimitOk) {
    return Response.json(
      { error: 'Rate limit exceeded. Try again later.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  if (!env.SNAPSHOT_INDEX) {
    return Response.json(
      { error: 'Snapshot index binding missing', code: 'KV_NOT_BOUND' },
      { status: 503 },
    );
  }

  const now = Date.now();
  const entries = await listSnapshots(env.SNAPSHOT_INDEX);

  let totalSizeBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const e of entries) {
    totalSizeBytes += e.sizeBytes ?? 0;
    if (oldest === null || e.lastAccessedAt < oldest) oldest = e.lastAccessedAt;
    if (newest === null || e.lastAccessedAt > newest) newest = e.lastAccessedAt;
  }

  return Response.json({
    generatedAt: new Date(now).toISOString(),
    summary: {
      total: entries.length,
      totalSizeBytes,
      oldestAccessedAtIso: oldest ? new Date(oldest).toISOString() : null,
      newestAccessedAtIso: newest ? new Date(newest).toISOString() : null,
    },
    entries: entries.map((e) => redactEntry(e, now)),
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

function redactEntry(entry: SnapshotIndexEntry, now: number) {
  return {
    repoFullName: entry.repoFullName,
    branch: entry.branch,
    createdAtIso: new Date(entry.createdAt).toISOString(),
    lastAccessedAtIso: new Date(entry.lastAccessedAt).toISOString(),
    ageSeconds: Math.floor((now - entry.lastAccessedAt) / 1000),
    sizeBytes: entry.sizeBytes ?? null,
    // Intentionally omitted: imageId, restoreToken (credentials),
    // v (internal schema version).
  };
}
