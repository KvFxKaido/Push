/**
 * worker-session.ts — the Push web/PWA/APK identity session.
 *
 * Part of the auth rework (docs/decisions/Auth Rework — GitHub as the Single
 * Identity Anchor.md). GitHub verifies a human identity exactly once, at the
 * App-OAuth moment in `worker-infra.ts` (`GET /user` → stable numeric id). The
 * Worker then mints a short-lived HMAC-signed session here and verifies *its
 * own signature* on every subsequent request — so the gated endpoints never
 * re-hit GitHub per request, and there is no copyable identity-less bearer like
 * the deployment token.
 *
 * This is deliberately NOT in root `lib/`: the CLI/daemon has its own remote
 * identity primitive (the Universal Session Bearer), and nothing cross-surface
 * consumes these claims yet. Promote if a second surface needs it.
 *
 * The token is a standard HS256 JWT (`header.payload.signature`, base64url) so
 * it is inspectable with off-the-shelf tooling — honest surfaces over an opaque
 * blob. The signing secret (`PUSH_SESSION_SECRET`) is independent of the
 * GitHub, client, and deployment secrets.
 */

import {
  base64UrlDecodeToBytes,
  base64UrlDecodeToString,
  base64UrlEncodeBytes,
  base64UrlEncodeString,
} from './worker-base64url';

export const SESSION_COOKIE_NAME = 'push_session';
export const SESSION_HEADER = 'X-Push-Session';
export const SESSION_ISS = 'push';
export const SESSION_AUD = 'push-session';

// 24h: short enough to bound a stale identity without a KV revocation list
// (there is none in step 1), long enough that a daily-active owner is not
// re-authing constantly. Revisit if/when revocation lands.
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface PushSessionClaims {
  /** GitHub's stable numeric user id, as a string. The allowlist subject. */
  sub: string;
  /** GitHub login — for logs/observability only, never an authz input. */
  login?: string;
  /** The installation id this session connected through, when known. */
  installation_id?: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  iss: string;
  aud: string;
}

export type SessionVerifyResult =
  | { ok: true; claims: PushSessionClaims }
  | {
      ok: false;
      // Symmetric, enumerable failure reasons so the gate can log *why* a
      // session was rejected instead of a flat "denied".
      reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_issuer' | 'wrong_audience';
    };

const JWT_HEADER = { alg: 'HS256', typ: 'JWT' } as const;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function signingInput(claims: PushSessionClaims): string {
  const header = base64UrlEncodeString(JSON.stringify(JWT_HEADER));
  const payload = base64UrlEncodeString(JSON.stringify(claims));
  return `${header}.${payload}`;
}

export interface MintSessionInput {
  sub: string;
  login?: string;
  installationId?: string;
  /** Epoch seconds "now". Injectable so tests are deterministic. */
  nowSeconds?: number;
  ttlSeconds?: number;
}

export interface MintedSession {
  token: string;
  /** ISO 8601 expiry — matches the shape the OAuth response already returns. */
  expiresAt: string;
  claims: PushSessionClaims;
}

export async function mintSessionToken(
  secret: string,
  input: MintSessionInput,
): Promise<MintedSession> {
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (input.ttlSeconds ?? SESSION_TTL_SECONDS);
  const claims: PushSessionClaims = {
    sub: input.sub,
    ...(input.login ? { login: input.login } : {}),
    ...(input.installationId ? { installation_id: input.installationId } : {}),
    iat,
    exp,
    iss: SESSION_ISS,
    aud: SESSION_AUD,
  };

  const input64 = signingInput(claims);
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input64));
  const token = `${input64}.${base64UrlEncodeBytes(signature)}`;

  return { token, expiresAt: new Date(exp * 1000).toISOString(), claims };
}

function parseClaims(payloadSegment: string): PushSessionClaims | null {
  try {
    const parsed = JSON.parse(
      base64UrlDecodeToString(payloadSegment),
    ) as Partial<PushSessionClaims>;
    if (
      typeof parsed.sub !== 'string' ||
      // Require finite integer timestamps: a non-finite exp (NaN/Infinity)
      // would slip past the `exp <= now` expiry check (NaN comparisons are
      // always false) and read as a never-expiring token.
      !Number.isInteger(parsed.iat) ||
      !Number.isInteger(parsed.exp) ||
      typeof parsed.iss !== 'string' ||
      typeof parsed.aud !== 'string'
    ) {
      return null;
    }
    return parsed as PushSessionClaims;
  } catch {
    return null;
  }
}

export async function verifySessionToken(
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionVerifyResult> {
  const segments = token.split('.');
  if (segments.length !== 3) return { ok: false, reason: 'malformed' };
  const [header64, payload64, signature64] = segments;

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlDecodeToBytes(signature64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const key = await importHmacKey(secret);
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    new TextEncoder().encode(`${header64}.${payload64}`),
  );
  if (!verified) return { ok: false, reason: 'bad_signature' };

  // Only parse claims after the signature is trusted — never act on attacker
  // controlled payload bytes that haven't been authenticated.
  const claims = parseClaims(payload64);
  if (!claims) return { ok: false, reason: 'malformed' };
  if (claims.iss !== SESSION_ISS) return { ok: false, reason: 'wrong_issuer' };
  if (claims.aud !== SESSION_AUD) return { ok: false, reason: 'wrong_audience' };
  if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// Cookie + header transport
// ---------------------------------------------------------------------------
//
// SameSite=None is the honest target: the Capacitor APK runs on
// `https://localhost` and calls the deployed Worker on a different origin, so a
// Lax cookie would never ride those requests. None+Secure is required for that
// cross-site case; same-origin web works under it too. The `X-Push-Session`
// header is the belt-and-suspenders fallback for clients where a cross-site
// webview cookie is unreliable (and mirrors how the deployment token already
// travels as a header).

export function buildSessionSetCookie(
  token: string,
  maxAgeSeconds: number = SESSION_TTL_SECONDS,
): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function buildSessionClearCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
}

function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Resolve the session token from a request: the `X-Push-Session` header takes
 * precedence (explicit client intent, reliable across surfaces), then the
 * cookie.
 */
export function extractSessionToken(request: Request): string | null {
  const header = request.headers.get(SESSION_HEADER)?.trim();
  if (header) return header;
  return readSessionCookie(request.headers.get('Cookie'));
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/**
 * Parse `GITHUB_ALLOWED_USER_IDS` (comma/space-separated numeric GitHub user
 * ids) into a set. Single entry today for the single-user deployment; the set
 * shape lets it widen without a code change.
 */
export function parseAllowedUserIds(raw: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!raw) return ids;
  for (const entry of raw.split(/[,\s]+/)) {
    const trimmed = entry.trim();
    if (trimmed) ids.add(trimmed);
  }
  return ids;
}
