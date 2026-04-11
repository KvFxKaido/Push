import type { AIProviderType } from '@/types';
import { normalizeConversationModel } from '@/hooks/chat-persistence';
import { getModelNameForProvider } from './providers';
import type { ActiveProvider } from './orchestrator';

export interface ChatProviderSelectionInput {
  existingProvider?: AIProviderType | null;
  existingModel?: string | null;
  requestedProvider?: AIProviderType | null;
  requestedModel?: string | null;
  fallbackProvider: ActiveProvider;
  isProviderAvailable: (provider: ActiveProvider) => boolean;
}

export interface ChatProviderSelectionResult {
  provider: ActiveProvider;
  model?: string;
  shouldPersistProvider: boolean;
  shouldPersistModel: boolean;
}

function getAvailableProvider(
  provider: AIProviderType | null | undefined,
  isProviderAvailable: (provider: ActiveProvider) => boolean,
): ActiveProvider | null {
  if (!provider || provider === 'demo') return null;
  return isProviderAvailable(provider as ActiveProvider) ? (provider as ActiveProvider) : null;
}

export function resolveProviderSpecificModel(
  resolvedProvider: ActiveProvider,
  model: string | null | undefined,
  modelProvider?: AIProviderType | null,
): string | undefined {
  if (modelProvider && modelProvider !== resolvedProvider) return undefined;
  return normalizeConversationModel(resolvedProvider, model) ?? undefined;
}

export function resolveChatProviderSelection(
  input: ChatProviderSelectionInput,
): ChatProviderSelectionResult {
  const availableExistingProvider = getAvailableProvider(
    input.existingProvider,
    input.isProviderAvailable,
  );
  const availableRequestedProvider = getAvailableProvider(
    input.requestedProvider,
    input.isProviderAvailable,
  );
  const provider =
    availableExistingProvider || availableRequestedProvider || input.fallbackProvider;

  const existingModel = resolveProviderSpecificModel(
    provider,
    input.existingModel,
    input.existingProvider,
  );
  const requestedModel = resolveProviderSpecificModel(
    provider,
    input.requestedModel,
    input.requestedProvider,
  );
  const model = existingModel || requestedModel || getModelNameForProvider(provider);

  return {
    provider,
    model,
    shouldPersistProvider: provider !== 'demo' && input.existingProvider !== provider,
    shouldPersistModel: Boolean(model && input.existingModel !== model),
  };
}
