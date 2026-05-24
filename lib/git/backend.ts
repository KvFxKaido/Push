/**
 * lib/git/backend.ts — the GitBackend abstraction and its sandbox/plumbing
 * implementation.
 *
 * `GitBackend` exposes typed, normalized git *reads*. It deliberately does
 * not own a sandbox or provider — it runs git through an injected `GitExec`
 * port, so the same backend works across surfaces: the web client
 * (`execInSandbox`), the CLI (`execFile('git', …)`), or any other executor.
 *
 * Normalization (per the PR 2 decision): the scattered read sites used
 * inconsistent git commands; the backend canonicalizes them — `currentBranch`
 * is the name or `null` when detached, `status` is one `GitStatusInfo`,
 * `headSha` takes a `short` flag. Consumers that need an exact legacy
 * string/wire shape adapt at their boundary rather than pushing that
 * inconsistency into this interface.
 *
 * The `GitExec` port is argv-based (the git arguments *after* `git`) so it
 * bridges a shell executor (join → `git <args>`) and `execFile('git', args)`
 * without a shell. The PR 2 reads pass only fixed flags — no caller data —
 * so a shell adapter needs no escaping; an adapter that forwards caller data
 * must quote it.
 */

import { parseGitStatusInfo, type GitStatusInfo } from './status.ts';

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs `git <args>` and resolves with its result. Adapters must resolve,
 * not reject — both command *failures* (non-zero exit) and transport/exec
 * errors are converted to a `GitExecResult` (the latter with a non-zero
 * exit). This lets the backend's typed reads return null on any failure
 * instead of throwing at call-sites.
 */
export type GitExec = (args: string[]) => Promise<GitExecResult>;

export interface GitBackend {
  /** Current branch name, or null when detached / not a repo / error. */
  currentBranch(): Promise<string | null>;
  /** HEAD commit sha (full, or abbreviated with `short`), or null on error. */
  headSha(opts?: { short?: boolean }): Promise<string | null>;
  /** Typed working-tree status, or null on error / not a repo. */
  status(): Promise<GitStatusInfo | null>;
}

/**
 * GitBackend implementation that runs git plumbing/porcelain through an
 * injected `GitExec`. Named "plumbing" because it favors stable,
 * machine-readable forms (`rev-parse`, `--porcelain`) over human output.
 */
export class SandboxPlumbingBackend implements GitBackend {
  private readonly exec: GitExec;

  constructor(exec: GitExec) {
    this.exec = exec;
  }

  async currentBranch(): Promise<string | null> {
    const res = await this.exec(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (res.exitCode !== 0) return null;
    const branch = res.stdout.trim();
    // `rev-parse --abbrev-ref HEAD` prints `HEAD` for a detached head; the
    // normalized contract is null there (no current branch).
    if (!branch || branch === 'HEAD') return null;
    return branch;
  }

  async headSha(opts?: { short?: boolean }): Promise<string | null> {
    const args = opts?.short ? ['rev-parse', '--short', 'HEAD'] : ['rev-parse', 'HEAD'];
    const res = await this.exec(args);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim() || null;
  }

  async status(): Promise<GitStatusInfo | null> {
    const res = await this.exec(['status', '--porcelain', '-b']);
    if (res.exitCode !== 0) return null;
    return parseGitStatusInfo(res.stdout);
  }
}
