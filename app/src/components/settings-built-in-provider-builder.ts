import type { SettingsBuiltInProvider } from '@/components/SettingsSheet';
import {
  BUILT_IN_SETTINGS_PROVIDER_ORDER,
  type BuiltInSettingsProviderId,
} from '@/components/settings-shared';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { AIProviderType } from '@/types';

interface ProviderLockArgs {
  isProviderLocked: boolean;
  lockedProvider: AIProviderType | null;
  isModelLocked: boolean;
}

interface BuildSettingsBuiltInProvidersArgs extends ProviderLockArgs {
  catalog: ModelCatalog;
}

type ProviderBuilder = (args: BuildSettingsBuiltInProvidersArgs) => SettingsBuiltInProvider;

const NOOP = () => {};

function isLockedByModel(args: ProviderLockArgs, provider: BuiltInSettingsProviderId): boolean {
  return args.isModelLocked && args.lockedProvider === provider;
}

function isLockedByProvider(args: ProviderLockArgs, provider: BuiltInSettingsProviderId): boolean {
  return args.isProviderLocked && args.lockedProvider === provider;
}

const BUILT_IN_PROVIDER_BUILDERS = {
  ollama: ({ catalog, ...args }) => ({
    hasKey: catalog.ollama.hasKey,
    model: catalog.ollama.model,
    setModel: catalog.ollama.setModel,
    modelOptions: catalog.ollamaModelOptions,
    modelsLoading: catalog.ollamaModels.loading,
    modelsError: catalog.ollamaModels.error,
    modelsUpdatedAt: catalog.ollamaModels.updatedAt,
    isModelLocked: isLockedByModel(args, 'ollama'),
    refreshModels: catalog.refreshOllamaModels,
    keyInput: catalog.ollama.keyInput,
    setKeyInput: catalog.ollama.setKeyInput,
    setKey: catalog.ollama.setKey,
    clearKey: catalog.ollama.clearKey,
  }),
  openrouter: ({ catalog, ...args }) => ({
    hasKey: catalog.openRouter.hasKey,
    model: catalog.openRouter.model,
    setModel: catalog.openRouter.setModel,
    modelOptions: catalog.openRouterModelOptions,
    modelsLoading: catalog.openRouterModels.loading,
    modelsError: catalog.openRouterModels.error,
    modelsUpdatedAt: catalog.openRouterModels.updatedAt,
    isModelLocked: isLockedByProvider(args, 'openrouter'),
    refreshModels: catalog.refreshOpenRouterModels,
    keyInput: catalog.openRouter.keyInput,
    setKeyInput: catalog.openRouter.setKeyInput,
    setKey: catalog.openRouter.setKey,
    clearKey: catalog.openRouter.clearKey,
  }),
  zen: ({ catalog, ...args }) => ({
    hasKey: catalog.zen.hasKey,
    model: catalog.zen.model,
    setModel: catalog.zen.setModel,
    modelOptions: catalog.zenModelOptions,
    modelsLoading: catalog.zenModels.loading,
    modelsError: catalog.zenModels.error,
    modelsUpdatedAt: catalog.zenModels.updatedAt,
    isModelLocked: isLockedByModel(args, 'zen'),
    refreshModels: catalog.refreshZenModels,
    keyInput: catalog.zen.keyInput,
    setKeyInput: catalog.zen.setKeyInput,
    setKey: catalog.zen.setKey,
    clearKey: catalog.zen.clearKey,
    goMode: catalog.zenGoMode,
    setGoMode: catalog.setZenGoMode,
  }),
  nvidia: ({ catalog, ...args }) => ({
    hasKey: catalog.nvidia.hasKey,
    model: catalog.nvidia.model,
    setModel: catalog.nvidia.setModel,
    modelOptions: catalog.nvidiaModelOptions,
    modelsLoading: catalog.nvidiaModels.loading,
    modelsError: catalog.nvidiaModels.error,
    modelsUpdatedAt: catalog.nvidiaModels.updatedAt,
    isModelLocked: isLockedByModel(args, 'nvidia'),
    refreshModels: catalog.refreshNvidiaModels,
    keyInput: catalog.nvidia.keyInput,
    setKeyInput: catalog.nvidia.setKeyInput,
    setKey: catalog.nvidia.setKey,
    clearKey: catalog.nvidia.clearKey,
  }),
  fireworks: ({ catalog, ...args }) => ({
    hasKey: catalog.fireworks.hasKey,
    model: catalog.fireworks.model,
    setModel: catalog.fireworks.setModel,
    modelOptions: catalog.fireworksModelOptions,
    modelsLoading: catalog.fireworksModels.loading,
    modelsError: catalog.fireworksModels.error,
    modelsUpdatedAt: catalog.fireworksModels.updatedAt,
    isModelLocked: isLockedByModel(args, 'fireworks'),
    refreshModels: catalog.refreshFireworksModels,
    keyInput: catalog.fireworks.keyInput,
    setKeyInput: catalog.fireworks.setKeyInput,
    setKey: catalog.fireworks.setKey,
    clearKey: catalog.fireworks.clearKey,
  }),
  sakana: ({ catalog, ...args }) => ({
    hasKey: catalog.sakana.hasKey,
    model: catalog.sakana.model,
    setModel: catalog.sakana.setModel,
    modelOptions: catalog.sakanaModelOptions,
    modelsLoading: catalog.sakanaModels.loading,
    modelsError: catalog.sakanaModels.error,
    modelsUpdatedAt: catalog.sakanaModels.updatedAt,
    isModelLocked: isLockedByModel(args, 'sakana'),
    refreshModels: catalog.refreshSakanaModels,
    keyInput: catalog.sakana.keyInput,
    setKeyInput: catalog.sakana.setKeyInput,
    setKey: catalog.sakana.setKey,
    clearKey: catalog.sakana.clearKey,
  }),
  deepseek: ({ catalog, ...args }) => ({
    hasKey: catalog.deepseek.hasKey,
    model: catalog.deepseek.model,
    setModel: catalog.deepseek.setModel,
    modelOptions: catalog.deepseekModelOptions,
    modelsLoading: catalog.deepseekModels.loading,
    modelsError: catalog.deepseekModels.error,
    modelsUpdatedAt: catalog.deepseekModels.updatedAt,
    isModelLocked: isLockedByModel(args, 'deepseek'),
    refreshModels: catalog.refreshDeepSeekModels,
    keyInput: catalog.deepseek.keyInput,
    setKeyInput: catalog.deepseek.setKeyInput,
    setKey: catalog.deepseek.setKey,
    clearKey: catalog.deepseek.clearKey,
  }),
  anthropic: ({ catalog, ...args }) => ({
    hasKey: catalog.anthropic.hasKey,
    model: catalog.anthropic.model,
    setModel: catalog.anthropic.setModel,
    modelOptions: catalog.anthropicModelOptions,
    modelsLoading: false,
    modelsError: null,
    modelsUpdatedAt: null,
    isModelLocked: isLockedByProvider(args, 'anthropic'),
    refreshModels: NOOP,
    keyInput: catalog.anthropic.keyInput,
    setKeyInput: catalog.anthropic.setKeyInput,
    setKey: catalog.anthropic.setKey,
    clearKey: catalog.anthropic.clearKey,
  }),
  openai: ({ catalog, ...args }) => ({
    hasKey: catalog.openai.hasKey,
    model: catalog.openai.model,
    setModel: catalog.openai.setModel,
    modelOptions: catalog.openaiModelOptions,
    modelsLoading: catalog.openaiModels.loading,
    modelsError: catalog.openaiModels.error,
    modelsUpdatedAt: catalog.openaiModels.updatedAt,
    isModelLocked: isLockedByProvider(args, 'openai'),
    refreshModels: catalog.refreshOpenAIModels,
    keyInput: catalog.openai.keyInput,
    setKeyInput: catalog.openai.setKeyInput,
    setKey: catalog.openai.setKey,
    clearKey: catalog.openai.clearKey,
  }),
  xai: ({ catalog, ...args }) => ({
    hasKey: catalog.xai.hasKey,
    model: catalog.xai.model,
    setModel: catalog.xai.setModel,
    modelOptions: catalog.xaiModelOptions,
    modelsLoading: catalog.xaiModels.loading,
    modelsError: catalog.xaiModels.error,
    modelsUpdatedAt: catalog.xaiModels.updatedAt,
    isModelLocked: isLockedByProvider(args, 'xai'),
    refreshModels: catalog.refreshXAIModels,
    keyInput: catalog.xai.keyInput,
    setKeyInput: catalog.xai.setKeyInput,
    setKey: catalog.xai.setKey,
    clearKey: catalog.xai.clearKey,
  }),
  google: ({ catalog, ...args }) => ({
    hasKey: catalog.google.hasKey,
    model: catalog.google.model,
    setModel: catalog.google.setModel,
    modelOptions: catalog.googleModelOptions,
    modelsLoading: catalog.googleModels.loading,
    modelsError: catalog.googleModels.error,
    modelsUpdatedAt: catalog.googleModels.updatedAt,
    isModelLocked: isLockedByProvider(args, 'google'),
    refreshModels: catalog.refreshGoogleModels,
    keyInput: catalog.google.keyInput,
    setKeyInput: catalog.google.setKeyInput,
    setKey: catalog.google.setKey,
    clearKey: catalog.google.clearKey,
  }),
} satisfies Record<BuiltInSettingsProviderId, ProviderBuilder>;

export function buildSettingsBuiltInProviders(
  args: BuildSettingsBuiltInProvidersArgs,
): Record<BuiltInSettingsProviderId, SettingsBuiltInProvider> {
  return Object.fromEntries(
    BUILT_IN_SETTINGS_PROVIDER_ORDER.map((providerId) => [
      providerId,
      BUILT_IN_PROVIDER_BUILDERS[providerId](args),
    ]),
  ) as Record<BuiltInSettingsProviderId, SettingsBuiltInProvider>;
}
