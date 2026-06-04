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
 * through the shared fetch chokepoint in `deployment-auth.ts`.
 */

import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

export const SESSION_TOKEN_STORAGE_KEY = 'push_session_token';
export const SESSION_EXPIRY_STORAGE_KEY = 'push_session_expiry';
// Must match SESSION_HEADER in app/src/worker/worker-session.ts.
export const SESSION_HEADER = 'X-Push-Session';

export function getSessionToken(): string {
  return safeStorageGet(SESSION_TOKEN_STORAGE_KEY)?.trim() ?? '';
}

export function setSessionToken(token: string | null | undefined, expiresAt?: string): void {
  const trimmed = (token ?? '').trim();
  if (trimmed) {
    safeStorageSet(SESSION_TOKEN_STORAGE_KEY, trimmed);
    if (expiresAt) safeStorageSet(SESSION_EXPIRY_STORAGE_KEY, expiresAt);
  } else {
    safeStorageRemove(SESSION_TOKEN_STORAGE_KEY);
    safeStorageRemove(SESSION_EXPIRY_STORAGE_KEY);
  }
}

export function clearSessionToken(): void {
  setSessionToken(null);
}
