/**
 * Web-surface adapter for the shared GitBackend.
 *
 * Wires the argv-based `GitExec` port to the sandbox executor so web
 * call-sites read git through the typed backend instead of bespoke
 * command-string + parse logic. Each argv token is shell-escaped before
 * being joined into `git <args>`, so the adapter stays injection-safe even
 * if a future read forwards caller-supplied data (today's reads pass only
 * fixed flags). Transport/exec errors are converted to a non-zero result
 * rather than propagated, honoring the `GitExec` contract so backend reads
 * resolve to null instead of throwing.
 */

import { SandboxPlumbingBackend, type GitBackend, type GitExec } from '@push/lib/git/backend';
import {
  PushGit,
  composePrePushGates,
  type PreCommitGate,
  type PrePushGate,
} from '@push/lib/git/push-git';
import { computePushedDiff } from '@push/lib/git/pushed-diff';
import { makeSecretScanPrePushGate } from '@push/lib/git/secret-scan-gate';
import { makeProtectMainPrePushGate } from '@push/lib/git/protect-main-gate';
import { resolveSecretScanEnabled } from '@push/lib/secret-scan';
import { execInSandbox, type ExecResult } from './sandbox-client';
import { shellEscape } from './sandbox-tool-utils';

type SandboxExecFn = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean },
) => Promise<ExecResult>;

/**
 * Build the argv-based `GitExec` port over a sandbox executor. Shared by the
 * backend and the secret-scan diff source so both run git the same way.
 */
function makeSandboxGitExec(sandboxId: string, execFn: SandboxExecFn): GitExec {
  return async (args, opts) => {
    const command = `git ${args.map(shellEscape).join(' ')}`;
    try {
      const res = await execFn(
        sandboxId,
        command,
        undefined,
        opts?.mutates ? { markWorkspaceMutated: true } : undefined,
      );
      // Pass `error` through (a gone/unreachable sandbox sets it out-of-band)
      // so write callers can detect expiry from the result.
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, error: res.error };
    } catch (err) {
      // `execInSandbox` throws on transport/timeout/non-2xx. The GitExec
      // contract is resolve-don't-reject, so convert to a non-zero result;
      // backend reads then return null rather than throwing at call-sites.
      const message = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: message, exitCode: 1, error: message };
    }
  };
}

/**
 * Resolve the web secret-scan opt-out. Vite exposes build-time vars on
 * `import.meta.env`; `VITE_PUSH_SECRET_SCAN=0` disables the gate on the client
 * (process env isn't readable in the browser). Guarded so it's safe under any
 * bundler/test runner.
 */
export function resolveWebSecretScanEnabled(): boolean {
  const env = (import.meta as { env?: Record<string, unknown> }).env?.VITE_PUSH_SECRET_SCAN;
  return resolveSecretScanEnabled({ env });
}

/**
 * Build a GitBackend bound to a sandbox. Defaults to the module-level
 * `execInSandbox`; pass a custom executor (e.g. a tool-handler's injected
 * `ctx.execInSandbox`) when the call-site already has one. Commands run in
 * the sandbox's default workdir (`/workspace`); write calls forward the
 * `mutates` hint as `markWorkspaceMutated`.
 */
export function createSandboxGitBackend(
  sandboxId: string,
  execFn: SandboxExecFn = execInSandbox,
): GitBackend {
  return new SandboxPlumbingBackend(makeSandboxGitExec(sandboxId, execFn));
}

/**
 * Build a PushGit facade bound to a sandbox. Pass `preCommit` (a closure the
 * handler builds over the Auditor) to gate commits; pass `secretScan: true` to
 * gate pushes behind the deterministic secret scan over the *uncapped*
 * about-to-be-pushed diff (`computePushedDiff`); pass `protectMain: true`
 * (with the repo `defaultBranch`) to refuse a push to the protected branch at
 * the boundary itself (defense-in-depth behind the Protect Main pre-hook); pass
 * `prePush` to inject a custom push gate; pass `execFn` to reuse a call-site's
 * injected executor.
 *
 * When both `protectMain` and `secretScan` are set, the gates compose and run
 * safety-first: Protect Main refuses a protected-branch push before the diff is
 * even scanned.
 */
export function createSandboxPushGit(
  sandboxId: string,
  opts?: {
    execFn?: SandboxExecFn;
    preCommit?: PreCommitGate;
    prePush?: PrePushGate;
    secretScan?: boolean;
    protectMain?: boolean;
    defaultBranch?: string;
  },
): PushGit {
  const exec = makeSandboxGitExec(sandboxId, opts?.execFn ?? execInSandbox);
  const backend = new SandboxPlumbingBackend(exec);
  const prePush =
    opts?.prePush ??
    composePrePushGates([
      opts?.protectMain
        ? makeProtectMainPrePushGate({
            enabled: true,
            defaultBranch: opts.defaultBranch,
            // Authoritative read of the real HEAD right before the push.
            getCurrentBranch: () => backend.currentBranch(),
          })
        : undefined,
      opts?.secretScan
        ? makeSecretScanPrePushGate({
            getDiff: () => computePushedDiff(exec),
            enabled: resolveWebSecretScanEnabled(),
          })
        : undefined,
    ]);
  return new PushGit({
    backend,
    preCommit: opts?.preCommit,
    prePush,
  });
}
