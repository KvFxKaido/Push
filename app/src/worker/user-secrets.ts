/**
 * user-secrets.ts — identity-keyed, encrypted-at-rest provider API keys.
 *
 * The Settings Unification track (docs/runbooks/Settings Unification —
 * GitHub-Identity-Keyed Config.md) deferred secrets; this is that fold. One
 * KV document per GitHub identity (`usersecrets:<userId>`, same
 * SNAPSHOT_INDEX binding as the settings doc) holding the user's provider
 * API keys, so engine-routed turns — which run server-side in DOs where
 * browser-held keys never arrive — can authenticate with the key the user
 * typed into Settings.
 *
 * ## Encryption
 *
 * Values are AES-256-GCM encrypted with a key HKDF-derived from
 * `PUSH_SESSION_SECRET` (salt/info pinned below). KV is already encrypted at
 * rest by Cloudflare; this layer means a KV-read compromise alone (leaked API
 * token with KV scope) does not yield plaintext keys — the attacker also
 * needs the Worker secret. Deliberately NOT a per-user key: rotation of
 * PUSH_SESSION_SECRET invalidates every stored key (decrypt fails → treated
 * as missing, logged, user re-enters). That trade is acceptable at
 * single-deployment scale and keeps zero extra setup steps.
 *
 * Fail-closed: no PUSH_SESSION_SECRET → writes are rejected (NOT_CONFIGURED)
 * and reads return null. Storing plaintext as a fallback would silently
 * downgrade the at-rest guarantee.
 *
 * ## Resolution order (unchanged)
 *
 * `standardAuth` stays: Worker env secret → request Authorization header.
 * User-stored keys enter as the *injected* Authorization header on the DO's
 * synthetic provider Requests (see coder-job-stream-adapter.ts), so the
 * precedence is env secret → user-stored key → nothing. Browser foreground
 * requests still forward the localStorage key and are unaffected.
 *
 * Key material is never logged and never returned by any read endpoint —
 * list surfaces `last4` + `updatedAt` only.
 */

import { ALL_PROVIDERS, isKnownProvider, type AIProviderType } from '@push/lib/provider-contract';
import type { Env } from './worker-middleware';

const USER_SECRETS_KEY_PREFIX = 'usersecrets:';
const HKDF_SALT = 'push-user-secrets-v1';
const HKDF_INFO = 'provider-api-keys';
/** Generous per-key ceiling — provider keys are well under 1 KiB; the cap
 * exists so a hostile client can't grow the doc unbounded. */
export const MAX_PROVIDER_KEY_CHARS = 4096;

export { ALL_PROVIDERS, isKnownProvider };

interface StoredProviderKey {
  /** base64 AES-GCM IV (12 bytes). */
  iv: string;
  /** base64 ciphertext (includes the GCM tag). */
  ct: string;
  /** Last 4 chars of the plaintext, for the Settings presence UI. */
  last4: string;
  updatedAt: number;
}

interface UserSecretsDoc {
  v: 1;
  updatedAt: number;
  providers: Partial<Record<AIProviderType, StoredProviderKey>>;
}

