/**
 * settings-config.ts — the server-authoritative web settings document.
 *
 * One JSON document per GitHub identity, stored in KV (`settings:<githubUserId>`)
 * behind the universal `/api/*` session gate. Generalizes the
 * `pr-review-config` round-trip (which keyed a *global* config) into an
 * identity-keyed store so the web app's preferences follow the signed-in user
 * across devices — and so the APK inherits it for free (it loads the prod origin
 * via `server.url`). See
 *   docs/runbooks/Settings Unification — GitHub-Identity-Keyed Config.md
 *   docs/decisions/Platform, Sessions, and Sandbox Decisions.md §11
 *
 * Identity-keyed from day one even though only the web reads it now: keying to a
 * global key (as `pr-review-config` did) makes every future reader a migration.
 * The doc is reused as the storage substrate for the autonomous PR reviewer
 * config (folded in `pr-review-config.ts`) so in-app controls and the webhook
 * reviewer read the same document for the deployment owner.
 *
 * Conflict policy is **last-write-wins per key**: a `PUT` shallow-merges the
 * caller's changed keys into the stored `values`, bumping a single monotonic
 * `updatedAt`. No CRDT — unnecessary at single-user scale (open question #4 in
 * the runbook, resolved to LWW). Per-key merge (rather than whole-document
 * replace) is the natural implementation and avoids a two-hooks-write-at-once
 * clobber without "building more".
 *
 * Reuses the `SNAPSHOT_INDEX` KV binding (same as `pr-review-config`) so the
 * in-app controls need no new binding.
 */

import { extractSessionToken, parseAllowedUserIds, verifySessionToken } from './worker-session';
import type { Env } from './worker-middleware';

const SETTINGS_KEY_PREFIX = 'settings:';

/**
 * Fallback user id when no GitHub identity can be resolved (local dev with no
 * session secret / allowlist configured). The key stays identity-shaped
 * (`settings:anon`) rather than a "global" key, so a configured deployment never
 * lands here. A one-time orphaned-doc rekey is the cost in the unconfigured
 * window; it is logged so it is visible rather than silent.
 */
export const ANON_USER_ID = 'anon';

/**
 * Generous ceiling for the whole document. These are preferences, not content —
 * appearance, toggles, model picks, a short profile. Far below any KV value
 * limit; the cap exists so a buggy or hostile client can't grow the doc
 * unbounded, not because real prefs approach it.
 */
export const MAX_SETTINGS_BYTES = 256 * 1024;

export interface SettingsDoc {
  /** Epoch milliseconds of the last write. 0 for a never-written doc. */
  updatedAt: number;
  /** Canonical-key → JSON value. Keys are owned by their consuming hook. */
  values: Record<string, unknown>;
}

export type SettingsIdentitySource = 'session' | 'allowlist' | 'anon';

export interface ResolvedSettingsIdentity {
  userId: string;
  source: SettingsIdentitySource;
}

function emptyDoc(): SettingsDoc {
  return { updatedAt: 0, values: {} };
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, event, ...ctx }));
}

export function settingsKey(userId: string): string {
  return `${SETTINGS_KEY_PREFIX}${userId}`;
}

/**
 * Resolve the settings owner for a request-less server read (the autonomous PR
 * reviewer reads its config on the webhook path, which carries HMAC auth but no
 * user session). A single-entry allowlist is *the* deployment owner; anything
 * else (empty, or multi-user) can't pick an identity and falls back to anon.
 */
export function resolveOwnerUserId(env: Env): string {
  const allowed = parseAllowedUserIds(env.GITHUB_ALLOWED_USER_IDS);
  if (allowed.size === 1) {
    for (const id of allowed) return id;
  }
  return ANON_USER_ID;
}

/**
 * Resolve the settings owner for an HTTP request. A verified session is the
 * true identity and always wins; otherwise fall back to the single-user
 * deployment owner (so observe-mode requests before login still hit the owner's
 * doc), then anon. Never rejects — allowlisting is the session gate's job; this
 * only keys storage by whoever is verified.
 */
export async function resolveSettingsUserId(
  request: Request,
  env: Env,
): Promise<ResolvedSettingsIdentity> {
  const token = extractSessionToken(request);
  const secret = (env.PUSH_SESSION_SECRET ?? '').trim();
  if (token && secret) {
    const result = await verifySessionToken(secret, token);
    if (result.ok) return { userId: result.claims.sub, source: 'session' };
  }
  const owner = resolveOwnerUserId(env);
  return owner === ANON_USER_ID
    ? { userId: ANON_USER_ID, source: 'anon' }
    : { userId: owner, source: 'allowlist' };
}

function isSettingsDoc(value: unknown): value is SettingsDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Record<string, unknown>;
  return (
    typeof doc.updatedAt === 'number' &&
    Number.isFinite(doc.updatedAt) &&
    !!doc.values &&
    typeof doc.values === 'object' &&
    !Array.isArray(doc.values)
  );
}

/**
 * Read the settings document for a user. Returns an empty doc — never throws —
 * on a missing binding, missing key, or unparseable value, so a settings read
 * never blocks the request. Each non-trivial branch emits a structured log so
 * "empty because new" is distinguishable from "empty because broken".
 */
export async function readSettingsDoc(env: Env, userId: string): Promise<SettingsDoc> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) {
    log('warn', 'settings_kv_unbound', { op: 'read', userId });
    return emptyDoc();
  }
  let raw: string | null;
  try {
    raw = await kv.get(settingsKey(userId));
  } catch (err) {
    log('error', 'settings_read_failed', {
      userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return emptyDoc();
  }
  if (!raw) return emptyDoc();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isSettingsDoc(parsed)) {
      log('warn', 'settings_doc_invalid_shape', { userId });
      return emptyDoc();
    }
    return parsed;
  } catch {
    log('warn', 'settings_doc_parse_failed', { userId });
    return emptyDoc();
  }
}

export type SettingsWriteResult =
  | { ok: true; doc: SettingsDoc }
  | { ok: false; reason: 'no_kv' | 'too_large' };

/**
 * Shallow-merge `incoming` into the stored `values` (last-write-wins per key)
 * and persist. `updatedAt` advances monotonically so a clock that ticks slowly
 * (or two writes in the same millisecond) can't produce a non-increasing
 * timestamp.
 */
export async function writeSettingsMerge(
  env: Env,
  userId: string,
  incoming: Record<string, unknown>,
  nowMs: number = Date.now(),
): Promise<SettingsWriteResult> {
  const kv = env.SNAPSHOT_INDEX;
  if (!kv) {
    log('warn', 'settings_kv_unbound', { op: 'write', userId });
    return { ok: false, reason: 'no_kv' };
  }
  const existing = await readSettingsDoc(env, userId);
  const merged: SettingsDoc = {
    updatedAt: Math.max(nowMs, existing.updatedAt + 1),
    values: { ...existing.values, ...incoming },
  };
  const serialized = JSON.stringify(merged);
  // TextEncoder gives the real UTF-8 byte length; `.length` would undercount
  // multi-byte characters and let an oversized doc slip past.
  if (new TextEncoder().encode(serialized).length > MAX_SETTINGS_BYTES) {
    log('warn', 'settings_doc_too_large', { userId, bytes: serialized.length });
    return { ok: false, reason: 'too_large' };
  }
  await kv.put(settingsKey(userId), serialized);
  log('info', 'settings_doc_written', { userId, keys: Object.keys(incoming).length });
  return { ok: true, doc: merged };
}
