import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  model: 'go-default',
  goMode: true,
  setModel: vi.fn<(model: string) => void>(),
  effects: [] as Array<() => void>,
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: (effect: () => void) => state.effects.push(effect),
  useState: <T>(initial: T | (() => T)) => [
    typeof initial === 'function' ? (initial as () => T)() : initial,
    vi.fn(),
  ],
}));

vi.mock('@/lib/providers', () => ({
  ZEN_DEFAULT_MODEL: 'standard-default',
  ZEN_MODELS: ['standard-default', 'standard-model'],
  ZEN_GO_DEFAULT_MODEL: 'go-default',
  ZEN_GO_MODELS: ['go-default', 'seeded-model'],
  getZenGoMode: () => state.goMode,
  setZenGoMode: vi.fn(),
}));

vi.mock('./useApiKeyConfig', () => ({
  createRegistryModelProviderConfig: () => ({
    getKey: vi.fn(),
    useConfig: () => ({
      key: null,
      setKey: vi.fn(),
      clearKey: vi.fn(),
      hasKey: false,
      model: state.model,
      setModel: state.setModel,
    }),
  }),
}));

const { useZenConfig } = await import('./useZenConfig');

function runEffects(): void {
  for (const effect of state.effects) effect();
}

beforeEach(() => {
  state.model = 'go-default';
  state.goMode = true;
  state.setModel.mockReset();
  state.effects = [];
});

describe('useZenConfig Go catalog validation', () => {
  it('accepts a model that exists only in the fetched Go catalog', () => {
    state.model = 'live-only-model';

    useZenConfig(['go-default', 'live-only-model']);
    runEffects();

    expect(state.setModel).not.toHaveBeenCalled();
  });

  it('rejects a model absent from the fetched Go catalog', () => {
    state.model = 'standard-model';

    useZenConfig(['go-default', 'live-only-model']);
    runEffects();

    expect(state.setModel).toHaveBeenCalledWith('go-default');
  });

  it('defers validation until the live Go catalog has loaded', () => {
    state.model = 'live-only-model';

    useZenConfig(null);
    runEffects();

    expect(state.setModel).not.toHaveBeenCalled();
  });
});
