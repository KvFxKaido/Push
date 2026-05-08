import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOYMENT_AUTH_REQUIRED_CODE,
  DEPLOYMENT_TOKEN_HEADER,
  DEPLOYMENT_TOKEN_STORAGE_KEY,
  captureDeploymentTokenFromHash,
  getDeploymentAuthState,
  installDeploymentAuthFetch,
  probeDeploymentAuth,
  subscribeDeploymentAuthState,
} from './deployment-auth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: vi.fn(() => {
      data.clear();
    }),
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(data.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function stubBrowser(url: string) {
  const parsed = new URL(url);
  const fetch = vi.fn<typeof window.fetch>(async () => new Response('{}', { status: 200 }));
  const history = {
    state: null,
    replaceState: vi.fn(),
  };
  const localStorage = createStorage();

  vi.stubGlobal('window', {
    location: {
      href: parsed.href,
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
    history,
    localStorage,
    fetch,
    __pushDeploymentAuthFetchInstalled: false,
  });
  vi.stubGlobal('document', { title: 'Push' });

  return { fetch, history, localStorage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deployment-auth', () => {
  it('captures #push_token into localStorage and strips it from the URL', () => {
    const { history, localStorage } = stubBrowser(
      'https://push.example.test/#push_token=secret&tab=chat',
    );

    expect(captureDeploymentTokenFromHash()).toBe('secret');
    expect(localStorage.getItem(DEPLOYMENT_TOKEN_STORAGE_KEY)).toBe('secret');
    expect(history.replaceState).toHaveBeenCalledWith(null, 'Push', '/#tab=chat');
  });

  it('attaches the deployment token to same-origin API fetches', async () => {
    const { fetch, localStorage } = stubBrowser('https://push.example.test/');
    localStorage.setItem(DEPLOYMENT_TOKEN_STORAGE_KEY, 'secret');

    installDeploymentAuthFetch();
    await window.fetch('/api/sandbox/create', { method: 'POST' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get(DEPLOYMENT_TOKEN_HEADER)).toBe('secret');
  });

  it('does not attach the deployment token to non-API or external fetches', async () => {
    const { fetch, localStorage } = stubBrowser('https://push.example.test/');
    localStorage.setItem(DEPLOYMENT_TOKEN_STORAGE_KEY, 'secret');

    installDeploymentAuthFetch();
    await window.fetch('/assets/app.js');
    await window.fetch('https://api.example.test/api/sandbox/create');

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(new Headers(init?.headers).get(DEPLOYMENT_TOKEN_HEADER)).toBeNull();
    }
  });

  it('flips state to "required" when the probe 401s with no stored token', async () => {
    const { fetch } = stubBrowser('https://push.example.test/');
    fetch.mockResolvedValueOnce(jsonResponse({ code: DEPLOYMENT_AUTH_REQUIRED_CODE }, 401));

    const result = await probeDeploymentAuth();

    expect(result).toBe('required');
    expect(getDeploymentAuthState()).toBe('required');
  });

  it('flips state to "invalid" when the probe 401s with a stored token', async () => {
    const { fetch, localStorage } = stubBrowser('https://push.example.test/');
    localStorage.setItem(DEPLOYMENT_TOKEN_STORAGE_KEY, 'stale');
    fetch.mockResolvedValueOnce(jsonResponse({ code: DEPLOYMENT_AUTH_REQUIRED_CODE }, 401));

    const result = await probeDeploymentAuth();

    expect(result).toBe('invalid');
    expect(getDeploymentAuthState()).toBe('invalid');
  });

  it('flips state to "ok" on a 200 probe response', async () => {
    const { fetch } = stubBrowser('https://push.example.test/');
    fetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await probeDeploymentAuth();

    expect(result).toBe('ok');
    expect(getDeploymentAuthState()).toBe('ok');
  });

  it('notifies subscribers of state transitions', async () => {
    const { fetch } = stubBrowser('https://push.example.test/');
    fetch.mockResolvedValueOnce(jsonResponse({ code: DEPLOYMENT_AUTH_REQUIRED_CODE }, 401));
    const observed: string[] = [];
    const unsubscribe = subscribeDeploymentAuthState((s) => observed.push(s));

    await probeDeploymentAuth();
    unsubscribe();

    // Subscribers fire immediately with the current state on subscribe,
    // then again on each transition.
    expect(observed[0]).toBeDefined();
    expect(observed[observed.length - 1]).toBe('required');
  });

  it('flips state via the fetch interceptor on a mid-session 401', async () => {
    const { fetch, localStorage } = stubBrowser('https://push.example.test/');
    localStorage.setItem(DEPLOYMENT_TOKEN_STORAGE_KEY, 'rotated-out');
    fetch.mockResolvedValueOnce(jsonResponse({ code: DEPLOYMENT_AUTH_REQUIRED_CODE }, 401));

    installDeploymentAuthFetch();
    await window.fetch('/api/sandbox/create', { method: 'POST' });
    // The interceptor inspects asynchronously and Response.json() adds
    // another microtask hop; flush the task queue with a 0ms timer.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getDeploymentAuthState()).toBe('invalid');
  });

  it('sends the auth probe with cache: "no-store"', async () => {
    const { fetch } = stubBrowser('https://push.example.test/');
    fetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await probeDeploymentAuth();

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.cache).toBe('no-store');
  });
});
