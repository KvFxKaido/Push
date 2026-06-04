import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-auth', () => ({
  SESSION_HEADER: 'X-Push-Session',
  getSessionToken: () => mockToken,
}));

let mockToken = '';

import { installApiAuthFetch, subscribeSessionInvalid } from './api-auth-fetch';

// The lib tests run in the `node` environment (no DOM), so we install a minimal
// fake `window`. Manage it explicitly and DELETE it on teardown — leaving a
// `window` defined (even via vi.unstubAllGlobals, which restores to `undefined`
// rather than removing it) flips `typeof window` for other test files in the
// shared worker and changes their SSR-vs-browser rendering.
type FakeWindow = {
  location: { origin: string; href: string };
  fetch: typeof fetch;
  __pushApiAuthFetchInstalled?: boolean;
};
const g = globalThis as { window?: FakeWindow };
let hadWindow: boolean;
let baseFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockToken = 'sess-tok';
  hadWindow = 'window' in g;
  baseFetch = vi.fn(async () => new Response('{}'));
  g.window = {
    location: { origin: 'https://app.test', href: 'https://app.test/' },
    fetch: baseFetch as unknown as typeof fetch,
  };
});

afterEach(() => {
  if (!hadWindow) delete g.window;
});

describe('installApiAuthFetch', () => {
  function lastInit(): RequestInit {
    return baseFetch.mock.calls[0][1] as RequestInit;
  }

  it('attaches the session header + credentials:include on first-party /api requests', async () => {
    installApiAuthFetch();
    await g.window!.fetch('/api/zen/chat', { method: 'POST' });
    const init = lastInit();
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-Push-Session')).toBe('sess-tok');
  });

  it('omits the header with no session token (cookie still rides via credentials)', async () => {
    mockToken = '';
    installApiAuthFetch();
    await g.window!.fetch('/api/zen/models');
    const init = lastInit();
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-Push-Session')).toBeNull();
  });

  it('leaves non-/api requests untouched', async () => {
    installApiAuthFetch();
    await g.window!.fetch('/assets/app.js');
    expect(baseFetch.mock.calls[0][1]).toBeUndefined();
  });

  it('does not attach to a cross-origin /api request', async () => {
    installApiAuthFetch();
    await g.window!.fetch('https://evil.test/api/zen/chat');
    expect(baseFetch.mock.calls[0][1]).toBeUndefined();
  });

  it('is idempotent (only wraps once)', () => {
    installApiAuthFetch();
    const wrapped = g.window!.fetch;
    installApiAuthFetch();
    expect(g.window!.fetch).toBe(wrapped);
  });

  it('notifies session-invalid subscribers on a first-party 401 SESSION_AUTH_REQUIRED', async () => {
    baseFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: 'SESSION_AUTH_REQUIRED' }), { status: 401 }),
    );
    installApiAuthFetch();
    const fired = new Promise<void>((res) => {
      const unsub = subscribeSessionInvalid(() => {
        unsub();
        res();
      });
    });
    await g.window!.fetch('/api/zen/chat', { method: 'POST' });
    await expect(fired).resolves.toBeUndefined();
  });

  it('does not notify on a 401 without the session code', async () => {
    baseFetch.mockResolvedValue(
      new Response(JSON.stringify({ code: 'SOMETHING_ELSE' }), { status: 401 }),
    );
    installApiAuthFetch();
    const cb = vi.fn();
    const unsub = subscribeSessionInvalid(cb);
    await g.window!.fetch('/api/zen/chat');
    await new Promise((r) => setTimeout(r, 0));
    unsub();
    expect(cb).not.toHaveBeenCalled();
  });
});
