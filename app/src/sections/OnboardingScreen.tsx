import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { GitHubUser } from '@/types';

interface OnboardingScreenProps {
  onConnect: (pat: string) => Promise<boolean>;
  onDemo: () => void;
  loading: boolean;
  error: string | null;
  validatedUser: GitHubUser | null;
}

export function OnboardingScreen({
  onConnect,
  onDemo,
  loading,
  error,
  validatedUser,
}: OnboardingScreenProps) {
  const [pat, setPat] = useState('');

  const handleConnect = async () => {
    if (!pat.trim() || loading) return;
    const success = await onConnect(pat.trim());
    if (success) setPat('');
  };

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[#09090b] px-6 safe-area-top">
      <div className="w-full max-w-sm">
        {/* Logo + tagline */}
        <div className="text-center mb-10">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#111113] border border-[#1a1a1e]">
            <svg
              width="22"
              height="22"
              viewBox="0 0 16 16"
              fill="none"
              className="text-[#0070f3]"
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
          <p className="text-sm text-[#a1a1aa] leading-relaxed">
            AI coding agent with direct repo access.
          </p>
        </div>

        {/* PAT input */}
        <div className="space-y-3">
          {validatedUser && !error ? (
            <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm text-emerald-400">
                Connected as <span className="font-medium">{validatedUser.login}</span>
              </span>
            </div>
          ) : (
            <>
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxx"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                disabled={loading}
                className="w-full rounded-xl border border-[#1a1a1e] bg-[#111113] px-4 py-3 text-sm text-[#fafafa] font-mono placeholder:text-[#3f3f46] outline-none transition-colors duration-200 focus:border-[#0070f3]/50 disabled:opacity-50"
                autoFocus
              />

              <button
                onClick={handleConnect}
                disabled={!pat.trim() || loading}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0070f3] px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#0060d3] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Validating…
                  </>
                ) : (
                  'Connect GitHub'
                )}
              </button>

              {error && (
                <p className="text-xs text-red-400 text-center leading-relaxed">
                  {error}
                </p>
              )}

              <p className="text-xs text-[#52525b] text-center leading-relaxed">
                Personal access token with{' '}
                <code className="text-[#71717a] font-mono">repo</code> scope.
                <br />
                Stored locally, never sent to our servers.
              </p>
            </>
          )}
        </div>

        {/* Divider + demo */}
        <div className="mt-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-[#1a1a1e]" />
            <span className="text-xs text-[#3f3f46]">or</span>
            <div className="flex-1 h-px bg-[#1a1a1e]" />
          </div>

          <button
            onClick={onDemo}
            className="w-full rounded-xl border border-[#1a1a1e] bg-transparent px-4 py-3 text-sm text-[#71717a] transition-all duration-200 hover:border-[#27272a] hover:text-[#a1a1aa] active:scale-[0.98]"
          >
            Try Demo Mode
          </button>
        </div>
      </div>
    </div>
  );
}
