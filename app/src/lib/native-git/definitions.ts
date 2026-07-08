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
  /** Working-tree diff against HEAD, plus porcelain status for diagnostics. */
  diff(options: NativeGitDirArg): Promise<{
    diff: string;
    truncated: boolean;
    git_status?: string;
    error?: string;
  }>;
  /** Verify/resolve a ref (branch, remote ref, sha, HEAD), or null when absent. */
  revParse(options: { dir: string; ref: string }): Promise<{ sha: string | null }>;
  /** Merge-base of two refs, or null when not computable. */
  mergeBase(options: { dir: string; a: string; b: string }): Promise<{ sha: string | null }>;
  /** Per-commit patch series for a rev/range, uncapped; null when unreadable. */
  logPatch(options: { dir: string; range: string }): Promise<{ patch: string | null }>;
  /** Live remote branch tip; ok=false means the remote read failed. */
  lsRemoteHead(options: {
    dir: string;
    remote?: string;
    branch: string;
    token?: string;
  }): Promise<{ ok: boolean; sha: string | null }>;

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

  // -- Working-copy filesystem ops -------------------------------------------
  // Read/write/list files inside a session working copy (the on-device clone).
  // Plain file I/O (java.io.File), NOT git — the session's non-git tools
  // (`sandbox_read_file` / `_write_file` / `_list_dir`) route here on native
  // instead of the cloud sandbox HTTP API. Every op is scoped to `dir` (the
  // clone root); `path` is relative to it. Result shapes mirror the local-daemon
  // FS helpers so the dispatcher formats native and daemon results identically.

  /**
   * Read `path` (relative to `dir`), optionally a 1-based inclusive line window.
   * `content` is '' on error; `code` carries the errno-style reason (`ENOENT`,
   * `EACCES`) so the caller can classify (e.g. → `FILE_NOT_FOUND`).
   */
  readFile(options: { dir: string; path: string; startLine?: number; endLine?: number }): Promise<{
    content: string;
    truncated: boolean;
    totalLines?: number;
    error?: string;
    code?: string;
  }>;

  /** Write `content` to `path` (relative to `dir`), creating parent dirs. */
  writeFile(options: {
    dir: string;
    path: string;
    content: string;
  }): Promise<{ ok: boolean; bytesWritten?: number; error?: string }>;

  /** List a directory (relative to `dir`; omit `path` for the clone root). */
  listDir(options: { dir: string; path?: string }): Promise<{
    entries: Array<{
      name: string;
      type: 'file' | 'directory' | 'symlink' | 'other';
      size?: number;
    }>;
    truncated: boolean;
    error?: string;
  }>;

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
   * Delete the single checkpoint whose commit is `commitId` and gc the orphaned
   * objects. `dropped` is false for an unknown/invalid commit (a no-op).
   */
  dropCheckpoint(options: { dir: string; commitId: string }): Promise<{ dropped: boolean }>;

  /**
   * Securely purge the checkpoint repo at `dir` by deleting the directory outright
   * (no recoverable objects/reflogs — the security mitigation, #1103). A single
   * lane dir or the whole `checkpoints` root may be passed. `cleared` is false when
   * the dir did not exist. The native side refuses any path outside the app-private
   * checkpoints area.
   */
  clearCheckpoints(options: { dir: string }): Promise<{ cleared: boolean }>;

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
