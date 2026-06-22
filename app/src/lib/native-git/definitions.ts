/**
 * Typed contract for the on-device git engine (the `NativeGit` Capacitor
 * plugin, backed by JGit on Android).
 *
 * Why typed methods instead of an argv `GitExec` (the shape the web/CLI
 * adapters use): JGit has no command-line parser, so an argv port would force
 * us to re-derive structured intent from `['commit','-m',…]` inside Kotlin.
 * Typed methods are the natural JGit surface and a stable bridge. The one place
 * we deliberately return git-CLI text is `status` — emitting porcelain v1 lets
 * the TS side reuse the canonical `parseGitStatusInfo` parser unchanged, so the
 * native status and the sandbox/CLI status can never drift.
 *
 * Every method operates on an absolute on-device working-copy `dir`. Network
 * operations (`clone`/`fetch`/`push`) take an optional `token` — Push already
 * manages GitHub tokens, so the plugin receives one transiently per call and
 * never persists credentials (mirroring the web transport boundary).
 */

/** Result of a mutating op. `message` carries git's reason on failure. */
export interface NativeGitWriteResult {
  ok: boolean;
  message?: string;
}

export interface NativeGitCloneOptions {
  /** HTTPS remote URL (e.g. `https://github.com/owner/repo.git`). */
  url: string;
  /** Absolute on-device destination directory. */
  dir: string;
  /** Branch to check out after clone; defaults to the remote HEAD. */
  branch?: string;
  /** GitHub token for private repos; injected transiently, never stored. */
  token?: string;
  /** Shallow-clone depth; omit for a full clone. */
  depth?: number;
}

export interface NativeGitDirArg {
  dir: string;
}

export interface NativeGitPlugin {
  /** Clone `url` into `dir`. */
  clone(options: NativeGitCloneOptions): Promise<NativeGitWriteResult>;

  // -- Reads (null = unreadable / not a repo) --------------------------------
  /** Current branch name, or null when detached. */
  currentBranch(options: NativeGitDirArg): Promise<{ branch: string | null }>;
  /** Upstream ref (e.g. `origin/feature/x`), or null when unset. */
  upstreamRef(options: NativeGitDirArg): Promise<{ ref: string | null }>;
  /** Resolved URL for a remote (default `origin`), or null when unset. */
  remoteUrl(options: { dir: string; remote?: string; push?: boolean }): Promise<{
    url: string | null;
  }>;
  /** HEAD sha (full, or abbreviated with `short`), or null on error. */
  headSha(options: { dir: string; short?: boolean }): Promise<{ sha: string | null }>;
  /** Working-tree status as porcelain v1 with branch header (`--porcelain -b`). */
  status(options: NativeGitDirArg): Promise<{ porcelain: string }>;

  // -- Sanctioned writes -----------------------------------------------------
  /** Create and switch to `name`, optionally from a ref. */
  createBranch(options: {
    dir: string;
    name: string;
    from?: string;
  }): Promise<NativeGitWriteResult>;
  /** Switch to an existing `branch`. */
  switchBranch(options: { dir: string; branch: string }): Promise<NativeGitWriteResult>;
  /** Stage all changes and commit. */
  commit(options: {
    dir: string;
    message: string;
    addAll?: boolean;
  }): Promise<NativeGitWriteResult>;
  /** Push to `remote`/`ref` (defaults to `origin HEAD`). */
  push(options: {
    dir: string;
    remote?: string;
    ref?: string;
    setUpstream?: boolean;
    token?: string;
  }): Promise<NativeGitWriteResult>;
  /** Fetch from a remote. */
  fetch(options: {
    dir: string;
    remote?: string;
    refspec?: string;
    depth?: number;
    token?: string;
  }): Promise<NativeGitWriteResult>;
}
