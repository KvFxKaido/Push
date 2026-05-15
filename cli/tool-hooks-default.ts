/**
 * Default CLI-side `PreToolUse` hook registry.
 *
 * The shared lib factories (`createProtectMainPreHook`, …) live in
 * `lib/default-pre-hooks.ts`. The CLI registers only the rules whose
 * semantics apply locally:
 *
 *   - Protect Main: yes — the CLI's `git_commit` tool commits directly
 *     to the working tree, so the same default-branch-block rule fires
 *     for CLI `git_commit` as for web `sandbox_prepare_commit` /
 *     `sandbox_push`.
 *
 *   - Git guard: no — that rule enforces Push's web-side branch-
 *     tracking abstraction (keeping `currentBranch` in sync with sandbox
 *     HEAD). The CLI operates on the user's real working tree; users can
 *     run raw `git checkout` whenever they want. The web matcher would
 *     not fire on CLI tool names (`exec` vs `sandbox_exec`) anyway, but
 *     skipping the registration here makes the intent explicit.
 *
 * Branch reads route through `git branch --show-current` in the
 * workspace root via `getCurrentBranch` on the hook context — wired at
 * the call site in `cli/tools.ts`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createProtectMainPreHook } from '../lib/default-pre-hooks.ts';
import { createToolHookRegistry, type ToolHookRegistry } from '../lib/tool-hooks.ts';

const execFileAsync = promisify(execFile);

export function getDefaultCliHookRegistry(): ToolHookRegistry {
  const registry = createToolHookRegistry();
  registry.pre.push(createProtectMainPreHook());
  return registry;
}

/**
 * Read the current git branch in the given workspace. Returns null on
 * any failure (no git repo, detached HEAD, command unavailable) — the
 * hook treats `null` as "couldn't determine" and fails safe by blocking.
 */
export async function readCliCurrentBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: workspaceRoot,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}
