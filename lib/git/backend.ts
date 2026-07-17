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

import { withRepoLock } from './repo-lock.js';
import { parseGitStatusInfo, type GitStatusInfo } from './status.js';
import type { RuntimeIntervention } from '../runtime-intervention.js';

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
  /** Typed runtime decision that denied the write, when the gate supplies one. */
  runtimeIntervention?: RuntimeIntervention;
}

/**
 * Tells a write it is already running inside its working-copy critical section,
 * so it must NOT re-acquire the lock (which is non-reentrant and would
 * self-deadlock). A composing layer that needs a gate + write to be atomic
 * (`PushGit`) takes the lock once via {@link GitBackend.runExclusive} and passes
 * this to the inner `commit`/`push`.
 */
export interface WriteLockContext {
  alreadyLocked?: boolean;
}

export interface GitBackend {
  /**
   * Run `task` inside this backend's working-copy critical section. When a
   * `lockScope` is configured, it acquires the same lock the sanctioned writes
   * use; otherwise it runs `task` directly. Composed operations that must be
   * atomic against concurrent executors — notably `PushGit`'s pre-push gate +
   * push, where a racing commit must not move HEAD between the audit and the
   * push — wrap the whole sequence here, then pass `{ alreadyLocked: true }` to
   * the inner `commit`/`push` so it doesn't re-acquire the (non-reentrant) lock.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
  /** Current branch name, or null when detached / not a repo / error. */
  currentBranch(): Promise<string | null>;
  /** Upstream ref for the current branch (e.g. `origin/feature/x`), or null when unset / unreadable. */
  upstreamRef(): Promise<string | null>;
  /**
   * URL for a remote (default `origin`) — the resolved remote *identity*, not
   * the symbolic ref name. Pass `{ push: true }` to read the actual push URL
   * (`git remote get-url --push`), which honors `remote.<name>.pushurl`.
   * Null when the remote is unset / unreadable. `upstreamRef` can stay
   * `origin/foo` across a remote repoint, so this is the read that catches
   * origin being aimed at another repo.
   */
  remoteUrl(remote?: string, opts?: { push?: boolean }): Promise<string | null>;
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
   * pathspecs) when staging differs. `lock` lets a caller that already holds the
   * working-copy lock (via `runExclusive`) skip re-acquiring it.
   */
  commit(
    message: string,
    opts?: { addArgs?: string[] },
    lock?: WriteLockContext,
  ): Promise<GitWriteResult>;
  /**
   * Push (`git push [-u] <remote> <ref>`; defaults to `origin HEAD`). `lock`
   * lets a caller already holding the working-copy lock skip re-acquiring it.
   */
  push(
    opts?: { setUpstream?: boolean; remote?: string; ref?: string },
    lock?: WriteLockContext,
  ): Promise<GitWriteResult>;
}

function toWriteResult(res: GitExecResult): GitWriteResult {
  return { ...res, ok: res.exitCode === 0 };
}

/**
 * The working-copy critical section, shared by every `GitBackend`
 * implementation (the sandbox/CLI `SandboxPlumbingBackend` and the mobile
 * `NativeGitBackend`) so the lock semantics live in one place. `runExclusive`
 * takes the lock for `lockScope` (or runs inline when unscoped);
 * `maybeExclusive` skips re-acquiring when the caller already holds it (the
 * `PushGit` gate+write span). Promote-to-`lib`-on-second-surface, per the
 * cross-surface checklist — `NativeGitBackend` was that second surface.
 */
export interface WorkingCopyLock {
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
  maybeExclusive<T>(lock: WriteLockContext | undefined, task: () => Promise<T>): Promise<T>;
}

export function createWorkingCopyLock(lockScope: string | undefined): WorkingCopyLock {
  const runExclusive = <T>(task: () => Promise<T>): Promise<T> =>
    lockScope ? withRepoLock(lockScope, task) : task();
  return {
    runExclusive,
    maybeExclusive: (lock, task) => (lock?.alreadyLocked ? task() : runExclusive(task)),
  };
}

