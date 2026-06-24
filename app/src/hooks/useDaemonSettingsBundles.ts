/**
 * useDaemonSettingsBundles — assembles the five Settings prop bundles
 * the daemon hub needs (`SettingsAuthProps`, `SettingsProfileProps`,
 * `SettingsAIProps`, `SettingsWorkspaceProps`, `SettingsDataProps`)
 * from the data sources daemon screens already have in scope.
 *
 * Why a dedicated builder and not the existing `buildSettings*`
 * helpers in `workspace-chat-route-builders.ts`: those take the full
 * `ChatRouteProps` aggregate, which `WorkspaceSessionScreen` constructs
 * and daemon screens don't have. Rather than fake a `ChatRouteProps`
 * shape (carries a lot of repo / sandbox state daemon never populates)
 * or refactor every builder's signature, this hook mirrors their
 * output shape from the smaller daemon surface.
 *
 * Sandbox / branch / repo fields collapse to inert values — daemon
 * sessions don't carry any of those, and the Settings UI treats null
 * sandbox + null activeRepo as "no per-workspace actions available".
 */
import { useMemo } from 'react';

import type {
  SettingsAIProps,
  SettingsAuthProps,
  SettingsDataProps,
  SettingsProfileProps,
  SettingsWorkspaceProps,
} from '@/components/SettingsSheet';
import type { ModelCatalog } from '@/hooks/useModelCatalog';
import type { useProtectMain } from '@/hooks/useProtectMain';
import type { useWorkspacePreferences } from '@/hooks/useWorkspacePreferences';

type ProtectMainHandle = ReturnType<typeof useProtectMain>;
import type { AIProviderType, WorkspaceScreenAuthProps } from '@/types';

type WorkspacePreferences = ReturnType<typeof useWorkspacePreferences>;

interface DaemonSettingsBundleSource {
  auth: WorkspaceScreenAuthProps;
  onDisconnect: () => void;
  prefs: WorkspacePreferences;
  catalog: ModelCatalog;
  protectMain: ProtectMainHandle;
  isProviderLocked: boolean;
  lockedProvider: AIProviderType | null;
  isModelLocked: boolean;
  lockedModel: string | null;
  deleteAllChats: () => void;
  /** Gate to defer bundle construction until the hub has been opened
   *  at least once. The AI bundle in particular reads ~60 catalog
   *  fields, several of which are async-loaded; computing it before
   *  the user navigates to Settings just thrashes the catalog and
   *  trips SSR test mocks that don't populate every field. Caller
   *  passes a sticky `hubEverOpen` flag — flip on first open and
   *  leave on. */
  enabled: boolean;
}

export interface DaemonSettingsBundles {
  settingsAuth: SettingsAuthProps | undefined;
  settingsProfile: SettingsProfileProps | undefined;
  settingsAI: SettingsAIProps | undefined;
  settingsWorkspace: SettingsWorkspaceProps | undefined;
  settingsData: SettingsDataProps | undefined;
}

const EMPTY_BUNDLES: DaemonSettingsBundles = {
  settingsAuth: undefined,
  settingsProfile: undefined,
  settingsAI: undefined,
  settingsWorkspace: undefined,
  settingsData: undefined,
};

const NOOP = () => {};
const NOOP_ASYNC = async () => false;

