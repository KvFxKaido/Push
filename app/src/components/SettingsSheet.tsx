import { Trash2, GitBranch, RefreshCw, Loader2, User, FolderCog, Cpu } from 'lucide-react';
import { getMalformedToolCallMetrics } from '@/lib/tool-call-metrics';
import { getContextMetrics } from '@/lib/context-metrics';
import { fileLedger } from '@/lib/file-awareness-ledger';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { Button } from '@/components/ui/button';
import type { AIProviderType, SandboxStateCardData } from '@/types';
import type { PreferredProvider } from '@/lib/providers';
import type { ContextMode } from '@/lib/orchestrator';
import type { SandboxStartMode } from '@/lib/sandbox-start-mode';
import type { RepoOverride } from '@/hooks/useProtectMain';

const PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  zen: 'OpenCode Zen',
  nvidia: 'Nvidia NIM',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex',
  demo: 'Demo',
};

// ── Prop groups ──────────────────────────────────────────────────────

export interface SettingsAuthProps {
  isConnected: boolean;
  isDemo: boolean;
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
  // Ollama
  hasOllamaKey: boolean;
  ollamaModel: string;
  setOllamaModel: (v: string) => void;
  ollamaModelOptions: string[];
  ollamaModelsLoading: boolean;
  ollamaModelsError: string | null;
  ollamaModelsUpdatedAt: number | null;
  isOllamaModelLocked: boolean;
  refreshOllamaModels: () => void;
  ollamaKeyInput: string;
  setOllamaKeyInput: (v: string) => void;
  setOllamaKey: (v: string) => void;
  clearOllamaKey: () => void;
  // OpenRouter
  hasOpenRouterKey: boolean;
  openRouterModel: string;
  setOpenRouterModel: (v: string) => void;
  openRouterModelOptions: string[];
  openRouterModelsLoading: boolean;
  openRouterModelsError: string | null;
  openRouterModelsUpdatedAt: number | null;
  isOpenRouterModelLocked: boolean;
  refreshOpenRouterModels: () => void;
  openRouterKeyInput: string;
  setOpenRouterKeyInput: (v: string) => void;
  setOpenRouterKey: (v: string) => void;
  clearOpenRouterKey: () => void;
  // OpenCode Zen
  hasZenKey: boolean;
  zenModel: string;
  setZenModel: (v: string) => void;
  zenModelOptions: string[];
  zenModelsLoading: boolean;
  zenModelsError: string | null;
  zenModelsUpdatedAt: number | null;
  isZenModelLocked: boolean;
  refreshZenModels: () => void;
  zenKeyInput: string;
  setZenKeyInput: (v: string) => void;
  setZenKey: (v: string) => void;
  clearZenKey: () => void;
  // Nvidia NIM
  hasNvidiaKey: boolean;
  nvidiaModel: string;
  setNvidiaModel: (v: string) => void;
  nvidiaModelOptions: string[];
  nvidiaModelsLoading: boolean;
  nvidiaModelsError: string | null;
  nvidiaModelsUpdatedAt: number | null;
  isNvidiaModelLocked: boolean;
  refreshNvidiaModels: () => void;
  nvidiaKeyInput: string;
  setNvidiaKeyInput: (v: string) => void;
  setNvidiaKey: (v: string) => void;
  clearNvidiaKey: () => void;
  // Azure OpenAI (experimental)
  hasAzureKey: boolean;
  azureKeyInput: string;
  setAzureKeyInput: (v: string) => void;
  setAzureKey: (v: string) => void;
  clearAzureKey: () => void;
  azureBaseUrl: string;
  azureBaseUrlInput: string;
  setAzureBaseUrlInput: (v: string) => void;
  setAzureBaseUrl: (v: string) => void;
  clearAzureBaseUrl: () => void;
  azureBaseUrlError: string | null;
  azureModel: string;
  azureModelInput: string;
  setAzureModelInput: (v: string) => void;
  setAzureModel: (v: string) => void;
  clearAzureModel: () => void;
  isAzureConfigured: boolean;
  // AWS Bedrock (experimental)
  hasBedrockKey: boolean;
  bedrockKeyInput: string;
  setBedrockKeyInput: (v: string) => void;
  setBedrockKey: (v: string) => void;
  clearBedrockKey: () => void;
  bedrockBaseUrl: string;
  bedrockBaseUrlInput: string;
  setBedrockBaseUrlInput: (v: string) => void;
  setBedrockBaseUrl: (v: string) => void;
  clearBedrockBaseUrl: () => void;
  bedrockBaseUrlError: string | null;
  bedrockModel: string;
  bedrockModelInput: string;
  setBedrockModelInput: (v: string) => void;
  setBedrockModel: (v: string) => void;
  clearBedrockModel: () => void;
  isBedrockConfigured: boolean;
  // Google Vertex (experimental)
  hasVertexKey: boolean;
  vertexKeyInput: string;
  setVertexKeyInput: (v: string) => void;
  setVertexKey: (v: string) => void;
  clearVertexKey: () => void;
  vertexBaseUrl: string;
  vertexBaseUrlInput: string;
  setVertexBaseUrlInput: (v: string) => void;
  setVertexBaseUrl: (v: string) => void;
  clearVertexBaseUrl: () => void;
  vertexBaseUrlError: string | null;
  vertexModel: string;
  vertexModelInput: string;
  setVertexModelInput: (v: string) => void;
  setVertexModel: (v: string) => void;
  clearVertexModel: () => void;
  isVertexConfigured: boolean;
  // Tavily
  hasTavilyKey: boolean;
  tavilyKeyInput: string;
  setTavilyKeyInput: (v: string) => void;
  setTavilyKey: (v: string) => void;
  clearTavilyKey: () => void;
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
  settingsTab: 'you' | 'workspace' | 'ai';
  setSettingsTab: (tab: 'you' | 'workspace' | 'ai') => void;
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
  backendId: PreferredProvider;
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
  setBaseUrl: (value: string) => void;
  clearBaseUrl: () => void;
  baseUrlError: string | null;
  baseUrlPlaceholder: string;
  model: string;
  modelInput: string;
  setModelInput: (value: string) => void;
  setModel: (value: string) => void;
  clearModel: () => void;
  modelPlaceholder: string;
}

