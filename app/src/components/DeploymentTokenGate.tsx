import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  getDeploymentAuthState,
  getDeploymentToken,
  probeDeploymentAuth,
  setDeploymentToken,
  subscribeDeploymentAuthState,
  type DeploymentAuthState,
} from '@/lib/deployment-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function DeploymentTokenGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DeploymentAuthState>(getDeploymentAuthState);
  // Render children optimistically while the probe is in flight only when a
  // token is already in storage — that path is already authenticated against
  // the gate or will fail mid-session and flip the state. Without a token,
  // block on `unknown` so we don't briefly expose UI/cached data on a private
  // deployment before the probe lands.
  const [hadStoredToken] = useState(() => Boolean(getDeploymentToken()));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeDeploymentAuthState(setState);
    return unsubscribe;
  }, []);
  useEffect(() => {
    void probeDeploymentAuth();
  }, []);

  if (state === 'ok') return <>{children}</>;
  if (state === 'unknown' && hadStoredToken) return <>{children}</>;
  if (state === 'unknown') return null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setDeploymentToken(value);
    const next = await probeDeploymentAuth();
    setBusy(false);
    if (next === 'ok') {
      setValue('');
    } else {
      setErr("That token didn't work. Double-check and try again.");
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-background text-foreground">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">Private deployment</h1>
          <p className="text-sm text-muted-foreground">
            This Push deployment is gated. Paste the deployment token to continue.
          </p>
        </header>
        <div className="space-y-2">
          <Label htmlFor="push-deployment-token">Deployment token</Label>
          <Input
            id="push-deployment-token"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="push_deployment_token"
            className="font-mono"
          />
        </div>
        {state === 'invalid' && !err && (
          <p className="text-sm text-destructive">Saved token rejected. Paste a fresh one.</p>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Button type="submit" disabled={busy || !value.trim()} className="w-full">
          {busy ? 'Checking…' : 'Save & continue'}
        </Button>
      </form>
    </div>
  );
}
