import { useState } from 'react';
import { Loader2, Globe, Key, MessageSquare } from 'lucide-react';
import {
  HUB_MATERIAL_BUTTON_CLASS,
  HUB_MATERIAL_INPUT_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_TAG_CLASS,
} from '@/components/chat/hub-styles';
import { PageScaffold } from '@/components/layout';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import { GitHubMarkIcon, PushMarkIcon } from '@/components/icons/push-custom-icons';
import { DEFAULT_REPO_APPEARANCE, getRepoAppearanceColorHex } from '@/lib/repo-appearance';
import type { GitHubUser } from '@/types';

// Ambient glow for the accountless chrome surfaces. No repo context here,
// so it borrows the default repo-appearance accent — the same cool wash the
// chat surface uses when a repo hasn't customized its color.
const CHROME_GLOW_COLOR = getRepoAppearanceColorHex(DEFAULT_REPO_APPEARANCE.color);

interface OnboardingScreenProps {
  onConnect: (pat: string) => Promise<boolean>;
  onConnectOAuth: () => void;
  onStartWorkspace: () => void;
  onStartChat: () => void;
  /**
   * Optional Remote (relay) entry. The relay path bypasses GitHub auth.
   * Undefined hides the tile (VITE_RELAY_MODE off).
   */
  onStartRelay?: () => void;
  onInstallApp: () => void;
  onConnectInstallationId: (installationId: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  validatedUser: GitHubUser | null;
  isAppAuth?: boolean;
}

export function OnboardingScreen({
  onConnect,
  onConnectOAuth,
  onStartWorkspace,
  onStartChat,
  onStartRelay,
  onInstallApp,
  onConnectInstallationId,
  loading,
  error,
  validatedUser,
  isAppAuth,
}: OnboardingScreenProps) {
  const [pat, setPat] = useState('');
  const [showPatInput, setShowPatInput] = useState(false);
  const [showInstallIdInput, setShowInstallIdInput] = useState(false);
  const [installationId, setInstallationId] = useState('');

  const onboardingButtonClass = `${HUB_MATERIAL_BUTTON_CLASS} relative flex w-full items-center justify-center gap-2 rounded-[18px] px-4 py-3 text-sm text-push-fg-secondary transition-all duration-200 disabled:pointer-events-none disabled:opacity-40`;
  const onboardingInputClass = `${HUB_MATERIAL_INPUT_CLASS} w-full rounded-[18px] px-4 py-3 text-sm text-push-fg font-mono placeholder:text-push-fg-dimmest`;

  const handleConnect = async () => {
    if (!pat.trim() || loading) return;
    const success = await onConnect(pat.trim());
    if (success) setPat('');
  };

  const handleConnectInstallation = async () => {
    const normalized = installationId.replace(/\D/g, '');
    if (!normalized || loading) return;
    const success = await onConnectInstallationId(normalized);
    if (success) {
      setInstallationId('');
      setShowInstallIdInput(false);
    }
  };

  return (
    <PageScaffold
      width="sm"
      align="center"
      className="px-6"
      backdrop={<ChatBackgroundGlow active color={CHROME_GLOW_COLOR} />}
    >
      <div className="space-y-6">
        {/* Logo + tagline */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center text-push-accent animate-fade-in-up">
            <PushMarkIcon className="h-[22px] w-[22px] text-push-accent" />
          </div>
          <h1 className="text-push-display font-display font-semibold text-push-fg mb-2">Push</h1>
          <p className="text-sm text-push-fg-secondary leading-relaxed">
            AI coding agent with direct repo access.
          </p>
        </div>

        <div className={`${HUB_PANEL_SURFACE_CLASS} stagger-in px-4 py-4`}>
          <div className="space-y-3">
            {validatedUser && !error ? (
              <div
                className={`flex items-center gap-3 px-4 py-3 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
              >
                <div className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-sm text-emerald-400">
                  Connected as <span className="font-medium">{validatedUser.login}</span>
                  {isAppAuth && (
                    <span className={`ml-2 align-middle ${HUB_TAG_CLASS} text-emerald-400`}>
                      GitHub App
                    </span>
                  )}
                </span>
              </div>
            ) : showPatInput ? (
              <>
                {/* PAT input mode */}
                <input
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxx"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                  disabled={loading}
                  className={onboardingInputClass}
                  autoFocus
                />

                <button
                  onClick={handleConnect}
                  disabled={!pat.trim() || loading}
                  className={onboardingButtonClass}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Validating…</span>
                    </>
                  ) : (
                    <>
                      <Key className="h-4 w-4" />
                      <span>Connect with PAT</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => setShowPatInput(false)}
                  className="w-full text-xs text-push-fg-dim transition-colors hover:text-push-fg-muted"
                >
                  ← Back to GitHub App
                </button>

                <p className="text-xs text-push-fg-dim text-center leading-relaxed">
                  Personal access token with{' '}
                  <code className="text-push-fg-muted font-mono">repo</code> scope.
                  <br />
                  Stored locally, never sent to our servers.
                </p>
              </>
            ) : showInstallIdInput ? (
              <>
                <input
                  type="text"
                  placeholder="Installation ID (numbers only)"
                  value={installationId}
                  onChange={(e) => setInstallationId(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && handleConnectInstallation()}
                  disabled={loading}
                  className={onboardingInputClass}
                  autoFocus
                />

                <button
                  onClick={handleConnectInstallation}
                  disabled={!installationId.replace(/\D/g, '') || loading}
                  className={onboardingButtonClass}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Connecting…</span>
                    </>
                  ) : (
                    <>
                      <GitHubMarkIcon className="h-4 w-4" />
                      <span>Connect Existing Install</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => setShowInstallIdInput(false)}
                  className="w-full text-xs text-push-fg-dim hover:text-push-fg-muted transition-colors"
                >
                  ← Back to install flow
                </button>

                <p className="text-xs text-push-fg-dim text-center leading-relaxed">
                  Already installed? Paste your installation ID.
                  <br />
                  Find it at{' '}
                  <code className="text-push-fg-muted font-mono">
                    github.com/settings/installations
                  </code>
                  .
                </p>

                {error && (
                  <p className="text-xs text-red-400 text-center leading-relaxed">{error}</p>
                )}
              </>
            ) : (
              <>
                {/* Connect with GitHub (OAuth auto-detect — primary) */}
                <button
                  onClick={onConnectOAuth}
                  disabled={loading}
                  className={onboardingButtonClass}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Connecting…</span>
                    </>
                  ) : (
                    <>
                      <GitHubMarkIcon className="h-4 w-4" />
                      <span>Connect with GitHub</span>
                    </>
                  )}
                </button>

                <p className="text-xs text-push-fg-dim text-center leading-relaxed">
                  One click for returning users.
                  <br />
                  <span className={`${HUB_TAG_CLASS} text-emerald-400`}>Recommended</span>{' '}
                  <span>auto-detects your installation.</span>
                </p>

                {error && (
                  <p className="text-xs text-red-400 text-center leading-relaxed">{error}</p>
                )}

                {/* Install GitHub App (secondary — for first-time users) */}
                <button onClick={onInstallApp} disabled={loading} className={onboardingButtonClass}>
                  <GitHubMarkIcon className="h-4 w-4" />
                  <span>Install GitHub App</span>
                </button>

                {/* PAT fallback */}
                <button onClick={() => setShowPatInput(true)} className={onboardingButtonClass}>
                  <Key className="h-4 w-4" />
                  <span>Use Personal Access Token</span>
                </button>

                <button
                  onClick={() => setShowInstallIdInput(true)}
                  className="w-full text-xs text-push-fg-dim hover:text-push-fg-muted transition-colors"
                >
                  Already installed? Enter installation ID
                </button>
              </>
            )}
          </div>

          {/* Divider + no-account entry */}
          <div className="mt-8">
            <div className="mb-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-push-edge-subtle" />
              <span className="text-xs text-push-fg-dimmest">or try without an account</span>
              <div className="flex-1 h-px bg-push-edge-subtle" />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={onStartChat} className={`${onboardingButtonClass} text-push-violet`}>
                <MessageSquare className="h-4 w-4" />
                <span>Chat</span>
              </button>
              <button
                onClick={onStartWorkspace}
                className={`${onboardingButtonClass} text-emerald-300`}
              >
                <span>Workspace</span>
              </button>
            </div>
            {onStartRelay && (
              <button
                type="button"
                onClick={onStartRelay}
                className={`${onboardingButtonClass} mt-2 text-sky-200`}
              >
                <Globe className="h-4 w-4" />
                <span>Remote</span>
                <span className="text-[10px] uppercase tracking-wide text-sky-200/60">
                  Experimental
                </span>
              </button>
            )}
            <p className="mt-2 text-center text-xs text-push-fg-dim">
              No account needed. Nothing is saved unless you choose.
            </p>
          </div>
        </div>
      </div>
    </PageScaffold>
  );
}
