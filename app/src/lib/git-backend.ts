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
import { PushGit, type PreCommitGate, type PrePushGate } from '@push/lib/git/push-git';
import { execInSandbox, type ExecResult } from './sandbox-client';
import { shellEscape } from './sandbox-tool-utils';

type SandboxExecFn = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean },
) => Promise<ExecResult>;

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
  const exec: GitExec = async (args, opts) => {
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
  return new SandboxPlumbingBackend(exec);
}

/**
 * Build a PushGit facade bound to a sandbox. Pass `preCommit` (a closure the
 * handler builds over the Auditor) to gate commits; pass `prePush` (built over
 * the deterministic secret scan, see `makeSecretScanPrePushGate`) to gate
 * pushes; pass `execFn` to reuse a call-site's injected executor.
 */
export function createSandboxPushGit(
  sandboxId: string,
  opts?: { execFn?: SandboxExecFn; preCommit?: PreCommitGate; prePush?: PrePushGate },
): PushGit {
  return new PushGit({
    backend: createSandboxGitBackend(sandboxId, opts?.execFn),
    preCommit: opts?.preCommit,
    prePush: opts?.prePush,
  });
}
