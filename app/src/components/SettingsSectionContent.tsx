import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { BranchWaveIcon, GitHubMarkIcon, LockIcon } from '@/components/icons/push-custom-icons';
import { getMalformedToolCallMetrics } from '@/lib/tool-call-metrics';
import { RUN_TOKEN_BUDGET_PRESETS } from '@/lib/run-token-budget-pref';
import { getContextMetrics } from '@/lib/context-metrics';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { ProviderIcon } from '@/components/ui/provider-icon';
import { ModelPicker } from '@/components/ui/model-picker';
import { Button } from '@/components/ui/button';
import { SettingsAccordion, SettingsAccordionItem } from '@/components/SettingsAccordion';
import {
  BUILT_IN_SETTINGS_PROVIDER_META,
  BUILT_IN_SETTINGS_PROVIDER_ORDER,
  PROVIDER_LABELS,
  TAVILY_SETTINGS_META,
} from '@/components/settings-shared';
import {
  ProviderKeySection,
  type SettingsAIProps,
  type SettingsAuthProps,
  type SettingsDataProps,
  type SettingsProfileProps,
  type SettingsTabKey,
  type SettingsWorkspaceProps,
} from '@/components/SettingsSheet';
import { formatModelDisplayName, type PreferredProvider } from '@/lib/providers';
import { describeGitHubTokenKind, getAppTokenExpiry, isDurableUserToken } from '@/lib/github-auth';
import {
  SANDBOX_USER_TOKEN_ACK_KEY,
  hasAcknowledgedUserTokenInjection,
  setAcknowledgedUserTokenInjection,
} from '@/lib/sandbox-auth-gate';
import { useAuditorGate } from '@/hooks/useAuditorGate';
import { useProviderCredentials } from '@/hooks/useProviderCredentials';
import type { AIProviderType } from '@/types';
import { getRoleLabel } from '@push/lib/role-display';

const SECTION_CARD_CLASS =
  'space-y-3 rounded-2xl border border-push-edge bg-push-surface/55 p-4 shadow-[0_14px_28px_rgba(0,0,0,0.18)]';

/**
 * Honest surface for the active GitHub credential: names the regime, its blast
 * radius, and expiry instead of collapsing App / OAuth / PAT into one
 * "connected" blob. For durable user-scoped tokens it surfaces the sandbox
 * caution and the acknowledgment toggle the cloud-sandbox gate reads.
 */
function SandboxCredentialGrant({ auth }: { auth: SettingsAuthProps }) {
  const kind = auth.tokenKind;
  const desc = describeGitHubTokenKind(kind);
  const durable = isDurableUserToken(kind);
  const [ack, setAck] = useState(() => hasAcknowledgedUserTokenInjection());

  // The initializer only runs on mount, so the checkbox can drift if the ack is
  // mutated elsewhere — most notably logout (which clears it) or a second tab.
  // Re-sync from storage on cross-document `storage` events so the toggle
  // reflects reality without remounting Settings. (The gate itself always
  // re-reads live, so this is cosmetic, but a stale "allowed" checkbox is
  // exactly the kind of thing that erodes trust in a security control.)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== SANDBOX_USER_TOKEN_ACK_KEY) return;
      setAck(hasAcknowledgedUserTokenInjection());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  let expiryLabel: string | null = null;
  if (kind === 'app') {
    const iso = getAppTokenExpiry();
    const t = iso ? new Date(iso).getTime() : NaN;
    expiryLabel = Number.isFinite(t)
      ? `Expires ${new Date(t).toLocaleString()}`
      : 'Refreshes automatically';
  } else if (kind !== 'none') {
    expiryLabel = 'Does not expire automatically';
  }

  const identity =
    kind === 'app'
      ? auth.installationId
        ? `Installation ${auth.installationId}`
        : null
      : auth.validatedUser?.login
        ? `@${auth.validatedUser.login}`
        : null;

  const labelTone =
    kind === 'app' ? 'text-emerald-400' : durable ? 'text-amber-400' : 'text-push-fg-secondary';

  return (
    <div className="space-y-1.5 rounded-lg border border-push-edge-subtle bg-push-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-sm font-medium ${labelTone}`}>{desc.label}</span>
        {identity && <span className="font-mono text-xs text-push-fg-muted">{identity}</span>}
      </div>
      <p className="text-xs text-push-fg-dim">{desc.authority}</p>
      {expiryLabel && <p className="text-xs text-push-fg-muted">{expiryLabel}</p>}

      {durable && (
        <div className="mt-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
          <p className="text-xs text-amber-200/90">
            This is a legacy full-account token (OAuth or PAT). It&rsquo;s written into the cloud
            sandbox&rsquo;s git config and stays readable inside the container for its whole
            lifetime. Connect the GitHub App for scoped, auto-expiring access instead &mdash;
            recommended.
          </p>
          <label className="flex items-start gap-2 text-xs text-push-fg-secondary">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => {
                setAck(e.target.checked);
                setAcknowledgedUserTokenInjection(e.target.checked);
              }}
              className="mt-0.5"
            />
            <span>Allow this token in cloud sandboxes (required to start a sandbox with it)</span>
          </label>
        </div>
      )}
    </div>
  );
}

interface SettingsSectionContentProps {
  settingsTab: SettingsTabKey;
  auth: SettingsAuthProps;
  profile: SettingsProfileProps;
  ai: SettingsAIProps;
  workspace: SettingsWorkspaceProps;
  data: SettingsDataProps;
  onDismiss: () => void;
}

