/**
 * Unit tests for the Push identity session primitive and the GitHub-identity
 * gate (auth rework, migration step 1 — docs/decisions/Auth Rework — GitHub as
 * the Single Identity Anchor.md).
 *
 * Covers the security-load-bearing behavior: a token only verifies under the
 * minting secret, expiry is enforced, the issuer/audience are pinned, tamper is
 * rejected, and the gate's observe-vs-enforce states behave as designed.
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_AUD,
  SESSION_COOKIE_NAME,
  SESSION_HEADER,
  SESSION_ISS,
  buildSessionSetCookie,
  extractSessionToken,
  mintSessionToken,
  parseAllowedUserIds,
  verifySessionToken,
} from './worker-session';
import { isSessionGatedPath, requireSessionForGatedApi, type Env } from './worker-middleware';

const SECRET = 'test-secret-do-not-use-in-prod';

// Mirror the production base64url + HS256 signing so we can forge tokens with
// arbitrary claims (wrong issuer/audience) that the real minter won't produce.
async function forgeToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify(claims));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${payload}.${sigB64}`;
}

describe('worker-session: mint + verify', () => {
  it('round-trips a minted token under the same secret', async () => {
    const { token, expiresAt, claims } = await mintSessionToken(SECRET, {
      sub: '12345',
      login: 'ishaw',
      installationId: '999',
      nowSeconds: 1_000,
      ttlSeconds: 3_600,
    });

    expect(claims.sub).toBe('12345');
    expect(claims.login).toBe('ishaw');
    expect(claims.installation_id).toBe('999');
    expect(claims.iss).toBe(SESSION_ISS);
    expect(claims.aud).toBe(SESSION_AUD);
    expect(claims.exp).toBe(4_600);
    expect(expiresAt).toBe(new Date(4_600 * 1000).toISOString());

    const result = await verifySessionToken(SECRET, token, 1_000);
    expect(result).toEqual({ ok: true, claims });
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await mintSessionToken(SECRET, { sub: '1', nowSeconds: 0 });
    const result = await verifySessionToken('a-different-secret', token, 1);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', async () => {
    const { token } = await mintSessionToken(SECRET, {
      sub: '1',
      nowSeconds: 1_000,
      ttlSeconds: 60,
    });
    // exp = 1060; verify at 1061 → expired.
    expect(await verifySessionToken(SECRET, token, 1_061)).toEqual({
      ok: false,
      reason: 'expired',
    });
    // Boundary: still valid one second before expiry.
    expect((await verifySessionToken(SECRET, token, 1_059)).ok).toBe(true);
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    const { token } = await mintSessionToken(SECRET, { sub: '1', nowSeconds: 0 });
    const [header, , signature] = token.split('.');
    const forgedPayload = btoa(
      JSON.stringify({ sub: '2', iat: 0, exp: 9e9, iss: 'push', aud: 'push-session' }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    const tampered = `${header}.${forgedPayload}.${signature}`;
    expect(await verifySessionToken(SECRET, tampered, 1)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects non-integer timestamps (no NaN/float expiry bypass)', async () => {
    // A validly-signed token whose exp is a non-integer must not be treated as
    // valid — guards the `exp <= now` check from float/NaN-style payloads.
    const fractionalExp = await forgeToken(SECRET, {
      sub: '1',
      iat: 0,
      exp: 1.5,
      iss: SESSION_ISS,
      aud: SESSION_AUD,
    });
    expect(await verifySessionToken(SECRET, fractionalExp, 0)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects structurally malformed tokens', async () => {
    expect(await verifySessionToken(SECRET, 'only.two')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await verifySessionToken(SECRET, 'a.b.!!!notbase64')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('pins issuer and audience', async () => {
    const wrongIss = await forgeToken(SECRET, {
      sub: '1',
      iat: 0,
      exp: 9e9,
      iss: 'evil',
      aud: SESSION_AUD,
    });
    expect(await verifySessionToken(SECRET, wrongIss, 1)).toEqual({
      ok: false,
      reason: 'wrong_issuer',
    });

    const wrongAud = await forgeToken(SECRET, {
      sub: '1',
      iat: 0,
      exp: 9e9,
      iss: SESSION_ISS,
      aud: 'some-other-app',
    });
    expect(await verifySessionToken(SECRET, wrongAud, 1)).toEqual({
      ok: false,
      reason: 'wrong_audience',
    });
  });
});

describe('worker-session: transport + allowlist', () => {
  it('extracts the token from the header (preferred) then the cookie', async () => {
    const headerReq = new Request('https://x/api/zen/chat', {
      headers: { [SESSION_HEADER]: 'header-token', Cookie: `${SESSION_COOKIE_NAME}=cookie-token` },
    });
    expect(extractSessionToken(headerReq)).toBe('header-token');

    const cookieReq = new Request('https://x/api/zen/chat', {
      headers: { Cookie: `other=1; ${SESSION_COOKIE_NAME}=cookie-token; more=2` },
    });
    expect(extractSessionToken(cookieReq)).toBe('cookie-token');

    expect(extractSessionToken(new Request('https://x/api/zen/chat'))).toBeNull();
  });

  it('builds a SameSite=None; Secure; HttpOnly cookie', () => {
    const cookie = buildSessionSetCookie('abc', 3_600);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('parses comma/space-separated allowlists, ignoring blanks', () => {
    expect([...parseAllowedUserIds('111, 222  333')].sort()).toEqual(['111', '222', '333']);
    expect(parseAllowedUserIds('').size).toBe(0);
    expect(parseAllowedUserIds(undefined).size).toBe(0);
  });
});

describe('worker-session: gated-path predicate', () => {
  it('gates the whole /api surface (universal gate), including formerly-open routes', () => {
    for (const p of [
      // metered
      '/api/zen/chat',
      '/api/anthropic/chat',
      '/api/google/search',
      '/api/search',
      '/api/search/tavily',
      '/api/sandbox/create',
      '/api/sandbox-cf/exec',
      '/api/jobs/start',
      '/api/jobs/abc/events',
      // previously token-only (would have been public on token removal)
      '/api/zen/models',
      '/api/anthropic/models',
      '/api/artifacts/create',
      '/api/library/items/create',
      '/api/github/tools',
      '/api/github/repo-coverage',
      '/api/pr-reviews/run',
      // the client's session probe
      '/api/auth-probe',
    ]) {
      expect(isSessionGatedPath(p)).toBe(true);
    }
  });

  it('exempts only bootstrap + self-authenticating + non-/api paths', () => {
    for (const p of [
      '/api/health',
      '/api/github/webhook', // HMAC
      '/api/github/app-oauth', // mints the session
      '/api/github/app-token', // auth bootstrap
      '/api/github/app-logout',
      '/api/_stats', // admin token
      '/api/admin/snapshots', // admin token
      '/api/relay/v1/session', // device bearer
      '/not-api/chat',
    ]) {
      expect(isSessionGatedPath(p)).toBe(false);
    }
  });
});

describe('requireSessionForGatedApi', () => {
  function makeEnv(overrides: Partial<Env>): Env {
    return overrides as Env;
  }

  async function gatedRequest(token?: string): Promise<Request> {
    return new Request('https://push.example/api/zen/chat', {
      method: 'POST',
      headers: token ? { [SESSION_HEADER]: token } : {},
    });
  }

  it('no-ops on exempt paths regardless of config', async () => {
    const env = makeEnv({ PUSH_SESSION_SECRET: SECRET, GITHUB_ALLOWED_USER_IDS: '1' });
    const req = new Request('https://push.example/api/github/app-oauth', { method: 'POST' });
    expect(await requireSessionForGatedApi(req, env)).toBeNull();
  });

  it('no-ops when unconfigured (no secret or empty allowlist)', async () => {
    expect(await requireSessionForGatedApi(await gatedRequest(), makeEnv({}))).toBeNull();
    expect(
      await requireSessionForGatedApi(
        await gatedRequest(),
        makeEnv({ PUSH_SESSION_SECRET: SECRET, GITHUB_ALLOWED_USER_IDS: '' }),
      ),
    ).toBeNull();
  });

  it('observe mode never blocks, even with no/invalid session', async () => {
    const env = makeEnv({ PUSH_SESSION_SECRET: SECRET, GITHUB_ALLOWED_USER_IDS: '12345' });
    expect(await requireSessionForGatedApi(await gatedRequest(), env)).toBeNull();
    expect(await requireSessionForGatedApi(await gatedRequest('garbage'), env)).toBeNull();
  });

  it('enforce mode allows an allowlisted identity', async () => {
    const env = makeEnv({
      PUSH_SESSION_SECRET: SECRET,
      GITHUB_ALLOWED_USER_IDS: '12345',
      PUSH_SESSION_GATE_ENFORCE: '1',
    });
    const { token } = await mintSessionToken(SECRET, { sub: '12345' });
    expect(await requireSessionForGatedApi(await gatedRequest(token), env)).toBeNull();
  });

  it('enforce mode 401s a non-allowlisted identity', async () => {
    const env = makeEnv({
      PUSH_SESSION_SECRET: SECRET,
      GITHUB_ALLOWED_USER_IDS: '99999',
      PUSH_SESSION_GATE_ENFORCE: '1',
    });
    const { token } = await mintSessionToken(SECRET, { sub: '12345' });
    const res = await requireSessionForGatedApi(await gatedRequest(token), env);
    expect(res?.status).toBe(401);
    const body = (await res?.json()) as { code?: string; reason?: string };
    expect(body.code).toBe('SESSION_AUTH_REQUIRED');
    expect(body.reason).toBe('not_allowlisted');
  });

  it('enforce mode 401s a missing session', async () => {
    const env = makeEnv({
      PUSH_SESSION_SECRET: SECRET,
      GITHUB_ALLOWED_USER_IDS: '12345',
      PUSH_SESSION_GATE_ENFORCE: '1',
    });
    const res = await requireSessionForGatedApi(await gatedRequest(), env);
    expect(res?.status).toBe(401);
    const body = (await res?.json()) as { reason?: string };
    expect(body.reason).toBe('no_session');
  });
});
