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

const state = vi.hoisted(() => ({
  globalDefault: false,
  repoOverride: 'inherit' as 'inherit' | 'always' | 'never',
  setGlobalDefaultCalls: [] as boolean[],
  setRepoOverrideCalls: [] as ('inherit' | 'always' | 'never')[],
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: () => {},
  useState: <T>(initial: T | (() => T)) => {
    const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
    // Route state to our controllable store for the two useState calls.
    if (typeof seed === 'boolean') {
      return [
        state.globalDefault as T,
        ((value: boolean) => state.setGlobalDefaultCalls.push(value)) as unknown,
      ];
    }
    return [
      state.repoOverride as T,
      ((value: 'inherit' | 'always' | 'never') =>
        state.setRepoOverrideCalls.push(value)) as unknown,
    ];
  },
}));

const { useProtectMain, getIsMainProtected } = await import('./useProtectMain');

beforeEach(() => {
  storage.get.mockReset();
  storage.set.mockReset().mockReturnValue(true);
  storage.remove.mockReset();
  state.globalDefault = false;
  state.repoOverride = 'inherit';
  state.setGlobalDefaultCalls = [];
  state.setRepoOverrideCalls = [];
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
});

describe('useProtectMain', () => {
  it('returns isProtected=true when the repo override is always', () => {
    state.repoOverride = 'always';
    state.globalDefault = false;
    const result = useProtectMain('owner/repo');
    expect(result.isProtected).toBe(true);
  });

  it('returns isProtected=false when the repo override is never, even with a true global default', () => {
    state.repoOverride = 'never';
    state.globalDefault = true;
    const result = useProtectMain('owner/repo');
    expect(result.isProtected).toBe(false);
  });

  it('falls back to the global default when the repo override is inherit', () => {
    state.repoOverride = 'inherit';
    state.globalDefault = true;
    const result = useProtectMain('owner/repo');
    expect(result.isProtected).toBe(true);
  });

  it('persists the global default when toggled', () => {
    const result = useProtectMain();
    result.setGlobalDefault(true);
    expect(storage.set).toHaveBeenCalledWith('protect_main_default', 'true');
    expect(state.setGlobalDefaultCalls).toEqual([true]);
  });

  it('clears the stored override when the value returns to inherit', () => {
    const result = useProtectMain('owner/repo');
    result.setRepoOverride('inherit');
    expect(storage.remove).toHaveBeenCalledWith('protect_main_owner/repo');
    expect(storage.set).not.toHaveBeenCalled();
    expect(state.setRepoOverrideCalls).toEqual(['inherit']);
  });

  it('writes the override key for always/never values', () => {
    const result = useProtectMain('owner/repo');
    result.setRepoOverride('always');
    expect(storage.set).toHaveBeenCalledWith('protect_main_owner/repo', 'always');
  });

  it('skips writing overrides when no repoFullName is active', () => {
    const result = useProtectMain();
    result.setRepoOverride('always');
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(state.setRepoOverrideCalls).toEqual(['always']);
  });
});
