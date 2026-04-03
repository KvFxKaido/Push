import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetModelNameForProvider,
  mockNormalizeConversationModel,
} = vi.hoisted(() => ({
  mockGetModelNameForProvider: vi.fn(),
  mockNormalizeConversationModel: vi.fn(),
}));

vi.mock('@/hooks/chat-persistence', () => ({
  normalizeConversationModel: (...args: unknown[]) => mockNormalizeConversationModel(...args),
}));

vi.mock('./providers', () => ({
  getModelNameForProvider: (...args: unknown[]) => mockGetModelNameForProvider(...args),
}));

import {
  resolveChatProviderSelection,
  resolveProviderSpecificModel,
} from './provider-selection';

describe('provider selection', () => {
  beforeEach(() => {
    mockGetModelNameForProvider.mockReset();
    mockNormalizeConversationModel.mockReset();

    mockGetModelNameForProvider.mockImplementation((provider: string) => `${provider}-default-model`);
    mockNormalizeConversationModel.mockImplementation((_provider: string, model: string | null | undefined) => {
      if (typeof model !== 'string') return null;
      const trimmed = model.trim();
      return trimmed || null;
    });
  });

  it('drops stale persisted models when the locked provider is unavailable', () => {
    const result = resolveChatProviderSelection({
      existingProvider: 'vertex',
      existingModel: 'google/gemini-2.5-pro',
      fallbackProvider: 'openrouter',
      isProviderAvailable: (provider) => provider === 'openrouter',
    });

    expect(result).toEqual({
      provider: 'openrouter',
      model: 'openrouter-default-model',
      shouldPersistProvider: true,
      shouldPersistModel: true,
    });
  });

  it('ignores explicit model overrides when their provider no longer matches', () => {
    expect(resolveProviderSpecificModel('openrouter', 'google/gemini-2.5-pro', 'vertex')).toBeUndefined();
    expect(resolveProviderSpecificModel('openrouter', ' anthropic/claude-sonnet ', 'openrouter'))
      .toBe('anthropic/claude-sonnet');
    expect(resolveProviderSpecificModel('openrouter', ' openai/gpt-5 ', undefined))
      .toBe('openai/gpt-5');
  });
});
