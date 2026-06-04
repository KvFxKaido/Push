import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  evaluateRepoAuth,
  formatRepoNotCoveredMessage,
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

describe('evaluateRepoAuth', () => {
  it('allows ephemeral (no-repo) sandboxes regardless of token kind', () => {
    expect(
      evaluateRepoAuth({ kind: 'pat', hasRepo: false, coverage: 'unknown', acknowledged: false }),
    ).toEqual({ allow: true });
  });

  // Case 1: App installed AND repo covered → installation token, normal path.
  it('allows an installation token when the App covers the repo', () => {
    expect(
      evaluateRepoAuth({ kind: 'app', hasRepo: true, coverage: 'covered', acknowledged: false }),
    ).toEqual({ allow: true });
  });

  // Case 2: App installed but repo NOT covered → actionable block.
  it('blocks an installation token when the App does not cover the repo', () => {
    expect(
      evaluateRepoAuth({
        kind: 'app',
        hasRepo: true,
        coverage: 'not_covered',
        acknowledged: false,
      }),
    ).toEqual({ allow: false, reason: 'app_repo_not_covered' });
  });

  it('fails open for an installation token when coverage is unknown (flaky probe)', () => {
    expect(
      evaluateRepoAuth({ kind: 'app', hasRepo: true, coverage: 'unknown', acknowledged: false }),
    ).toEqual({ allow: true });
  });

  // Case 3 (no App installation, no token) → nothing injected → allow.
  it('allows when there is no token (public clone / ephemeral)', () => {
    expect(
      evaluateRepoAuth({ kind: 'none', hasRepo: true, coverage: 'unknown', acknowledged: false }),
    ).toEqual({ allow: true });
  });

  // Case 4: legacy durable token → one-time ack, independent of coverage.
  it('blocks a legacy durable token until acknowledged', () => {
    expect(
      evaluateRepoAuth({ kind: 'oauth', hasRepo: true, coverage: 'unknown', acknowledged: false }),
    ).toEqual({ allow: false, reason: 'needs_ack' });
    expect(
      evaluateRepoAuth({ kind: 'oauth', hasRepo: true, coverage: 'unknown', acknowledged: true }),
    ).toEqual({ allow: true });
  });

  it('gates pat, env, and unknown the same as oauth (blast-radius parity)', () => {
    for (const kind of ['pat', 'env', 'unknown'] as const) {
      expect(
        evaluateRepoAuth({ kind, hasRepo: true, coverage: 'covered', acknowledged: false }).allow,
      ).toBe(false);
      expect(
        evaluateRepoAuth({ kind, hasRepo: true, coverage: 'covered', acknowledged: true }).allow,
      ).toBe(true);
    }
  });

  it('formats an actionable not-covered message with the install URL', () => {
    const msg = formatRepoNotCoveredMessage(
      'owner/repo',
      'https://github.com/apps/x/installations/new',
    );
    expect(msg).toContain('owner/repo');
    expect(msg).toContain('https://github.com/apps/x/installations/new');
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

  // Case 5: an installation token is preferred over a stored durable token, so
  // the resolved kind is 'app' (→ coverage path, not the durable ack path).
  it('prefers an installation token over a stored durable token', async () => {
    const { getActiveGitHubTokenInfo, APP_TOKEN_STORAGE_KEY, OAUTH_STORAGE_KEY } = await import(
      './github-auth'
    );
    localStorage.store.set(OAUTH_STORAGE_KEY, 'ghp_durablePAT');
    localStorage.store.set(APP_TOKEN_STORAGE_KEY, 'ghs_installationToken');
    expect(getActiveGitHubTokenInfo().kind).toBe('app');
  });
});
