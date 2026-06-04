/**
 * api-auth-fetch.ts — the first-party `/api/*` auth transport.
 *
 * A single global `window.fetch` wrapper that attaches the Push identity session
 * to every first-party `/api/*` request: the `X-Push-Session` header (the APK /
 * cross-surface fallback) plus `credentials: 'include'` so the `SameSite=None`
 * session cookie rides — even cross-origin from the Capacitor APK
 * (`https://localhost`) to the deployed Worker.
 *
 * This is the surviving half of the former `deployment-auth.ts`: the auth rework
 * (step 3) retired the `X-Push-Deployment-Token` and its `#push_token` /
 * 401-state-machine, but the session transport it carried lives on here. The
 * session itself is stored by `session-auth.ts`; this module is purely
 * transport.
 */

import { SESSION_HEADER, getSessionToken } from './session-auth';

declare global {
  interface Window {
    __pushApiAuthFetchInstalled?: boolean;
  }
}

function getApiOrigins(): Set<string> {
  const origins = new Set<string>();
  if (typeof window === 'undefined') return origins;

  origins.add(window.location.origin);

  const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (apiBase) {
    try {
      origins.add(new URL(apiBase, window.location.href).origin);
    } catch {
      // Invalid API base is handled by the failing fetch; just don't attach
      // private session credentials to an unknown origin.
    }
  }

  return origins;
}

function isFirstPartyApiRequest(input: RequestInfo | URL): boolean {
  if (typeof window === 'undefined') return false;

  const rawUrl =
    input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);

  try {
    const url = new URL(rawUrl, window.location.href);
    return url.pathname.startsWith('/api/') && getApiOrigins().has(url.origin);
  } catch {
    return false;
  }
}

/**
 * Decorate a first-party `/api/*` request: attach the session header (when
 * present) and `credentials: 'include'`. Applied regardless of token presence
 * because the cookie is the primary session carrier on web.
 */
function decorateApiRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );

  const sessionToken = getSessionToken();
  if (sessionToken) headers.set(SESSION_HEADER, sessionToken);

  if (input instanceof Request && !init) {
    return [new Request(input, { headers, credentials: 'include' }), undefined];
  }

  return [input, { ...init, headers, credentials: 'include' }];
}

export function installApiAuthFetch(): void {
  if (typeof window === 'undefined' || window.__pushApiAuthFetchInstalled) return;

  const baseFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const [nextInput, nextInit] = isFirstPartyApiRequest(input)
      ? decorateApiRequest(input, init)
      : ([input, init] as [RequestInfo | URL, RequestInit | undefined]);
    return baseFetch(nextInput, nextInit);
  }) as typeof window.fetch;

  window.__pushApiAuthFetchInstalled = true;
}