export function useDaemonSettingsBundles({
  auth,
  onDisconnect,
  prefs,
  catalog,
  protectMain,
  isProviderLocked,
  lockedProvider,
  isModelLocked,
  lockedModel,
  deleteAllChats,
  enabled,
}: DaemonSettingsBundleSource): DaemonSettingsBundles {
  // Bundles are pure projections — memoize so identity stays stable
  // across renders that don't actually change source state. The
  // Settings sheet re-renders on bundle-identity change, so churning
  // these would re-mount input fields and drop focus.
  return useMemo(() => {
    if (!enabled) return EMPTY_BUNDLES;
    const settingsAuth: SettingsAuthProps = {
      isConnected: Boolean(auth.token),
      isAppAuth: auth.isAppAuth,
      installationId: auth.installationId ?? '',
      token: auth.token ?? '',
      tokenKind: auth.tokenKind,
      patToken: auth.patToken ?? '',
      validatedUser: auth.validatedUser,
      appLoading: auth.appLoading,
      appError: auth.appError,
      connectApp: auth.connectApp,
      installApp: auth.installApp,
      showInstallIdInput: prefs.showInstallIdInput,
      setShowInstallIdInput: prefs.setShowInstallIdInput,
      installIdInput: prefs.installIdInput,
      setInstallIdInput: prefs.setInstallIdInput,
      setInstallationIdManually: auth.setInstallationIdManually,
      allowlistSecretCmd: prefs.allowlistSecretCmd,
      copyAllowlistCommand: prefs.copyAllowlistCommand,
      onDisconnect,
    };

    const settingsProfile: SettingsProfileProps = {
      displayNameDraft: prefs.displayNameDraft,
      setDisplayNameDraft: prefs.setDisplayNameDraft,
      onDisplayNameBlur: prefs.handleDisplayNameBlur,
      bioDraft: prefs.bioDraft,
      setBioDraft: prefs.setBioDraft,
      onBioBlur: prefs.handleBioBlur,
      chatInstructionsDraft: prefs.chatInstructionsDraft,
      setChatInstructionsDraft: prefs.setChatInstructionsDraft,
      onChatInstructionsBlur: prefs.handleChatInstructionsBlur,
      profile: prefs.profile,
      clearProfile: prefs.clearProfile,
      validatedUser: auth.validatedUser,
    };

    const isOllamaModelLocked = isModelLocked && lockedProvider === 'ollama';
    const isCloudflareModelLocked = isModelLocked && lockedProvider === 'cloudflare';
    const isZenModelLocked = isModelLocked && lockedProvider === 'zen';
    const isNvidiaModelLocked = isModelLocked && lockedProvider === 'nvidia';
    const isBlackboxModelLocked = isModelLocked && lockedProvider === 'blackbox';
    const isKilocodeModelLocked = isModelLocked && lockedProvider === 'kilocode';
    const isFireworksModelLocked = isModelLocked && lockedProvider === 'fireworks';
    const isOpenAdapterModelLocked = isModelLocked && lockedProvider === 'openadapter';

    const settingsAI: SettingsAIProps = {
      activeProviderLabel: catalog.activeProviderLabel,
      activeBackend: catalog.activeBackend,
      setActiveBackend: catalog.setActiveBackend,
      isProviderLocked,
      lockedProvider,
      lockedModel,
      availableProviders: catalog.availableProviders,
      setPreferredProvider: catalog.setPreferredProvider,
      clearPreferredProvider: catalog.clearPreferredProvider,
      builtInProviders: {
        ollama: {
          hasKey: catalog.ollama.hasKey,
          model: catalog.ollama.model,
          setModel: catalog.ollama.setModel,
          modelOptions: catalog.ollamaModelOptions,
          modelsLoading: catalog.ollamaModels.loading,
          modelsError: catalog.ollamaModels.error,
          modelsUpdatedAt: catalog.ollamaModels.updatedAt,
          isModelLocked: isOllamaModelLocked,
          refreshModels: catalog.refreshOllamaModels,
          keyInput: catalog.ollama.keyInput,
          setKeyInput: catalog.ollama.setKeyInput,
          setKey: catalog.ollama.setKey,
          clearKey: catalog.ollama.clearKey,
        },
        openrouter: {
          hasKey: catalog.openRouter.hasKey,
          model: catalog.openRouter.model,
          setModel: catalog.openRouter.setModel,
          modelOptions: catalog.openRouterModelOptions,
          modelsLoading: catalog.openRouterModels.loading,
          modelsError: catalog.openRouterModels.error,
          modelsUpdatedAt: catalog.openRouterModels.updatedAt,
          isModelLocked: isProviderLocked && lockedProvider === 'openrouter',
          refreshModels: catalog.refreshOpenRouterModels,
          keyInput: catalog.openRouter.keyInput,
          setKeyInput: catalog.openRouter.setKeyInput,
          setKey: catalog.openRouter.setKey,
          clearKey: catalog.openRouter.clearKey,
        },
        nvidia: {
          hasKey: catalog.nvidia.hasKey,
          model: catalog.nvidia.model,
          setModel: catalog.nvidia.setModel,
          modelOptions: catalog.nvidiaModelOptions,
          modelsLoading: catalog.nvidiaModels.loading,
          modelsError: catalog.nvidiaModels.error,
          modelsUpdatedAt: catalog.nvidiaModels.updatedAt,
          isModelLocked: isNvidiaModelLocked,
          refreshModels: catalog.refreshNvidiaModels,
          keyInput: catalog.nvidia.keyInput,
          setKeyInput: catalog.nvidia.setKeyInput,
          setKey: catalog.nvidia.setKey,
          clearKey: catalog.nvidia.clearKey,
        },
        zen: {
          hasKey: catalog.zen.hasKey,
          model: catalog.zen.model,
          setModel: catalog.zen.setModel,
          modelOptions: catalog.zenModelOptions,
          modelsLoading: catalog.zenModels.loading,
          modelsError: catalog.zenModels.error,
          modelsUpdatedAt: catalog.zenModels.updatedAt,
          isModelLocked: isZenModelLocked,
          refreshModels: catalog.refreshZenModels,
          keyInput: catalog.zen.keyInput,
          setKeyInput: catalog.zen.setKeyInput,
          setKey: catalog.zen.setKey,
          clearKey: catalog.zen.clearKey,
          goMode: catalog.zenGoMode,
          setGoMode: catalog.setZenGoMode,
        },
        blackbox: {
          hasKey: catalog.blackbox.hasKey,
          model: catalog.blackbox.model,
          setModel: catalog.blackbox.setModel,
          modelOptions: catalog.blackboxModelOptions,
          modelsLoading: catalog.blackboxModels.loading,
          modelsError: catalog.blackboxModels.error,
          modelsUpdatedAt: catalog.blackboxModels.updatedAt,
          isModelLocked: isBlackboxModelLocked,
          refreshModels: catalog.refreshBlackboxModels,
          keyInput: catalog.blackbox.keyInput,
          setKeyInput: catalog.blackbox.setKeyInput,
          setKey: catalog.blackbox.setKey,
          clearKey: catalog.blackbox.clearKey,
        },
        kilocode: {
          hasKey: catalog.kilocode.hasKey,
          model: catalog.kilocode.model,
          setModel: catalog.kilocode.setModel,
          modelOptions: catalog.kilocodeModelOptions,
          modelsLoading: catalog.kilocodeModels.loading,
          modelsError: catalog.kilocodeModels.error,
          modelsUpdatedAt: catalog.kilocodeModels.updatedAt,
          isModelLocked: isKilocodeModelLocked,
          refreshModels: catalog.refreshKilocodeModels,
          keyInput: catalog.kilocode.keyInput,
          setKeyInput: catalog.kilocode.setKeyInput,
          setKey: catalog.kilocode.setKey,
          clearKey: catalog.kilocode.clearKey,
        },
        fireworks: {
          hasKey: catalog.fireworks.hasKey,
          model: catalog.fireworks.model,
          setModel: catalog.fireworks.setModel,
          modelOptions: catalog.fireworksModelOptions,
          modelsLoading: catalog.fireworksModels.loading,
          modelsError: catalog.fireworksModels.error,
          modelsUpdatedAt: catalog.fireworksModels.updatedAt,
          isModelLocked: isFireworksModelLocked,
          refreshModels: catalog.refreshFireworksModels,
          keyInput: catalog.fireworks.keyInput,
          setKeyInput: catalog.fireworks.setKeyInput,
          setKey: catalog.fireworks.setKey,
          clearKey: catalog.fireworks.clearKey,
        },
        openadapter: {
          hasKey: catalog.openadapter.hasKey,
          model: catalog.openadapter.model,
          setModel: catalog.openadapter.setModel,
          modelOptions: catalog.openAdapterModelOptions,
          modelsLoading: catalog.openAdapterModels.loading,
          modelsError: catalog.openAdapterModels.error,
          modelsUpdatedAt: catalog.openAdapterModels.updatedAt,
          isModelLocked: isOpenAdapterModelLocked,
          refreshModels: catalog.refreshOpenAdapterModels,
          keyInput: catalog.openadapter.keyInput,
          setKeyInput: catalog.openadapter.setKeyInput,
          setKey: catalog.openadapter.setKey,
          clearKey: catalog.openadapter.clearKey,
        },
        anthropic: {
          hasKey: catalog.anthropic.hasKey,
          model: catalog.anthropic.model,
          setModel: catalog.anthropic.setModel,
          modelOptions: catalog.anthropicModelOptions,
          modelsLoading: false,
          modelsError: null,
          modelsUpdatedAt: null,
          isModelLocked: isProviderLocked && lockedProvider === 'anthropic',
          refreshModels: NOOP,
          keyInput: catalog.anthropic.keyInput,
          setKeyInput: catalog.anthropic.setKeyInput,
          setKey: catalog.anthropic.setKey,
          clearKey: catalog.anthropic.clearKey,
        },
        openai: {
          hasKey: catalog.openai.hasKey,
          model: catalog.openai.model,
          setModel: catalog.openai.setModel,
          modelOptions: catalog.openaiModelOptions,
          modelsLoading: catalog.openaiModels.loading,
          modelsError: catalog.openaiModels.error,
          modelsUpdatedAt: catalog.openaiModels.updatedAt,
          isModelLocked: isProviderLocked && lockedProvider === 'openai',
          refreshModels: catalog.refreshOpenAIModels,
          keyInput: catalog.openai.keyInput,
          setKeyInput: catalog.openai.setKeyInput,
          setKey: catalog.openai.setKey,
          clearKey: catalog.openai.clearKey,
        },
        google: {
          hasKey: catalog.google.hasKey,
          model: catalog.google.model,
          setModel: catalog.google.setModel,
          modelOptions: catalog.googleModelOptions,
          modelsLoading: catalog.googleModels.loading,
          modelsError: catalog.googleModels.error,
          modelsUpdatedAt: catalog.googleModels.updatedAt,
          isModelLocked: isProviderLocked && lockedProvider === 'google',
          refreshModels: catalog.refreshGoogleModels,
          keyInput: catalog.google.keyInput,
          setKeyInput: catalog.google.setKeyInput,
          setKey: catalog.google.setKey,
          clearKey: catalog.google.clearKey,
        },
      },
      cloudflareProvider: {
        configured: catalog.cloudflare.configured,
        statusLoading: catalog.cloudflare.statusLoading,
        statusError: catalog.cloudflare.statusError,
        model: catalog.cloudflare.model,
        setModel: catalog.cloudflare.setModel,
        modelOptions: catalog.cloudflareModelOptions,
        modelsLoading: catalog.cloudflareModels.loading,
        modelsError: catalog.cloudflareModels.error,
        modelsUpdatedAt: catalog.cloudflareModels.updatedAt,
        isModelLocked: isCloudflareModelLocked,
        refreshModels: catalog.refreshCloudflareModels,
      },
      experimentalProviders: {
        azure: {
          hasKey: catalog.azure.hasKey,
          keyInput: catalog.azure.keyInput,
          setKeyInput: catalog.azure.setKeyInput,
          setKey: catalog.azure.setKey,
          clearKey: catalog.azure.clearKey,
          baseUrl: catalog.azure.baseUrl,
          baseUrlInput: catalog.azure.baseUrlInput,
          setBaseUrlInput: catalog.azure.setBaseUrlInput,
          baseUrlError: catalog.azure.baseUrlError,
          setBaseUrl: catalog.azure.setBaseUrl,
          clearBaseUrl: catalog.azure.clearBaseUrl,
          model: catalog.azure.model,
          modelInput: catalog.azure.modelInput,
          setModelInput: catalog.azure.setModelInput,
          setModel: catalog.azure.setModel,
          clearModel: catalog.azure.clearModel,
          deployments: catalog.azure.deployments,
          activeDeploymentId: catalog.azure.activeDeploymentId,
          saveDeployment: catalog.azure.saveDeployment,
          selectDeployment: catalog.azure.selectDeployment,
          removeDeployment: catalog.azure.removeDeployment,
          clearDeployments: catalog.azure.clearDeployments,
          deploymentLimitReached: catalog.azure.deploymentLimitReached,
          isConfigured: catalog.azure.isConfigured,
        },
        bedrock: {
          hasKey: catalog.bedrock.hasKey,
          keyInput: catalog.bedrock.keyInput,
          setKeyInput: catalog.bedrock.setKeyInput,
          setKey: catalog.bedrock.setKey,
          clearKey: catalog.bedrock.clearKey,
          baseUrl: catalog.bedrock.baseUrl,
          baseUrlInput: catalog.bedrock.baseUrlInput,
          setBaseUrlInput: catalog.bedrock.setBaseUrlInput,
          baseUrlError: catalog.bedrock.baseUrlError,
          setBaseUrl: catalog.bedrock.setBaseUrl,
          clearBaseUrl: catalog.bedrock.clearBaseUrl,
          model: catalog.bedrock.model,
          modelInput: catalog.bedrock.modelInput,
          setModelInput: catalog.bedrock.setModelInput,
          setModel: catalog.bedrock.setModel,
          clearModel: catalog.bedrock.clearModel,
          deployments: catalog.bedrock.deployments,
          activeDeploymentId: catalog.bedrock.activeDeploymentId,
          saveDeployment: catalog.bedrock.saveDeployment,
          selectDeployment: catalog.bedrock.selectDeployment,
          removeDeployment: catalog.bedrock.removeDeployment,
          clearDeployments: catalog.bedrock.clearDeployments,
          deploymentLimitReached: catalog.bedrock.deploymentLimitReached,
          isConfigured: catalog.bedrock.isConfigured,
        },
      },
      vertexProvider: {
        hasKey: catalog.vertex.hasKey,
        keyInput: catalog.vertex.keyInput,
        setKeyInput: catalog.vertex.setKeyInput,
        keyError: catalog.vertex.keyError,
        setKey: catalog.vertex.setKey,
        clearKey: catalog.vertex.clearKey,
        region: catalog.vertex.region,
        regionInput: catalog.vertex.regionInput,
        setRegionInput: catalog.vertex.setRegionInput,
        regionError: catalog.vertex.regionError,
        setRegion: catalog.vertex.setRegion,
        clearRegion: catalog.vertex.clearRegion,
        model: catalog.vertex.model,
        modelInput: catalog.vertex.modelInput,
        setModelInput: catalog.vertex.setModelInput,
        modelOptions: catalog.vertex.modelOptions,
        setModel: catalog.vertex.setModel,
        clearModel: catalog.vertex.clearModel,
        mode: catalog.vertex.mode,
        transport: catalog.vertex.transport,
        projectId: catalog.vertex.projectId,
        hasLegacyConfig: catalog.vertex.hasLegacyConfig,
        isConfigured: catalog.vertex.isConfigured,
      },
      tavilyProvider: {
        hasKey: catalog.tavily.hasKey,
        keyInput: catalog.tavily.keyInput,
        setKeyInput: catalog.tavily.setKeyInput,
        setKey: catalog.tavily.setKey,
        clearKey: catalog.tavily.clearKey,
      },
    };

    const settingsWorkspace: SettingsWorkspaceProps = {
      approvalMode: prefs.approvalMode,
      updateApprovalMode: prefs.updateApprovalMode,
      // Daemon sessions don't have a cloud sandbox. The Settings UI's
      // Sandbox panel reads these to render the active-sandbox card;
      // null collapses it to "no sandbox active" which is accurate.
      sandboxStatus: 'idle',
      sandboxId: null,
      sandboxError: null,
      sandboxState: null,
      sandboxStateLoading: false,
      fetchSandboxState: NOOP,
      protectMainGlobal: protectMain.globalDefault,
      setProtectMainGlobal: protectMain.setGlobalDefault,
      // Per-repo override needs an active repo; daemon has none, so
      // the override controls stay hidden behind the null activeRepo
      // check in the Settings UI.
      protectMainRepoOverride: protectMain.repoOverride,
      setProtectMainRepoOverride: protectMain.setRepoOverride,
      showToolActivity: prefs.showToolActivity,
      setShowToolActivity: prefs.updateShowToolActivity,
      providerFailover: prefs.providerFailover,
      setProviderFailover: prefs.updateProviderFailover,
      runTokenBudget: prefs.runTokenBudget,
      setRunTokenBudget: prefs.updateRunTokenBudget,
      activeRepoFullName: null,
    };

    const settingsData: SettingsDataProps = {
      activeRepo: null,
      activeBranch: null,
      deleteAllChats,
      // No repo binding -> no repo-scoped or branch-scoped memory to
      // clear. The Settings UI gates these on a non-null activeRepo so
      // the buttons stay hidden; the no-ops are belt-and-suspenders.
      clearMemoryByRepo: NOOP,
      clearMemoryByBranch: NOOP_ASYNC,
    };

    return { settingsAuth, settingsProfile, settingsAI, settingsWorkspace, settingsData };
  }, [
    enabled,
    auth,
    onDisconnect,
    prefs,
    catalog,
    protectMain,
    isProviderLocked,
    lockedProvider,
    isModelLocked,
    lockedModel,
    deleteAllChats,
  ]);
}
