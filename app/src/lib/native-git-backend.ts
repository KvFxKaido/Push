/**
 * Mobile-surface `GitBackend` over the on-device JGit engine.
 *
 * This is the third `GitBackend` implementation, alongside the sandbox/CLI
 * `SandboxPlumbingBackend`. Where those run argv through a `GitExec` (a real
 * `git` process or a shell-exec over the sandbox), the mobile shell has no
 * `git` binary — it drives JGit through the typed `NativeGit` Capacitor plugin.
 * Implementing `GitBackend` directly (rather than faking a `GitExec`) keeps the
 * bridge typed end-to-end and avoids an argv round-trip with no `git` to parse
 * it on the other side.
 *
 * Everything above this layer is reused unchanged: `PushGit`'s commit/push
 * gates, and the working-copy serialization lock (via the shared
 * {@link createWorkingCopyLock} — the lock the sandbox backend uses too). The
 * lock scope is the on-device working-copy directory, so concurrent writes to
 * one local clone serialize exactly as they do on a sandbox.
 */

import {
  type GitBackend,
  type GitWriteResult,
  type WorkingCopyLock,
  type WriteLockContext,
  createWorkingCopyLock,
} from '@push/lib/git/backend';
import { gitWorkingCopyLockScope } from '@push/lib/git/repo-lock';
import { parseGitStatusInfo, type GitStatusInfo } from '@push/lib/git/status';
import type { NativeGitPlugin, NativeGitWriteResult } from './native-git/definitions';

/** Token provider for network ops; returns the active GitHub token or undefined. */
export type GitHubTokenProvider = () => string | undefined;

export interface NativeGitBackendOptions {
  /** Absolute on-device working-copy directory (the local clone). */
  dir: string;
  /** Supplies a GitHub token for push (private repos); omit for public/no-auth. */
  getToken?: GitHubTokenProvider;
}

/** Map the plugin's `{ ok, message }` onto the shared `GitWriteResult` shape. */
function toWriteResult(res: NativeGitWriteResult): GitWriteResult {
  return {
    ok: res.ok,
    exitCode: res.ok ? 0 : 1,
    stdout: res.ok ? (res.message ?? '') : '',
    stderr: res.ok ? '' : (res.message ?? ''),
  };
}

/** Convert a thrown bridge/transport error into a failed `GitWriteResult`. */
function writeError(err: unknown): GitWriteResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, exitCode: 1, stdout: '', stderr: message, error: message };
}

export class NativeGitBackend implements GitBackend {
  private readonly plugin: NativeGitPlugin;
  private readonly dir: string;
  private readonly getToken?: GitHubTokenProvider;
  private readonly lock: WorkingCopyLock;

  constructor(plugin: NativeGitPlugin, opts: NativeGitBackendOptions) {
    this.plugin = plugin;
    this.dir = opts.dir;
    this.getToken = opts.getToken;
    // Same lock the sandbox backend uses; keyed by the on-device working copy.
    this.lock = createWorkingCopyLock(gitWorkingCopyLockScope(opts.dir));
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.lock.runExclusive(task);
  }

  // -- Reads (null on any failure, per the GitBackend contract) --------------

  async currentBranch(): Promise<string | null> {
    try {
      return (await this.plugin.currentBranch({ dir: this.dir })).branch;
    } catch {
      return null;
    }
  }

  async upstreamRef(): Promise<string | null> {
    try {
      return (await this.plugin.upstreamRef({ dir: this.dir })).ref;
    } catch {
      return null;
    }
  }

  async remoteUrl(remote = 'origin', opts?: { push?: boolean }): Promise<string | null> {
    try {
      return (await this.plugin.remoteUrl({ dir: this.dir, remote, push: opts?.push })).url;
    } catch {
      return null;
    }
  }

  async headSha(opts?: { short?: boolean }): Promise<string | null> {
    try {
      return (await this.plugin.headSha({ dir: this.dir, short: opts?.short })).sha;
    } catch {
      return null;
    }
  }

  async status(): Promise<GitStatusInfo | null> {
    try {
      const { porcelain } = await this.plugin.status({ dir: this.dir });
      return parseGitStatusInfo(porcelain);
    } catch {
      return null;
    }
  }

  // -- Sanctioned writes (serialized; gated by PushGit above) ----------------

  async createBranch(name: string, from?: string): Promise<GitWriteResult> {
    return this.runExclusive(async () => {
      try {
        return toWriteResult(await this.plugin.createBranch({ dir: this.dir, name, from }));
      } catch (err) {
        return writeError(err);
      }
    });
  }

  async switchBranch(branch: string): Promise<GitWriteResult> {
    return this.runExclusive(async () => {
      try {
        const first = toWriteResult(await this.plugin.switchBranch({ dir: this.dir, branch }));
        if (first.ok) return first;
        // Shallow / single-branch clones (created with `depth` or only the
        // initial branch) may not have the target branch locally yet. Fetch it
        // (depth 1) then retry — matching SandboxPlumbingBackend.switchBranch so
        // the native backend honors the same contract.
        const fetched = toWriteResult(
          await this.plugin.fetch({
            dir: this.dir,
            remote: 'origin',
            refspec: `${branch}:refs/remotes/origin/${branch}`,
            depth: 1,
            token: this.getToken?.(),
          }),
        );
        if (!fetched.ok) return fetched;
        const retried = toWriteResult(await this.plugin.switchBranch({ dir: this.dir, branch }));
        if (retried.ok) return retried;
        // JGit's bare checkout has no create-from-remote guess at all — a
        // fetched refs/remotes/origin/<branch> never satisfies it. Create the
        // local branch from the remote-tracking ref explicitly. If the create
        // also fails (e.g. the branch DID exist locally and the switch failed
        // for another reason), surface the switch failure — it's the
        // informative one.
        try {
          const created = toWriteResult(
            await this.plugin.createBranch({
              dir: this.dir,
              name: branch,
              from: `refs/remotes/origin/${branch}`,
            }),
          );
          return created.ok ? created : retried;
        } catch {
          return retried;
        }
      } catch (err) {
        return writeError(err);
      }
    });
  }

  async commit(
    message: string,
    _opts?: { addArgs?: string[] },
    lock?: WriteLockContext,
  ): Promise<GitWriteResult> {
    // `addArgs` is a CLI-specific pathspec form; the native engine stages all
    // tracked + untracked changes (addAll), matching the web default of `-A`.
    return this.lock.maybeExclusive(lock, async () => {
      try {
        return toWriteResult(await this.plugin.commit({ dir: this.dir, message, addAll: true }));
      } catch (err) {
        return writeError(err);
      }
    });
  }

  async push(
    opts?: { setUpstream?: boolean; remote?: string; ref?: string },
    lock?: WriteLockContext,
  ): Promise<GitWriteResult> {
    return this.lock.maybeExclusive(lock, async () => {
      try {
        return toWriteResult(
          await this.plugin.push({
            dir: this.dir,
            remote: opts?.remote,
            ref: opts?.ref,
            setUpstream: opts?.setUpstream,
            // Inject the token transiently for this push only.
            token: this.getToken?.(),
          }),
        );
      } catch (err) {
        return writeError(err);
      }
    });
  }
}
