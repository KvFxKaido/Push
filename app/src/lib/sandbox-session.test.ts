import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSandboxSessionStorageKey,
  clearSandboxSessionByStorageKey,
  decideReconnectProbe,
  isSavedSessionRecoverable,
  loadSandboxSession,
  markSandboxSessionMutated,
  type ReconnectAttempt,
  saveSandboxSession,
  shouldRetryReconnect,
  touchSandboxSessionActivity,
  type PersistedSandboxSession,
} from './sandbox-session';

function createStorageMock() {
  const data = new Map<string, string>();

  return {
    data,
    getItem: vi.fn((key: string) => (data.has(key) ? data.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

function createSession(overrides: Partial<PersistedSandboxSession> = {}): PersistedSandboxSession {
  return {
    sandboxId: 'sb-123',
    ownerToken: 'owner-token',
    repoFullName: 'owner/repo',
    branch: 'main',
    createdAt: 123456,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sandbox-session', () => {
  it('keys repo sessions by repo and branch', () => {
    expect(buildSandboxSessionStorageKey('owner/repo', 'main')).toBe(
      'sandbox_session:repo%3Aowner%2Frepo:main',
    );
    expect(buildSandboxSessionStorageKey('owner/repo', 'feature/test')).toBe(
      'sandbox_session:repo%3Aowner%2Frepo:feature%2Ftest',
    );
  });

  it('uses a dedicated scratch key', () => {
    expect(buildSandboxSessionStorageKey('', 'main')).toBe('sandbox_session:__scratch__:main');
  });

  it('returns null for repo sessions without a branch', () => {
    expect(buildSandboxSessionStorageKey('owner/repo', null)).toBeNull();
  });

  it('saves and loads a branch-scoped session', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const session = createSession({ branch: 'feature-x' });
    saveSandboxSession('owner/repo', 'feature-x', session);

    expect(loadSandboxSession('owner/repo', 'feature-x')).toEqual(session);
    expect(loadSandboxSession('owner/repo', 'main')).toBeNull();
  });

  it('migrates matching legacy session data once', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const legacy = createSession({ repoFullName: 'owner/repo', branch: 'main' });
    localStorage.setItem('sandbox_session', JSON.stringify(legacy));

    expect(loadSandboxSession('owner/repo', 'main')).toEqual(legacy);
    expect(localStorage.removeItem).toHaveBeenCalledWith('sandbox_session');
    expect(localStorage.getItem('sandbox_session:repo%3Aowner%2Frepo:main')).toBe(
      JSON.stringify(legacy),
    );
  });

  it('does not migrate legacy session data across branches', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const legacy = createSession({ repoFullName: 'owner/repo', branch: 'main' });
    localStorage.setItem('sandbox_session', JSON.stringify(legacy));

    expect(loadSandboxSession('owner/repo', 'feature-x')).toBeNull();
    expect(localStorage.getItem('sandbox_session')).toBe(JSON.stringify(legacy));
  });

  it('clears session by storage key', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const key = buildSandboxSessionStorageKey('owner/repo', 'main');
    expect(key).not.toBeNull();
    localStorage.setItem(key!, JSON.stringify(createSession()));

    expect(clearSandboxSessionByStorageKey(key)).toBe(true);
    expect(localStorage.getItem(key!)).toBeNull();
  });

  it('does not clear a storage key that now belongs to a different sandbox', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

    const key = buildSandboxSessionStorageKey('owner/repo', 'main');
    expect(key).not.toBeNull();
    localStorage.setItem(key!, JSON.stringify(createSession({ sandboxId: 'sb-newer' })));

    expect(clearSandboxSessionByStorageKey(key, 'sb-older')).toBe(false);
    expect(localStorage.getItem(key!)).toBe(
      JSON.stringify(createSession({ sandboxId: 'sb-newer' })),
    );
  });

  describe('touchSandboxSessionActivity', () => {
    it('updates only lastActivityAt on the matching session', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      saveSandboxSession('owner/repo', 'main', createSession({ snapshotId: 'snap-1' }));

      expect(touchSandboxSessionActivity('owner/repo', 'main', 'sb-123', 999)).toBe(true);
      expect(loadSandboxSession('owner/repo', 'main')).toEqual(
        createSession({ snapshotId: 'snap-1', lastActivityAt: 999 }),
      );
    });

    it('is a no-op when the stored session points at a different sandbox', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      saveSandboxSession('owner/repo', 'main', createSession({ sandboxId: 'sb-newer' }));

      // A stale interval from a swapped-out container must not stamp the new one.
      expect(touchSandboxSessionActivity('owner/repo', 'main', 'sb-older', 999)).toBe(false);
      expect(loadSandboxSession('owner/repo', 'main')?.lastActivityAt).toBeUndefined();
    });

    it('is a no-op when no session is stored', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      expect(touchSandboxSessionActivity('owner/repo', 'main', 'sb-123', 999)).toBe(false);
    });
  });

  describe('markSandboxSessionMutated', () => {
    it('flips hasMutated to true on the matching session', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      saveSandboxSession('owner/repo', 'main', createSession({ hasMutated: false }));

      expect(markSandboxSessionMutated('owner/repo', 'main', 'sb-123')).toBe(true);
      expect(loadSandboxSession('owner/repo', 'main')).toEqual(createSession({ hasMutated: true }));
    });

    it('is idempotent once already true', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      saveSandboxSession('owner/repo', 'main', createSession({ hasMutated: true }));

      expect(markSandboxSessionMutated('owner/repo', 'main', 'sb-123')).toBe(true);
      expect(loadSandboxSession('owner/repo', 'main')).toEqual(createSession({ hasMutated: true }));
    });

    it('is a no-op when the stored session points at a different sandbox', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      saveSandboxSession(
        'owner/repo',
        'main',
        createSession({ sandboxId: 'sb-newer', hasMutated: false }),
      );

      expect(markSandboxSessionMutated('owner/repo', 'main', 'sb-older')).toBe(false);
      expect(loadSandboxSession('owner/repo', 'main')?.hasMutated).toBe(false);
    });

    it('is a no-op when no session is stored', () => {
      const localStorage = createStorageMock();
      vi.stubGlobal('window', { localStorage, sessionStorage: createStorageMock() });

      expect(markSandboxSessionMutated('owner/repo', 'main', 'sb-123')).toBe(false);
    });
  });

  describe('isSavedSessionRecoverable', () => {
    const MAX = 50 * 60 * 1000;

    it('keeps a young session even with no snapshot or recent activity', () => {
      expect(
        isSavedSessionRecoverable({
          ageMs: 1000,
          idleMs: Infinity,
          hasSnapshot: false,
          maxAgeMs: MAX,
        }),
      ).toBe(true);
    });

    it('keeps an old but recently-active session (the long-active container case)', () => {
      // createdAt is hours old, but a real call landed a minute ago → CF's
      // sleepAfter clock was just reset → the container is almost certainly live.
      expect(
        isSavedSessionRecoverable({
          ageMs: 3 * 60 * 60 * 1000,
          idleMs: 60 * 1000,
          hasSnapshot: false,
          maxAgeMs: MAX,
        }),
      ).toBe(true);
    });

    it('keeps an old session whose persisted activity is within the caller grace window', () => {
      // `lastActivityAt` is maintained by an interval, so it can be slightly
      // stale when a reload lands between a real call and the next persistence
      // tick. The caller can allow that staleness without extending the raw age
      // gate for sessions that were never recently active.
      expect(
        isSavedSessionRecoverable({
          ageMs: 3 * 60 * 60 * 1000,
          idleMs: MAX + 30 * 1000,
          hasSnapshot: false,
          maxAgeMs: MAX,
          maxIdleMs: MAX + 60 * 1000,
        }),
      ).toBe(true);
    });

    it('keeps an old, idle session that still has a snapshot to restore', () => {
      expect(
        isSavedSessionRecoverable({
          ageMs: 3 * 60 * 60 * 1000,
          idleMs: 3 * 60 * 60 * 1000,
          hasSnapshot: true,
          maxAgeMs: MAX,
        }),
      ).toBe(true);
    });

    it('discards only when old AND idle AND snapshot-less', () => {
      expect(
        isSavedSessionRecoverable({
          ageMs: 3 * 60 * 60 * 1000,
          idleMs: 3 * 60 * 60 * 1000,
          hasSnapshot: false,
          maxAgeMs: MAX,
        }),
      ).toBe(false);
    });
  });

  describe('decideReconnectProbe', () => {
    const BACKOFF = 30 * 1000;
    const NOW = 1_700_000_000_000; // realistic epoch so the `at: 0` sentinel reads as cooldown-open

    it('probes a fresh saved sandbox (no prior attempt) as attempt 1', () => {
      const d = decideReconnectProbe({
        savedSandboxId: 'sb-1',
        prior: null,
        now: NOW,
        backoffMs: BACKOFF,
      });
      expect(d.probe).toBe(true);
      expect(d.nextAttempt).toEqual({ sandboxId: 'sb-1', at: NOW, attempts: 1 });
    });

    it('resets to attempt 1 when the saved sandbox differs from the prior attempt', () => {
      const prior: ReconnectAttempt = { sandboxId: 'sb-old', at: NOW, attempts: 2 };
      const d = decideReconnectProbe({
        savedSandboxId: 'sb-new',
        prior,
        now: NOW + 500,
        backoffMs: BACKOFF,
      });
      expect(d.probe).toBe(true);
      expect(d.nextAttempt).toEqual({ sandboxId: 'sb-new', at: NOW + 500, attempts: 1 });
    });

    it('skips re-probing the same sandbox within the backoff window (the spin-breaker)', () => {
      const prior: ReconnectAttempt = { sandboxId: 'sb-1', at: NOW, attempts: 1 };
      const d = decideReconnectProbe({
        savedSandboxId: 'sb-1',
        prior,
        now: NOW + BACKOFF - 1, // still inside the window
        backoffMs: BACKOFF,
      });
      expect(d.probe).toBe(false);
      expect(d.nextAttempt).toBe(prior); // unchanged — no new probe stamped
    });

    it('re-probes the same sandbox once the backoff elapses, incrementing the attempt', () => {
      const prior: ReconnectAttempt = { sandboxId: 'sb-1', at: NOW, attempts: 1 };
      const d = decideReconnectProbe({
        savedSandboxId: 'sb-1',
        prior,
        now: NOW + BACKOFF, // window just elapsed
        backoffMs: BACKOFF,
      });
      expect(d.probe).toBe(true);
      expect(d.nextAttempt).toEqual({ sandboxId: 'sb-1', at: NOW + BACKOFF, attempts: 2 });
    });

    it('treats at:0 as cooldown-open so the retry timer can force a re-probe', () => {
      const prior: ReconnectAttempt = { sandboxId: 'sb-1', at: 0, attempts: 1 };
      const d = decideReconnectProbe({
        savedSandboxId: 'sb-1',
        prior,
        now: NOW,
        backoffMs: BACKOFF,
      });
      expect(d.probe).toBe(true);
      expect(d.nextAttempt.attempts).toBe(2);
    });

    it('does not spin: repeated same-tick re-entries after a probe all skip', () => {
      // This is the regression: a transient failure parks status back at 'idle',
      // re-entering the effect on the SAME tick. Pre-fix that re-probed forever;
      // now every same-tick re-entry for the same sandbox skips.
      let prior: ReconnectAttempt | null = null;
      const first = decideReconnectProbe({
        savedSandboxId: 'sb-1',
        prior,
        now: NOW,
        backoffMs: BACKOFF,
      });
      expect(first.probe).toBe(true);
      prior = first.nextAttempt;
      let extraProbes = 0;
      for (let i = 0; i < 50; i++) {
        const d = decideReconnectProbe({
          savedSandboxId: 'sb-1',
          prior,
          now: NOW,
          backoffMs: BACKOFF,
        });
        if (d.probe) extraProbes++;
        prior = d.nextAttempt;
      }
      expect(extraProbes).toBe(0); // exactly one probe across 51 same-tick entries
    });
  });

  describe('shouldRetryReconnect', () => {
    it('retries while under the attempt budget', () => {
      expect(shouldRetryReconnect(1, 2)).toBe(true);
    });

    it('stops once the budget is reached (single backoff retry, then give up)', () => {
      expect(shouldRetryReconnect(2, 2)).toBe(false);
      expect(shouldRetryReconnect(3, 2)).toBe(false);
    });

    it('bounds the auto-retry burst to exactly maxAttempts probes', () => {
      const BACKOFF = 30 * 1000;
      const MAX = 2;
      let prior: ReconnectAttempt | null = null;
      let now = 1_700_000_000_000;
      let probes = 0;
      // Drive the real failure loop: probe → transient fail → wait backoff → repeat,
      // stopping when the retry budget is spent.
      for (let i = 0; i < 20; i++) {
        const d = decideReconnectProbe({
          savedSandboxId: 'sb-1',
          prior,
          now,
          backoffMs: BACKOFF,
        });
        expect(d.probe).toBe(true); // clock advanced past backoff each round
        probes++;
        prior = d.nextAttempt;
        if (!shouldRetryReconnect(prior.attempts, MAX)) break; // gave up auto-retry
        now += BACKOFF; // retry timer waited out the cooldown
      }
      expect(probes).toBe(MAX); // initial probe + exactly one retry
    });
  });
});
