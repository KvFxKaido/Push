import { Trash2, GitBranch, RefreshCw, Loader2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
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
  moonshot: 'Kimi',
  mistral: 'Mistral',
  zai: 'Z.ai',
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
  // Kimi
  hasKimiKey: boolean;
  kimiKeyInput: string;
  setKimiKeyInput: (v: string) => void;
  setKimiKey: (v: string) => void;
  clearKimiKey: () => void;
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
  // Z.ai
  hasZaiKey: boolean;
  zaiKeyInput: string;
  setZaiKeyInput: (v: string) => void;
  setZaiKey: (v: string) => void;
  clearZaiKey: () => void;
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
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} className="border-[#151b26] bg-push-grad-panel flex flex-col overflow-hidden">
        {/* Subtle top glow */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/[0.03] to-transparent" />

        <SheetHeader className="relative shrink-0">
          <SheetTitle className="text-push-fg">Settings</SheetTitle>
          <SheetDescription className="text-push-fg-secondary">
            Connect GitHub and configure your workspace.
          </SheetDescription>
        </SheetHeader>

        {/* Tab bar — matches WorkspacePanel */}
        <div className="flex gap-1.5 px-4 pt-1 pb-2.5 shrink-0">
          {([['you', 'You'], ['workspace', 'Workspace'], ['ai', 'AI']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSettingsTab(key)}
              className={`flex-1 min-h-[40px] rounded-xl px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                settingsTab === key
                  ? 'border border-push-edge-hover bg-[#0d1119] text-push-fg shadow-push-sm'
                  : 'border border-transparent text-push-fg-dim hover:text-push-fg-secondary hover:bg-[#080b10]/80'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col gap-6 px-4 pt-2 pb-8">
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
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2">
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
                          className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50 font-mono"
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
                className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50"
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
                className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50 resize-none"
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
                    ai.hasOllamaKey || ai.hasKimiKey || ai.hasMistralKey || ai.hasZaiKey ? 'bg-emerald-500' : 'bg-push-fg-dim'
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
              {ai.hasOllamaKey ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2">
                    <p className="text-sm text-push-fg-secondary font-mono">Key Saved</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-push-fg-muted shrink-0">Default model:</span>
                    <select
                      value={ai.ollamaModel}
                      onChange={(e) => ai.setOllamaModel(e.target.value)}
                      disabled={ai.ollamaModelOptions.length === 0 || ai.ollamaModelsLoading}
                      className="flex-1 rounded-md border border-push-edge bg-push-surface px-2 py-1 text-xs text-push-fg font-mono focus:outline-none focus:border-push-sky/50 disabled:opacity-50"
                    >
                      {ai.ollamaModelOptions.length === 0 ? (
                        <option value={ai.ollamaModel}>{ai.ollamaModel}</option>
                      ) : (
                        ai.ollamaModelOptions.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={ai.refreshOllamaModels}
                      disabled={ai.ollamaModelsLoading}
                      className="rounded-md border border-push-edge bg-push-surface p-1.5 text-push-fg-secondary hover:text-push-fg disabled:opacity-50"
                      aria-label="Refresh Ollama models"
                      title="Refresh Ollama models"
                    >
                      {ai.ollamaModelsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  {ai.ollamaModelsError && (
                    <p className="text-xs text-amber-400">
                      {ai.ollamaModelsError}
                    </p>
                  )}
                  {ai.ollamaModelsUpdatedAt && (
                    <p className="text-xs text-push-fg-dim">
                      Updated {new Date(ai.ollamaModelsUpdatedAt).toLocaleTimeString()}
                    </p>
                  )}
                  {ai.isOllamaModelLocked && ai.lockedModel && (
                    <p className="text-xs text-amber-400">
                      Current chat remains locked to {ai.lockedModel}. Default applies on new chats.
                    </p>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      ai.clearOllamaKey();
                      if (ai.activeBackend === 'ollama') {
                        ai.clearPreferredProvider();
                        ai.setActiveBackend(null);
                      }
                    }}
                    className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={ai.ollamaKeyInput}
                    onChange={(e) => ai.setOllamaKeyInput(e.target.value)}
                    placeholder="Ollama API key"
                    className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ai.ollamaKeyInput.trim()) {
                        ai.setOllamaKey(ai.ollamaKeyInput.trim());
                        ai.setOllamaKeyInput('');
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (ai.ollamaKeyInput.trim()) {
                        ai.setOllamaKey(ai.ollamaKeyInput.trim());
                        ai.setOllamaKeyInput('');
                      }
                    }}
                    disabled={!ai.ollamaKeyInput.trim()}
                    className="text-push-fg-secondary hover:text-push-fg w-full justify-start"
                  >
                    Save Ollama key
                  </Button>
                  <p className="text-xs text-push-fg-dim">
                    Ollama API key (local or cloud).
                  </p>
                </div>
              )}
            </div>

            {/* Kimi */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-push-fg-secondary">Kimi</label>
              {ai.hasKimiKey ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2">
                    <p className="text-sm text-push-fg-secondary font-mono">
                      Key Saved
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      ai.clearKimiKey();
                      if (ai.activeBackend === 'moonshot') {
                        ai.clearPreferredProvider();
                        ai.setActiveBackend(null);
                      }
                    }}
                    className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={ai.kimiKeyInput}
                    onChange={(e) => ai.setKimiKeyInput(e.target.value)}
                    placeholder="sk-kimi-..."
                    className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ai.kimiKeyInput.trim()) {
                        ai.setKimiKey(ai.kimiKeyInput.trim());
                        ai.setKimiKeyInput('');
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (ai.kimiKeyInput.trim()) {
                        ai.setKimiKey(ai.kimiKeyInput.trim());
                        ai.setKimiKeyInput('');
                      }
                    }}
                    disabled={!ai.kimiKeyInput.trim()}
                    className="text-push-fg-secondary hover:text-push-fg w-full justify-start"
                  >
                    Save Kimi key
                  </Button>
                  <p className="text-xs text-push-fg-dim">
                    Kimi For Coding API key (starts with sk-kimi-).
                  </p>
                </div>
              )}
            </div>

            {/* Mistral */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-push-fg-secondary">Mistral</label>
              {ai.hasMistralKey ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2">
                    <p className="text-sm text-push-fg-secondary font-mono">Key Saved</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-push-fg-muted shrink-0">Default model:</span>
                    <select
                      value={ai.mistralModel}
                      onChange={(e) => ai.setMistralModel(e.target.value)}
                      disabled={ai.mistralModelOptions.length === 0 || ai.mistralModelsLoading}
                      className="flex-1 rounded-md border border-push-edge bg-push-surface px-2 py-1 text-xs text-push-fg font-mono focus:outline-none focus:border-push-sky/50 disabled:opacity-50"
                    >
                      {ai.mistralModelOptions.length === 0 ? (
                        <option value={ai.mistralModel}>{ai.mistralModel}</option>
                      ) : (
                        ai.mistralModelOptions.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={ai.refreshMistralModels}
                      disabled={ai.mistralModelsLoading}
                      className="rounded-md border border-push-edge bg-push-surface p-1.5 text-push-fg-secondary hover:text-push-fg disabled:opacity-50"
                      aria-label="Refresh Mistral models"
                      title="Refresh Mistral models"
                    >
                      {ai.mistralModelsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  {ai.mistralModelsError && (
                    <p className="text-xs text-amber-400">
                      {ai.mistralModelsError}
                    </p>
                  )}
                  {ai.mistralModelsUpdatedAt && (
                    <p className="text-xs text-push-fg-dim">
                      Updated {new Date(ai.mistralModelsUpdatedAt).toLocaleTimeString()}
                    </p>
                  )}
                  {ai.isMistralModelLocked && ai.lockedModel && (
                    <p className="text-xs text-amber-400">
                      Current chat remains locked to {ai.lockedModel}. Default applies on new chats.
                    </p>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      ai.clearMistralKey();
                      if (ai.activeBackend === 'mistral') {
                        ai.clearPreferredProvider();
                        ai.setActiveBackend(null);
                      }
                    }}
                    className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={ai.mistralKeyInput}
                    onChange={(e) => ai.setMistralKeyInput(e.target.value)}
                    placeholder="Mistral API key"
                    className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ai.mistralKeyInput.trim()) {
                        ai.setMistralKey(ai.mistralKeyInput.trim());
                        ai.setMistralKeyInput('');
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (ai.mistralKeyInput.trim()) {
                        ai.setMistralKey(ai.mistralKeyInput.trim());
                        ai.setMistralKeyInput('');
                      }
                    }}
                    disabled={!ai.mistralKeyInput.trim()}
                    className="text-push-fg-secondary hover:text-push-fg w-full justify-start"
                  >
                    Save Mistral key
                  </Button>
                  <p className="text-xs text-push-fg-dim">
                    Mistral API key from console.mistral.ai.
                  </p>
                </div>
              )}
            </div>

          </div>


            {/* Z.ai */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-push-fg-secondary">Z.ai</label>
              {ai.hasZaiKey ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2">
                    <p className="text-sm text-push-fg-secondary font-mono">Key Saved</p>
                  </div>
                  <p className="text-xs text-push-fg-dim">
                    Uses subscription-based API keys from platform.z.ai.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      ai.clearZaiKey();
                      if (ai.activeBackend === 'zai') {
                        ai.clearPreferredProvider();
                        ai.setActiveBackend(null);
                      }
                    }}
                    className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={ai.zaiKeyInput}
                    onChange={(e) => ai.setZaiKeyInput(e.target.value)}
                    placeholder="Z.ai API key"
                    className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ai.zaiKeyInput.trim()) {
                        ai.setZaiKey(ai.zaiKeyInput.trim());
                        ai.setZaiKeyInput('');
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (ai.zaiKeyInput.trim()) {
                        ai.setZaiKey(ai.zaiKeyInput.trim());
                        ai.setZaiKeyInput('');
                      }
                    }}
                    disabled={!ai.zaiKeyInput.trim()}
                    className="text-push-fg-secondary hover:text-push-fg w-full justify-start"
                  >
                    Save Z.ai key
                  </Button>
                  <p className="text-xs text-push-fg-dim">
                    Z.ai API keys are available through subscription plans.
                  </p>
                </div>
              )}
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
              {ai.hasTavilyKey ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2">
                    <p className="text-sm text-push-fg-secondary font-mono">Tavily Key Saved</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => ai.clearTavilyKey()}
                    className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                  >
                    Remove key
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={ai.tavilyKeyInput}
                    onChange={(e) => ai.setTavilyKeyInput(e.target.value)}
                    placeholder="tvly-..."
                    className="w-full rounded-lg border border-push-edge bg-push-surface px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ai.tavilyKeyInput.trim()) {
                        ai.setTavilyKey(ai.tavilyKeyInput.trim());
                        ai.setTavilyKeyInput('');
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (ai.tavilyKeyInput.trim()) {
                        ai.setTavilyKey(ai.tavilyKeyInput.trim());
                        ai.setTavilyKeyInput('');
                      }
                    }}
                    disabled={!ai.tavilyKeyInput.trim()}
                    className="text-push-fg-secondary hover:text-push-fg w-full justify-start"
                  >
                    Save Tavily key
                  </Button>
                  <p className="text-xs text-push-fg-dim">
                    Not required — web search works without this. Add a Tavily API key for higher-quality, LLM-optimized results. Free tier: 1,000 searches/month.
                  </p>
                </div>
              )}
            </div>
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
      </SheetContent>
    </Sheet>
  );
}
