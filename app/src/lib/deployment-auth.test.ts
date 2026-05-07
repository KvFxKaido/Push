import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOYMENT_TOKEN_HEADER,
  DEPLOYMENT_TOKEN_STORAGE_KEY,
  captureDeploymentTokenFromHash,
  installDeploymentAuthFetch,
} from './deployment-auth';

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
});
