/**
 * Workspace identity helpers.
 *
 * Context-memory records are scoped by `repoFullName` and `branch`.
 * In Node environments, they come from git. In Browser/Worker environments,
 * they fall back to defaults unless provided.
 */

export interface WorkspaceIdentity {
  repoFullName: string;
  branch: string | null;
}

/**
 * Parse a git remote URL into `owner/repo` form. Handles:
 *   - https://github.com/owner/repo(.git)?
 *   - git@github.com:owner/repo(.git)?
 *   - ssh://git@github.com/owner/repo(.git)?
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
 * Resolve the workspace's git identity.
 * Environment-aware: uses node:child_process in Node, returns default in others.
 */
export async function resolveWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;

  if (!isNode) {
    return { repoFullName: 'unknown', branch: null };
  }

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const path = await import('node:path');
    const execFileAsync = promisify(execFile);

    const execGit = async (args: string[]) => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    };

    const [remoteUrl, branchRaw] = await Promise.all([
      execGit(['remote', 'get-url', 'origin']),
      execGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);

    const parsed = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
    const repoFullName = parsed ?? path.basename(cwd) ?? 'unknown';
    const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;

    return { repoFullName, branch };
  } catch {
    return { repoFullName: 'unknown', branch: null };
  }
}
