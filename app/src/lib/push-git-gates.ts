import { composePrePushGates, type PrePushGate, type PushOptions } from '@push/lib/git/push-git';
import { makeSecretScanPrePushGate } from '@push/lib/git/secret-scan-gate';
import { makeProtectMainPrePushGate } from '@push/lib/git/protect-main-gate';
import { makeAuditorPrePushGate, type AuditorPushVerdict } from '@push/lib/git/auditor-push-gate';
import { resolveSecretScanEnabled } from '@push/lib/secret-scan';

type PushDiffProvider = (opts?: PushOptions) => Promise<string | null> | string | null;

/**
 * Resolve the web/native secret-scan opt-out. Vite exposes build-time vars on
 * `import.meta.env`; `VITE_PUSH_SECRET_SCAN=0` disables the gate on the client.
 * Guarded so it's safe under any bundler/test runner.
 */
export function resolveWebSecretScanEnabled(): boolean {
  const env = (import.meta as { env?: Record<string, unknown> }).env?.VITE_PUSH_SECRET_SCAN;
  return resolveSecretScanEnabled({ env });
}

/**
 * Resolve whether the Auditor runs at the push boundary (Gate-at-Push Move A).
 *
 * Default ON (Move A flipped): the SAFE/UNSAFE Auditor gate now lives at the
 * push step. The agent commits silently via `sandbox_commit` (no audit), then
 * ships via `prepare_push` / `sandbox_push`, where this gate audits the
 * cumulative push diff.
 */
export function resolveWebAuditAtPushEnabled(): boolean {
  const raw =
    typeof process !== 'undefined' && process.env?.VITE_PUSH_AUDIT_AT_PUSH !== undefined
      ? process.env.VITE_PUSH_AUDIT_AT_PUSH
      : (import.meta as { env?: Record<string, unknown> }).env?.VITE_PUSH_AUDIT_AT_PUSH;
  return !(raw === '0' || raw === 'false');
}

export function buildPushPrePushGate(opts: {
  prePush?: PrePushGate;
  secretScan?: boolean;
  protectMain?: boolean;
  defaultBranch?: string;
  getCurrentBranch: () => Promise<string | null>;
  getPushedDiff?: PushDiffProvider;
  auditAtPush?: {
    audit: (diff: string) => Promise<AuditorPushVerdict>;
    enabled?: boolean;
  };
}): PrePushGate | undefined {
  if (opts.prePush) return opts.prePush;
  const secretScanEnabled = Boolean(opts.secretScan && resolveWebSecretScanEnabled());
  const auditAtPushEnabled = Boolean(opts.auditAtPush && opts.auditAtPush.enabled !== false);
  const missingDiffProviderGate: PrePushGate | undefined =
    !opts.getPushedDiff && (secretScanEnabled || auditAtPushEnabled)
      ? async () => ({
          ok: false,
          reason:
            'Push blocked: pushed-diff provider is unavailable, so enabled push gates cannot inspect this delivery.',
        })
      : undefined;
  const getDiff = opts.getPushedDiff ?? (() => null);
  return composePrePushGates([
    opts.protectMain
      ? makeProtectMainPrePushGate({
          enabled: true,
          defaultBranch: opts.defaultBranch,
          getCurrentBranch: opts.getCurrentBranch,
        })
      : undefined,
    missingDiffProviderGate,
    opts.secretScan
      ? makeSecretScanPrePushGate({
          getDiff,
          enabled: secretScanEnabled,
        })
      : undefined,
    opts.auditAtPush
      ? makeAuditorPrePushGate({
          getDiff,
          audit: opts.auditAtPush.audit,
          enabled: opts.auditAtPush.enabled,
        })
      : undefined,
  ]);
}
