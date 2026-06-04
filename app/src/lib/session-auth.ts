/**
 * session-auth.ts — client-side storage for the Push identity session
 * (auth rework: docs/decisions/Auth Rework — GitHub as the Single Identity
 * Anchor.md).
 *
 * The session is minted by the Worker at GitHub App-OAuth time and travels two
 * ways: a `SameSite=None` cookie (primary; the only thing that works for a pure
 * web client and the natural carrier) and the `X-Push-Session` header (fallback
 * for the Capacitor APK, where a cross-site webview cookie is unreliable). This
 * module owns the header copy in `localStorage`; the transport (attaching the
 * header + `credentials: 'include'` on first-party `/api/*` requests) is wired
 * through the shared fetch chokepoint in `api-auth-fetch.ts`.
 */

import { resolveApiUrl } from './api-url';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';
import { SESSION_HEADER } from './session-constants';

export const SESSION_TOKEN_STORAGE_KEY = 'push_session_token';
export { SESSION_HEADER };

// Session-gated probe: a 200 means the request carried a valid, allowlisted
// session; a 401 means it did not. The sign-in gate uses it to decide whether to
// show the app or the connect screen (auth rework step 3).
export const SESSION_PROBE_PATH = '/api/auth-probe';

export function getSessionToken(): string {
  return safeStorageGet(SESSION_TOKEN_STORAGE_KEY)?.trim() ?? '';
}

/**
 * Probe whether the current request context carries a valid Push session
 * (cookie or header). Resolves `true` on 200, `false` on 401/other. Network
 * errors resolve `false` so the gate fails toward "show connect" rather than
 * silently exposing the app on a flaky probe. The probe rides the global fetch
 * wrapper, so it carries the session automatically.
 */
export async function probeSession(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const res = await window.fetch(resolveApiUrl(SESSION_PROBE_PATH), {
      method: 'GET',
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function setSessionToken(token: string | null | undefined): void {
  const trimmed = (token ?? '').trim();
  if (trimmed) {
    safeStorageSet(SESSION_TOKEN_STORAGE_KEY, trimmed);
  } else {
    safeStorageRemove(SESSION_TOKEN_STORAGE_KEY);
  }
}

export function clearSessionToken(): void {
  setSessionToken(null);
}
