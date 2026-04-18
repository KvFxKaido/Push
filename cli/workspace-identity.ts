/**
 * Workspace identity helpers for the daemon.
 *
 * Context-memory records are scoped by `repoFullName` and `branch`
 * (see `MemoryScope` in `lib/runtime-contract.ts`). On the web side
 * both fields come from the selected repo UI. On the daemon side
 * they come from git — `git remote get-url origin` parsed to
 * `owner/repo`, and `git rev-parse --abbrev-ref HEAD` for the
 * current branch.
 *
 * Fallbacks when git is unavailable or misconfigured:
 *   - `repoFullName`: `path.basename(cwd)` — preserves per-workspace
 *     scoping even for non-git directories.
 *   - `branch`: `null` — records land in the `__no_branch.jsonl`
 *     file at the store layer.
 *
 * These helpers are pure + cheap (one subprocess each), but the
 * callers cache them per-session where possible so heavy task
 * graphs don't invoke git dozens of times.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkspaceIdentity {
  repoFullName: string;
  branch: string | null;
}

async function execGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL into `owner/repo` form. Handles:
 *   - https://github.com/owner/repo(.git)?
 *   - git@github.com:owner/repo(.git)?
 *   - ssh://git@github.com/owner/repo(.git)?
 *   - any Gitea/GitLab/Bitbucket variant with the same shape
 *
 * Returns null when no `owner/repo` shape can be extracted.
 */
export function parseGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Strip `.git` suffix if present.
  const withoutDotGit = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;

  // SSH shorthand: git@host:owner/repo
  const sshMatch = withoutDotGit.match(/^[^@]+@[^:]+:([^/]+\/[^/]+)$/);
  if (sshMatch) return sshMatch[1];

  // URL form: scheme://host[:port]/owner/repo (at least two trailing segments)
  try {
    const parsed = new URL(withoutDotGit);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const [owner, ...rest] = segments.slice(-2);
      return `${owner}/${rest.join('/')}`;
    }
  } catch {
    // Not a URL — fall through.
  }

  return null;
}

/**
 * Resolve the workspace's git identity. Prefers `git remote get-url
 * origin` + `git rev-parse --abbrev-ref HEAD`. Falls back to
 * `path.basename(cwd)` with `branch: null` when git is unavailable
 * or the cwd is not a git repo.
 *
 * Never throws — errors become fallbacks so the daemon's memory
 * plumbing degrades gracefully.
 */
export async function resolveWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  const [remoteUrl, branchRaw] = await Promise.all([
    execGit(cwd, ['remote', 'get-url', 'origin']),
    execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);

  const parsed = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
  const repoFullName = parsed ?? path.basename(cwd) ?? 'unknown';

  // `rev-parse --abbrev-ref HEAD` returns "HEAD" in detached-head
  // state. Treat that as "no branch" so records go to
  // __no_branch.jsonl rather than creating a HEAD.jsonl file.
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;

  return { repoFullName, branch };
}
