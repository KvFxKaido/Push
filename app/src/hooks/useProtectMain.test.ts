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

// The settings store is the persistence backend. getSetting returns the cached
// doc value (drives the read paths; falls back to legacy localStorage when
// undefined); setSetting is the write spy the persistence assertions check.
const settings = vi.hoisted(() => ({
  get: vi.fn<(key: string) => unknown>(() => undefined),
  set: vi.fn<(key: string, value: unknown) => void>(),
}));

vi.mock('@/lib/settings-store', () => ({
  SETTINGS_KEYS: {
    protectMainDefault: 'prefs.protectMain.default',
    protectMainByRepo: 'prefs.protectMain.byRepo',
  },
  getSetting: (key: string) => settings.get(key),
  setSetting: (key: string, value: unknown) => settings.set(key, value),
  subscribeSetting: () => () => {},
}));

// Minimal React shims: useSyncExternalStore returns the live snapshot, useMemo
// recomputes eagerly, useCallback is identity.
vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useMemo: <T>(fn: () => T) => fn(),
  useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
}));

const { useProtectMain, getIsMainProtected } = await import('./useProtectMain');

beforeEach(() => {
  storage.get.mockReset();
  storage.set.mockReset().mockReturnValue(true);
  storage.remove.mockReset();
  settings.get.mockReset().mockReturnValue(undefined);
  settings.set.mockReset();
});

describe('getIsMainProtected', () => {
  it('honors repo-level "always" override regardless of the global default', () => {
    storage.get.mockImplementation((key) =>
      key === 'protect_main_owner/repo' ? 'always' : 'false',
    );
    expect(getIsMainProtected('owner/repo')).toBe(true);
  });

  it('honors repo-level "never" override regardless of the global default', () => {
    storage.get.mockImplementation((key) => (key === 'protect_main_owner/repo' ? 'never' : 'true'));
    expect(getIsMainProtected('owner/repo')).toBe(false);
  });

  it('falls back to the global default when the override is "inherit"', () => {
    storage.get.mockImplementation((key) => (key === 'protect_main_default' ? 'true' : null));
    expect(getIsMainProtected('owner/repo')).toBe(true);
  });

  it('treats a missing repo override as inherit', () => {
    storage.get.mockImplementation((key) => (key === 'protect_main_default' ? 'false' : null));
    expect(getIsMainProtected()).toBe(false);
  });

  it('prefers the settings doc over the legacy localStorage value', () => {
    settings.get.mockImplementation((key) =>
      key === 'prefs.protectMain.byRepo' ? { 'owner/repo': 'never' } : undefined,
    );
    storage.get.mockImplementation((key) =>
      key === 'protect_main_owner/repo' ? 'always' : 'true',
    );
    expect(getIsMainProtected('owner/repo')).toBe(false);
  });
});

describe('useProtectMain', () => {
  it('returns isProtected=true when the repo override is always', () => {
    settings.get.mockImplementation((key) =>
      key === 'prefs.protectMain.byRepo' ? { 'owner/repo': 'always' } : undefined,
    );
    const result = useProtectMain('owner/repo');
    expect(result.isProtected).toBe(true);
  });

  it('returns isProtected=false when the repo override is never, even with a true global default', () => {
    settings.get.mockImplementation((key) => {
      if (key === 'prefs.protectMain.byRepo') return { 'owner/repo': 'never' };
      if (key === 'prefs.protectMain.default') return true;
      return undefined;
    });
    const result = useProtectMain('owner/repo');
    expect(result.isProtected).toBe(false);
  });

  it('falls back to the global default when the repo override is inherit', () => {
    settings.get.mockImplementation((key) =>
      key === 'prefs.protectMain.default' ? true : undefined,
    );
    const result = useProtectMain('owner/repo');
    expect(result.isProtected).toBe(true);
  });

  it('persists the global default to the settings doc when toggled', () => {
    const result = useProtectMain();
    result.setGlobalDefault(true);
    expect(settings.set).toHaveBeenCalledWith('prefs.protectMain.default', true);
  });

  it('drops the repo from the override map when the value returns to inherit', () => {
    settings.get.mockImplementation((key) =>
      key === 'prefs.protectMain.byRepo' ? { 'owner/repo': 'always' } : undefined,
    );
    const result = useProtectMain('owner/repo');
    result.setRepoOverride('inherit');
    expect(settings.set).toHaveBeenCalledWith('prefs.protectMain.byRepo', {});
  });

  it('writes the override into the map for always/never values', () => {
    const result = useProtectMain('owner/repo');
    result.setRepoOverride('always');
    expect(settings.set).toHaveBeenCalledWith('prefs.protectMain.byRepo', {
      'owner/repo': 'always',
    });
  });

  it('is a no-op when no repoFullName is active', () => {
    const result = useProtectMain();
    result.setRepoOverride('always');
    expect(settings.set).not.toHaveBeenCalled();
  });
});
