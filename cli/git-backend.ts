/**
 * CLI-surface adapter for the shared GitBackend.
 *
 * Wires the argv-based `GitExec` port to a local `execFile('git', …)` so the
 * CLI reads git through the same typed backend as the web surface — no shell,
 * argv passed straight to git. Command failures (non-zero exit) are caught
 * and surfaced as a `GitExecResult` with the exit code rather than a throw,
 * which is the contract `GitBackend` expects.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SandboxPlumbingBackend, type GitBackend, type GitExec } from '../lib/git/backend.js';
import { PushGit, type PreCommitGate } from '../lib/git/push-git.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5000;

export function createLocalGitBackend(cwd: string, opts?: { timeoutMs?: number }): GitBackend {
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The `mutates` hint is sandbox-only (workspace-revision bump); the local
  // working tree needs no equivalent, so it is ignored here.
  const exec: GitExec = async (args, _opts) => {
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
  return new SandboxPlumbingBackend(exec);
}

/**
 * Build a PushGit facade over the local working tree at `cwd`. An optional
 * `preCommit` gate is run by `PushGit.commit` before the commit lands — the
 * CLI uses this to wire the Auditor commit gate (see `makeAuditorPreCommitGate`
 * in `cli/tools.ts`).
 */
export function createLocalPushGit(
  cwd: string,
  opts?: { timeoutMs?: number; preCommit?: PreCommitGate },
): PushGit {
  return new PushGit({
    backend: createLocalGitBackend(cwd, { timeoutMs: opts?.timeoutMs }),
    preCommit: opts?.preCommit,
  });
}
