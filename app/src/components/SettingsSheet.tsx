import { Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ModelPicker } from '@/components/ui/model-picker';
import { SettingsSectionContent } from '@/components/SettingsSectionContent';
import type { AIProviderType, SandboxStateCardData } from '@/types';
import type { PreferredProvider } from '@/lib/providers';
import type { GitHubTokenKind } from '@/lib/github-auth';
import type { ApprovalMode } from '@/lib/approval-mode';
import type { RepoOverride } from '@/hooks/useProtectMain';
import type { BuiltInSettingsProviderId } from '@/components/settings-shared';
import { SETTINGS_SECTION_ICONS } from '@/components/settings-shared';
import type { ProviderCredentialSource } from '@/lib/provider-engine-capability';

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

// ── Prop groups ──────────────────────────────────────────────────────

export interface SettingsAuthProps {
  isConnected: boolean;
  isAppAuth: boolean;
  installationId: string;
  token: string;
  tokenKind: GitHubTokenKind;
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
  chatInstructionsDraft: string;
  setChatInstructionsDraft: (v: string) => void;
  onChatInstructionsBlur: () => void;
  profile: { displayName: string; bio: string; chatInstructions?: string; githubLogin?: string };
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
  cloudflareProvider: SettingsCloudflareProvider;
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

export interface SettingsCloudflareProvider {
  configured: boolean;
  statusLoading: boolean;
  statusError: string | null;
  model: string;
  setModel: (value: string) => void;
  modelOptions: string[];
  modelsLoading: boolean;
  modelsError: string | null;
  modelsUpdatedAt: number | null;
  isModelLocked: boolean;
  refreshModels: () => void;
}

export interface SettingsTavilyProvider {
  hasKey: boolean;
  keyInput: string;
  setKeyInput: (value: string) => void;
  setKey: (value: string) => void;
  clearKey: () => void;
}

export interface SettingsWorkspaceProps {
  approvalMode: ApprovalMode;
  updateApprovalMode: (mode: ApprovalMode) => void;
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
  providerFailover: boolean;
  setProviderFailover: (value: boolean) => void;
  runTokenBudget: number | null;
  setRunTokenBudget: (value: number | null) => void;
  activeRepoFullName: string | null;
}

export interface SettingsDataProps {
  activeRepo: { name: string } | null;
  activeBranch: string | null;
  deleteAllChats: () => void;
  clearMemoryByRepo: () => void;
  clearMemoryByBranch: () => void;
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
  /**
   * Where this provider's credential actually resolves server-side
   * (`useProviderCredentials`). When the key lives outside the browser —
   * gateway BYOK, Worker secret — the section renders connected WITHOUT a
   * key input: dispatch prefers the server credential (and BYOK omits the
   * auth header entirely), so a typed key would be dead weight pretending
   * to work.
   */
  credentialSource?: ProviderCredentialSource | null;
  model?: {
    value: string;
    set: (v: string) => void;
    options: string[];
    isLocked: boolean;
    lockedModel: string | null;
  };
  refresh?: {
    trigger: () => void;
    loading: boolean;
    error: string | null;
    updatedAt: number | null;
  };
}

/** Human labels for server-held credential sources. */
const CREDENTIAL_SOURCE_LABELS: Partial<Record<ProviderCredentialSource, string>> = {
  'gateway-byok': 'Key in gateway',
  'worker-secret': 'Server key',
  binding: 'Worker binding',
};

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
  credentialSource,
  model,
  refresh,
}: ProviderKeySectionProps) {
  // A credential held outside the browser (gateway BYOK / Worker secret /
  // binding) connects the provider regardless of any local key — and takes
  // precedence over one at dispatch. `user-key` is the browser-owned path and
  // renders through the existing hasKey branch.
  const serverHeld =
    credentialSource === 'gateway-byok' ||
    credentialSource === 'worker-secret' ||
    credentialSource === 'binding';
  if (hasKey || serverHeld) {
    const statusLabel = serverHeld
      ? (CREDENTIAL_SOURCE_LABELS[credentialSource as ProviderCredentialSource] ?? 'Connected')
      : 'Connected';
    return (
      <div className="space-y-3 rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.015))] p-3 shadow-[0_12px_24px_rgba(0,0,0,0.18)]">
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <p className="text-sm text-push-fg-secondary">{statusLabel}</p>
          </div>
          {hasKey && (
            <button
              type="button"
              onClick={() => {
                clearKey();
                // Removing a local key only unsets the active backend when it
                // was the provider's ONLY credential — a server-held key keeps
                // the provider usable, so the selection stands.
                if (activeBackend === backendId && !serverHeld) {
                  clearPreferredProvider();
                  setActiveBackend(null);
                }
              }}
              className="text-push-fg-dim hover:text-red-400 transition-colors"
              aria-label={serverHeld ? `Remove unused local ${label} key` : `Remove ${label} key`}
              title={serverHeld ? 'Remove unused local key' : 'Remove key'}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {serverHeld && (
          <p className="text-xs text-push-fg-dim">
            {credentialSource === 'gateway-byok'
              ? `The ${label} key is stored in the AI Gateway, which injects it per request.${hasKey ? ' Your local key is unused.' : ' No local key needed.'}`
              : credentialSource === 'binding'
                ? 'Authenticates via the deployed Worker binding. No key needed.'
                : `The ${label} key is set on the Worker.${hasKey ? ' Your local key is unused.' : ' No local key needed.'}`}
          </p>
        )}
        {model && (
          <div className="flex items-center gap-2 rounded-xl border border-push-edge-subtle bg-push-surface/45 px-3 py-2">
            <span className="shrink-0 text-xs text-push-fg-muted">Use for new chats</span>
            <ModelPicker
              provider={backendId}
              value={model.value}
              options={model.options}
              onChange={model.set}
              disabled={refresh?.loading ?? false}
              onRefresh={refresh?.trigger}
              isRefreshing={refresh?.loading}
              refreshAriaLabel={`Refresh ${label} models`}
              ariaLabel={`Select ${label} model`}
            />
          </div>
        )}
        {refresh?.error && <p className="text-xs text-amber-400">{refresh.error}</p>}
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
        {savedHint && <p className="text-xs text-push-fg-dim">{savedHint}</p>}
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
      <p className="text-xs text-push-fg-dim">{hint}</p>
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
        className="w-[86vw] rounded-r-2xl border-push-edge-subtle bg-push-grad-panel p-0 text-push-fg shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] sm:max-w-none [&>[data-slot=sheet-close]]:text-push-fg-secondary [&>[data-slot=sheet-close]]:hover:text-push-fg"
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
                  <p className="text-push-2xs uppercase tracking-[0.24em] text-push-fg-dim">
                    Control center
                  </p>
                  <p className="mt-1 text-push-xl font-display font-semibold text-push-fg">
                    {tabMeta.title}
                  </p>
                  <p className="mt-0.5 text-push-xs text-push-fg-dim">{tabMeta.description}</p>
                </div>
              </div>
            </div>
          </header>

          {/* Tab bar */}
          <div className="shrink-0 border-b border-push-edge px-3 py-3">
            <div className="rounded-2xl border border-push-edge bg-push-surface-raised/85 p-1.5 shadow-[0_12px_28px_rgba(0,0,0,0.22)]">
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    ['you', 'You'],
                    ['workspace', 'Workspace'],
                    ['ai', 'AI'],
                  ] as const
                ).map(([key, label]) => {
                  const Icon = SETTINGS_SECTION_ICONS[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSettingsTab(key)}
                      className={`flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-2 text-push-xs font-medium transition-all ${
                        settingsTab === key
                          ? 'border border-push-edge-hover bg-push-grad-input text-push-fg shadow-[0_12px_24px_rgba(0,0,0,0.32),0_2px_6px_rgba(0,0,0,0.18)]'
                          : 'border border-transparent text-push-fg-dim hover:border-push-edge hover:bg-push-surface-raised hover:text-push-fg-secondary'
                      }`}
                    >
                      <span
                        className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                          settingsTab === key
                            ? 'border-push-edge-hover bg-white/6'
                            : 'border-transparent bg-transparent'
                        }`}
                      >
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
