import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  get: vi.fn<(key: string) => string | null>(),
  set: vi.fn<(key: string, value: string) => boolean>(() => true),
  remove: vi.fn<(key: string) => void>(),
}));

vi.mock('@/lib/safe-storage', () => ({
  safeStorageGet: (key: string) => storage.get(key),
  safeStorageSet: (key: string, value: string) => storage.set(key, value),
  safeStorageRemove: (key: string) => storage.remove(key),
}));

const { getIsAuditorGateEnabled } = await import('./useAuditorGate');

beforeEach(() => {
  storage.get.mockReset();
  storage.set.mockReset().mockReturnValue(true);
  storage.remove.mockReset();
});

describe('getIsAuditorGateEnabled (commit-time gate getter)', () => {
  it('defaults ON when nothing is stored — the required-gate invariant', () => {
    storage.get.mockReturnValue(null);
    expect(getIsAuditorGateEnabled()).toBe(true);
    expect(getIsAuditorGateEnabled('owner/repo')).toBe(true);
  });

  it('only an explicit global "false" disables it', () => {
    storage.get.mockImplementation((key) => (key === 'auditor_gate_default' ? 'false' : null));
    expect(getIsAuditorGateEnabled()).toBe(false);
  });

  it('treats any non-"false" global value as on (default-on bias)', () => {
    storage.get.mockImplementation((key) => (key === 'auditor_gate_default' ? 'true' : null));
    expect(getIsAuditorGateEnabled()).toBe(true);
  });

  it('repo "never" override disables even when the global default is on', () => {
    storage.get.mockImplementation((key) => (key === 'auditor_gate_owner/repo' ? 'never' : null));
    expect(getIsAuditorGateEnabled('owner/repo')).toBe(false);
  });

  it('repo "always" override enables even when the global default is off', () => {
    storage.get.mockImplementation((key) => {
      if (key === 'auditor_gate_owner/repo') return 'always';
      if (key === 'auditor_gate_default') return 'false';
      return null;
    });
    expect(getIsAuditorGateEnabled('owner/repo')).toBe(true);
  });

  it('repo "inherit" (or unset) falls back to the global default', () => {
    // global off, repo unset → off
    storage.get.mockImplementation((key) => (key === 'auditor_gate_default' ? 'false' : null));
    expect(getIsAuditorGateEnabled('owner/repo')).toBe(false);
    // global on (unset), repo unset → on
    storage.get.mockReturnValue(null);
    expect(getIsAuditorGateEnabled('owner/repo')).toBe(true);
  });
});
