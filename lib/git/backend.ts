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

import { parseGitStatusInfo, type GitStatusInfo } from './status.js';

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Transport/exec-layer error detail (e.g. an unreachable / gone sandbox),
   * surfaced by adapters when the executor reports one out-of-band. Callers
   * that detect such conditions (cold-resume / expiry recovery) read it.
   */
  error?: string;
}

export interface GitExecOptions {
  /**
   * Hint that this invocation mutates the workspace. The sandbox adapter maps
   * it to `markWorkspaceMutated` (bumps the workspace revision / invalidates
   * caches); the local CLI adapter ignores it. Read-only calls omit it.
   */
  mutates?: boolean;
}

/**
 * Runs `git <args>` and resolves with its result. Adapters must resolve,
 * not reject — both command *failures* (non-zero exit) and transport/exec
 * errors are converted to a `GitExecResult` (the latter with a non-zero
 * exit). This lets the backend's typed reads return null on any failure
 * instead of throwing at call-sites.
 */
export type GitExec = (args: string[], opts?: GitExecOptions) => Promise<GitExecResult>;

/** Result of a sanctioned write — the raw exec result plus an `ok` flag. */
export interface GitWriteResult extends GitExecResult {
  ok: boolean;
  /**
   * True when a `PushGit` gate (e.g. the pre-push secret scan) denied the write
   * before it reached git. Lets callers distinguish a policy block from a real
   * git/transport failure (and not, e.g., trigger sandbox-recovery on a block).
   */
  blocked?: boolean;
  /**
   * Set when a gate blocked on transient infra trouble rather than a real policy
   * violation (e.g. the Auditor backend was unreachable). Carried up from the
   * gate's `PrePushVerdict.retryable` so callers map it to a retryable structured
   * error instead of a terminal block — never lump infra trouble into the
   * verdict bucket (CLAUDE.md).
   */
  retryable?: boolean;
}

export interface GitBackend {
  /** Current branch name, or null when detached / not a repo / error. */
  currentBranch(): Promise<string | null>;
  /** Upstream ref for the current branch (e.g. `origin/feature/x`), or null when unset / unreadable. */
  upstreamRef(): Promise<string | null>;
  /** HEAD commit sha (full, or abbreviated with `short`), or null on error. */
  headSha(opts?: { short?: boolean }): Promise<string | null>;
  /** Typed working-tree status, or null on error / not a repo. */
  status(): Promise<GitStatusInfo | null>;

  // --- Sanctioned writes (the only mutations the backend exposes; merge /
  // reset / rebase / cherry-pick are policy-blocked and never surfaced).
  //
  // Ref/branch/path arguments are passed through as-is. Callers MUST validate
  // them (e.g. `isInvalidGitRef`) before calling — the sandbox adapter
  // shell-escapes argv so there is no shell-injection surface, but it does not
  // validate ref *semantics* (e.g. a leading `-` that git would read as a
  // flag). Validation stays a caller concern to keep this layer transport-only.
  // ---

  /** Create and switch to `name` (atomic `checkout -b`), optionally from a ref. */
  createBranch(name: string, from?: string): Promise<GitWriteResult>;
  /** Switch to `branch`, with a depth-1 fetch fallback for shallow clones. */
  switchBranch(branch: string): Promise<GitWriteResult>;
  /**
   * Stage and commit. `addArgs` are the `git add` arguments (default `-A`);
   * pass surface-specific forms (e.g. the CLI's `-A -- . :!.push`, or explicit
   * pathspecs) when staging differs.
   */
  commit(message: string, opts?: { addArgs?: string[] }): Promise<GitWriteResult>;
  /** Push (`git push [-u] <remote> <ref>`; defaults to `origin HEAD`). */
  push(opts?: { setUpstream?: boolean; remote?: string; ref?: string }): Promise<GitWriteResult>;
}

function toWriteResult(res: GitExecResult): GitWriteResult {
  return { ...res, ok: res.exitCode === 0 };
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
    // `git branch --show-current` returns the branch name — including an
    // unborn branch with no commits yet — and an empty string when detached,
    // which is exactly the normalized contract. (`rev-parse --abbrev-ref
    // HEAD` would print `HEAD` when detached and fail on an unborn branch,
    // losing the name in a freshly-initialized repo.)
    const res = await this.exec(['branch', '--show-current']);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim() || null;
  }

  async upstreamRef(): Promise<string | null> {
    const res = await this.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (res.exitCode !== 0) return null;
    return res.stdout.trim() || null;
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

  async createBranch(name: string, from?: string): Promise<GitWriteResult> {
    // Atomic `checkout -b` only moves HEAD on success.
    const args = from ? ['checkout', '-b', name, from] : ['checkout', '-b', name];
    return toWriteResult(await this.exec(args, { mutates: true }));
  }

  async switchBranch(branch: string): Promise<GitWriteResult> {
    // `git switch` is branch-only (a path collision fails fast instead of a
    // silent path-mode checkout). Fall back to a depth-1 fetch when the bare
    // switch fails: shallow clones (`--depth=1 --single-branch`) only have the
    // create-time branch locally, so other remote branches need fetching first.
    let res = await this.exec(['switch', branch], { mutates: true });
    if (res.exitCode !== 0) {
      const fetched = await this.exec(
        ['fetch', '--depth=1', 'origin', `${branch}:refs/remotes/origin/${branch}`],
        { mutates: true },
      );
      if (fetched.exitCode === 0) {
        res = await this.exec(['switch', branch], { mutates: true });
      } else {
        res = fetched;
      }
    }
    return toWriteResult(res);
  }

  async commit(message: string, opts?: { addArgs?: string[] }): Promise<GitWriteResult> {
    const addArgs = opts?.addArgs ?? ['-A'];
    const staged = await this.exec(['add', ...addArgs], { mutates: true });
    if (staged.exitCode !== 0) return toWriteResult(staged);
    return toWriteResult(await this.exec(['commit', '-m', message], { mutates: true }));
  }

  async push(opts?: {
    setUpstream?: boolean;
    remote?: string;
    ref?: string;
  }): Promise<GitWriteResult> {
    const remote = opts?.remote ?? 'origin';
    const ref = opts?.ref ?? 'HEAD';
    const args = opts?.setUpstream ? ['push', '-u', remote, ref] : ['push', remote, ref];
    return toWriteResult(await this.exec(args, { mutates: true }));
  }
}
