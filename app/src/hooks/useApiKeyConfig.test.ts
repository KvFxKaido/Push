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

type StateEntry = { value: unknown; setter: (v: unknown) => void };

const reactState = vi.hoisted(() => ({
  states: [] as StateEntry[],
  index: 0,
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useState: <T>(initial: T | (() => T)) => {
    const i = reactState.index++;
    if (!reactState.states[i]) {
      const seed = typeof initial === 'function' ? (initial as () => T)() : initial;
      const entry: StateEntry = {
        value: seed,
        setter: (v: unknown) => {
          entry.value = v;
        },
      };
      reactState.states[i] = entry;
    }
    const entry = reactState.states[i];
    return [entry.value as T, entry.setter as (v: T) => void];
  },
}));

const {
  createApiKeyGetter,
  useApiKeyConfig,
  useApiKeyWithModelConfig,
  createKeyOnlyProviderConfig,
  createModelProviderConfig,
} = await import('./useApiKeyConfig');

beforeEach(() => {
  storage.get.mockReset();
  storage.set.mockReset().mockReturnValue(true);
  storage.remove.mockReset();
  reactState.states = [];
  reactState.index = 0;
});

describe('createApiKeyGetter', () => {
  it('returns the stored value when present', () => {
    storage.get.mockReturnValue('stored-key');
    const getter = createApiKeyGetter('my_key', 'ENV_FALLBACK');
    expect(getter()).toBe('stored-key');
  });

  it('falls back to the env var when no stored value exists', () => {
    storage.get.mockReturnValue(null);
    const getter = createApiKeyGetter('my_key', 'env-key');
    expect(getter()).toBe('env-key');
  });

  it('returns null when neither stored nor env var is present', () => {
    storage.get.mockReturnValue(null);
    const getter = createApiKeyGetter('my_key', undefined);
    expect(getter()).toBeNull();
  });

  it('prefers the stored value even when env var is also set', () => {
    storage.get.mockReturnValue('stored');
    const getter = createApiKeyGetter('my_key', 'env');
    expect(getter()).toBe('stored');
  });
});

describe('useApiKeyConfig', () => {
  it('seeds key from the getter on first render', () => {
    const getter = () => 'seeded-key';
    const result = useApiKeyConfig('k', undefined, getter);
    expect(result.key).toBe('seeded-key');
    expect(result.hasKey).toBe(true);
  });

  it('reports hasKey=false when the getter returns null', () => {
    const result = useApiKeyConfig('k', undefined, () => null);
    expect(result.key).toBeNull();
    expect(result.hasKey).toBe(false);
  });

  it('setKey trims whitespace and persists to storage', () => {
    const result = useApiKeyConfig('k', undefined, () => null);
    result.setKey('  new-value  ');
    expect(storage.set).toHaveBeenCalledWith('k', 'new-value');
    // After the setter runs, the hoisted state holds the trimmed value.
    expect(reactState.states[0].value).toBe('new-value');
  });

  it('setKey ignores empty or whitespace-only input', () => {
    const result = useApiKeyConfig('k', undefined, () => null);
    result.setKey('   ');
    expect(storage.set).not.toHaveBeenCalled();
    expect(reactState.states[0].value).toBeNull();
  });

  it('clearKey removes the stored key and falls back to the env var', () => {
    storage.get.mockReturnValue('old');
    const result = useApiKeyConfig('k', 'ENV_VALUE', () => 'old');
    result.clearKey();
    expect(storage.remove).toHaveBeenCalledWith('k');
    expect(reactState.states[0].value).toBe('ENV_VALUE');
  });

  it('clearKey resets to null when no env var is provided', () => {
    const result = useApiKeyConfig('k', undefined, () => 'old');
    result.clearKey();
    expect(storage.remove).toHaveBeenCalledWith('k');
    expect(reactState.states[0].value).toBeNull();
  });
});

describe('useApiKeyWithModelConfig', () => {
  it('seeds the model from storage when present', () => {
    storage.get.mockImplementation((k) => (k === 'model_k' ? 'stored-model' : null));
    const result = useApiKeyWithModelConfig(
      'key_k',
      'model_k',
      undefined,
      'default-model',
      () => null,
    );
    expect(result.model).toBe('stored-model');
  });

  it('falls back to the default model when storage is empty', () => {
    storage.get.mockReturnValue(null);
    const result = useApiKeyWithModelConfig(
      'key_k',
      'model_k',
      undefined,
      'default-model',
      () => null,
    );
    expect(result.model).toBe('default-model');
  });

  it('applies normalizeModel to the seed when provided', () => {
    storage.get.mockImplementation((k) => (k === 'model_k' ? 'RAW_MODEL' : null));
    const result = useApiKeyWithModelConfig(
      'key_k',
      'model_k',
      undefined,
      'default',
      () => null,
      (m) => m.toLowerCase(),
    );
    expect(result.model).toBe('raw_model');
  });

  it('setModel trims and persists the normalized value', () => {
    storage.get.mockReturnValue(null);
    const result = useApiKeyWithModelConfig(
      'key_k',
      'model_k',
      undefined,
      'default',
      () => null,
      (m) => `norm:${m}`,
    );
    result.setModel('  gpt-4  ');
    expect(storage.set).toHaveBeenCalledWith('model_k', 'norm:gpt-4');
  });

  it('setModel ignores empty/whitespace input', () => {
    storage.get.mockReturnValue(null);
    const result = useApiKeyWithModelConfig('key_k', 'model_k', undefined, 'default', () => null);
    result.setModel('   ');
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('setModel bails out when normalizeModel returns empty', () => {
    storage.get.mockReturnValue(null);
    const result = useApiKeyWithModelConfig(
      'key_k',
      'model_k',
      undefined,
      'default',
      () => null,
      () => '',
    );
    result.setModel('anything');
    expect(storage.set).not.toHaveBeenCalled();
  });
});

describe('createKeyOnlyProviderConfig', () => {
  it('returns a getKey and useConfig wired to the same storage key/envVar', () => {
    storage.get.mockReturnValue('stored');
    const config = createKeyOnlyProviderConfig({
      storageKey: 'tavily_key',
      envVar: 'TAVILY_ENV',
    });
    expect(config.getKey()).toBe('stored');
    const hookResult = config.useConfig();
    expect(hookResult.key).toBe('stored');
    expect(hookResult.hasKey).toBe(true);
  });
});

describe('createModelProviderConfig', () => {
  it('returns a getKey and useConfig that returns key+model', () => {
    storage.get.mockImplementation((k) => {
      if (k === 'k') return 'my-key';
      if (k === 'm') return 'my-model';
      return null;
    });
    const config = createModelProviderConfig({
      storageKey: 'k',
      modelStorageKey: 'm',
      envVar: undefined,
      defaultModel: 'default',
    });
    expect(config.getKey()).toBe('my-key');
    const hookResult = config.useConfig();
    expect(hookResult.key).toBe('my-key');
    expect(hookResult.model).toBe('my-model');
  });
});
