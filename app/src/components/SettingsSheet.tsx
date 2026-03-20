import { useState } from 'react';
import { Trash2, RefreshCw, Loader2, Check, Plus, ChevronDown } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { SettingsSectionContent } from '@/components/SettingsSectionContent';
import type { AIProviderType, SandboxStateCardData } from '@/types';
import type { PreferredProvider } from '@/lib/providers';
import type { ContextMode } from '@/lib/orchestrator';
import type { SandboxStartMode } from '@/lib/sandbox-start-mode';
import type { RepoOverride } from '@/hooks/useProtectMain';
import {
  MAX_EXPERIMENTAL_DEPLOYMENTS,
  normalizeExperimentalBaseUrl,
  type ExperimentalDeployment,
  type ExperimentalProviderType,
} from '@/lib/experimental-providers';
import type { VertexConfiguredMode } from '@/hooks/useVertexConfig';
import type {
  BuiltInSettingsProviderId,
  ExperimentalSettingsProviderId,
} from '@/components/settings-shared';
import { SETTINGS_SECTION_ICONS } from '@/components/settings-shared';

export type SettingsTabKey = 'you' | 'workspace' | 'ai';

const SETTINGS_TAB_META: Record<SettingsTabKey, { title: string; description: string }> = {
  you: {
    title: 'You',
    description: 'How Push should know and represent you.',
  },
  workspace: {
    title: 'Workspace',
    description: 'How this workspace behaves while you work.',
  },
  ai: {
    title: 'AI',
    description: 'Which models power new chats and reviews.',
  },
};

const SETTINGS_SELECT_CLASS = 'rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50 [color-scheme:dark] [background-color:#121926] [&>option]:bg-[#121926] [&>option]:text-push-fg';

// ── Prop groups ──────────────────────────────────────────────────────

export interface SettingsAuthProps {
  isConnected: boolean;
  isAppAuth: boolean;
  installationId: string;
  token: string;
  patToken: string;
  validatedUser: { login: string } | null;
  appLoading: boolean;
  appError: string | null;
  connectApp: () => void;
  installApp: () => void;
  showInstallIdInput: boolean;
  setShowInstallIdInput: (v: boolean) => void;
  installIdInput: string;
  setInstallIdInput: (v: string) => void;
  setInstallationIdManually: (id: string) => Promise<boolean>;
  allowlistSecretCmd: string;
  copyAllowlistCommand: () => void;
  onDisconnect: () => void;
}

export interface SettingsProfileProps {
  displayNameDraft: string;
  setDisplayNameDraft: (v: string) => void;
  onDisplayNameBlur: () => void;
  bioDraft: string;
  setBioDraft: (v: string) => void;
  onBioBlur: () => void;
  profile: { displayName: string; bio: string; githubLogin?: string };
  clearProfile: () => void;
  validatedUser: { login: string } | null;
}

export interface SettingsAIProps {
  activeProviderLabel: AIProviderType;
  activeBackend: PreferredProvider | null;
  setActiveBackend: (v: PreferredProvider | null) => void;
  isProviderLocked: boolean;
  lockedProvider: AIProviderType | null;
  lockedModel: string | null;
  availableProviders: readonly (readonly [string, string, boolean])[];
  setPreferredProvider: (v: PreferredProvider) => void;
  clearPreferredProvider: () => void;
  builtInProviders: Record<BuiltInSettingsProviderId, SettingsBuiltInProvider>;
  experimentalProviders: Record<ExperimentalSettingsProviderId, SettingsExperimentalProvider>;
  vertexProvider: SettingsVertexProvider;
  tavilyProvider: SettingsTavilyProvider;
}

export interface SettingsBuiltInProvider {
  hasKey: boolean;
  model: string;
  setModel: (value: string) => void;
  modelOptions: string[];
  modelsLoading: boolean;
  modelsError: string | null;
  modelsUpdatedAt: number | null;
  isModelLocked: boolean;
  refreshModels: () => void;
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (value: string) => void;
  clearKey: () => void;
  goMode?: boolean;
  setGoMode?: (enabled: boolean) => void;
}

