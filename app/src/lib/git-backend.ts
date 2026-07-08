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
import { gitWorkingCopyLockScope } from '@push/lib/git/repo-lock';
import { PushGit, type PreCommitGate, type PrePushGate } from '@push/lib/git/push-git';
import { computePushedDiff } from '@push/lib/git/pushed-diff';
import { computePushPlan, type PushPlan } from '@push/lib/git/push-plan';
import type { AuditorPushVerdict } from '@push/lib/git/auditor-push-gate';
import { execInSandbox, type ExecResult } from './sandbox-client';
import { getActiveGitHubToken } from './github-auth';
import { shellEscape } from './sandbox-tool-utils';
import { buildPushPrePushGate } from './push-git-gates';

export { resolveWebAuditAtPushEnabled, resolveWebSecretScanEnabled } from './push-git-gates';

type SandboxExecFn = (
  sandboxId: string,
  command: string,
  workdir?: string,
  options?: { markWorkspaceMutated?: boolean; suppressWorkspaceMutationSignal?: boolean },
) => Promise<ExecResult>;

type GitHubTokenProvider = () => string;

function base64Encode(value: string): string {
  if (typeof btoa === 'function') return btoa(value);
  return Buffer.from(value, 'utf8').toString('base64');
}

function shouldInjectGitHubAuth(args: string[]): boolean {
  return args[0] === 'fetch' || args[0] === 'push' || args[0] === 'ls-remote';
}

function gitHubAuthConfigArgs(token: string): string[] {
  const encoded = base64Encode(`x-access-token:${token}`);
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded}`];
}

function withTransientGitHubAuth(args: string[], token: string): string[] {
  if (!token || !shouldInjectGitHubAuth(args)) return args;
  return [...gitHubAuthConfigArgs(token), ...args];
}

/**
 * Shell-escaped `git -c …` prefix that injects transient GitHub auth into a RAW
 * git command string that talks to origin. Origin is rewritten tokenless after
 * clone (#987), so code that builds shell commands directly (NOT via the
 * GitBackend argv path) must add auth itself for network reads against origin —
 * e.g. auto-back restore's `git fetch origin <ref>` and the remote
 * branch-collision `git ls-remote origin`. Returns '' when no token is active,
 * so public-repo / no-auth calls are unchanged. Splice as `git ${prefix}fetch …`
 * (the non-empty form carries a trailing space).
 */
export function gitHubAuthCommandPrefix(
  getToken: GitHubTokenProvider = getActiveGitHubToken,
): string {
  const token = getToken();
  if (!token) return '';
  return `${gitHubAuthConfigArgs(token).map(shellEscape).join(' ')} `;
}

/**
 * Build the argv-based `GitExec` port over a sandbox executor. Shared by the
 * backend and the secret-scan diff source so both run git the same way.
 */
function makeSandboxGitExec(
  sandboxId: string,
  execFn: SandboxExecFn,
  getGitHubToken: GitHubTokenProvider = getActiveGitHubToken,
): GitExec {
  return async (args, opts) => {
    const commandArgs = withTransientGitHubAuth(args, getGitHubToken());
    const command = `git ${commandArgs.map(shellEscape).join(' ')}`;
    try {
      const res = await execFn(
        sandboxId,
        command,
        undefined,
        opts?.mutates
          ? { markWorkspaceMutated: true, suppressWorkspaceMutationSignal: true }
          : undefined,
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
 * Build a GitBackend bound to a sandbox. Defaults to the module-level
 * `execInSandbox`; pass a custom executor (e.g. a tool-handler's injected
 * `ctx.execInSandbox`) when the call-site already has one. Commands run in
 * the sandbox's default workdir (`/workspace`); write calls forward the
 * `mutates` hint as `markWorkspaceMutated`.
 */
export function createSandboxGitBackend(
  sandboxId: string,
  execFn: SandboxExecFn = execInSandbox,
  opts?: { getGitHubToken?: GitHubTokenProvider },
): GitBackend {
  // The sandbox id is the durable working-copy identity on web (one sandbox =
  // one working copy, preserved across typed branch switches); every backend/
  // PushGit over the same sandbox shares this lock lane.
  return new SandboxPlumbingBackend(makeSandboxGitExec(sandboxId, execFn, opts?.getGitHubToken), {
    lockScope: gitWorkingCopyLockScope(sandboxId),
  });
}

/**
 * Compute the cumulative push diff for a sandbox — the commits the next `git
 * push` would upload (uncapped), resolved through the same `GitExec` port the
 * backend and secret-scan gate use. Returns `null` when the diff read itself
 * fails (no commits / invalid ref / unreachable sandbox); callers treat that as
 * infra trouble, not "nothing to push". This is the diff source the push-time
 * Auditor (`prepare_push`) audits, so it matches what the gate scans byte for
 * byte. Pass a call-site's injected executor (e.g. a handler's
 * `ctx.execInSandbox`) when one is available.
 */
export function computeSandboxPushedDiff(
  sandboxId: string,
  execFn: SandboxExecFn = execInSandbox,
  opts?: { ref?: string; remote?: string; getGitHubToken?: GitHubTokenProvider },
): Promise<string | null> {
  return computePushedDiff(makeSandboxGitExec(sandboxId, execFn, opts?.getGitHubToken), opts);
}

/**
 * Compute the ref-only push plan for a sandbox — what the next `git push` would
 * do (create / fast-forward / force / skip) plus origin's live tip as the
 * force-with-lease value — resolved through the same auth-injecting `GitExec`
 * port the backend uses (so `ls-remote` against origin carries the GitHub
 * token). Side-effect-free. `prepare_push` uses it to block a diverged push and
 * to pin the lease; the approval check re-reads the live tip the same way to
 * detect a remote that moved between review and push.
 */
export function computeSandboxPushPlan(
  sandboxId: string,
  execFn: SandboxExecFn = execInSandbox,
  opts?: { ref?: string; remote?: string; getGitHubToken?: GitHubTokenProvider },
): Promise<PushPlan> {
  return computePushPlan(makeSandboxGitExec(sandboxId, execFn, opts?.getGitHubToken), {
    ref: opts?.ref,
    remote: opts?.remote,
  });
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
    /**
     * Gate the push behind the model Auditor over the cumulative push diff
     * (Gate-at-Push Move A). The caller injects `audit` (built over the real
     * Auditor runner — the same diff source, `computePushedDiff`, is wired here)
     * and the resolved `enabled` flag. Composed last so the cheap deterministic
     * gates (Protect Main, secret scan) short-circuit before an LLM call.
     */
    auditAtPush?: {
      audit: (diff: string) => Promise<AuditorPushVerdict>;
      enabled?: boolean;
    };
    getGitHubToken?: GitHubTokenProvider;
  },
): PushGit {
  const exec = makeSandboxGitExec(sandboxId, opts?.execFn ?? execInSandbox, opts?.getGitHubToken);
  const backend = new SandboxPlumbingBackend(exec, {
    lockScope: gitWorkingCopyLockScope(sandboxId),
  });
  const prePush = buildPushPrePushGate({
    prePush: opts?.prePush,
    protectMain: opts?.protectMain,
    defaultBranch: opts?.defaultBranch,
    getCurrentBranch: () => backend.currentBranch(),
    secretScan: opts?.secretScan,
    getPushedDiff: (pushOpts) => computePushedDiff(exec, pushOpts),
    auditAtPush: opts?.auditAtPush,
  });
  return new PushGit({
    backend,
    preCommit: opts?.preCommit,
    prePush,
  });
}
