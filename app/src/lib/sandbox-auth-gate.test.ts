import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateSandboxAuthGate,
  hasAcknowledgedUserTokenInjection,
  setAcknowledgedUserTokenInjection,
  SANDBOX_USER_TOKEN_ACK_KEY,
} from './sandbox-auth-gate';

function createStorageMock() {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
  };
}

describe('evaluateSandboxAuthGate', () => {
  it('allows ephemeral (no-repo) sandboxes regardless of token kind', () => {
    expect(evaluateSandboxAuthGate({ kind: 'pat', hasRepo: false, acknowledged: false })).toEqual({
      allow: true,
    });
  });

  it('allows installation tokens without acknowledgment', () => {
    expect(evaluateSandboxAuthGate({ kind: 'app', hasRepo: true, acknowledged: false })).toEqual({
      allow: true,
    });
  });

  it('allows when there is no token', () => {
    expect(evaluateSandboxAuthGate({ kind: 'none', hasRepo: true, acknowledged: false })).toEqual({
      allow: true,
    });
  });

  it('blocks a durable user-scoped token until acknowledged', () => {
    expect(evaluateSandboxAuthGate({ kind: 'oauth', hasRepo: true, acknowledged: false })).toEqual({
      allow: false,
      reason: 'needs_ack',
    });
    expect(evaluateSandboxAuthGate({ kind: 'oauth', hasRepo: true, acknowledged: true })).toEqual({
      allow: true,
    });
  });

  it('gates pat, env, and unknown the same way as oauth (blast-radius parity)', () => {
    for (const kind of ['pat', 'env', 'unknown'] as const) {
      expect(evaluateSandboxAuthGate({ kind, hasRepo: true, acknowledged: false }).allow).toBe(
        false,
      );
      expect(evaluateSandboxAuthGate({ kind, hasRepo: true, acknowledged: true }).allow).toBe(true);
    }
  });
});

describe('user-token injection acknowledgment persistence', () => {
  let localStorage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to not acknowledged', () => {
    expect(hasAcknowledgedUserTokenInjection()).toBe(false);
  });

  it('round-trips set and clear', () => {
    setAcknowledgedUserTokenInjection(true);
    expect(localStorage.store.get(SANDBOX_USER_TOKEN_ACK_KEY)).toBe('1');
    expect(hasAcknowledgedUserTokenInjection()).toBe(true);

    setAcknowledgedUserTokenInjection(false);
    expect(localStorage.store.has(SANDBOX_USER_TOKEN_ACK_KEY)).toBe(false);
    expect(hasAcknowledgedUserTokenInjection()).toBe(false);
  });
});
