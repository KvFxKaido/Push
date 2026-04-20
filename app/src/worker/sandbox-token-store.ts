/**
 * Owner-token store for the Cloudflare sandbox path.
 *
 * Modal binds every sandbox op to an owner token server-side; Push's CF
 * scaffold shipped without that layer, leaving `sandboxId`-guessing as the
 * only gate beyond origin + rate-limit. This module adds the missing layer
 * using a per-provider KV namespace (SANDBOX_TOKENS).
 *
 * Storage shape:
 *   key:   "token:<sandboxId>"
 *   value: { token: string, createdAt: number, ownerHint?: string }
 *
 * The 24-hour TTL is a safety net for the case where `routeCleanup` fails
 * to delete the entry explicitly. Tokens that outlive their sandbox are
 * harmless (verify() will succeed, but no routes will reach a live
 * container) — the TTL just keeps KV tidy.
 *
 * Separate binding from SNAPSHOT_INDEX per the per-provider-prefix
 * discipline in `lib/sandbox-provider.ts` — if a future provider wants its
 * own token store, give it its own binding rather than sharing keys here.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

const KEY_PREFIX = 'token:';
const TTL_SECONDS = 86_400; // 24h

interface TokenRecord {
  token: string;
  createdAt: number;
  ownerHint?: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; status: 404; code: 'NOT_FOUND' }
  | { ok: false; status: 403; code: 'AUTH_FAILURE' }
  | { ok: false; status: 503; code: 'NOT_CONFIGURED' };

/**
 * Generate a fresh owner token and persist it against a sandboxId. Called
 * exactly once per sandbox, from routeCreate; the returned token is
 * surfaced in the create response for the client to stash.
 */
export async function issueToken(
  store: KVNamespace,
  sandboxId: string,
  ownerHint?: string,
): Promise<string> {
  const token = crypto.randomUUID();
  const record: TokenRecord = {
    token,
    createdAt: Date.now(),
    ...(ownerHint !== undefined ? { ownerHint } : {}),
  };
  await store.put(`${KEY_PREFIX}${sandboxId}`, JSON.stringify(record), {
    expirationTtl: TTL_SECONDS,
  });
  return token;
}

/**
 * Verify a caller-provided token against the stored one for a sandboxId.
 * Always fails closed: missing store → 503; missing record → 404;
 * mismatch → 403.
 *
 * Uses a timing-safe comparison so attackers can't shortcut the match by
 * measuring per-byte response time. The constant-time property matters
 * less for 122-bit UUID tokens than for short secrets, but it's free to
 * do right and matches the habit we want everywhere else.
 */
export async function verifyToken(
  store: KVNamespace | undefined,
  sandboxId: string,
  providedToken: string,
): Promise<VerifyResult> {
  if (!store) {
    return { ok: false, status: 503, code: 'NOT_CONFIGURED' };
  }
  if (!sandboxId || !providedToken) {
    // Reject malformed inputs at the shape level rather than passing them
    // to KV — avoids a wasted roundtrip on obvious bad requests.
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }
  const raw = await store.get(`${KEY_PREFIX}${sandboxId}`, 'json');
  const record = raw as TokenRecord | null;
  if (!record) {
    return { ok: false, status: 404, code: 'NOT_FOUND' };
  }
  if (!timingSafeEqual(record.token, providedToken)) {
    return { ok: false, status: 403, code: 'AUTH_FAILURE' };
  }
  return { ok: true };
}

/**
 * Remove a sandbox's token record. Called from routeCleanup after the DO
 * is destroyed. Idempotent — deleting a missing key is a no-op on KV.
 */
export async function revokeToken(
  store: KVNamespace | undefined,
  sandboxId: string,
): Promise<void> {
  if (!store) return;
  await store.delete(`${KEY_PREFIX}${sandboxId}`);
}

/**
 * Constant-time string equality. Works byte-wise on UTF-8 encodings so
 * unequal lengths still run a full scan against the longer string before
 * returning false — no early-exit length-comparison leak.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i += 1) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}