function ProviderKeySection({
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
      <div className="space-y-2">
        <div className="flex items-center justify-between rounded-lg border border-[#1b2230] bg-push-surface px-3 py-2">
          <p className="text-sm text-push-fg-secondary font-mono">Key Saved</p>
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
          <div className="flex items-center gap-2">
            <span className="text-xs text-push-fg-muted shrink-0">Default model:</span>
            <select
              value={model.value}
              onChange={(e) => model.set(e.target.value)}
              disabled={model.options.length === 0 || (refresh?.loading ?? false)}
              className="flex-1 rounded-md border border-[#1b2230] bg-push-grad-input px-2 py-1 text-xs text-push-fg font-mono shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50 disabled:opacity-50"
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
            Current chat remains locked to {model.lockedModel}. Default applies on new chats.
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
    <div className="space-y-2">
      <input
        type="password"
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50"
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

function ExperimentalProviderSection({
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
  setBaseUrl,
  clearBaseUrl,
  baseUrlError,
  baseUrlPlaceholder,
  model,
  modelInput,
  setModelInput,
  setModel,
  clearModel,
  modelPlaceholder,
}: ExperimentalProviderSectionProps) {
  const clearAll = () => {
    clearKey();
    clearBaseUrl();
    clearModel();
    setKeyInput('');
    setBaseUrlInput('');
    setModelInput('');
    if (activeBackend === backendId) {
      clearPreferredProvider();
      setActiveBackend(null);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-push-edge bg-push-surface/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-push-fg">{label}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
              configured
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-amber-500/10 text-amber-300'
            }`}>
              {configured ? 'Ready' : 'Experimental'}
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
        <label className="text-[11px] font-medium text-push-fg-secondary">Base URL</label>
        <input
          type="url"
          value={baseUrlInput}
          onChange={(e) => setBaseUrlInput(e.target.value)}
          placeholder={baseUrl || baseUrlPlaceholder}
          className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50"
        />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = baseUrlInput.trim();
              if (!next) return;
              setBaseUrl(next);
              setBaseUrlInput('');
            }}
            disabled={!baseUrlInput.trim()}
            className="text-push-fg-secondary hover:text-push-fg"
          >
            Save URL
          </Button>
          {baseUrl && (
            <span className="min-w-0 self-center truncate text-[11px] text-push-fg-dim">{baseUrl}</span>
          )}
        </div>
        {baseUrlError && <p className="text-xs text-amber-400">{baseUrlError}</p>}
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-push-fg-secondary">Deployment / model</label>
        <input
          type="text"
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          placeholder={model || modelPlaceholder}
          className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50"
        />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = modelInput.trim();
              if (!next) return;
              setModel(next);
              setModelInput('');
            }}
            disabled={!modelInput.trim()}
            className="text-push-fg-secondary hover:text-push-fg"
          >
            Save model
          </Button>
          <span className="min-w-0 self-center truncate text-[11px] text-push-fg-dim">{model}</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-push-fg-secondary">API key</label>
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={hasKey ? 'Key saved' : `${label} API key`}
          className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50"
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
          {hasKey && <span className="self-center text-[11px] text-push-fg-dim">Stored locally</span>}
        </div>
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
  const tcMetrics = getMalformedToolCallMetrics();
  const ctxMetrics = getContextMetrics();
  const guardMetrics = fileLedger.getMetrics();
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
        <header className="border-b border-push-edge px-3 py-3 shrink-0">
          <p className="text-sm font-semibold text-push-fg">Settings</p>
          <p className="text-[11px] text-push-fg-dim">Configure your workspace</p>
        </header>

        {/* Tab bar */}
        <div className="border-b border-push-edge px-2 py-2 shrink-0">
          <div className="grid grid-cols-3 gap-1">
            {([['you', 'You', User], ['workspace', 'Workspace', FolderCog], ['ai', 'AI', Cpu]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setSettingsTab(key)}
                className={`flex min-h-[42px] items-center justify-center gap-1.5 rounded-lg px-1 text-[11px] font-medium transition-all ${
                  settingsTab === key
                    ? 'border border-[#31425a] bg-push-grad-input text-push-fg shadow-[0_8px_20px_rgba(0,0,0,0.4),0_2px_6px_rgba(0,0,0,0.22)] backdrop-blur-xl'
                    : 'border border-transparent text-push-fg-dim hover:border-[#1f2a3a] hover:bg-[#0c1018] hover:text-push-fg-secondary'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-3 pt-2 pb-8">
          {/* ── You tab ── */}
          {settingsTab === 'you' && (
          <>
          {/* GitHub Connection */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                GitHub
              </label>
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full ${
                    auth.isConnected ? 'bg-emerald-500' : 'bg-push-fg-dim'
                  }`}
                />
                <span className="text-xs text-push-fg-secondary">
                  {auth.isDemo
                    ? 'Demo mode'
                    : auth.isConnected
                    ? `Connected${auth.validatedUser ? ` as ${auth.validatedUser.login}` : ''}`
                    : 'Not connected'}
                </span>
              </div>
            </div>

            {auth.isConnected && (
              <div className="space-y-2">
                {!auth.isDemo && (
                  <div className="rounded-lg border border-[#1b2230] bg-push-surface px-3 py-2">
                    <p className="text-sm text-push-fg-secondary font-mono">
                      {auth.isAppAuth ? (
                        <span className="text-emerald-400">GitHub App</span>
                      ) : auth.token.startsWith('ghp_') ? (
                        'ghp_••••••••'
                      ) : (
                        'Token saved'
                      )}
                    </p>
                    {auth.isAppAuth && (
                      <p className="text-xs text-push-fg-dim mt-1">
                        Auto-refreshing token
                      </p>
                    )}
                    {auth.isAppAuth && auth.installationId && (
                      <p className="text-xs text-push-fg-muted mt-1 font-mono">
                        Installation ID: {auth.installationId}
                      </p>
                    )}
                  </div>
                )}
                {/* Upgrade to GitHub App (shown when using PAT) */}
                {!auth.isDemo && !auth.isAppAuth && auth.patToken && (
                  <div className="space-y-2">
                    {auth.showInstallIdInput ? (
                      <>
                        <input
                          type="text"
                          value={auth.installIdInput}
                          onChange={(e) => auth.setInstallIdInput(e.target.value)}
                          placeholder="Installation ID (e.g., 12345678)"
                          className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50 font-mono"
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter' && auth.installIdInput.trim()) {
                              const success = await auth.setInstallationIdManually(auth.installIdInput.trim());
                              if (success) {
                                auth.setInstallIdInput('');
                                auth.setShowInstallIdInput(false);
                              }
                            }
                          }}
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              if (auth.installIdInput.trim()) {
                                const success = await auth.setInstallationIdManually(auth.installIdInput.trim());
                                if (success) {
                                  auth.setInstallIdInput('');
                                  auth.setShowInstallIdInput(false);
                                }
                              }
                            }}
                            disabled={!auth.installIdInput.trim() || auth.appLoading}
                            className="text-push-link hover:text-push-fg flex-1"
                          >
                            {auth.appLoading ? 'Connecting...' : 'Connect'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => auth.setShowInstallIdInput(false)}
                            className="text-push-fg-dim hover:text-push-fg-secondary"
                          >
                            Cancel
                          </Button>
                        </div>
                        <p className="text-xs text-push-fg-dim">
                          Find your ID at github.com/settings/installations
                        </p>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            auth.connectApp();
                            onOpenChange(false);
                          }}
                          className="text-push-link hover:text-push-fg w-full justify-start"
                        >
                          ⬆️ Connect with GitHub
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            auth.installApp();
                            onOpenChange(false);
                          }}
                          className="text-push-fg-dim hover:text-push-fg-secondary w-full justify-start text-xs"
                        >
                          Install GitHub App (first time)
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => auth.setShowInstallIdInput(true)}
                          className="text-push-fg-dim hover:text-push-fg-secondary w-full justify-start text-xs"
                        >
                          Enter installation ID manually
                        </Button>
                      </>
                    )}
                    {auth.appError && (
                      <div className="space-y-1">
                        <p className="text-xs text-red-400">{auth.appError}</p>
                        {auth.appError.includes('GITHUB_ALLOWED_INSTALLATION_IDS') && (
                          <div className="text-[11px] text-push-fg-muted">
                            <p>Ask the deployment admin to run:</p>
                            <div className="mt-1 flex items-center gap-2">
                              <code className="font-mono text-push-fg-secondary">{auth.allowlistSecretCmd}</code>
                              <button
                                type="button"
                                onClick={auth.copyAllowlistCommand}
                                className="rounded border border-push-edge px-2 py-0.5 text-[10px] text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover"
                              >
                                Copy
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    auth.onDisconnect();
                    onOpenChange(false);
                  }}
                  className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>

          {/* About You */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <label className="text-sm font-medium text-push-fg">
              About You
            </label>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">
                Your Name
              </label>
              <input
                type="text"
                value={profile.displayNameDraft}
                onChange={(e) => profile.setDisplayNameDraft(e.target.value)}
                onBlur={profile.onDisplayNameBlur}
                placeholder="Your name"
                className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50"
              />
            </div>

            {profile.validatedUser && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-push-fg-secondary">
                  GitHub
                </label>
                <div className="text-xs text-push-fg-secondary font-mono">
                  @{profile.profile.githubLogin || profile.validatedUser.login}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">
                About You
              </label>
              <textarea
                value={profile.bioDraft}
                onChange={(e) => profile.setBioDraft(e.target.value.slice(0, 300))}
                onBlur={profile.onBioBlur}
                rows={3}
                maxLength={300}
                placeholder="Anything you want the assistant to know about you"
                className="w-full rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all focus:border-push-sky/50 resize-none"
              />
              <p className="text-[10px] text-push-fg-dim">
                {profile.bioDraft.length}/300
              </p>
            </div>

            {profile.profile.displayName.trim().length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  profile.clearProfile();
                  profile.setDisplayNameDraft('');
                  profile.setBioDraft('');
                }}
                className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
              >
                Clear Profile
              </Button>
            )}
          </div>
          </>
          )}

          {/* ── Workspace tab ── */}
          {settingsTab === 'workspace' && (<>
          {/* Context Mode */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                Context Mode
              </label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.contextMode === 'graceful' ? 'Graceful digest' : 'No trimming'}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => workspace.updateContextMode('graceful')}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  workspace.contextMode === 'graceful'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Graceful Digest
              </button>
              <button
                type="button"
                onClick={() => workspace.updateContextMode('none')}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  workspace.contextMode === 'none'
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                No Trimming
              </button>
            </div>
            {workspace.contextMode === 'none' && (
              <p className="text-[11px] text-push-fg-secondary">
                No trimming can hit model context limits on long chats and cause failures.
              </p>
            )}
          </div>

          {/* Sandbox Start Mode */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                Sandbox Start Mode
              </label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.sandboxStartMode === 'off' ? 'Off' : workspace.sandboxStartMode === 'smart' ? 'Smart' : 'Always'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => workspace.updateSandboxStartMode('off')}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  workspace.sandboxStartMode === 'off'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Off
              </button>
              <button
                type="button"
                onClick={() => workspace.updateSandboxStartMode('smart')}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  workspace.sandboxStartMode === 'smart'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Smart
              </button>
              <button
                type="button"
                onClick={() => workspace.updateSandboxStartMode('always')}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  workspace.sandboxStartMode === 'always'
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Always
              </button>
            </div>
            <p className="text-[11px] text-push-fg-secondary">
              Smart prewarms sandbox for likely coding prompts. Always prewarms on every message.
            </p>
          </div>

          {/* Show Tool Activity */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                Show Tool Activity
              </label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.showToolActivity ? 'On' : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => workspace.setShowToolActivity(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  !workspace.showToolActivity
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Off
              </button>
              <button
                type="button"
                onClick={() => workspace.setShowToolActivity(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  workspace.showToolActivity
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                On
              </button>
            </div>
            <p className="text-[11px] text-push-fg-secondary">
              Controls whether the Console tab appears in Workspace Hub. Tool execution is unchanged.
            </p>
          </div>

          {/* Protect Main */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                Protect Main
              </label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.protectMainGlobal ? 'On' : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => workspace.setProtectMainGlobal(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  !workspace.protectMainGlobal
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Off
              </button>
              <button
                type="button"
                onClick={() => workspace.setProtectMainGlobal(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  workspace.protectMainGlobal
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                On
              </button>
            </div>
            <p className="text-[11px] text-push-fg-secondary">
              When enabled, commits and pushes to the main/default branch are blocked. Create a feature branch first.
            </p>

            {workspace.activeRepoFullName && (
              <div className="space-y-2 pt-1">
                <label className="text-xs font-medium text-push-fg-secondary">
                  Override for {workspace.activeRepoFullName.split('/').pop()}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => workspace.setProtectMainRepoOverride('inherit')}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      workspace.protectMainRepoOverride === 'inherit'
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    Inherit
                  </button>
                  <button
                    type="button"
                    onClick={() => workspace.setProtectMainRepoOverride('always')}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      workspace.protectMainRepoOverride === 'always'
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    Always
                  </button>
                  <button
                    type="button"
                    onClick={() => workspace.setProtectMainRepoOverride('never')}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      workspace.protectMainRepoOverride === 'never'
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    Never
                  </button>
                </div>
                <p className="text-[11px] text-push-fg-dim">
                  Inherit uses the global default. Always/Never overrides it for this repo only.
                </p>
              </div>
            )}
          </div>

          {/* Sandbox State */}
          {workspace.sandboxStatus !== 'idle' && (
            <div className="space-y-3 pt-2 border-t border-push-edge">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-push-fg">
                  Sandbox
                </label>
                <div className="flex items-center gap-1.5">
                  <div className={`h-2 w-2 rounded-full ${
                    workspace.sandboxStatus === 'ready' ? 'bg-emerald-500' :
                    workspace.sandboxStatus === 'creating' ? 'bg-amber-500 animate-pulse' :
                    workspace.sandboxStatus === 'error' ? 'bg-red-500' : 'bg-push-fg-dim'
                  }`} />
                  <span className="text-xs text-push-fg-secondary">
                    {workspace.sandboxStatus === 'ready' ? 'Running' :
                     workspace.sandboxStatus === 'creating' ? 'Starting...' :
                     workspace.sandboxStatus === 'error' ? 'Error' : 'Idle'}
                  </span>
                </div>
              </div>

              {workspace.sandboxState && workspace.sandboxStatus === 'ready' && (
                <div className="rounded-lg border border-push-edge bg-push-surface overflow-hidden">
                  <div className="px-3 py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <GitBranch className="h-3.5 w-3.5 text-push-fg-muted" />
                      <span className="text-xs text-push-fg-secondary font-mono truncate">{workspace.sandboxState.branch}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                        workspace.sandboxState.changedFiles > 0
                          ? 'bg-amber-500/15 text-amber-500'
                          : 'bg-emerald-500/15 text-emerald-500'
                      }`}>
                        {workspace.sandboxState.changedFiles > 0 ? `${workspace.sandboxState.changedFiles} changed` : 'clean'}
                      </span>
                      <button
                        type="button"
                        onClick={() => workspace.sandboxId && workspace.fetchSandboxState(workspace.sandboxId)}
                        disabled={workspace.sandboxStateLoading}
                        className="inline-flex items-center gap-1 rounded border border-push-edge px-1.5 py-0.5 text-[10px] text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover disabled:opacity-50"
                        title="Refresh sandbox state"
                      >
                        {workspace.sandboxStateLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  {workspace.sandboxState.changedFiles > 0 && (
                    <div className="px-3 pb-2 space-y-1.5">
                      <div className="flex gap-3 text-[11px] text-push-fg-muted">
                        <span>Staged: <span className="text-push-fg-secondary">{workspace.sandboxState.stagedFiles}</span></span>
                        <span>Unstaged: <span className="text-push-fg-secondary">{workspace.sandboxState.unstagedFiles}</span></span>
                        <span>Untracked: <span className="text-push-fg-secondary">{workspace.sandboxState.untrackedFiles}</span></span>
                      </div>
                      {workspace.sandboxState.preview.length > 0 && (
                        <div className="rounded border border-push-edge bg-push-surface p-1.5 space-y-0.5">
                          {workspace.sandboxState.preview.map((line, idx) => (
                            <div key={`${line}-${idx}`} className="text-[10px] text-push-fg-secondary font-mono truncate">
                              {line}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="px-3 pb-2 text-[10px] text-push-fg-dim">
                    {new Date(workspace.sandboxState.fetchedAt).toLocaleTimeString()}
                    <span className="font-mono ml-1.5">{workspace.sandboxState.sandboxId.slice(0, 12)}...</span>
                  </div>
                </div>
              )}

              {workspace.sandboxError && (
                <p className="text-xs text-red-400">{workspace.sandboxError}</p>
              )}
            </div>
          )}

          </>)}

          {/* ── AI tab ── */}
          {settingsTab === 'ai' && (<>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                AI Defaults
              </label>
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full ${
                    ai.availableProviders.length > 0 ? 'bg-emerald-500' : 'bg-push-fg-dim'
                  }`}
                />
                <span className="text-xs text-push-fg-secondary">
                  <span className="inline-flex items-center gap-1.5">
                    <ProviderIcon
                      provider={ai.activeBackend ?? ai.activeProviderLabel}
                      size={12}
                    />
                    {ai.activeBackend
                      ? `${PROVIDER_LABELS[ai.activeBackend]} default`
                      : `${PROVIDER_LABELS[ai.activeProviderLabel] || 'Offline'} (auto)`}
                  </span>
                </span>
              </div>
            </div>

            {/* Provider lock warning */}
            {ai.isProviderLocked && ai.lockedProvider && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                <p className="inline-flex items-center gap-1.5 text-xs text-amber-400">
                  <span aria-hidden="true">🔒</span>
                  <ProviderIcon provider={ai.lockedProvider} size={12} />
                  Current chat is locked to {PROVIDER_LABELS[ai.lockedProvider]}
                </p>
                <p className="text-xs text-push-fg-muted mt-0.5">
                  Defaults below apply to new chats.
                </p>
                {ai.lockedModel && (
                  <p className="text-xs text-push-fg-muted mt-0.5">
                    Current chat model: <span className="font-mono text-push-fg-secondary">{ai.lockedModel}</span>
                  </p>
                )}
              </div>
            )}

            {/* Backend picker */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">
                Default backend (new chats)
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    ai.clearPreferredProvider();
                    ai.setActiveBackend(null);
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    ai.activeBackend === null
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                      : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                  }`}
                >
                  Auto (Zen first)
                </button>
                {ai.availableProviders.length === 0 ? (
                  <div className="col-span-1 rounded-lg border border-push-edge bg-push-surface px-3 py-1.5 text-xs text-push-fg-dim">
                    Add a key
                  </div>
                ) : (
                  ai.availableProviders.map(([value, label]) => {
                    const isRecommended = value === 'zen';
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          ai.setPreferredProvider(value as PreferredProvider);
                          ai.setActiveBackend(value as PreferredProvider);
                        }}
                        className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          ai.activeBackend === value
                            ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                            : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                        }`}
                      >
                        <ProviderIcon provider={value as AIProviderType} size={12} />
                        {label}{isRecommended ? ' (Recommended)' : ''}
                      </button>
                    );
                  })
                )}
              </div>
              <p className="text-[11px] text-push-fg-dim">
                Sets your preferred provider for new chats. Auto prefers OpenCode Zen when available.
              </p>
            </div>

            {/* Ollama */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-push-fg-secondary">Ollama</label>
              <ProviderKeySection
                label="Ollama"
                hasKey={ai.hasOllamaKey}
                keyInput={ai.ollamaKeyInput}
                setKeyInput={ai.setOllamaKeyInput}
                saveKey={() => ai.setOllamaKey(ai.ollamaKeyInput.trim())}
                clearKey={ai.clearOllamaKey}
                activeBackend={ai.activeBackend}
                backendId="ollama"
                clearPreferredProvider={ai.clearPreferredProvider}
                setActiveBackend={ai.setActiveBackend}
                placeholder="Ollama API key"
                saveLabel="Save Ollama key"
                hint="Ollama API key (local or cloud)."
                model={{
                  value: ai.ollamaModel,
                  set: ai.setOllamaModel,
                  options: ai.ollamaModelOptions,
                  isLocked: ai.isOllamaModelLocked,
                  lockedModel: ai.lockedModel,
                }}
                refresh={{
                  trigger: ai.refreshOllamaModels,
                  loading: ai.ollamaModelsLoading,
                  error: ai.ollamaModelsError,
                  updatedAt: ai.ollamaModelsUpdatedAt,
                }}
              />
            </div>


          </div>


          {/* OpenRouter */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-push-fg-secondary">OpenRouter</label>
            <ProviderKeySection
              label="OpenRouter"
              hasKey={ai.hasOpenRouterKey}
              keyInput={ai.openRouterKeyInput}
              setKeyInput={ai.setOpenRouterKeyInput}
              saveKey={() => ai.setOpenRouterKey(ai.openRouterKeyInput.trim())}
              clearKey={ai.clearOpenRouterKey}
              activeBackend={ai.activeBackend}
              backendId="openrouter"
              clearPreferredProvider={ai.clearPreferredProvider}
              setActiveBackend={ai.setActiveBackend}
              placeholder="OpenRouter API key"
              saveLabel="Save OpenRouter key"
              hint="OpenRouter API key from openrouter.ai. BYOK works too: keep provider-native keys in your OpenRouter account, then use your OpenRouter key here."
              model={{
                value: ai.openRouterModel,
                set: ai.setOpenRouterModel,
                options: ai.openRouterModelOptions,
                isLocked: ai.isOpenRouterModelLocked,
                lockedModel: ai.lockedModel,
                labelTransform: (m) => m.replace(/^[^/]+\//, ''),
              }}
              refresh={{
                trigger: ai.refreshOpenRouterModels,
                loading: ai.openRouterModelsLoading,
                error: ai.openRouterModelsError,
                updatedAt: ai.openRouterModelsUpdatedAt,
              }}
            />
          </div>

          {/* Nvidia NIM */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-push-fg-secondary">Nvidia NIM</label>
            <ProviderKeySection
              label="Nvidia NIM"
              hasKey={ai.hasNvidiaKey}
              keyInput={ai.nvidiaKeyInput}
              setKeyInput={ai.setNvidiaKeyInput}
              saveKey={() => ai.setNvidiaKey(ai.nvidiaKeyInput.trim())}
              clearKey={ai.clearNvidiaKey}
              activeBackend={ai.activeBackend}
              backendId="nvidia"
              clearPreferredProvider={ai.clearPreferredProvider}
              setActiveBackend={ai.setActiveBackend}
              placeholder="Nvidia API key"
              saveLabel="Save Nvidia key"
              hint="Nvidia NIM API key (OpenAI-compatible endpoint)."
              model={{
                value: ai.nvidiaModel,
                set: ai.setNvidiaModel,
                options: ai.nvidiaModelOptions,
                isLocked: ai.isNvidiaModelLocked,
                lockedModel: ai.lockedModel,
              }}
              refresh={{
                trigger: ai.refreshNvidiaModels,
                loading: ai.nvidiaModelsLoading,
                error: ai.nvidiaModelsError,
                updatedAt: ai.nvidiaModelsUpdatedAt,
              }}
            />
          </div>

          {/* OpenCode Zen */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-push-fg-secondary">OpenCode Zen</label>
            <ProviderKeySection
              label="OpenCode Zen"
              hasKey={ai.hasZenKey}
              keyInput={ai.zenKeyInput}
              setKeyInput={ai.setZenKeyInput}
              saveKey={() => ai.setZenKey(ai.zenKeyInput.trim())}
              clearKey={ai.clearZenKey}
              activeBackend={ai.activeBackend}
              backendId="zen"
              clearPreferredProvider={ai.clearPreferredProvider}
              setActiveBackend={ai.setActiveBackend}
              placeholder="Zen API key"
              saveLabel="Save OpenCode Zen key"
              hint="OpenCode Zen API key for https://opencode.ai/zen."
              model={{
                value: ai.zenModel,
                set: ai.setZenModel,
                options: ai.zenModelOptions,
                isLocked: ai.isZenModelLocked,
                lockedModel: ai.lockedModel,
              }}
              refresh={{
                trigger: ai.refreshZenModels,
                loading: ai.zenModelsLoading,
                error: ai.zenModelsError,
                updatedAt: ai.zenModelsUpdatedAt,
              }}
            />
          </div>

          <details className="space-y-3 rounded-xl border border-push-edge bg-push-surface/40 p-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-push-fg">
              Private connectors (experimental)
            </summary>
            <p className="mt-2 text-xs text-push-fg-dim">
              Direct Azure/Bedrock/Vertex deployments live here so they stay opt-in and out of Push&apos;s normal provider story.
            </p>
            <div className="mt-3 space-y-3">
              <ExperimentalProviderSection
                label="Azure OpenAI"
                backendId="azure"
                activeBackend={ai.activeBackend}
                setActiveBackend={ai.setActiveBackend}
                clearPreferredProvider={ai.clearPreferredProvider}
                helperText="Use either your classic Azure OpenAI /openai/v1 base URL or an Azure AI Foundry project URL. Push normalizes Foundry project URLs to .../openai/v1."
                configured={ai.isAzureConfigured}
                hasKey={ai.hasAzureKey}
                keyInput={ai.azureKeyInput}
                setKeyInput={ai.setAzureKeyInput}
                setKey={ai.setAzureKey}
                clearKey={ai.clearAzureKey}
                baseUrl={ai.azureBaseUrl}
                baseUrlInput={ai.azureBaseUrlInput}
                setBaseUrlInput={ai.setAzureBaseUrlInput}
                setBaseUrl={ai.setAzureBaseUrl}
                clearBaseUrl={ai.clearAzureBaseUrl}
                baseUrlError={ai.azureBaseUrlError}
                baseUrlPlaceholder="https://your-resource.services.ai.azure.com/api/projects/PROJECT"
                model={ai.azureModel}
                modelInput={ai.azureModelInput}
                setModelInput={ai.setAzureModelInput}
                setModel={ai.setAzureModel}
                clearModel={ai.clearAzureModel}
                modelPlaceholder="Deployment or model name"
              />

              <ExperimentalProviderSection
                label="AWS Bedrock"
                backendId="bedrock"
                activeBackend={ai.activeBackend}
                setActiveBackend={ai.setActiveBackend}
                clearPreferredProvider={ai.clearPreferredProvider}
                helperText="Use the Bedrock OpenAI-compatible /openai/v1 base URL for a specific region and the exact model id."
                configured={ai.isBedrockConfigured}
                hasKey={ai.hasBedrockKey}
                keyInput={ai.bedrockKeyInput}
                setKeyInput={ai.setBedrockKeyInput}
                setKey={ai.setBedrockKey}
                clearKey={ai.clearBedrockKey}
                baseUrl={ai.bedrockBaseUrl}
                baseUrlInput={ai.bedrockBaseUrlInput}
                setBaseUrlInput={ai.setBedrockBaseUrlInput}
                setBaseUrl={ai.setBedrockBaseUrl}
                clearBaseUrl={ai.clearBedrockBaseUrl}
                baseUrlError={ai.bedrockBaseUrlError}
                baseUrlPlaceholder="https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"
                model={ai.bedrockModel}
                modelInput={ai.bedrockModelInput}
                setModelInput={ai.setBedrockModelInput}
                setModel={ai.setBedrockModel}
                clearModel={ai.clearBedrockModel}
                modelPlaceholder="Bedrock model id"
              />

              <ExperimentalProviderSection
                label="Google Vertex"
                backendId="vertex"
                activeBackend={ai.activeBackend}
                setActiveBackend={ai.setActiveBackend}
                clearPreferredProvider={ai.clearPreferredProvider}
                helperText="Use the Vertex AI OpenAI-compatible OpenAPI endpoint for your project/location and the model id you want."
                configured={ai.isVertexConfigured}
                hasKey={ai.hasVertexKey}
                keyInput={ai.vertexKeyInput}
                setKeyInput={ai.setVertexKeyInput}
                setKey={ai.setVertexKey}
                clearKey={ai.clearVertexKey}
                baseUrl={ai.vertexBaseUrl}
                baseUrlInput={ai.vertexBaseUrlInput}
                setBaseUrlInput={ai.setVertexBaseUrlInput}
                setBaseUrl={ai.setVertexBaseUrl}
                clearBaseUrl={ai.clearVertexBaseUrl}
                baseUrlError={ai.vertexBaseUrlError}
                baseUrlPlaceholder="https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT/locations/us-central1/endpoints/openapi"
                model={ai.vertexModel}
                modelInput={ai.vertexModelInput}
                setModelInput={ai.setVertexModelInput}
                setModel={ai.setVertexModel}
                clearModel={ai.clearVertexModel}
                modelPlaceholder="Vertex model id"
              />
            </div>
          </details>

          {/* Web Search (Tavily) */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                Web Search
              </label>
              <span className="text-xs text-push-fg-dim">Optional</span>
            </div>
            <div className="space-y-2">
              <ProviderKeySection
                label="Tavily"
                hasKey={ai.hasTavilyKey}
                keyInput={ai.tavilyKeyInput}
                setKeyInput={ai.setTavilyKeyInput}
                saveKey={() => ai.setTavilyKey(ai.tavilyKeyInput.trim())}
                clearKey={ai.clearTavilyKey}
                activeBackend={ai.activeBackend}
                backendId="tavily"
                clearPreferredProvider={ai.clearPreferredProvider}
                setActiveBackend={ai.setActiveBackend}
                placeholder="tvly-..."
                saveLabel="Save Tavily key"
                hint="Not required — web search works without this. Add a Tavily API key for higher-quality, LLM-optimized results. Free tier: 1,000 searches/month."
              />
            </div>
          </div>

          {/* Edit Guard Diagnostics */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <label className="text-sm font-medium text-push-fg">
              Edit Guard Diagnostics
            </label>
            {guardMetrics.checksTotal === 0 && guardMetrics.autoExpandAttempts === 0 ? (
              <p className="text-xs text-push-fg-dim">No edit-guard activity this session.</p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <span className="text-xs text-push-fg-secondary">Checks</span>
                  <span className="text-xs text-push-fg-dim text-right">{guardMetrics.checksTotal}</span>
                  <span className="text-xs text-push-fg-secondary">Allowed</span>
                  <span className="text-xs text-push-fg-dim text-right">{guardMetrics.allowedTotal}</span>
                  <span className="text-xs text-push-fg-secondary">Blocked</span>
                  <span className="text-xs text-push-fg-dim text-right">{guardMetrics.blockedTotal}</span>
                  <span className="text-xs text-push-fg-secondary">Auto-expand</span>
                  <span className="text-xs text-push-fg-dim text-right">
                    {guardMetrics.autoExpandSuccesses}/{guardMetrics.autoExpandAttempts}
                  </span>
                  <span className="text-xs text-push-fg-secondary">Symbols read</span>
                  <span className="text-xs text-push-fg-dim text-right">{guardMetrics.symbolsReadTotal}</span>
                  <span className="text-xs text-push-fg-secondary">Symbol warnings softened</span>
                  <span className="text-xs text-push-fg-dim text-right">{guardMetrics.symbolWarningsSoftened}</span>
                </div>
                {(guardMetrics.blockedTotal > 0 || guardMetrics.symbolWarningsSoftened > 0) && (
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-push-fg-dim">Never read blocks</span>
                      <span className="text-[11px] text-push-fg-dim">{guardMetrics.blockedByNeverRead}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-push-fg-dim">Stale blocks</span>
                      <span className="text-[11px] text-push-fg-dim">{guardMetrics.blockedByStale}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-push-fg-dim">Partial-read blocks</span>
                      <span className="text-[11px] text-push-fg-dim">{guardMetrics.blockedByPartialRead}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-push-fg-dim">Unknown-symbol blocks</span>
                      <span className="text-[11px] text-push-fg-dim">{guardMetrics.blockedByUnknownSymbol}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-push-fg-dim">Symbol auto-expands</span>
                      <span className="text-[11px] text-push-fg-dim">{guardMetrics.symbolAutoExpands}</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Tool Call Diagnostics */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <label className="text-sm font-medium text-push-fg">
              Tool Call Diagnostics
            </label>
            {tcMetrics.count === 0 ? (
              <p className="text-xs text-push-fg-dim">No malformed tool calls this session.</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-push-fg-secondary">
                  {tcMetrics.count} malformed {tcMetrics.count === 1 ? 'call' : 'calls'} detected this session
                </p>
                {Object.entries(tcMetrics.byProvider).map(([provider, pm]) => (
                  <div key={provider} className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-push-fg-secondary">
                        {PROVIDER_LABELS[provider as AIProviderType] ?? provider}
                      </span>
                      <span className="text-xs text-push-fg-dim">{pm.count}</span>
                    </div>
                    {Object.entries(pm.byModel).map(([model, mm]) => (
                      <div key={model} className="space-y-0.5 pl-2 border-l border-push-edge">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-push-fg-dim truncate max-w-[160px]">{model}</span>
                          <span className="text-[11px] text-push-fg-dim">{mm.count}</span>
                        </div>
                        {(Object.entries(mm.reasons) as [string, number][])
                          .filter(([, n]) => n > 0)
                          .map(([reason, n]) => (
                            <div key={reason} className="flex items-center justify-between pl-2">
                              <span className="text-[10px] text-push-fg-dim">
                                {reason === 'truncated' ? 'Truncated' :
                                 reason === 'validation_failed' ? 'Invalid schema' :
                                 reason === 'malformed_json' ? 'Malformed JSON' :
                                 reason === 'natural_language_intent' ? 'NL intent' :
                                 reason}
                              </span>
                              <span className="text-[10px] text-push-fg-dim">{n}</span>
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Context Diagnostics */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <label className="text-sm font-medium text-push-fg">
              Context Diagnostics
            </label>
            {ctxMetrics.totalEvents === 0 ? (
              <p className="text-xs text-push-fg-dim">No context compression events this session.</p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <span className="text-xs text-push-fg-secondary">Events</span>
                  <span className="text-xs text-push-fg-dim text-right">{ctxMetrics.totalEvents}</span>
                  <span className="text-xs text-push-fg-secondary">Tokens saved</span>
                  <span className="text-xs text-push-fg-dim text-right">{ctxMetrics.totalTokensSaved.toLocaleString()}</span>
                  <span className="text-xs text-push-fg-secondary">Largest reduction</span>
                  <span className="text-xs text-push-fg-dim text-right">{ctxMetrics.largestReduction.toLocaleString()}</span>
                  <span className="text-xs text-push-fg-secondary">Max context seen</span>
                  <span className="text-xs text-push-fg-dim text-right">{ctxMetrics.maxContextSeen.toLocaleString()}</span>
                </div>
                {/* Phase breakdown */}
                <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                  {([
                    ['Summarization', ctxMetrics.summarization] as const,
                    ['Digest + drop', ctxMetrics.digestDrop] as const,
                    ['Hard trim', ctxMetrics.hardTrim] as const,
                  ]).filter(([, p]) => p.count > 0).map(([label, p]) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-[11px] text-push-fg-dim">{label}</span>
                      <span className="text-[11px] text-push-fg-dim">
                        {p.count}× · {(p.totalBefore - p.totalAfter).toLocaleString()} saved
                        {p.messagesDropped > 0 ? ` · ${p.messagesDropped} msgs dropped` : ''}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Summarization causes */}
                {Object.values(ctxMetrics.summarizationCauses).some(c => c > 0) && (
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                    <span className="text-[11px] text-push-fg-secondary font-medium">Summarization causes</span>
                    {([
                      ['Tool output', ctxMetrics.summarizationCauses.tool_output] as const,
                      ['Long message', ctxMetrics.summarizationCauses.long_message] as const,
                      ['Mixed', ctxMetrics.summarizationCauses.mixed] as const,
                    ]).filter(([, c]) => c > 0).map(([label, count]) => (
                      <div key={label} className="flex items-center justify-between">
                        <span className="text-[11px] text-push-fg-dim">{label}</span>
                        <span className="text-[11px] text-push-fg-dim">{count}×</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Provider breakdown */}
                {Object.keys(ctxMetrics.byProvider).length > 0 && (
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                    {Object.entries(ctxMetrics.byProvider).map(([prov, pm]) => (
                      <div key={prov} className="flex items-center justify-between">
                        <span className="text-[11px] text-push-fg-dim">
                          {PROVIDER_LABELS[prov as AIProviderType] ?? prov}
                        </span>
                        <span className="text-[11px] text-push-fg-dim">
                          {pm.count}× · {(pm.totalBefore - pm.totalAfter).toLocaleString()} saved
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Danger Zone */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <label className="text-sm font-medium text-push-fg">
              Data
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                data.deleteAllChats();
                onOpenChange(false);
              }}
              className="text-push-fg-secondary hover:text-red-400 w-full justify-start gap-2"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete all chats{data.activeRepo ? ` for ${data.activeRepo.name}` : ''}
            </Button>
          </div>
          </>)}
        </div>
        </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
