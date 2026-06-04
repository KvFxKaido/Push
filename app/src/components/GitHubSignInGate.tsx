import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useGitHubAppAuth } from '@/hooks/useGitHubAppAuth';
import { getSessionToken, probeSession } from '@/lib/session-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * App-level gate replacing the retired DeploymentTokenGate (auth rework step 3).
 * The Push session is the universal `/api/*` gate, so a context with no session
 * can't do anything useful — block it behind a single "Connect GitHub" call to
 * action instead of letting every feature 401 piecemeal.
 *
 * Renders the app when there's a session OR while a GitHub OAuth callback is
 * being processed (that's *how* you get a session). It reuses `useGitHubAppAuth`
 * for the full connect surface (OAuth auto-connect, first-time install, and the
 * manual installation-id path) and only renders children once authenticated, so
 * the OAuth `?code=` is consumed exactly once (here) and App's own
 * `useGitHubAppAuth` never sees it again.
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // During an OAuth/install callback, let `useGitHubAppAuth` consume the code
    // and mint the session; we flip to authed off `auth.token` below.
    if (isCallback) return;
    let cancelled = false;
    probeSession().then((ok) => {
      if (!cancelled) setProbe(ok ? 'authed' : 'no-session');
    });
    return () => {
      cancelled = true;
    };
  }, [isCallback]);

  // A session obtained mid-gate (OAuth callback, or manual installation-id entry)
  // sets the app token — treat that as authenticated and reveal the app.
  const authed = probe === 'authed' || Boolean(auth.token);

  if (authed) return <>{children}</>;

  // Probe in flight: render optimistically only if a session token copy already
  // exists (avoids a flash of the connect screen for an already-signed-in user);
  // otherwise show nothing until the probe lands.
  if (probe === 'pending') {
    if (isCallback) return <SignInSplash label="Connecting GitHub…" />;
    return getSessionToken() ? <>{children}</> : <SignInSplash label="Checking session…" />;
  }

  const onSubmitInstallationId = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await auth.setInstallationIdManually(instId.trim());
    setBusy(false);
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
            <Button type="submit" variant="secondary" disabled={busy || !instId.trim()}>
              {busy ? '…' : 'Use'}
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
