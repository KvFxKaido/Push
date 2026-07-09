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
import { buildSettingsBuiltInProviders } from '@/components/settings-built-in-provider-builder';
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

    const isCloudflareModelLocked = isModelLocked && lockedProvider === 'cloudflare';

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
      builtInProviders: buildSettingsBuiltInProviders({
        catalog,
        isProviderLocked,
        lockedProvider,
        isModelLocked,
      }),
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
