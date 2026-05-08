import { safeStorageGet, safeStorageRemove, safeStorageSet } from './safe-storage';

export const DEPLOYMENT_TOKEN_HEADER = 'X-Push-Deployment-Token';
export const DEPLOYMENT_TOKEN_STORAGE_KEY = 'push_deployment_token';
export const DEPLOYMENT_TOKEN_HASH_PARAM = 'push_token';
export const DEPLOYMENT_AUTH_PROBE_PATH = '/api/auth-probe';
export const DEPLOYMENT_AUTH_REQUIRED_CODE = 'DEPLOYMENT_AUTH_REQUIRED';

export type DeploymentAuthState = 'unknown' | 'ok' | 'required' | 'invalid';
type Listener = (state: DeploymentAuthState) => void;
const listeners = new Set<Listener>();
let currentState: DeploymentAuthState = 'unknown';

function setState(next: DeploymentAuthState): void {
  if (next === currentState) return;
  currentState = next;
  for (const listener of listeners) listener(next);
}

declare global {
  interface Window {
    __pushDeploymentAuthFetchInstalled?: boolean;
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
      // private deployment credentials to an unknown origin.
    }
  }

  return origins;
}

function shouldAttachDeploymentToken(input: RequestInfo | URL): boolean {
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

function withDeploymentToken(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  token: string,
): [RequestInfo | URL, RequestInit | undefined] {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(DEPLOYMENT_TOKEN_HEADER, token);

  if (input instanceof Request && !init) {
    return [new Request(input, { headers }), undefined];
  }

  return [input, { ...init, headers }];
}

export function getDeploymentToken(): string {
  return safeStorageGet(DEPLOYMENT_TOKEN_STORAGE_KEY)?.trim() ?? '';
}

export function setDeploymentToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) {
    safeStorageSet(DEPLOYMENT_TOKEN_STORAGE_KEY, trimmed);
  } else {
    safeStorageRemove(DEPLOYMENT_TOKEN_STORAGE_KEY);
  }
}

export function captureDeploymentTokenFromHash(): string {
  if (typeof window === 'undefined') return '';

  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!rawHash.includes(DEPLOYMENT_TOKEN_HASH_PARAM)) return '';

  const params = new URLSearchParams(rawHash);
  const token = params.get(DEPLOYMENT_TOKEN_HASH_PARAM)?.trim() ?? '';
  if (!token) return '';

  setDeploymentToken(token);
  params.delete(DEPLOYMENT_TOKEN_HASH_PARAM);

  const nextHash = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${
    nextHash ? `#${nextHash}` : ''
  }`;
  const title = typeof document === 'undefined' ? '' : document.title;
  window.history.replaceState(window.history.state, title, nextUrl);

  return token;
}

async function inspectDeploymentAuthResponse(
  res: Response,
  input: RequestInfo | URL,
): Promise<void> {
  if (res.status !== 401 || !shouldAttachDeploymentToken(input)) return;
  try {
    const body = (await res.clone().json()) as { code?: unknown };
    if (body?.code === DEPLOYMENT_AUTH_REQUIRED_CODE) {
      setState(getDeploymentToken() ? 'invalid' : 'required');
    }
  } catch {
    // body wasn't JSON or already consumed — leave state alone
  }
}

export function getDeploymentAuthState(): DeploymentAuthState {
  return currentState;
}

export function subscribeDeploymentAuthState(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

export async function probeDeploymentAuth(): Promise<DeploymentAuthState> {
  if (typeof window === 'undefined') return currentState;
  try {
    const res = await fetch(DEPLOYMENT_AUTH_PROBE_PATH, { method: 'GET' });
    if (res.ok) {
      setState('ok');
      return 'ok';
    }
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { code?: unknown };
      if (body?.code === DEPLOYMENT_AUTH_REQUIRED_CODE) {
        const next: DeploymentAuthState = getDeploymentToken() ? 'invalid' : 'required';
        setState(next);
        return next;
      }
    }
  } catch {
    // network noise — leave state alone, app surfaces its own offline UI
  }
  return currentState;
}

export function installDeploymentAuthFetch(): void {
  if (typeof window === 'undefined' || window.__pushDeploymentAuthFetchInstalled) return;

  captureDeploymentTokenFromHash();
  const baseFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = getDeploymentToken();
    const [nextInput, nextInit] =
      token && shouldAttachDeploymentToken(input)
        ? withDeploymentToken(input, init, token)
        : ([input, init] as [RequestInfo | URL, RequestInit | undefined]);
    const res = await baseFetch(nextInput, nextInit);
    void inspectDeploymentAuthResponse(res, input);
    return res;
  }) as typeof window.fetch;

  window.__pushDeploymentAuthFetchInstalled = true;
}
