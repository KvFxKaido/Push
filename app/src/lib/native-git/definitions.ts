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

  // -- Checkpoint operations (CheckpointStore native backend) ----------------
  // These operate on an app-private backup repo (auto-`git init`-ed on first
  // use), separate from any session working copy. See
  // `app/src/lib/checkpoint/native-jgit-store.ts`.

  /**
   * Extract a ZIP (base64) into `dir`'s worktree (clearing prior worktree
   * content but keeping `.git`), `git add -A` (delete-faithful), and commit.
   * `committed` is false when the tree was identical to HEAD (nothing to commit);
   * `commitId` is the resulting HEAD either way (null on error, with `message`).
   */
  commitWorkingTree(options: {
    dir: string;
    archiveBase64: string;
    message: string;
  }): Promise<{ committed: boolean; commitId: string | null; message?: string }>;

  /** A checkpoint commit's tree as a base64 ZIP, or null when not found. */
  archiveCommit(options: {
    dir: string;
    commitId: string;
  }): Promise<{ archiveBase64: string | null }>;

  /** Checkpoint history (the repo's `git log`), newest first. */
  listCheckpoints(options: { dir: string }): Promise<{
    checkpoints: Array<{ commitId: string; message: string; timestampMs: number }>;
  }>;

  /** Retain the newest `keep` checkpoints; drop the rest. Returns how many were pruned. */
  pruneCheckpoints(options: { dir: string; keep: number }): Promise<{ pruned: number }>;

  /**
   * Content-only manifest (`path -> blob SHA-1`) of the newest checkpoint's tree —
   * the base for a diff capture. Empty when there is no checkpoint yet. Blob ids
   * are content hashes (mode excluded), to agree with the sandbox's raw-bytes
   * manifest. (Diff transport — see docs/decisions/Native Checkpoint Store.md.)
   */
  listManifest(options: { dir: string }): Promise<{ manifest: Record<string, string> }>;

  /**
   * Apply a capture delta onto the worktree (no clear: extract changed files,
   * remove `deletedPaths`, handling dir<->file transitions) and commit an orphan
   * checkpoint — but only after the applied tree is verified against
   * `expectedManifest` (the sandbox's current content manifest); a mismatch
   * publishes NO ref. `committed=false` + null `commitId` means no base / verify
   * failed / threw (caller must full-capture); `committed=false` + a `commitId`
   * means the delta de-duped to the newest checkpoint (no change).
   */
  commitDelta(options: {
    dir: string;
    deltaArchiveBase64: string;
    deletedPaths: string[];
    expectedManifest: Record<string, string>;
    message: string;
  }): Promise<{ committed: boolean; commitId: string | null; treeId: string | null }>;
}
