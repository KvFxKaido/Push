import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetProviderPushStream,
  mockGetActiveProvider,
  mockIsProviderAvailable,
  mockGetModelForRole,
} = vi.hoisted(() => ({
  mockGetProviderPushStream: vi.fn(),
  mockGetActiveProvider: vi.fn(),
  mockIsProviderAvailable: vi.fn(),
  mockGetModelForRole: vi.fn(),
}));

vi.mock('./orchestrator', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  isProviderAvailable: (...args: unknown[]) => mockIsProviderAvailable(...args),
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock('./providers', async () => {
  const actual = await vi.importActual<typeof import('./providers')>('./providers');
  return {
    ...actual,
    getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
  };
});

import { runPlanner } from './planner-agent';
import type { PushStream } from '@push/lib/provider-contract';

describe('runPlanner', () => {
  let captured: Array<{ model: string }>;

  beforeEach(() => {
    captured = [];
    mockGetProviderPushStream.mockReset();
    mockGetActiveProvider.mockReset();
    mockIsProviderAvailable.mockReset();
    mockGetModelForRole.mockReset();

    mockGetActiveProvider.mockReturnValue('openrouter');
    mockIsProviderAvailable.mockImplementation((provider: string) => provider === 'openrouter');
    mockGetModelForRole.mockReturnValue({ id: 'coder-default-model' });

    const stream: PushStream = (req) => {
      captured.push({ model: req.model });
      return (async function* () {
        yield {
          type: 'text_delta',
          text: '{"approach":"Ship the fix","features":[{"id":"auth","description":"Update auth flow"}]}',
        };
        yield { type: 'done', finishReason: 'stop' };
      })();
    };
    mockGetProviderPushStream.mockImplementation(() => stream);
  });

  it('falls back to the active provider model when the override provider is unavailable', async () => {
    const plan = await runPlanner('Fix the auth flow', ['src/auth.ts'], () => {}, {
      providerOverride: 'vertex',
      modelOverride: 'google/gemini-2.5-pro',
    });

    expect(plan?.features).toHaveLength(1);
    expect(mockGetProviderPushStream).toHaveBeenCalledWith('openrouter');
    expect(captured[0]?.model).toBe('coder-default-model');
  });

  it('keeps the explicit model override when the requested provider is still available', async () => {
    mockIsProviderAvailable.mockReturnValue(true);

    await runPlanner('Fix the auth flow', ['src/auth.ts'], () => {}, {
      providerOverride: 'openrouter',
      modelOverride: 'anthropic/claude-sonnet-4.6:nitro',
    });

    expect(mockGetProviderPushStream).toHaveBeenCalledWith('openrouter');
    expect(captured[0]?.model).toBe('anthropic/claude-sonnet-4.6:nitro');
  });
});