/** Construction options for {@link SandboxPlumbingBackend}. */
export interface SandboxPlumbingBackendOptions {
  /**
   * Working-copy lock scope (build it with `gitWorkingCopyLockScope` from
   * `./repo-lock.ts`). When set, the sanctioned *writes* — `createBranch`,
   * `switchBranch`, `commit`, `push` — run under {@link withRepoLock} so two
   * executors sharing one working copy (a sandbox id on web, a repo path on
   * CLI) can't race `.git/index.lock` or interleave a stage with another
   * commit. Every backend over the same working copy MUST pass the *same*
   * scope string to share the lane. Omitted (e.g. read-normalization unit
   * tests) means writes run unserialized, exactly as before.
   *
   * Only writes are serialized: reads are designed to run in parallel (the
   * per-turn read cap) and a read that races a write already resolves to null
   * via the GitExec null-on-failure contract — it can't corrupt the index.
   * The lock is in-process (a module-level registry); it serializes concurrent
   * ops within one isolate/daemon, the realistic race here. Cross-isolate
   * coordination against one sandbox relies on the working copy's own
   * single-writer nature and higher-level routing (e.g. the single-threaded
   * coder-job DO), not this lock.
   */
  lockScope?: string;
}

/**
 * GitBackend implementation that runs git plumbing/porcelain through an
 * injected `GitExec`. Named "plumbing" because it favors stable,
 * machine-readable forms (`rev-parse`, `--porcelain`) over human output.
 */
export class SandboxPlumbingBackend implements GitBackend {
  private readonly exec: GitExec;
  private readonly lock: WorkingCopyLock;

  constructor(exec: GitExec, opts?: SandboxPlumbingBackendOptions) {
    this.exec = exec;
    this.lock = createWorkingCopyLock(opts?.lockScope);
  }

  /**
   * Run a whole logical write under the working-copy lock (see
   * {@link createWorkingCopyLock}). Each write method wraps its *entire* git
   * sequence (e.g. `commit`'s add+commit, `switchBranch`'s fetch-fallback+
   * switch) in one call so the sequence is indivisible — never a per-exec lock,
   * which would leave the gap between staging and commit open to interleaving.
   *
   * Public so a composing layer (`PushGit`) can hold this same critical section
   * across a gate + write; that caller passes `{ alreadyLocked: true }` to the
   * inner write so the (non-reentrant) lock isn't re-acquired.
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.lock.runExclusive(task);
  }

  /** Run `task` under the lock unless the caller already holds it. */
  private maybeExclusive<T>(
    lock: WriteLockContext | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.lock.maybeExclusive(lock, task);
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

  async remoteUrl(remote = 'origin', opts?: { push?: boolean }): Promise<string | null> {
    const args = opts?.push
      ? ['remote', 'get-url', '--push', remote]
      : ['remote', 'get-url', remote];
    const res = await this.exec(args);
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
    return this.runExclusive(async () => {
      // Atomic `checkout -b` only moves HEAD on success.
      const args = from ? ['checkout', '-b', name, from] : ['checkout', '-b', name];
      return toWriteResult(await this.exec(args, { mutates: true }));
    });
  }

  async switchBranch(branch: string): Promise<GitWriteResult> {
    return this.runExclusive(async () => {
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
    });
  }

  async commit(
    message: string,
    opts?: { addArgs?: string[] },
    lock?: WriteLockContext,
  ): Promise<GitWriteResult> {
    return this.maybeExclusive(lock, async () => {
      const addArgs = opts?.addArgs ?? ['-A'];
      const staged = await this.exec(['add', ...addArgs], { mutates: true });
      if (staged.exitCode !== 0) return toWriteResult(staged);
      return toWriteResult(await this.exec(['commit', '-m', message], { mutates: true }));
    });
  }

  async push(
    opts?: {
      setUpstream?: boolean;
      remote?: string;
      ref?: string;
    },
    lock?: WriteLockContext,
  ): Promise<GitWriteResult> {
    return this.maybeExclusive(lock, async () => {
      const remote = opts?.remote ?? 'origin';
      const ref = opts?.ref ?? 'HEAD';
      const args = opts?.setUpstream ? ['push', '-u', remote, ref] : ['push', remote, ref];
      return toWriteResult(await this.exec(args, { mutates: true }));
    });
  }
}