export interface SettingsExperimentalProvider {
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (value: string) => void;
  clearKey: () => void;
  baseUrl: string;
  baseUrlInput: string;
  setBaseUrlInput: (value: string) => void;
  baseUrlError: string | null;
  setBaseUrl: (value: string) => void;
  clearBaseUrl: () => void;
  model: string;
  modelInput: string;
  setModelInput: (value: string) => void;
  setModel: (value: string) => void;
  clearModel: () => void;
  deployments: ExperimentalDeployment[];
  activeDeploymentId: string | null;
  saveDeployment: (model: string) => boolean;
  selectDeployment: (id: string) => void;
  removeDeployment: (id: string) => void;
  clearDeployments: () => void;
  deploymentLimitReached: boolean;
  isConfigured: boolean;
}

export interface SettingsVertexProvider {
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (value: string) => void;
  keyError: string | null;
  setKey: (value: string) => void;
  clearKey: () => void;
  region: string;
  regionInput: string;
  setRegionInput: (value: string) => void;
  regionError: string | null;
  setRegion: (value: string) => void;
  clearRegion: () => void;
  model: string;
  modelInput: string;
  setModelInput: (value: string) => void;
  modelOptions: string[];
  setModel: (value: string) => void;
  clearModel: () => void;
  mode: VertexConfiguredMode;
  transport: 'openapi' | 'anthropic';
  projectId: string | null;
  hasLegacyConfig: boolean;
  isConfigured: boolean;
}

export interface SettingsTavilyProvider {
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (value: string) => void;
  clearKey: () => void;
}

export interface SettingsWorkspaceProps {
  contextMode: ContextMode;
  updateContextMode: (mode: ContextMode) => void;
  sandboxStartMode: SandboxStartMode;
  updateSandboxStartMode: (mode: SandboxStartMode) => void;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  sandboxId: string | null;
  sandboxError: string | null;
  sandboxState: SandboxStateCardData | null;
  sandboxStateLoading: boolean;
  fetchSandboxState: (id: string) => void;
  // Protect Main
  protectMainGlobal: boolean;
  setProtectMainGlobal: (value: boolean) => void;
  protectMainRepoOverride: RepoOverride;
  setProtectMainRepoOverride: (value: RepoOverride) => void;
  showToolActivity: boolean;
  setShowToolActivity: (value: boolean) => void;
  activeRepoFullName: string | null;
}

export interface SettingsDataProps {
  activeRepo: { name: string } | null;
  deleteAllChats: () => void;
}

export interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'left' | 'right';
  settingsTab: SettingsTabKey;
  setSettingsTab: (tab: SettingsTabKey) => void;
  auth: SettingsAuthProps;
  profile: SettingsProfileProps;
  ai: SettingsAIProps;
  workspace: SettingsWorkspaceProps;
  data: SettingsDataProps;
}

// ── Provider Key Section ─────────────────────────────────────────────

interface ProviderKeySectionProps {
  label: string;
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (v: string) => void;
  saveKey: () => void;
  clearKey: () => void;
  activeBackend: PreferredProvider | null;
  backendId: PreferredProvider | 'tavily';
  clearPreferredProvider: () => void;
  setActiveBackend: (v: PreferredProvider | null) => void;
  placeholder: string;
  saveLabel: string;
  hint: string;
  savedHint?: string;
  model?: {
    value: string;
    set: (v: string) => void;
    options: string[];
    isLocked: boolean;
    lockedModel: string | null;
    labelTransform?: (model: string) => string;
  };
  refresh?: {
    trigger: () => void;
    loading: boolean;
    error: string | null;
    updatedAt: number | null;
  };
}

