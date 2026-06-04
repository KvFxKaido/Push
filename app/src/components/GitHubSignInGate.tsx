import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { probeSession } from '@/lib/session-auth';
import { subscribeSessionInvalid } from '@/lib/api-auth-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * App-level gate replacing the retired DeploymentTokenGate (auth rework step 3).
 * The Push session is the universal `/api/*` gate, so a context with no session
 * can't do anything useful — block it behind a single "Connect GitHub" call to
 * action instead of letting every feature 401 piecemeal.
 *
 * Authoritative signal is the session *probe* (`/api/auth-probe`), never the
 * GitHub App installation token alone: `handleGitHubAppToken` can return a token
 * without minting a session (missing secret, unvouched installation, org
 * account), and revealing the app then would 401 every gated call. So we
 * re-probe whenever auth completes and gate strictly on the probe result. A
 * mid-session 401 (session expiry) flips us back to the connect screen via
 * `subscribeSessionInvalid`.
 *
 * The OAuth `?code=` callback is consumed exactly once here (this gate owns
 * `useGitHubAppAuth` while the app is hidden), so App's own hook never re-runs
 * the exchange.
 */

function hasOAuthCallbackParams(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('code')) return true;
  return Boolean(params.get('installation_id') && params.get('setup_action'));
}

type ProbeState = 'pending' | 'authed' | 'no-session';

export function GitHubSignInGate({ children }: { children: ReactNode }) {
  const auth = useGitHubAppAuth();
  const isCallback = useMemo(() => hasOAuthCallbackParams(), []);
  const [probe, setProbe] = useState<ProbeState>('pending');
  const [instId, setInstId] = useState('');

  // Initial probe — skipped during an OAuth/install callback, where the hook is
  // busy minting the session; the auth.token effect below re-probes once it's done.
  useEffect(() => {
    if (isCallback) return;
    let cancelled = false;
    probeSession().then((ok) => {
      if (!cancelled) setProbe(ok ? 'authed' : 'no-session');
    });
    return () => {
      cancelled = true;
    };
  }, [isCallback]);

  // Re-probe authoritatively after the hook obtains an installation token (OAuth
  // callback or manual installation-id entry). A token does NOT imply a session,
  // so only the probe decides whether to reveal the app.
  useEffect(() => {
    if (!auth.token) return;
    let cancelled = false;
    probeSession().then((ok) => {
      if (!cancelled) setProbe(ok ? 'authed' : 'no-session');
    });
    return () => {
      cancelled = true;
    };
  }, [auth.token]);

  // A mid-session 401 (session expired) returns us to the connect screen.
  useEffect(() => subscribeSessionInvalid(() => setProbe('no-session')), []);

  if (probe === 'authed') return <>{children}</>;

  // Actively resolving: the hook is processing a connect/callback, or a probe is
  // in flight after a callback minted a token. Anything that leaves the hook
  // idle with `auth.error` (e.g. an expired OAuth code) falls through to the
  // connect screen below, which surfaces the error — never a perpetual splash.
  const resolving =
    auth.loading || (probe === 'pending' && isCallback && Boolean(auth.token) && !auth.error);
  if (resolving) return <SignInSplash label="Connecting GitHub…" />;
  if (probe === 'pending' && !isCallback) return <SignInSplash label="Checking session…" />;

  const onSubmitInstallationId = (e: FormEvent) => {
    e.preventDefault();
    void auth.setInstallationIdManually(instId.trim());
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-background text-foreground">
      <div className="w-full max-w-sm space-y-5">
        <header className="space-y-1">
          <h1 className="text-push-2xl font-display font-semibold">Connect GitHub to continue</h1>
          <p className="text-sm text-muted-foreground">
            Push runs on your GitHub identity. Sign in with the GitHub App to start a session.
          </p>
        </header>

        <div className="space-y-2">
          <Button onClick={auth.connect} disabled={auth.loading} className="w-full">
            {auth.loading ? 'Connecting…' : 'Connect with GitHub'}
          </Button>
          <Button onClick={auth.install} variant="outline" className="w-full">
            Install the GitHub App (first time)
          </Button>
        </div>

        <form onSubmit={onSubmitInstallationId} className="space-y-2 border-t border-border pt-4">
          <Label htmlFor="gh-installation-id" className="text-xs text-muted-foreground">
            Already installed? Enter your installation ID
          </Label>
          <div className="flex gap-2">
            <Input
              id="gh-installation-id"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={instId}
              onChange={(e) => setInstId(e.target.value)}
              placeholder="12345678"
              className="font-mono"
            />
            <Button type="submit" variant="secondary" disabled={auth.loading || !instId.trim()}>
              Use
            </Button>
          </div>
        </form>

        {auth.error && <p className="text-sm text-destructive">{auth.error}</p>}
      </div>
    </div>
  );
}

function SignInSplash({ label }: { label: string }) {
  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-background text-foreground">
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