export interface ProviderKeyMeta {
  last4: string;
  updatedAt: number;
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

export function userSecretsKey(userId: string): string {
  return `${USER_SECRETS_KEY_PREFIX}${userId}`;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

// Derived-key cache, keyed by the secret it came from so a rotated secret
// (new isolate config) can't serve a stale key.
let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function deriveAesKey(sessionSecret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.secret === sessionSecret) return cachedKey.key;
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(sessionSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  cachedKey = { secret: sessionSecret, key };
  return key;
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function encryptValue(
  sessionSecret: string,
  plaintext: string,
): Promise<{ iv: string; ct: string }> {
  const key = await deriveAesKey(sessionSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function decryptValue(
  sessionSecret: string,
  stored: StoredProviderKey,
): Promise<string | null> {
  try {
    const key = await deriveAesKey(sessionSecret);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(stored.iv) as unknown as BufferSource },
      key,
      fromBase64(stored.ct) as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Document I/O
// ---------------------------------------------------------------------------

function emptyDoc(): UserSecretsDoc {
  return { v: 1, updatedAt: 0, providers: {} };
}

function isUserSecretsDoc(value: unknown): value is UserSecretsDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  return doc.v === 1 && !!doc.providers && typeof doc.providers === 'object';
}

async function readDoc(env: Env, userId: string): Promise<UserSecretsDoc> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) {
    log('warn', 'user_secrets_kv_unbound', { op: 'read', userId });
    return emptyDoc();
  }
  let raw: string | null;
  try {
    raw = await kv.get(userSecretsKey(userId));
  } catch (err) {
    log('error', 'user_secrets_read_failed', {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return emptyDoc();
  }
  if (!raw) return emptyDoc();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isUserSecretsDoc(parsed)) {
      log('warn', 'user_secrets_doc_invalid_shape', { userId });
      return emptyDoc();
    }
    return parsed;
  } catch {
    log('warn', 'user_secrets_doc_parse_failed', { userId });
    return emptyDoc();
  }
}

export type UserSecretWriteResult =
  | { ok: true }
  | { ok: false; reason: 'no_kv' | 'not_configured' | 'invalid_provider' | 'too_large' };

/**
 * Store (or overwrite) one provider key for a user. Same non-atomic
 * read-modify-write trade as the settings doc (LWW at single-user scale).
 */
export async function putUserProviderKey(
  env: Env,
  userId: string,
  provider: string,
  key: string,
  nowMs: number = Date.now(),
): Promise<UserSecretWriteResult> {
  if (!isKnownProvider(provider)) return { ok: false, reason: 'invalid_provider' };
  if (key.length > MAX_PROVIDER_KEY_CHARS) return { ok: false, reason: 'too_large' };
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) {
    log('warn', 'user_secrets_kv_unbound', { op: 'write', userId });
    return { ok: false, reason: 'no_kv' };
  }
  const sessionSecret = (env.PUSH_SESSION_SECRET ?? '').trim();
  if (!sessionSecret) {
    log('warn', 'user_secrets_not_configured', { op: 'write', userId, provider });
    return { ok: false, reason: 'not_configured' };
  }
  const doc = await readDoc(env, userId);
  const { iv, ct } = await encryptValue(sessionSecret, key);
  doc.providers[provider] = { iv, ct, last4: key.slice(-4), updatedAt: nowMs };
  doc.updatedAt = Math.max(nowMs, doc.updatedAt + 1);
  await kv.put(userSecretsKey(userId), JSON.stringify(doc));
  log('info', 'user_secret_stored', { userId, provider, last4: key.slice(-4) });
  return { ok: true };
}

/**
 * Deliberately NOT gated on PUSH_SESSION_SECRET (unlike put, which can't
 * encrypt without it): removing stored data must always be possible — a
 * deployment that lost its session secret should still be able to purge
 * keys it can no longer decrypt, and a delete can't leak or downgrade
 * anything. The asymmetry is intentional (push-agent review, PR #890).
 */
export async function deleteUserProviderKey(
  env: Env,
  userId: string,
  provider: string,
  nowMs: number = Date.now(),
): Promise<UserSecretWriteResult> {
  if (!isKnownProvider(provider)) return { ok: false, reason: 'invalid_provider' };
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) {
    log('warn', 'user_secrets_kv_unbound', { op: 'delete', userId });
    return { ok: false, reason: 'no_kv' };
  }
  const doc = await readDoc(env, userId);
  if (!doc.providers[provider]) {
    // Idempotent delete — nothing stored is success, but log it so a
    // mismatched-provider bug is visible rather than silent.
    log('info', 'user_secret_delete_noop', { userId, provider });
    return { ok: true };
  }
  delete doc.providers[provider];
  doc.updatedAt = Math.max(nowMs, doc.updatedAt + 1);
  await kv.put(userSecretsKey(userId), JSON.stringify(doc));
  log('info', 'user_secret_deleted', { userId, provider });
  return { ok: true };
}

/**
 * Resolve one provider key for server-side dispatch. Null on every miss
 * path; each distinct branch logs once so "no key" is distinguishable from
 * "key exists but the session secret rotated" (the latter needs the user to
 * re-enter the key, and silence here would make engine 401s undiagnosable —
 * the exact failure class this module exists to fix).
 */
export async function getUserProviderKey(
  env: Env,
  userId: string | undefined,
  provider: AIProviderType,
): Promise<string | null> {
  if (!userId) return null;
  const sessionSecret = (env.PUSH_SESSION_SECRET ?? '').trim();
  if (!sessionSecret) {
    // Loud on purpose: without this line a missing/rotated session secret
    // surfaces only as provider 401s on the engine path — invisible to ops
    // (push-agent review, PR #890). One line per dispatch is the cost.
    log('warn', 'user_secrets_not_configured', { op: 'read', userId, provider });
    return null;
  }
  const doc = await readDoc(env, userId);
  const stored = doc.providers[provider];
  if (!stored) return null;
  const plain = await decryptValue(sessionSecret, stored);
  if (plain === null) {
    log('warn', 'user_secret_decrypt_failed', { userId, provider });
    return null;
  }
  return plain;
}

/** Presence metadata for the Settings UI and the capability probe — never
 * returns key material. */
export async function listUserProviderKeyMeta(
  env: Env,
  userId: string,
): Promise<Partial<Record<AIProviderType, ProviderKeyMeta>>> {
  const doc = await readDoc(env, userId);
  const out: Partial<Record<AIProviderType, ProviderKeyMeta>> = {};
  for (const provider of ALL_PROVIDERS) {
    const stored = doc.providers[provider];
    if (stored) out[provider] = { last4: stored.last4, updatedAt: stored.updatedAt };
  }
  return out;
}
