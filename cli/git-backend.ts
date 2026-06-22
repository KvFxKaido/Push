/**
 * CLI-surface adapter for the shared GitBackend.
 *
 * Wires the argv-based `GitExec` port to a local `execFile('git', …)` so the
 * CLI reads git through the same typed backend as the web surface — no shell,
 * argv passed straight to git. Command failures (non-zero exit) are caught
 * and surfaced as a `GitExecResult` with the exit code rather than a throw,
 * which is the contract `GitBackend` expects.
 */

import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { SandboxPlumbingBackend, type GitBackend, type GitExec } from '../lib/git/backend.js';
import { gitWorkingCopyLockScope } from '../lib/git/repo-lock.js';
import {
  PushGit,
  composePrePushGates,
  type PreCommitGate,
  type PrePushGate,
} from '../lib/git/push-git.js';
import { computePushedDiff } from '../lib/git/pushed-diff.js';
import { makeSecretScanPrePushGate } from '../lib/git/secret-scan-gate.js';
import { makeProtectMainPrePushGate } from '../lib/git/protect-main-gate.js';
import { resolveSecretScanEnabled } from '../lib/secret-scan.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Build a `GitExec` bound to `cwd` that shells out to local git via
 * `execFile` (no shell, argv passed straight through). Exported so CLI-local
 * git plumbing that the typed `GitBackend` doesn't cover — e.g. worktree
 * management in `cli/worktree.ts` — runs through the same escaped, timeout-aware
 * path instead of re-spawning git ad hoc.
 */
export function makeLocalGitExec(cwd: string, timeout: number): GitExec {
  // The `mutates` hint is sandbox-only (workspace-revision bump); the local
  // working tree needs no equivalent, so it is ignored here.
  return async (args, _opts) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      const message = err instanceof Error ? err.message : String(err);
      // execFile sets a numeric exit code on a normal git failure, or a string
      // like 'ENOENT' (or none, on timeout) when git can't be spawned.
      const isGitExit = typeof e.code === 'number';
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? message,
        exitCode: isGitExit ? (e.code as number) : 1,
        // Reserve `error` for spawn/transport failures — a normal non-zero git
        // exit is conveyed by stderr + exitCode, so callers prefer git's stderr.
        error: isGitExit ? undefined : message,
      };
    }
  };
}

/**
 * Resolve the lock key for the working copy containing `cwd`. The key is the
 * Git **working tree root** (`git rev-parse --show-toplevel`), not the
 * invocation directory: two sessions rooted at different subdirs of one working
 * copy — say `/repo` and `/repo/packages/app` — mutate the same `.git/index`
 * and HEAD, so they must share a lock lane. Each linked worktree has its own
 * toplevel and index, so `--show-toplevel` (not the shared common git dir) is
 * the correct identity. Falls back to the resolved `cwd` when `cwd` isn't in a
 * repo or git can't be spawned — an unmanaged dir simply keys by its own path.
 */
function resolveWorkingCopyLockScope(cwd: string, timeout: number): string {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout,
      encoding: 'utf8',
    }).trim();
    if (root) return gitWorkingCopyLockScope(root);
  } catch {
    // Not a git repo, or git unavailable — fall through to the path-based key.
  }
  return gitWorkingCopyLockScope(path.resolve(cwd));
}

export function createLocalGitBackend(cwd: string, opts?: { timeoutMs?: number }): GitBackend {
  // Lock by the working-tree root so every backend/PushGit over the same working
  // copy shares one lane, regardless of which subdir the session was rooted at.
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new SandboxPlumbingBackend(makeLocalGitExec(cwd, timeout), {
    lockScope: resolveWorkingCopyLockScope(cwd, timeout),
  });
}

/**
 * Build a PushGit facade over the local working tree at `cwd`. An optional
 * `preCommit` gate is run by `PushGit.commit` before the commit lands — the
 * CLI uses this to wire the Auditor commit gate (see `makeAuditorPreCommitGate`
 * in `cli/tools.ts`). Pass `secretScan: true` to gate pushes behind the
 * deterministic secret scan over the *uncapped* about-to-be-pushed diff; pass
 * `protectMain: true` (with `defaultBranch`) to refuse a push to the protected
 * branch at the boundary; pass `prePush` to inject a custom gate. Wired for
 * parity even though the CLI does not push today; `PUSH_SECRET_SCAN=0` opts out.
 */
export function createLocalPushGit(
  cwd: string,
  opts?: {
    timeoutMs?: number;
    preCommit?: PreCommitGate;
    prePush?: PrePushGate;
    secretScan?: boolean;
    protectMain?: boolean;
    defaultBranch?: string;
  },
): PushGit {
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = makeLocalGitExec(cwd, timeout);
  const backend = new SandboxPlumbingBackend(exec, {
    lockScope: resolveWorkingCopyLockScope(cwd, timeout),
  });
  const prePush =
    opts?.prePush ??
    composePrePushGates([
      opts?.protectMain
        ? makeProtectMainPrePushGate({
            enabled: true,
            defaultBranch: opts.defaultBranch,
            getCurrentBranch: () => backend.currentBranch(),
          })
        : undefined,
      opts?.secretScan
        ? makeSecretScanPrePushGate({
            getDiff: (pushOpts) => computePushedDiff(exec, pushOpts),
            enabled: resolveSecretScanEnabled({ env: process.env.PUSH_SECRET_SCAN }),
          })
        : undefined,
    ]);
  return new PushGit({
    backend,
    preCommit: opts?.preCommit,
    prePush,
  });
}