interface ExperimentalProviderSectionProps {
  label: string;
  backendId: ExperimentalProviderType;
  activeBackend: PreferredProvider | null;
  setActiveBackend: (v: PreferredProvider | null) => void;
  clearPreferredProvider: () => void;
  helperText: string;
  configured: boolean;
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (value: string) => void;
  clearKey: () => void;
  baseUrl: string;
  baseUrlInput: string;
  setBaseUrlInput: (value: string) => void;
  baseUrlError: string | null;
  setBaseUrl: (value: string) => void;
  clearBaseUrl: () => void;
  baseUrlPlaceholder: string;
  model: string;
  modelInput: string;
  setModelInput: (value: string) => void;
  clearModel: () => void;
  deployments: ExperimentalDeployment[];
  activeDeploymentId: string | null;
  saveDeployment: (model: string) => boolean;
  selectDeployment: (id: string) => void;
  removeDeployment: (id: string) => void;
  clearDeployments: () => void;
  modelPlaceholder: string;
}

interface VertexProviderSectionProps {
  activeBackend: PreferredProvider | null;
  setActiveBackend: (v: PreferredProvider | null) => void;
  clearPreferredProvider: () => void;
  configured: boolean;
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (value: string) => void;
  keyError: string | null;
  setKey: (value: string) => void;
  clearKey: () => void;
  region: string;
  regionInput: string;
  setRegionInput: (value: string) => void;
  regionError: string | null;
  setRegion: (value: string) => void;
  clearRegion: () => void;
  model: string;
  modelInput: string;
  setModelInput: (value: string) => void;
  modelOptions: string[];
  setModel: (value: string) => void;
  clearModel: () => void;
  mode: VertexConfiguredMode;
  transport: 'openapi' | 'anthropic';
  projectId: string | null;
  hasLegacyConfig: boolean;
}

function formatExperimentalDeploymentTarget(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const trimmedPath = parsed.pathname.replace(/\/openai\/v1$/, '') || '/openai/v1';
    return `${parsed.host}${trimmedPath}`;
  } catch {
    return baseUrl;
  }
}

export function ProviderKeySection({
  label,
  hasKey,
  keyInput,
  setKeyInput,
  saveKey,
  clearKey,
  activeBackend,
  backendId,
  clearPreferredProvider,
  setActiveBackend,
  placeholder,
  saveLabel,
  hint,
  savedHint,
  model,
  refresh,
}: ProviderKeySectionProps) {
  if (hasKey) {
    return (
      <div className="space-y-3 rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] p-3 shadow-[0_12px_24px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <p className="text-sm text-push-fg-secondary">Connected</p>
          </div>
          <button
            type="button"
            onClick={() => {
              clearKey();
              if (activeBackend === backendId) {
                clearPreferredProvider();
                setActiveBackend(null);
              }
            }}
            className="text-push-fg-dim hover:text-red-400 transition-colors"
            aria-label={`Remove ${label} key`}
            title="Remove key"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {model && (
          <div className="flex items-center gap-2 rounded-xl border border-push-edge-subtle bg-push-surface/45 px-3 py-2">
            <span className="shrink-0 text-xs text-push-fg-muted">Use for new chats</span>
            <select
              value={model.value}
              onChange={(e) => model.set(e.target.value)}
              disabled={model.options.length === 0 || (refresh?.loading ?? false)}
              className={`flex-1 rounded-md px-2 py-1 text-xs font-mono disabled:opacity-50 ${SETTINGS_SELECT_CLASS}`}
            >
              {model.options.length === 0 ? (
                <option value={model.value}>{model.labelTransform ? model.labelTransform(model.value) : model.value}</option>
              ) : (
                model.options.map((m) => (
                  <option key={m} value={m}>
                    {model.labelTransform ? model.labelTransform(m) : m}
                  </option>
                ))
              )}
            </select>
            {refresh && (
              <button
                type="button"
                onClick={refresh.trigger}
                disabled={refresh.loading}
                className="rounded-md border border-push-edge bg-push-surface p-1.5 text-push-fg-secondary hover:text-push-fg disabled:opacity-50"
                aria-label={`Refresh ${label} models`}
                title={`Refresh ${label} models`}
              >
                {refresh.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )}
        {refresh?.error && (
          <p className="text-xs text-amber-400">
            {refresh.error}
          </p>
        )}
        {refresh?.updatedAt && (
          <p className="text-xs text-push-fg-dim">
            Updated {new Date(refresh.updatedAt).toLocaleTimeString()}
          </p>
        )}
        {model?.isLocked && model.lockedModel && (
          <p className="text-xs text-amber-400">
            This chat keeps using {model.lockedModel}. New chats will use your updated default.
          </p>
        )}
        {savedHint && (
          <p className="text-xs text-push-fg-dim">
            {savedHint}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.012))] p-3 shadow-[0_12px_24px_rgba(0,0,0,0.16)]">
      <input
        type="password"
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && keyInput.trim()) {
            saveKey();
            setKeyInput('');
          }
        }}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          if (keyInput.trim()) {
            saveKey();
            setKeyInput('');
          }
        }}
        disabled={!keyInput.trim()}
        className="text-push-fg-secondary hover:text-push-fg w-full justify-start"
      >
        {saveLabel}
      </Button>
      <p className="text-xs text-push-fg-dim">
        {hint}
      </p>
    </div>
  );
}

