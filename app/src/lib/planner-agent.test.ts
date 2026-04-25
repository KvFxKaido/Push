import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockStreamFn,
  mockGetActiveProvider,
  mockIsProviderAvailable,
  mockGetProviderStreamFn,
  mockGetModelForRole,
} = vi.hoisted(() => ({
  mockStreamFn: vi.fn(),
  mockGetActiveProvider: vi.fn(),
  mockIsProviderAvailable: vi.fn(),
  mockGetProviderStreamFn: vi.fn(),
  mockGetModelForRole: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  isProviderAvailable: (...args: unknown[]) => mockIsProviderAvailable(...args),
  getProviderStreamFn: (...args: unknown[]) => mockGetProviderStreamFn(...args),
}));

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers');
  return {
    ...actual,
    getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
  };
});

import { runPlanner } from './planner-agent';

describe('runPlanner', () => {
  beforeEach(() => {
    mockStreamFn.mockReset();
    mockGetActiveProvider.mockReset();
    mockIsProviderAvailable.mockReset();
    mockGetProviderStreamFn.mockReset();
    mockGetModelForRole.mockReset();

    mockGetActiveProvider.mockReturnValue('openrouter');
    mockIsProviderAvailable.mockImplementation((provider: string) => provider === 'openrouter');
    mockGetProviderStreamFn.mockImplementation((provider: string) => ({
      providerType: provider,
      streamFn: mockStreamFn,
    }));
    mockGetModelForRole.mockReturnValue({ id: 'coder-default-model' });
    mockStreamFn.mockImplementation(
      (_messages: unknown, onToken: (token: string) => void, onDone: () => void) => {
        onToken(
          '{"approach":"Ship the fix","features":[{"id":"auth","description":"Update auth flow"}]}',
        );
        onDone();
        return Promise.resolve();
      },
    );
  });

  it('falls back to the active provider model when the override provider is unavailable', async () => {
    const plan = await runPlanner('Fix the auth flow', ['src/auth.ts'], () => {}, {
      providerOverride: 'vertex',
      modelOverride: 'google/gemini-2.5-pro',
    });

    expect(plan?.features).toHaveLength(1);
    expect(mockGetProviderStreamFn).toHaveBeenCalledWith('openrouter');
    // PushStream consumer assembles `req.model` from `modelId` and passes it
    // through the bridged ProviderStreamFn as the 8th positional argument.
    expect(mockStreamFn.mock.calls[0]?.[7]).toBe('coder-default-model');
  });

  it('keeps the explicit model override when the requested provider is still available', async () => {
    mockIsProviderAvailable.mockReturnValue(true);

    await runPlanner('Fix the auth flow', ['src/auth.ts'], () => {}, {
      providerOverride: 'openrouter',
      modelOverride: 'anthropic/claude-sonnet-4.6:nitro',
    });

    expect(mockGetProviderStreamFn).toHaveBeenCalledWith('openrouter');
    expect(mockStreamFn.mock.calls[0]?.[7]).toBe('anthropic/claude-sonnet-4.6:nitro');
  });
});
