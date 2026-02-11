import { useState } from 'react';
import { Loader2, Github, Key } from 'lucide-react';
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
    <div className="flex h-dvh flex-col items-center justify-center bg-[#000] px-6 safe-area-top">
      <div className="w-full max-w-sm">
        {/* Logo + tagline */}
        <div className="text-center mb-10">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[#1e2634] bg-[linear-gradient(180deg,#0d1119_0%,#070a10_100%)] shadow-push-lg animate-fade-in-up">
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

        {/* Auth section */}
        <div className="space-y-3 stagger-in">
          {validatedUser && !error ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm text-emerald-400">
                Connected as <span className="font-medium">{validatedUser.login}</span>
                {isAppAuth && (
                  <span className="ml-1 text-emerald-500/60">(GitHub App)</span>
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
                className="w-full rounded-xl border border-push-edge bg-push-surface px-4 py-3 text-sm text-push-fg font-mono placeholder:text-[#4f596d] outline-none transition-colors duration-200 focus:border-push-sky/50 disabled:opacity-50"
                autoFocus
              />

              <button
                onClick={handleConnect}
                disabled={!pat.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#1b80d8] bg-[#0b74e8] px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#0a67cf] disabled:opacity-40 disabled:pointer-events-none spring-press"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Validating…
                  </>
                ) : (
                  'Connect with PAT'
                )}
              </button>

              <button
                onClick={() => setShowPatInput(false)}
                className="w-full text-xs text-push-fg-dim hover:text-[#8e99ad] transition-colors"
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
                className="w-full rounded-xl border border-push-edge bg-push-surface px-4 py-3 text-sm text-push-fg font-mono placeholder:text-[#4f596d] outline-none transition-colors duration-200 focus:border-push-sky/50 disabled:opacity-50"
                autoFocus
              />

              <button
                onClick={handleConnectInstallation}
                disabled={!installationId.replace(/\D/g, '') || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#1b80d8] bg-[#0b74e8] px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#0a67cf] disabled:opacity-40 disabled:pointer-events-none spring-press"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  'Connect Existing Install'
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
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-[#1b80d8] bg-[#0b74e8] px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#0a67cf] disabled:opacity-40 disabled:pointer-events-none spring-press"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <Github className="h-4 w-4" />
                    Connect with GitHub
                  </>
                )}
              </button>

              <p className="text-xs text-push-fg-dim text-center leading-relaxed">
                One click for returning users.
                <br />
                <span className="text-emerald-400">Recommended</span> — auto-detects your installation.
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
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-push-edge bg-push-surface px-4 py-3 text-sm text-[#9ca6b9] transition-all duration-200 hover:border-[#31425a] hover:text-[#e2e8f0] spring-press"
              >
                <Github className="h-4 w-4" />
                Install GitHub App
              </button>

              {/* PAT fallback */}
              <button
                onClick={() => setShowPatInput(true)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-push-edge bg-push-surface px-4 py-3 text-sm text-[#9ca6b9] transition-all duration-200 hover:border-[#31425a] hover:text-[#e2e8f0] spring-press"
              >
                <Key className="h-4 w-4" />
                Use Personal Access Token
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
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-[#1b2230]" />
            <span className="text-xs text-[#4f596d]">or</span>
            <div className="flex-1 h-px bg-[#1b2230]" />
          </div>

          <button
            onClick={onSandboxMode}
            className="w-full rounded-xl border border-emerald-500/25 bg-emerald-900/10 px-4 py-3 text-sm font-medium text-emerald-300 transition-all duration-200 hover:border-emerald-500/45 hover:bg-emerald-800/20 spring-press"
          >
            Try it now — no account needed
          </button>
          <p className="text-xs text-push-fg-dim text-center mt-2">
            Ephemeral sandbox. Nothing is saved unless you choose.
          </p>
        </div>
      </div>
    </div>
  );
}