export function SettingsSectionContent({
  settingsTab,
  auth,
  profile,
  ai,
  workspace,
  data,
  onDismiss,
}: SettingsSectionContentProps) {
  const tcMetrics = getMalformedToolCallMetrics();
  const ctxMetrics = getContextMetrics();
  const guardMetrics = fileLedger.getMetrics();
  // Auditor commit gate — consumed directly (not threaded through the workspace
  // bundle like Protect Main) because it has no cross-system side-effect: the
  // commit call sites read it on demand via `getIsAuditorGateEnabled`. Keyed by
  // the active repo so the per-repo override matches what those call sites read.
  const auditorGate = useAuditorGate(workspace.activeRepoFullName ?? undefined);
  // Credential provenance (gateway BYOK / Worker secret / user key) — read
  // directly rather than threaded through SettingsAIProps: it's a module-level
  // cached snapshot, and no other layer needs to transform it.
  const credentials = useProviderCredentials();
  // Provider accordion: single-open, seeded with the provider that matters
  // most right now — the active backend, else the first one with a key, else
  // zen. Uncontrolled after mount, so picking a backend elsewhere in the tab
  // doesn't yank the accordion out from under the user.
  const defaultOpenProvider =
    (ai.activeBackend === 'cloudflare' ? 'cloudflare' : null) ??
    BUILT_IN_SETTINGS_PROVIDER_ORDER.find((providerId) => providerId === ai.activeBackend) ??
    BUILT_IN_SETTINGS_PROVIDER_ORDER.find((providerId) => ai.builtInProviders[providerId].hasKey) ??
    'zen';

  return (
    <div className="flex flex-col gap-6 px-3 pt-2 pb-8">
      {/* ── You tab ── */}
      {settingsTab === 'you' && (
        <>
          <div className="rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] px-4 py-4 shadow-[0_16px_30px_rgba(0,0,0,0.2)]">
            <p className="text-sm font-medium text-push-fg">Personalize Push</p>
            <p className="mt-1 text-xs text-push-fg-dim">
              Set how Push knows you and how it connects to GitHub.
            </p>
          </div>

          {/* GitHub Connection */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">GitHub connection</label>
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full ${
                    auth.isConnected ? 'bg-emerald-500' : 'bg-push-fg-dim'
                  }`}
                />
                <span className="text-xs text-push-fg-secondary">
                  {auth.isConnected
                    ? `Connected${auth.validatedUser ? ` as ${auth.validatedUser.login}` : ''}`
                    : 'Signed out'}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              {auth.isConnected ? (
                <>
                  <SandboxCredentialGrant auth={auth} />

                  {!auth.isAppAuth && auth.patToken && (
                    <div className="space-y-2">
                      {auth.showInstallIdInput ? (
                        <>
                          <input
                            type="text"
                            value={auth.installIdInput}
                            onChange={(e) => auth.setInstallIdInput(e.target.value)}
                            placeholder="Installation ID (e.g., 12345678)"
                            className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50 font-mono"
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && auth.installIdInput.trim()) {
                                const success = await auth.setInstallationIdManually(
                                  auth.installIdInput.trim(),
                                );
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
                                  const success = await auth.setInstallationIdManually(
                                    auth.installIdInput.trim(),
                                  );
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
                              onDismiss();
                            }}
                            className="text-push-link hover:text-push-fg w-full justify-start"
                          >
                            <GitHubMarkIcon className="size-4" /> Connect with GitHub
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              auth.installApp();
                              onDismiss();
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
                            <div className="text-push-xs text-push-fg-muted">
                              <p>Ask the deployment admin to run:</p>
                              <div className="mt-1 flex items-center gap-2">
                                <code className="font-mono text-push-fg-secondary">
                                  {auth.allowlistSecretCmd}
                                </code>
                                <button
                                  type="button"
                                  onClick={auth.copyAllowlistCommand}
                                  className="rounded border border-push-edge px-2 py-0.5 text-push-2xs text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover"
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
                      onDismiss();
                    }}
                    className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
                  >
                    Disconnect
                  </Button>
                </>
              ) : auth.showInstallIdInput ? (
                <>
                  <input
                    type="text"
                    value={auth.installIdInput}
                    onChange={(e) => auth.setInstallIdInput(e.target.value)}
                    placeholder="Installation ID (e.g., 12345678)"
                    className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50 font-mono"
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' && auth.installIdInput.trim()) {
                        const success = await auth.setInstallationIdManually(
                          auth.installIdInput.trim(),
                        );
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
                          const success = await auth.setInstallationIdManually(
                            auth.installIdInput.trim(),
                          );
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
                  {auth.appError && (
                    <div className="space-y-1">
                      <p className="text-xs text-red-400">{auth.appError}</p>
                      {auth.appError.includes('GITHUB_ALLOWED_INSTALLATION_IDS') && (
                        <div className="text-push-xs text-push-fg-muted">
                          <p>Ask the deployment admin to run:</p>
                          <div className="mt-1 flex items-center gap-2">
                            <code className="font-mono text-push-fg-secondary">
                              {auth.allowlistSecretCmd}
                            </code>
                            <button
                              type="button"
                              onClick={auth.copyAllowlistCommand}
                              className="rounded border border-push-edge px-2 py-0.5 text-push-2xs text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover"
                            >
                              Copy
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs leading-relaxed text-push-fg-dim">
                    Connect GitHub to browse repos, inspect PRs, and work from a repo-backed
                    workspace.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      auth.connectApp();
                      onDismiss();
                    }}
                    className="text-push-link hover:text-push-fg w-full justify-start"
                  >
                    <GitHubMarkIcon className="size-4" /> Connect with GitHub
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      auth.installApp();
                      onDismiss();
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
                  {auth.appError && (
                    <div className="space-y-1">
                      <p className="text-xs text-red-400">{auth.appError}</p>
                      {auth.appError.includes('GITHUB_ALLOWED_INSTALLATION_IDS') && (
                        <div className="text-push-xs text-push-fg-muted">
                          <p>Ask the deployment admin to run:</p>
                          <div className="mt-1 flex items-center gap-2">
                            <code className="font-mono text-push-fg-secondary">
                              {auth.allowlistSecretCmd}
                            </code>
                            <button
                              type="button"
                              onClick={auth.copyAllowlistCommand}
                              className="rounded border border-push-edge px-2 py-0.5 text-push-2xs text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover"
                            >
                              Copy
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* About You */}
          <div className={SECTION_CARD_CLASS}>
            <label className="text-sm font-medium text-push-fg">About you</label>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">Name</label>
              <input
                type="text"
                value={profile.displayNameDraft}
                onChange={(e) => profile.setDisplayNameDraft(e.target.value)}
                onBlur={profile.onDisplayNameBlur}
                placeholder="What should Push call you?"
                className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50"
              />
            </div>

            {profile.validatedUser && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-push-fg-secondary">GitHub</label>
                <div className="text-xs text-push-fg-secondary font-mono">
                  @{profile.profile.githubLogin || profile.validatedUser.login}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">Working style</label>
              <textarea
                value={profile.bioDraft}
                onChange={(e) => profile.setBioDraft(e.target.value.slice(0, 300))}
                onBlur={profile.onBioBlur}
                rows={3}
                maxLength={300}
                placeholder="Anything helpful to know about how you like to work"
                className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50 resize-none"
              />
              <p className="text-push-2xs text-push-fg-dim">{profile.bioDraft.length}/300</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">
                Chat instructions
              </label>
              <p className="text-push-2xs text-push-fg-dim">
                Guidance for plain chat mode. Workspace and repo conversations use project
                instructions instead.
              </p>
              <textarea
                value={profile.chatInstructionsDraft}
                onChange={(e) => profile.setChatInstructionsDraft(e.target.value.slice(0, 4000))}
                onBlur={profile.onChatInstructionsBlur}
                rows={5}
                maxLength={4000}
                placeholder="How should Push behave in chat? Preferences, tone, focus areas..."
                className="w-full rounded-lg border border-push-edge-subtle bg-push-grad-input px-3 py-2 text-sm text-push-fg placeholder:text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] outline-none transition-all focus:border-push-sky/50 resize-none"
              />
              <p className="text-push-2xs text-push-fg-dim">
                {profile.chatInstructionsDraft.length}/4000
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
                  profile.setChatInstructionsDraft('');
                }}
                className="text-push-fg-secondary hover:text-red-400 w-full justify-start"
              >
                Clear profile
              </Button>
            )}
          </div>
        </>
      )}

      {/* ── Workspace tab ── */}
      {settingsTab === 'workspace' && (
        <>
          <div className="rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] px-4 py-4 shadow-[0_16px_30px_rgba(0,0,0,0.2)]">
            <p className="text-sm font-medium text-push-fg">Shape how the workspace behaves</p>
            <p className="mt-1 text-xs text-push-fg-dim">
              Tune approval behavior, long-chat behavior, runtime warm-up, and branch safety without
              changing your overall flow.
            </p>
          </div>

          {/* Approval Mode */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">Approval mode</label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.approvalMode === 'supervised'
                  ? 'Supervised'
                  : workspace.approvalMode === 'autonomous'
                    ? 'Autonomous'
                    : 'Full auto'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => workspace.updateApprovalMode('supervised')}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  workspace.approvalMode === 'supervised'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Supervised
              </button>
              <button
                type="button"
                onClick={() => workspace.updateApprovalMode('autonomous')}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  workspace.approvalMode === 'autonomous'
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Autonomous
              </button>
              <button
                type="button"
                onClick={() => workspace.updateApprovalMode('full-auto')}
                className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                  workspace.approvalMode === 'full-auto'
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Full auto
              </button>
            </div>
            <p className="text-push-xs text-push-fg-secondary">
              {workspace.approvalMode === 'supervised'
                ? 'The model asks before mutating actions. Best for careful, step-by-step work.'
                : workspace.approvalMode === 'autonomous'
                  ? 'The model acts decisively, only asking when genuinely ambiguous. Faster flow.'
                  : 'No confirmations, no questions. Errors auto-retry. Maximum speed, sandbox-safe.'}
            </p>
          </div>

          {/* Show Tool Activity */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">Console in hub</label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.showToolActivity ? 'Visible' : 'Hidden'}
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
                Hidden
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
                Visible
              </button>
            </div>
            <p className="text-push-xs text-push-fg-secondary">
              Show or hide the Console tab in the hub. Tool execution stays the same either way.
            </p>
          </div>

          {/* Protect Main */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">Protect Main</label>
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
            <p className="text-push-xs text-push-fg-secondary">
              Keep main as a landing zone. Start a branch first when you want to make changes.
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
                <p className="text-push-xs text-push-fg-dim">
                  Inherit follows your global default. Always or Never only affects this repo.
                </p>
              </div>
            )}
          </div>

          {/* Provider Failover */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">Provider Failover</label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.providerFailover ? 'On' : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => workspace.setProviderFailover(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  !workspace.providerFailover
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Off
              </button>
              <button
                type="button"
                onClick={() => workspace.setProviderFailover(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  workspace.providerFailover
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                On
              </button>
            </div>
            <p className="text-push-xs text-push-fg-secondary">
              When enabled, a chat whose provider fails mid-request (rate limit, outage, bad key)
              retries the round on another configured provider of the same kind. Your chosen
              provider stays the default — failover only rescues the failing turn.
            </p>
          </div>

          {/* Run Token Budget */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">Run Token Budget</label>
              <span className="text-xs text-push-fg-secondary">
                {workspace.runTokenBudget
                  ? `${Math.round(workspace.runTokenBudget / 1000)}K`
                  : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              {RUN_TOKEN_BUDGET_PRESETS.map((preset) => {
                const active = (workspace.runTokenBudget ?? null) === preset.value;
                const activeClass =
                  preset.value === null
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-amber-500/50 bg-amber-500/10 text-amber-400';
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => workspace.setRunTokenBudget(preset.value)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                      active
                        ? activeClass
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <p className="text-push-xs text-push-fg-secondary">
              Stops a run once it has spent this many tokens — a cost circuit breaker on top of the
              round limit. Applies to the chat lead and any Coder it delegates. Off means no token
              cap.
            </p>
          </div>

          {/* Auditor Gate */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">
                {getRoleLabel('auditor')} commit gate
              </label>
              <span className="text-xs text-push-fg-secondary">
                {auditorGate.globalDefault ? 'On' : 'Off'}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => auditorGate.setGlobalDefault(false)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  !auditorGate.globalDefault
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                Off
              </button>
              <button
                type="button"
                onClick={() => auditorGate.setGlobalDefault(true)}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                  auditorGate.globalDefault
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                }`}
              >
                On
              </button>
            </div>
            <p className="text-push-xs text-push-fg-secondary">
              Review each commit for safety (secrets, injection, disabled security) before it lands.
              On by default — turning it off skips the SAFE/UNSAFE check.
            </p>

            {workspace.activeRepoFullName && (
              <div className="space-y-2 pt-1">
                <label className="text-xs font-medium text-push-fg-secondary">
                  Override for {workspace.activeRepoFullName.split('/').pop()}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => auditorGate.setRepoOverride('inherit')}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      auditorGate.repoOverride === 'inherit'
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    Inherit
                  </button>
                  <button
                    type="button"
                    onClick={() => auditorGate.setRepoOverride('always')}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      auditorGate.repoOverride === 'always'
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    Always
                  </button>
                  <button
                    type="button"
                    onClick={() => auditorGate.setRepoOverride('never')}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      auditorGate.repoOverride === 'never'
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                        : 'border-push-edge bg-push-surface text-push-fg-muted hover:text-push-fg-secondary'
                    }`}
                  >
                    Never
                  </button>
                </div>
                <p className="text-push-xs text-push-fg-dim">
                  Inherit follows your global default. Always or Never only affects this repo.
                </p>
              </div>
            )}
          </div>

          {/* Workspace Status */}
          {workspace.sandboxStatus !== 'idle' && (
            <div className={SECTION_CARD_CLASS}>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-push-fg">Runtime status</label>
                <div className="flex items-center gap-1.5">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      workspace.sandboxStatus === 'ready'
                        ? 'bg-emerald-500'
                        : workspace.sandboxStatus === 'creating'
                          ? 'bg-amber-500 animate-pulse'
                          : workspace.sandboxStatus === 'error'
                            ? 'bg-red-500'
                            : 'bg-push-fg-dim'
                    }`}
                  />
                  <span className="text-xs text-push-fg-secondary">
                    {workspace.sandboxStatus === 'ready'
                      ? 'Running'
                      : workspace.sandboxStatus === 'creating'
                        ? 'Warming up...'
                        : workspace.sandboxStatus === 'error'
                          ? 'Error'
                          : 'Idle'}
                  </span>
                </div>
              </div>

              {workspace.sandboxState && workspace.sandboxStatus === 'ready' && (
                <div className="rounded-lg border border-push-edge bg-push-surface overflow-hidden">
                  <div className="px-3 py-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <BranchWaveIcon className="h-3.5 w-3.5 text-push-fg-muted" />
                      <span className="text-xs text-push-fg-secondary font-mono truncate">
                        {workspace.sandboxState.branch}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-push-xs px-1.5 py-0.5 rounded-full ${
                          workspace.sandboxState.changedFiles > 0
                            ? 'bg-amber-500/15 text-amber-500'
                            : 'bg-emerald-500/15 text-emerald-500'
                        }`}
                      >
                        {workspace.sandboxState.changedFiles > 0
                          ? `${workspace.sandboxState.changedFiles} changed`
                          : 'clean'}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          workspace.sandboxId && workspace.fetchSandboxState(workspace.sandboxId)
                        }
                        disabled={workspace.sandboxStateLoading}
                        className="inline-flex items-center gap-1 rounded border border-push-edge px-1.5 py-0.5 text-push-2xs text-push-fg-secondary hover:text-push-fg hover:border-push-edge-hover disabled:opacity-50"
                        title="Refresh workspace status"
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
                      <div className="flex gap-3 text-push-xs text-push-fg-muted">
                        <span>
                          Staged:{' '}
                          <span className="text-push-fg-secondary">
                            {workspace.sandboxState.stagedFiles}
                          </span>
                        </span>
                        <span>
                          Unstaged:{' '}
                          <span className="text-push-fg-secondary">
                            {workspace.sandboxState.unstagedFiles}
                          </span>
                        </span>
                        <span>
                          Untracked:{' '}
                          <span className="text-push-fg-secondary">
                            {workspace.sandboxState.untrackedFiles}
                          </span>
                        </span>
                      </div>
                      {workspace.sandboxState.preview.length > 0 && (
                        <div className="rounded border border-push-edge bg-push-surface p-1.5 space-y-0.5">
                          {workspace.sandboxState.preview.map((line, idx) => (
                            <div
                              key={`${line}-${idx}`}
                              className="text-push-2xs text-push-fg-secondary font-mono truncate"
                            >
                              {line}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="px-3 pb-2 text-push-2xs text-push-fg-dim">
                    {new Date(workspace.sandboxState.fetchedAt).toLocaleTimeString()}
                    <span className="font-mono ml-1.5">
                      {workspace.sandboxState.sandboxId.slice(0, 12)}...
                    </span>
                  </div>
                </div>
              )}

              {workspace.sandboxError && (
                <p className="text-xs text-red-400">{workspace.sandboxError}</p>
              )}
            </div>
          )}
        </>
      )}

      {/* ── AI tab ── */}
      {settingsTab === 'ai' && (
        <>
          <div className="rounded-2xl border border-push-edge bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] px-4 py-4 shadow-[0_16px_30px_rgba(0,0,0,0.2)]">
            <p className="text-sm font-medium text-push-fg">Set your defaults once</p>
            <p className="mt-1 text-xs text-push-fg-dim">
              Choose which providers and models new chats should reach for first.
            </p>
          </div>

          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">New chat defaults</label>
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full ${
                    ai.availableProviders.length > 0 ? 'bg-emerald-500' : 'bg-push-fg-dim'
                  }`}
                />
                <span className="text-xs text-push-fg-secondary">
                  <span className="inline-flex items-center gap-1.5">
                    <ProviderIcon provider={ai.activeBackend ?? ai.activeProviderLabel} size={12} />
                    {ai.activeBackend
                      ? `${PROVIDER_LABELS[ai.activeBackend]} for new chats`
                      : `${PROVIDER_LABELS[ai.activeProviderLabel] || 'Offline'} on auto`}
                  </span>
                </span>
              </div>
            </div>

            {/* Provider lock warning */}
            {ai.isProviderLocked && ai.lockedProvider && (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                <p className="inline-flex items-center gap-1.5 text-xs text-amber-400">
                  <LockIcon width={12} height={12} aria-hidden="true" />
                  <ProviderIcon provider={ai.lockedProvider} size={12} />
                  This chat is staying on {PROVIDER_LABELS[ai.lockedProvider]}
                </p>
                <p className="text-xs text-push-fg-muted mt-0.5">
                  Any changes below only affect new chats.
                </p>
                {ai.lockedModel && (
                  <p className="text-xs text-push-fg-muted mt-0.5">
                    Current chat model:{' '}
                    <span className="font-mono text-push-fg-secondary">{ai.lockedModel}</span>
                  </p>
                )}
              </div>
            )}

            {/* Backend picker */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-push-fg-secondary">
                Use this provider for new chats
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
                  Auto
                </button>
                {ai.availableProviders.length === 0 ? (
                  <div className="col-span-1 rounded-lg border border-push-edge bg-push-surface px-3 py-1.5 text-xs text-push-fg-dim">
                    Add a key
                  </div>
                ) : (
                  ai.availableProviders.map(([value, label]) => {
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
                        {label}
                      </button>
                    );
                  })
                )}
              </div>
              <p className="text-push-xs text-push-fg-dim">
                Auto uses the last provider you picked.
              </p>
            </div>

            {/* AI Gateway status — requests take an extra hop when active;
                the surface should say so rather than hide it. */}
            {credentials.gatewayActive && (
              <div className="flex items-start gap-2.5 rounded-xl border border-push-edge-subtle bg-push-surface/45 px-3 py-2.5">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-push-fg-secondary">AI Gateway active</p>
                  <p className="mt-0.5 text-[11px] text-push-fg-dim">
                    Requests route through Cloudflare AI Gateway for observability.
                    {(() => {
                      const byok = BUILT_IN_SETTINGS_PROVIDER_ORDER.filter(
                        (id) => credentials.sources[id] === 'gateway-byok',
                      );
                      return byok.length > 0
                        ? ` Keys held in the gateway: ${byok.map((id) => PROVIDER_LABELS[id]).join(', ')}.`
                        : '';
                    })()}
                  </p>
                </div>
              </div>
            )}

            <SettingsAccordion type="single" collapsible defaultValue={defaultOpenProvider}>
              {BUILT_IN_SETTINGS_PROVIDER_ORDER.map((providerId) => {
                const provider = ai.builtInProviders[providerId];
                const meta = BUILT_IN_SETTINGS_PROVIDER_META[providerId];
                const label = PROVIDER_LABELS[providerId];
                const modelLabel = meta.labelTransform
                  ? meta.labelTransform(provider.model)
                  : provider.model;
                const source = credentials.sources[providerId] ?? null;
                const headerStatus =
                  source === 'gateway-byok'
                    ? 'Key in gateway'
                    : source === 'worker-secret'
                      ? 'Server key'
                      : provider.hasKey || source === 'user-key'
                        ? 'Connected'
                        : 'No key configured';

                return (
                  <SettingsAccordionItem
                    key={providerId}
                    value={providerId}
                    startContent={
                      <ProviderIcon provider={providerId as AIProviderType} size={14} />
                    }
                    title={label}
                    subtitle={
                      headerStatus === 'No key configured'
                        ? headerStatus
                        : `${headerStatus}${modelLabel ? ` · ${modelLabel}` : ''}`
                    }
                  >
                    <ProviderKeySection
                      label={label}
                      hasKey={provider.hasKey}
                      keyInput={provider.keyInput}
                      setKeyInput={provider.setKeyInput}
                      saveKey={() => provider.setKey(provider.keyInput.trim())}
                      clearKey={provider.clearKey}
                      activeBackend={ai.activeBackend}
                      backendId={providerId}
                      clearPreferredProvider={ai.clearPreferredProvider}
                      setActiveBackend={ai.setActiveBackend}
                      placeholder={meta.placeholder}
                      saveLabel={meta.saveLabel}
                      hint={meta.hint}
                      credentialSource={source}
                      byokPartialNote={meta.byokPartialNote}
                      model={{
                        value: provider.model,
                        set: provider.setModel,
                        options: provider.modelOptions,
                        isLocked: provider.isModelLocked,
                        lockedModel: ai.lockedModel,
                      }}
                      refresh={{
                        trigger: provider.refreshModels,
                        loading: provider.modelsLoading,
                        error: provider.modelsError,
                        updatedAt: provider.modelsUpdatedAt,
                      }}
                    />
                    {/* OpenCode Go is a SEPARATE service from pay-as-you-go
                          Zen — a subscription with its own model pool and
                          billing. This toggle selects which service chats
                          route to, so it must stay visible whenever zen has
                          ANY credential (local, account, gateway, or Worker),
                          not only when a local key exists. */}
                    {providerId === 'zen' &&
                      (provider.hasKey || source != null) &&
                      provider.setGoMode && (
                        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-push-edge-subtle bg-push-surface/45 px-3 py-2">
                          <span className="min-w-0">
                            <span className="block text-xs text-push-fg-muted">OpenCode Go</span>
                            <span className="block text-[11px] text-push-fg-dim">
                              Separate subscription service — routes chats to the Go pool instead of
                              pay-as-you-go Zen.
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            checked={provider.goMode ?? false}
                            onChange={(e) => provider.setGoMode!(e.target.checked)}
                            className="h-3.5 w-3.5 shrink-0 accent-emerald-400"
                          />
                        </label>
                      )}
                  </SettingsAccordionItem>
                );
              })}

              <SettingsAccordionItem
                value="cloudflare"
                startContent={<ProviderIcon provider="cloudflare" size={14} />}
                title={PROVIDER_LABELS.cloudflare}
                subtitle={
                  ai.cloudflareProvider.configured
                    ? `Configured on Worker${ai.cloudflareProvider.model ? ` · ${formatModelDisplayName('cloudflare', ai.cloudflareProvider.model)}` : ''}`
                    : 'Not configured on Worker'
                }
                endContent={
                  <>
                    {ai.cloudflareProvider.statusLoading && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-push-fg-dim" />
                    )}
                    <span
                      className={`h-2 w-2 rounded-full ${
                        ai.cloudflareProvider.configured ? 'bg-emerald-500' : 'bg-push-fg-dim'
                      }`}
                    />
                  </>
                }
              >
                <div className="rounded-xl border border-push-edge-subtle bg-push-surface/45 px-3 py-3">
                  <label className="text-xs font-medium text-push-fg-secondary">
                    Worker-bound model
                  </label>
                  <div className="mt-2">
                    <ModelPicker
                      provider="cloudflare"
                      value={ai.cloudflareProvider.model}
                      options={ai.cloudflareProvider.modelOptions}
                      onChange={ai.cloudflareProvider.setModel}
                      disabled={ai.cloudflareProvider.modelsLoading}
                      onRefresh={() => ai.cloudflareProvider.refreshModels()}
                      isRefreshing={ai.cloudflareProvider.modelsLoading}
                      refreshAriaLabel="Refresh Cloudflare models"
                      ariaLabel="Select Cloudflare Workers AI model"
                    />
                  </div>

                  <p className="mt-2 text-push-xs text-push-fg-dim">
                    Uses the deployed Worker binding via `env.AI`. No local API key needed.
                  </p>
                  <p className="mt-1 text-push-xs text-push-fg-dim">
                    Usage is billed to the deployed Worker&apos;s Cloudflare account, not your
                    browser session.
                  </p>
                  {ai.cloudflareProvider.statusError && (
                    <p className="mt-2 text-push-xs text-amber-400">
                      {ai.cloudflareProvider.statusError}
                    </p>
                  )}
                  {ai.cloudflareProvider.modelsError && (
                    <p className="mt-2 text-push-xs text-amber-400">
                      {ai.cloudflareProvider.modelsError}
                    </p>
                  )}
                  {ai.cloudflareProvider.isModelLocked && ai.lockedModel && (
                    <p className="mt-2 text-push-xs text-amber-400">
                      This chat keeps using {ai.lockedModel}.
                    </p>
                  )}
                  {ai.cloudflareProvider.modelsUpdatedAt && (
                    <p className="mt-2 text-push-xs text-push-fg-dim">
                      Updated {new Date(ai.cloudflareProvider.modelsUpdatedAt).toLocaleTimeString()}
                    </p>
                  )}
                </div>
              </SettingsAccordionItem>
            </SettingsAccordion>
          </div>

          {/* Web Search (Tavily) */}
          <div className={SECTION_CARD_CLASS}>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-push-fg">Web Search</label>
              <span className="text-xs text-push-fg-dim">Optional</span>
            </div>
            <SettingsAccordion type="single" collapsible>
              <SettingsAccordionItem
                value="tavily"
                title="Tavily"
                subtitle={
                  ai.tavilyProvider.hasKey
                    ? 'Connected'
                    : 'No key configured — optional, improves web search'
                }
              >
                <ProviderKeySection
                  label="Tavily"
                  hasKey={ai.tavilyProvider.hasKey}
                  keyInput={ai.tavilyProvider.keyInput}
                  setKeyInput={ai.tavilyProvider.setKeyInput}
                  saveKey={() => ai.tavilyProvider.setKey(ai.tavilyProvider.keyInput.trim())}
                  clearKey={ai.tavilyProvider.clearKey}
                  activeBackend={ai.activeBackend}
                  backendId="tavily"
                  clearPreferredProvider={ai.clearPreferredProvider}
                  setActiveBackend={ai.setActiveBackend}
                  placeholder={TAVILY_SETTINGS_META.placeholder}
                  saveLabel={TAVILY_SETTINGS_META.saveLabel}
                  hint={TAVILY_SETTINGS_META.hint}
                />
              </SettingsAccordionItem>
            </SettingsAccordion>
          </div>

          {/* Diagnostics */}
          <div className={SECTION_CARD_CLASS}>
            <label className="text-sm font-medium text-push-fg">Diagnostics</label>
            <SettingsAccordion type="multiple">
              <SettingsAccordionItem
                value="edit-guard"
                title="Edit Guard"
                subtitle={
                  guardMetrics.checksTotal === 0 && guardMetrics.autoExpandAttempts === 0
                    ? 'No activity this session'
                    : `${guardMetrics.checksTotal} checks · ${guardMetrics.blockedTotal} blocked`
                }
              >
                {guardMetrics.checksTotal === 0 && guardMetrics.autoExpandAttempts === 0 ? (
                  <p className="text-xs text-push-fg-dim">No edit-guard activity this session.</p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <span className="text-xs text-push-fg-secondary">Checks</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {guardMetrics.checksTotal}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Allowed</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {guardMetrics.allowedTotal}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Blocked</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {guardMetrics.blockedTotal}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Auto-expand</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {guardMetrics.autoExpandSuccesses}/{guardMetrics.autoExpandAttempts}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Symbols read</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {guardMetrics.symbolsReadTotal}
                      </span>
                      <span className="text-xs text-push-fg-secondary">
                        Symbol warnings softened
                      </span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {guardMetrics.symbolWarningsSoftened}
                      </span>
                    </div>
                    {(guardMetrics.blockedTotal > 0 || guardMetrics.symbolWarningsSoftened > 0) && (
                      <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-push-xs text-push-fg-dim">Never read blocks</span>
                          <span className="text-push-xs text-push-fg-dim">
                            {guardMetrics.blockedByNeverRead}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-push-xs text-push-fg-dim">Stale blocks</span>
                          <span className="text-push-xs text-push-fg-dim">
                            {guardMetrics.blockedByStale}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-push-xs text-push-fg-dim">Partial-read blocks</span>
                          <span className="text-push-xs text-push-fg-dim">
                            {guardMetrics.blockedByPartialRead}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-push-xs text-push-fg-dim">
                            Unknown-symbol blocks
                          </span>
                          <span className="text-push-xs text-push-fg-dim">
                            {guardMetrics.blockedByUnknownSymbol}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-push-xs text-push-fg-dim">Symbol auto-expands</span>
                          <span className="text-push-xs text-push-fg-dim">
                            {guardMetrics.symbolAutoExpands}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </SettingsAccordionItem>

              <SettingsAccordionItem
                value="tool-calls"
                title="Tool Calls"
                subtitle={
                  tcMetrics.count === 0
                    ? 'No malformed calls this session'
                    : `${tcMetrics.count} malformed ${tcMetrics.count === 1 ? 'call' : 'calls'}`
                }
              >
                {tcMetrics.count === 0 ? (
                  <p className="text-xs text-push-fg-dim">No malformed tool calls this session.</p>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-push-fg-secondary">
                      {tcMetrics.count} malformed {tcMetrics.count === 1 ? 'call' : 'calls'}{' '}
                      detected this session
                    </p>
                    {Object.entries(tcMetrics.byProvider).map(([provider, pm]) => (
                      <div
                        key={provider}
                        className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-push-fg-secondary">
                            {PROVIDER_LABELS[provider as AIProviderType] ?? provider}
                          </span>
                          <span className="text-xs text-push-fg-dim">{pm.count}</span>
                        </div>
                        {Object.entries(pm.byModel).map(([model, mm]) => (
                          <div key={model} className="space-y-0.5 pl-2 border-l border-push-edge">
                            <div className="flex items-center justify-between">
                              <span className="text-push-xs text-push-fg-dim truncate max-w-[160px]">
                                {model}
                              </span>
                              <span className="text-push-xs text-push-fg-dim">{mm.count}</span>
                            </div>
                            {(Object.entries(mm.reasons) as [string, number][])
                              .filter(([, n]) => n > 0)
                              .map(([reason, n]) => (
                                <div
                                  key={reason}
                                  className="flex items-center justify-between pl-2"
                                >
                                  <span className="text-push-2xs text-push-fg-dim">
                                    {reason === 'truncated'
                                      ? 'Truncated'
                                      : reason === 'validation_failed'
                                        ? 'Invalid schema'
                                        : reason === 'malformed_json'
                                          ? 'Malformed JSON'
                                          : reason === 'natural_language_intent'
                                            ? 'NL intent'
                                            : reason}
                                  </span>
                                  <span className="text-push-2xs text-push-fg-dim">{n}</span>
                                </div>
                              ))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </SettingsAccordionItem>

              <SettingsAccordionItem
                value="context"
                title="Context"
                subtitle={
                  ctxMetrics.totalEvents === 0
                    ? 'No compression events this session'
                    : `${ctxMetrics.totalEvents} ${ctxMetrics.totalEvents === 1 ? 'event' : 'events'} · ${ctxMetrics.totalTokensSaved.toLocaleString()} tokens saved`
                }
              >
                {ctxMetrics.totalEvents === 0 ? (
                  <p className="text-xs text-push-fg-dim">
                    No context compression events this session.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                      <span className="text-xs text-push-fg-secondary">Events</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {ctxMetrics.totalEvents}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Tokens saved</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {ctxMetrics.totalTokensSaved.toLocaleString()}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Largest reduction</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {ctxMetrics.largestReduction.toLocaleString()}
                      </span>
                      <span className="text-xs text-push-fg-secondary">Max context seen</span>
                      <span className="text-xs text-push-fg-dim text-right">
                        {ctxMetrics.maxContextSeen.toLocaleString()}
                      </span>
                    </div>
                    {/* Phase breakdown */}
                    <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                      {[
                        ['Summarization', ctxMetrics.summarization] as const,
                        ['Digest + drop', ctxMetrics.digestDrop] as const,
                        ['Hard trim', ctxMetrics.hardTrim] as const,
                      ]
                        .filter(([, p]) => p.count > 0)
                        .map(([label, p]) => (
                          <div key={label} className="flex items-center justify-between">
                            <span className="text-push-xs text-push-fg-dim">{label}</span>
                            <span className="text-push-xs text-push-fg-dim">
                              {p.count}× · {(p.totalBefore - p.totalAfter).toLocaleString()} saved
                              {p.messagesDropped > 0 ? ` · ${p.messagesDropped} msgs dropped` : ''}
                            </span>
                          </div>
                        ))}
                    </div>
                    {/* Summarization causes */}
                    {Object.values(ctxMetrics.summarizationCauses).some((c) => c > 0) && (
                      <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                        <span className="text-push-xs text-push-fg-secondary font-medium">
                          Summarization causes
                        </span>
                        {[
                          ['Tool output', ctxMetrics.summarizationCauses.tool_output] as const,
                          ['Long message', ctxMetrics.summarizationCauses.long_message] as const,
                          ['Mixed', ctxMetrics.summarizationCauses.mixed] as const,
                        ]
                          .filter(([, c]) => c > 0)
                          .map(([label, count]) => (
                            <div key={label} className="flex items-center justify-between">
                              <span className="text-push-xs text-push-fg-dim">{label}</span>
                              <span className="text-push-xs text-push-fg-dim">{count}×</span>
                            </div>
                          ))}
                      </div>
                    )}
                    {/* Provider breakdown */}
                    {Object.keys(ctxMetrics.byProvider).length > 0 && (
                      <div className="rounded-lg border border-push-edge bg-push-surface px-3 py-2 space-y-1">
                        {Object.entries(ctxMetrics.byProvider).map(([prov, pm]) => (
                          <div key={prov} className="flex items-center justify-between">
                            <span className="text-push-xs text-push-fg-dim">
                              {PROVIDER_LABELS[prov as AIProviderType] ?? prov}
                            </span>
                            <span className="text-push-xs text-push-fg-dim">
                              {pm.count}× · {(pm.totalBefore - pm.totalAfter).toLocaleString()}{' '}
                              saved
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </SettingsAccordionItem>
            </SettingsAccordion>
          </div>

          {/* Danger Zone */}
          <div className="space-y-3 pt-2 border-t border-push-edge">
            <label className="text-sm font-medium text-push-fg">Data</label>
            <p className="text-xs text-push-fg-dim">
              Context memory is stored locally in your browser to help the agent remember facts
              across conversations. You can clear it below.
            </p>
            <div className="space-y-1.5 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  data.deleteAllChats();
                  onDismiss();
                }}
                className="text-push-fg-secondary hover:text-red-400 w-full justify-start gap-2 h-8 px-2"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete all chats{data.activeRepo ? ` for ${data.activeRepo.name}` : ''}
              </Button>

              {data.activeRepo && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    data.clearMemoryByRepo();
                    onDismiss();
                  }}
                  className="text-push-fg-secondary hover:text-red-400 w-full justify-start gap-2 h-8 px-2"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear repo memory for {data.activeRepo.name}
                </Button>
              )}

              {data.activeBranch && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    data.clearMemoryByBranch();
                    onDismiss();
                  }}
                  className="text-push-fg-secondary hover:text-red-400 w-full justify-start gap-2 h-8 px-2 justify-between flex"
                >
                  <div className="flex items-center gap-2">
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear branch memory
                  </div>
                  <span className="text-push-2xs font-mono">{data.activeBranch}</span>
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
