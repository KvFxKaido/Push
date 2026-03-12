import { useState } from 'react';
import { Loader2, Github, Key } from 'lucide-react';
import {
  HUB_MATERIAL_BUTTON_CLASS,
  HUB_MATERIAL_INPUT_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { GitHubUser } from '@/types';

interface OnboardingScreenProps {
  onConnect: (pat: string) => Promise<boolean>;
  onConnectOAuth: () => void;
  onSandboxMode: () => void;
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
  onSandboxMode,
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

  const onboardingButtonClass =
    `${HUB_MATERIAL_BUTTON_CLASS} relative flex w-full items-center justify-center gap-2 rounded-[18px] px-4 py-3 text-sm text-push-fg-secondary transition-all duration-200 disabled:pointer-events-none disabled:opacity-40`;
  const onboardingInputClass =
    `${HUB_MATERIAL_INPUT_CLASS} w-full rounded-[18px] px-4 py-3 text-sm text-push-fg font-mono placeholder:text-[#4f596d]`;

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
    <div className="relative flex h-dvh flex-col items-center justify-center bg-[linear-gradient(180deg,rgba(4,6,10,1)_0%,rgba(2,4,8,1)_100%)] px-6 safe-area-top">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/[0.03] to-transparent" />
      <div className="w-full max-w-sm space-y-6">
        {/* Logo + tagline */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center text-push-accent animate-fade-in-up">
            <svg
              width="22"
              height="22"
              viewBox="0 0 16 16"
              fill="none"
              className="text-push-accent"
            >
              <path
                d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-[#fafafa] tracking-tight mb-2">
            Push
          </h1>
          <p className="text-sm text-push-fg-secondary leading-relaxed">
            AI coding agent with direct repo access.
          </p>
        </div>

        <div className={`${HUB_PANEL_SURFACE_CLASS} stagger-in px-4 py-4`}>
          <div className="space-y-3">
          {validatedUser && !error ? (
            <div className={`flex items-center gap-3 px-4 py-3 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
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
                <HubControlGlow />
                {loading ? (
                  <>
                    <Loader2 className="relative z-10 h-4 w-4 animate-spin" />
                    <span className="relative z-10">Validating…</span>
                  </>
                ) : (
                  <>
                    <Key className="relative z-10 h-4 w-4" />
                    <span className="relative z-10">Connect with PAT</span>
                  </>
                )}
              </button>

              <button
                onClick={() => setShowPatInput(false)}
                className="w-full text-xs text-push-fg-dim transition-colors hover:text-[#8e99ad]"
              >
                ← Back to GitHub App
              </button>

              <p className="text-xs text-push-fg-dim text-center leading-relaxed">
                Personal access token with{' '}
                <code className="text-[#9ca6b9] font-mono">repo</code> scope.
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
                <HubControlGlow />
                {loading ? (
                  <>
                    <Loader2 className="relative z-10 h-4 w-4 animate-spin" />
                    <span className="relative z-10">Connecting…</span>
                  </>
                ) : (
                  <>
                    <Github className="relative z-10 h-4 w-4" />
                    <span className="relative z-10">Connect Existing Install</span>
                  </>
                )}
              </button>

              <button
                onClick={() => setShowInstallIdInput(false)}
                className="w-full text-xs text-push-fg-dim hover:text-[#8e99ad] transition-colors"
              >
                ← Back to install flow
              </button>

              <p className="text-xs text-push-fg-dim text-center leading-relaxed">
                Already installed? Paste your installation ID.
                <br />
                Find it at <code className="text-[#9ca6b9] font-mono">github.com/settings/installations</code>.
              </p>

              {error && (
                <p className="text-xs text-red-400 text-center leading-relaxed">
                  {error}
                </p>
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
                <HubControlGlow />
                {loading ? (
                  <>
                    <Loader2 className="relative z-10 h-4 w-4 animate-spin" />
                    <span className="relative z-10">Connecting…</span>
                  </>
                ) : (
                  <>
                    <Github className="relative z-10 h-4 w-4" />
                    <span className="relative z-10">Connect with GitHub</span>
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
                <p className="text-xs text-red-400 text-center leading-relaxed">
                  {error}
                </p>
              )}

              {/* Install GitHub App (secondary — for first-time users) */}
              <button
                onClick={onInstallApp}
                disabled={loading}
                className={onboardingButtonClass}
              >
                <HubControlGlow />
                <Github className="relative z-10 h-4 w-4" />
                <span className="relative z-10">Install GitHub App</span>
              </button>

              {/* PAT fallback */}
              <button
                onClick={() => setShowPatInput(true)}
                className={onboardingButtonClass}
              >
                <HubControlGlow />
                <Key className="relative z-10 h-4 w-4" />
                <span className="relative z-10">Use Personal Access Token</span>
              </button>

              <button
                onClick={() => setShowInstallIdInput(true)}
                className="w-full text-xs text-push-fg-dim hover:text-[#8e99ad] transition-colors"
              >
                Already installed? Enter installation ID
              </button>
            </>
          )}
          </div>

          {/* Divider + sandbox */}
          <div className="mt-8">
            <div className="mb-6 flex items-center gap-3">
            <div className="flex-1 h-px bg-push-edge-subtle" />
            <span className="text-xs text-[#4f596d]">or</span>
            <div className="flex-1 h-px bg-push-edge-subtle" />
            </div>

            <button
              onClick={onSandboxMode}
              className={`${onboardingButtonClass} text-emerald-300`}
            >
              <HubControlGlow />
              <span className="relative z-10">Try it now — no account needed</span>
            </button>
            <p className="mt-2 text-center text-xs text-push-fg-dim">
              Ephemeral sandbox. Nothing is saved unless you choose.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
