import { Trash2, GitBranch, RefreshCw, Loader2, User, FolderCog, Cpu } from 'lucide-react';
import { getMalformedToolCallMetrics } from '@/lib/tool-call-metrics';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { AIProviderType, SandboxStateCardData } from '@/types';
import type { PreferredProvider } from '@/lib/providers';
import type { ContextMode } from '@/lib/orchestrator';
import type { SandboxStartMode } from '@/lib/sandbox-start-mode';
import type { RepoOverride } from '@/hooks/useProtectMain';

const PROVIDER_LABELS: Record<AIProviderType, string> = {
  ollama: 'Ollama',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  zai: 'Z.AI',
  google: 'Google',
  zen: 'OpenCode Zen',
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
  // Mistral
  hasMistralKey: boolean;
  mistralModel: string;
  setMistralModel: (v: string) => void;
  mistralModelOptions: string[];
  mistralModelsLoading: boolean;
  mistralModelsError: string | null;
  mistralModelsUpdatedAt: number | null;
  isMistralModelLocked: boolean;
  refreshMistralModels: () => void;
  mistralKeyInput: string;
  setMistralKeyInput: (v: string) => void;
  setMistralKey: (v: string) => void;
  clearMistralKey: () => void;
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
  // Z.AI
  hasZaiKey: boolean;
  zaiModel: string;
  setZaiModel: (v: string) => void;
  zaiModelOptions: string[];
  zaiModelsLoading: boolean;
  zaiModelsError: string | null;
  zaiModelsUpdatedAt: number | null;
  isZaiModelLocked: boolean;
  refreshZaiModels: () => void;
  zaiKeyInput: string;
  setZaiKeyInput: (v: string) => void;
  setZaiKey: (v: string) => void;
  clearZaiKey: () => void;
  // Google
  hasGoogleKey: boolean;
  googleModel: string;
  setGoogleModel: (v: string) => void;
  googleModelOptions: string[];
  googleModelsLoading: boolean;
  googleModelsError: string | null;
  googleModelsUpdatedAt: number | null;
  isGoogleModelLocked: boolean;
  refreshGoogleModels: () => void;
  googleKeyInput: string;
  setGoogleKeyInput: (v: string) => void;
  setGoogleKey: (v: string) => void;
  clearGoogleKey: () => void;
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
  sandboxStatus: 'idle' | 'creating' | 'ready' | 'error';
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
                  {ai.activeBackend
                    ? `${PROVIDER_LABELS[ai.activeBackend]} default`
                    : `${PROVIDER_LABELS[ai.activeProviderLabel] || 'Offline'} (auto)`}
                </span>
              </div>
            </div>

            {/* Provider lock warning */}
            {ai.isProviderLocked && ai.lockedProvider && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-amber-400">
                  🔒 Current chat is locked to {PROVIDER_LABELS[ai.lockedProvider]}
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
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    ai.activeBackend === null
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                      : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                  }`}
                >
                  Auto
                </button>
                {ai.availableProviders.length === 0 ? (
                  <div className="col-span-1 rounded-lg border border-push-edge bg-push-surface px-3 py-1.5 text-xs text-push-fg-dim">
                    Add a key
                  </div>
                ) : (
                  ai.availableProviders.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        ai.setPreferredProvider(value as PreferredProvider);
                        ai.setActiveBackend(value as PreferredProvider);
                      }}
                      className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                        ai.activeBackend === value
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                          : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                      }`}
                    >
                      {label}
                    </button>
                  ))
                )}
              </div>
              <p className="text-[11px] text-push-fg-dim">
                Sets your preferred provider for new chats.
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

            {/* Mistral */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-push-fg-secondary">Mistral</label>
              <ProviderKeySection
                label="Mistral"
                hasKey={ai.hasMistralKey}
                keyInput={ai.mistralKeyInput}
                setKeyInput={ai.setMistralKeyInput}
                saveKey={() => ai.setMistralKey(ai.mistralKeyInput.trim())}
                clearKey={ai.clearMistralKey}
                activeBackend={ai.activeBackend}
                backendId="mistral"
                clearPreferredProvider={ai.clearPreferredProvider}
                setActiveBackend={ai.setActiveBackend}
                placeholder="Mistral API key"
                saveLabel="Save Mistral key"
                hint="Mistral API key from console.mistral.ai."
                model={{
                  value: ai.mistralModel,
                  set: ai.setMistralModel,
                  options: ai.mistralModelOptions,
                  isLocked: ai.isMistralModelLocked,
                  lockedModel: ai.lockedModel,
                }}
                refresh={{
                  trigger: ai.refreshMistralModels,
                  loading: ai.mistralModelsLoading,
                  error: ai.mistralModelsError,
                  updatedAt: ai.mistralModelsUpdatedAt,
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
              hint="OpenRouter API key from openrouter.ai. Access 50+ models including Claude, GPT-4, Codex."
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

          {/* Z.AI */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-push-fg-secondary">Z.AI</label>
            <ProviderKeySection
              label="Z.AI"
              hasKey={ai.hasZaiKey}
              keyInput={ai.zaiKeyInput}
              setKeyInput={ai.setZaiKeyInput}
              saveKey={() => ai.setZaiKey(ai.zaiKeyInput.trim())}
              clearKey={ai.clearZaiKey}
              activeBackend={ai.activeBackend}
              backendId="zai"
              clearPreferredProvider={ai.clearPreferredProvider}
              setActiveBackend={ai.setActiveBackend}
              placeholder="Z.AI API key"
              saveLabel="Save Z.AI key"
              hint="Z.AI API key for the coding endpoint."
              model={{
                value: ai.zaiModel,
                set: ai.setZaiModel,
                options: ai.zaiModelOptions,
                isLocked: ai.isZaiModelLocked,
                lockedModel: ai.lockedModel,
              }}
              refresh={{
                trigger: ai.refreshZaiModels,
                loading: ai.zaiModelsLoading,
                error: ai.zaiModelsError,
                updatedAt: ai.zaiModelsUpdatedAt,
              }}
            />
          </div>

          {/* Google */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-push-fg-secondary">Google</label>
            <ProviderKeySection
              label="Google"
              hasKey={ai.hasGoogleKey}
              keyInput={ai.googleKeyInput}
              setKeyInput={ai.setGoogleKeyInput}
              saveKey={() => ai.setGoogleKey(ai.googleKeyInput.trim())}
              clearKey={ai.clearGoogleKey}
              activeBackend={ai.activeBackend}
              backendId="google"
              clearPreferredProvider={ai.clearPreferredProvider}
              setActiveBackend={ai.setActiveBackend}
              placeholder="Google API key"
              saveLabel="Save Google key"
              hint="Google Gemini API key (OpenAI-compatible endpoint)."
              model={{
                value: ai.googleModel,
                set: ai.setGoogleModel,
                options: ai.googleModelOptions,
                isLocked: ai.isGoogleModelLocked,
                lockedModel: ai.lockedModel,
              }}
              refresh={{
                trigger: ai.refreshGoogleModels,
                loading: ai.googleModelsLoading,
                error: ai.googleModelsError,
                updatedAt: ai.googleModelsUpdatedAt,
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