export function ExperimentalProviderSection({
  label,
  backendId,
  activeBackend,
  setActiveBackend,
  clearPreferredProvider,
  helperText,
  configured,
  hasKey,
  keyInput,
  setKeyInput,
  setKey,
  clearKey,
  baseUrl,
  baseUrlInput,
  setBaseUrlInput,
  baseUrlError,
  setBaseUrl,
  clearBaseUrl,
  baseUrlPlaceholder,
  model,
  modelInput,
  setModelInput,
  clearModel,
  deployments,
  activeDeploymentId,
  saveDeployment,
  selectDeployment,
  removeDeployment,
  clearDeployments,
  modelPlaceholder,
}: ExperimentalProviderSectionProps) {
  const nextBaseUrl = baseUrlInput.trim();
  const nextModel = modelInput.trim();
  const isAtDeploymentLimit = deployments.length >= MAX_EXPERIMENTAL_DEPLOYMENTS;
  const resolvedBaseUrlValidation = nextBaseUrl
    ? normalizeExperimentalBaseUrl(backendId, nextBaseUrl)
    : null;
  const draftBaseUrlError = nextBaseUrl
    ? (resolvedBaseUrlValidation && !resolvedBaseUrlValidation.ok ? resolvedBaseUrlValidation.error : null)
    : baseUrlError;
  const [isAddDeploymentExpanded, setIsAddDeploymentExpanded] = useState(() => deployments.length === 0);
  const isAddDeploymentOpen = deployments.length === 0 || isAddDeploymentExpanded;
  const saveCurrentBaseUrl = () => {
    if (!nextBaseUrl || draftBaseUrlError) return;
    setBaseUrl(nextBaseUrl);
    setBaseUrlInput('');
  };

  const saveCurrentDeployment = () => {
    if (!nextModel) return;
    const saved = saveDeployment(nextModel);
    if (!saved) return;
    setModelInput('');
    setIsAddDeploymentExpanded(false);
  };

  const clearAll = () => {
    clearKey();
    clearBaseUrl();
    clearModel();
    clearDeployments();
    setKeyInput('');
    setBaseUrlInput('');
    setModelInput('');
    setIsAddDeploymentExpanded(true);
    if (activeBackend === backendId) {
      clearPreferredProvider();
      setActiveBackend(null);
    }
  };

  return (
    <div className="min-w-0 space-y-2 overflow-hidden rounded-xl border border-push-edge bg-push-surface/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-push-fg">{label}</span>
            <span className={`rounded-full px-2 py-0.5 text-push-2xs uppercase tracking-wide ${
              configured
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-amber-500/10 text-amber-300'
            }`}>
              {configured ? 'Connected' : 'Bring your own'}
            </span>
          </div>
          <p className="text-xs text-push-fg-dim">{helperText}</p>
        </div>
        <button
          type="button"
          onClick={clearAll}
          className="text-push-fg-dim hover:text-red-400 transition-colors"
          aria-label={`Reset ${label} connector`}
          title="Reset connector"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-push-xs font-medium text-push-fg-secondary">API key</label>
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={hasKey ? 'Key saved' : `${label} API key`}
          className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
        />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = keyInput.trim();
              if (!next) return;
              setKey(next);
              setKeyInput('');
            }}
            disabled={!keyInput.trim()}
            className="text-push-fg-secondary hover:text-push-fg"
          >
            Save key
          </Button>
          {hasKey && <span className="self-center text-push-xs text-push-fg-dim">Stored locally</span>}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label className="text-push-xs font-medium text-push-fg-secondary">Deployments</label>
          <span className="text-push-2xs text-push-fg-dim">{deployments.length}/3 saved</span>
        </div>
        {deployments.length > 0 ? (
          <div className="space-y-2">
            {deployments.map((deployment) => {
              const isActive = deployment.id === activeDeploymentId;
              return (
                <div
                  key={deployment.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                    isActive
                      ? 'border-emerald-500/40 bg-emerald-500/10'
                      : 'border-push-edge-subtle bg-push-surface/60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectDeployment(deployment.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-push-fg">{deployment.model}</span>
                      {isActive && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-push-2xs uppercase tracking-wide text-emerald-400">
                          <Check className="h-3 w-3" />
                          Active
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeDeployment(deployment.id)}
                    className="text-push-fg-dim transition-colors hover:text-red-400"
                    aria-label={`Remove ${deployment.model}`}
                    title="Remove deployment"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : configured ? (
          <p className="text-xs text-push-fg-dim">No saved deployments yet. Add this one if you want to reuse it later.</p>
        ) : (
          <p className="text-xs text-push-fg-dim">No saved deployments yet.</p>
        )}
        {isAtDeploymentLimit && (
          <p className="text-xs text-amber-400">
            Max {MAX_EXPERIMENTAL_DEPLOYMENTS} saved deployments. Remove one before adding another.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-push-xs font-medium text-push-fg-secondary">Base URL</label>
        <input
          type="url"
          value={baseUrlInput}
          onChange={(e) => setBaseUrlInput(e.target.value)}
          placeholder={baseUrl || baseUrlPlaceholder}
          className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
        />
        {draftBaseUrlError && <p className="text-xs text-amber-400">{draftBaseUrlError}</p>}
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={saveCurrentBaseUrl}
            disabled={!nextBaseUrl || Boolean(draftBaseUrlError)}
            className="text-push-fg-secondary hover:text-push-fg"
          >
            Save base URL
          </Button>
          {baseUrl && <span className="self-center text-push-xs text-push-fg-dim">Stored locally</span>}
        </div>
      </div>

      {!isAtDeploymentLimit && (
        <div className="rounded-lg border border-push-edge-subtle bg-push-surface/40 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setIsAddDeploymentExpanded((prev) => !prev)}
            className="flex w-full items-center justify-between gap-2 text-left text-sm text-push-fg-secondary"
            aria-expanded={isAddDeploymentOpen}
          >
            <span className="flex items-center gap-2">
              <Plus className="h-3.5 w-3.5" />
              Add deployment
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform ${isAddDeploymentOpen ? 'rotate-180' : ''}`} />
          </button>
          {isAddDeploymentOpen && (
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <label className="text-push-xs font-medium text-push-fg-secondary">Deployment / model</label>
                <input
                  type="text"
                  value={modelInput}
                  onChange={(e) => setModelInput(e.target.value)}
                  placeholder={model || modelPlaceholder}
                  className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
                />
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={saveCurrentDeployment}
                disabled={!nextModel}
                className="text-push-fg-secondary hover:text-push-fg"
              >
                Add deployment
              </Button>
            </div>
          )}
        </div>
      )}

      {configured && (
        <div className="rounded-lg border border-push-edge-subtle bg-push-surface/40 px-3 py-2">
          <p className="text-push-xs text-push-fg-secondary">Active now</p>
          <p className="truncate text-sm text-push-fg">{model}</p>
          {baseUrl && (
            <p className="truncate text-push-xs text-push-fg-dim">{formatExperimentalDeploymentTarget(baseUrl)}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function VertexProviderSection({
  activeBackend,
  setActiveBackend,
  clearPreferredProvider,
  configured,
  hasKey,
  keyInput,
  setKeyInput,
  keyError,
  setKey,
  clearKey,
  region,
  regionInput,
  setRegionInput,
  regionError,
  setRegion,
  clearRegion,
  model,
  modelInput,
  setModelInput,
  modelOptions,
  setModel,
  clearModel,
  mode,
  transport,
  projectId,
  hasLegacyConfig,
}: VertexProviderSectionProps) {
  const clearAll = () => {
    clearKey();
    clearRegion();
    clearModel();
    setKeyInput('');
    setRegionInput('');
    setModelInput('');
    if (activeBackend === 'vertex') {
      clearPreferredProvider();
      setActiveBackend(null);
    }
  };

  return (
    <div className="min-w-0 space-y-2 overflow-hidden rounded-xl border border-push-edge bg-push-surface/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-push-fg">Google Vertex</span>
            <span className={`rounded-full px-2 py-0.5 text-push-2xs uppercase tracking-wide ${
              configured
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-amber-500/10 text-amber-300'
            }`}>
              {configured ? 'Connected' : 'Bring your own'}
            </span>
          </div>
          <p className="text-xs text-push-fg-dim">
            Bring your own Google service account, pick a region, and Push will route Gemini and Claude through Vertex for you.
          </p>
        </div>
        <button
          type="button"
          onClick={clearAll}
          className="text-push-fg-dim hover:text-red-400 transition-colors"
          aria-label="Reset Google Vertex connector"
          title="Reset connector"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-push-xs font-medium text-push-fg-secondary">Service account JSON</label>
        <textarea
          rows={6}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={hasKey ? 'Service account JSON saved locally' : 'Paste the full Google service account JSON'}
          className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50 font-mono resize-y"
        />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = keyInput.trim();
              if (!next) return;
              setKey(next);
            }}
            disabled={!keyInput.trim()}
            className="text-push-fg-secondary hover:text-push-fg"
          >
            Save service account
          </Button>
          {hasKey && <span className="self-center text-push-xs text-push-fg-dim">Stored locally</span>}
        </div>
        {keyError && <p className="text-xs text-amber-400">{keyError}</p>}
        {projectId && (
          <p className="text-xs text-push-fg-dim">
            Project detected: <span className="font-mono text-push-fg-secondary">{projectId}</span>
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-push-xs font-medium text-push-fg-secondary">Region</label>
          <input
            type="text"
            value={regionInput}
            onChange={(e) => setRegionInput(e.target.value)}
            placeholder={region || 'global'}
            className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
          />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRegion((regionInput || region).trim())}
              disabled={!((regionInput || region).trim())}
              className="text-push-fg-secondary hover:text-push-fg"
            >
              Save region
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearRegion}
              className="text-push-fg-dim hover:text-push-fg-secondary"
            >
              Reset
            </Button>
          </div>
          {regionError ? (
            <p className="text-xs text-amber-400">{regionError}</p>
          ) : (
            <p className="text-xs text-push-fg-dim">Use <span className="font-mono">global</span> unless you need a region-specific deployment.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-push-xs font-medium text-push-fg-secondary">Default model</label>
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setModelInput(e.target.value);
            }}
            className={`w-full ${SETTINGS_SELECT_CLASS}`}
          >
            {modelOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
          <input
            type="text"
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder={model}
            className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
          />
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setModel((modelInput || model).trim())}
              disabled={!((modelInput || model).trim())}
              className="text-push-fg-secondary hover:text-push-fg"
            >
              Save model
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearModel}
              className="text-push-fg-dim hover:text-push-fg-secondary"
            >
              Reset
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-push-edge-subtle bg-push-surface/40 px-3 py-2">
        <p className="text-push-xs text-push-fg-secondary">Active now</p>
        <p className="truncate text-sm text-push-fg">{model}</p>
        <p className="truncate text-push-xs text-push-fg-dim">
          Mode: {mode} · Transport: {transport} · Region: {region}
        </p>
        {hasLegacyConfig && (
          <p className="mt-1 text-push-2xs text-amber-400">
            Legacy raw-endpoint Vertex config is still present and will be used only if no service account is saved.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────

export function SettingsSheet({
  open,
  onOpenChange,
  side = 'right',
  settingsTab,
  setSettingsTab,
  auth,
  profile,
  ai,
  workspace,
  data,
}: SettingsSheetProps) {
  const tabMeta = SETTINGS_TAB_META[settingsTab];
  const ActiveTabIcon = SETTINGS_SECTION_ICONS[settingsTab];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className="w-[86vw] rounded-r-2xl border-[#151b26] bg-push-grad-panel p-0 text-push-fg shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] sm:max-w-none [&>[data-slot=sheet-close]]:text-push-fg-secondary [&>[data-slot=sheet-close]]:hover:text-push-fg"
      >
        <SheetTitle className="sr-only">Settings</SheetTitle>
        <SheetDescription className="sr-only">Configure your workspace</SheetDescription>

        {/* Subtle top glow */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 rounded-tr-2xl bg-gradient-to-b from-white/[0.03] to-transparent" />

        <div className="relative flex h-dvh flex-col overflow-hidden rounded-r-2xl">
        {/* Header */}
        <header className="shrink-0 border-b border-push-edge px-4 pt-4 pb-3">
          <div className="rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] px-3 py-3 shadow-[0_16px_30px_rgba(0,0,0,0.24)]">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-push-edge bg-push-surface/80 text-push-fg shadow-[0_10px_22px_rgba(0,0,0,0.22)]">
                <ActiveTabIcon className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <p className="text-push-2xs uppercase tracking-[0.24em] text-push-fg-dim">Control center</p>
                <p className="mt-1 text-base font-semibold text-push-fg">{tabMeta.title}</p>
                <p className="mt-0.5 text-push-xs text-push-fg-dim">{tabMeta.description}</p>
              </div>
            </div>
          </div>
        </header>

        {/* Tab bar */}
        <div className="shrink-0 border-b border-push-edge px-3 py-3">
          <div className="rounded-2xl border border-push-edge bg-[#0b1017]/85 p-1.5 shadow-[0_12px_28px_rgba(0,0,0,0.22)]">
            <div className="grid grid-cols-3 gap-1.5">
            {([['you', 'You'], ['workspace', 'Workspace'], ['ai', 'AI']] as const).map(([key, label]) => {
              const Icon = SETTINGS_SECTION_ICONS[key];
              return (
              <button
                key={key}
                type="button"
                onClick={() => setSettingsTab(key)}
                className={`flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-2 text-push-xs font-medium transition-all ${
                  settingsTab === key
                    ? 'border border-push-edge-hover bg-push-grad-input text-push-fg shadow-[0_12px_24px_rgba(0,0,0,0.32),0_2px_6px_rgba(0,0,0,0.18)]'
                    : 'border border-transparent text-push-fg-dim hover:border-[#1f2a3a] hover:bg-[#0c1018] hover:text-push-fg-secondary'
                }`}
              >
                <span className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                  settingsTab === key
                    ? 'border-push-edge-hover bg-white/6'
                    : 'border-transparent bg-transparent'
                }`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                {label}
              </button>
            );
            })}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <SettingsSectionContent
            settingsTab={settingsTab}
            auth={auth}
            profile={profile}
            ai={ai}
            workspace={workspace}
            data={data}
            onDismiss={() => onOpenChange(false)}
          />
        </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
