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

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 5000;

export function createLocalGitBackend(cwd: string, opts?: { timeoutMs?: number }): GitBackend {
  const timeout = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec: GitExec = async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
        // execFile sets a numeric exit code on command failure, or a string
        // like 'ENOENT' when git can't be spawned — normalize the latter to 1.
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  };
  return new SandboxPlumbingBackend(exec);
}
