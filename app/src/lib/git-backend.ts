/**
 * Web-surface adapter for the shared GitBackend.
 *
 * Wires the argv-based `GitExec` port to the sandbox executor so web
 * call-sites read git through the typed backend instead of bespoke
 * command-string + parse logic. The PR 2 reads pass only fixed flags, so
 * joining argv into `git <args>` needs no shell escaping.
 */

import { SandboxPlumbingBackend, type GitBackend, type GitExec } from '@push/lib/git/backend';
import { execInSandbox, type ExecResult } from './sandbox-client';

type SandboxExecFn = (sandboxId: string, command: string) => Promise<ExecResult>;

/**
 * Build a GitBackend bound to a sandbox. Defaults to the module-level
 * `execInSandbox`; pass a custom executor (e.g. a tool-handler's injected
 * `ctx.execInSandbox`) when the call-site already has one. Commands run in
 * the sandbox's default workdir (`/workspace`).
 */
export function createSandboxGitBackend(
  sandboxId: string,
  execFn: SandboxExecFn = execInSandbox,
): GitBackend {
  const exec: GitExec = async (args) => {
    const res = await execFn(sandboxId, `git ${args.join(' ')}`);
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  };
  return new SandboxPlumbingBackend(exec);
}
