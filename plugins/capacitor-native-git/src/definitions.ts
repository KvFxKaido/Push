// Typed contract for the on-device git engine. Mirrors
// app/src/lib/native-git/definitions.ts — that copy is the one the web app
// currently imports (it binds to this plugin by name via `registerPlugin`).
// Future cleanup: have the app import the interface from here to remove the
// duplicated copy in app/src/lib/native-git/definitions.ts (see README).

export interface NativeGitWriteResult {
  ok: boolean;
  message?: string;
}

export interface NativeGitCloneOptions {
  url: string;
  dir: string;
  branch?: string;
  token?: string;
  depth?: number;
}

export interface NativeGitDirArg {
  dir: string;
}

export interface NativeGitPlugin {
  clone(options: NativeGitCloneOptions): Promise<NativeGitWriteResult>;
  currentBranch(options: NativeGitDirArg): Promise<{ branch: string | null }>;
  upstreamRef(options: NativeGitDirArg): Promise<{ ref: string | null }>;
  remoteUrl(options: { dir: string; remote?: string; push?: boolean }): Promise<{
    url: string | null;
  }>;
  headSha(options: { dir: string; short?: boolean }): Promise<{ sha: string | null }>;
  status(options: NativeGitDirArg): Promise<{ porcelain: string }>;
  diff(options: NativeGitDirArg): Promise<{
    diff: string;
    truncated: boolean;
    git_status?: string;
    error?: string;
  }>;
  revParse(options: { dir: string; ref: string }): Promise<{ sha: string | null }>;
  mergeBase(options: { dir: string; a: string; b: string }): Promise<{ sha: string | null }>;
  logPatch(options: { dir: string; range: string }): Promise<{ patch: string | null }>;
  lsRemoteHead(options: {
    dir: string;
    remote?: string;
    branch: string;
    token?: string;
  }): Promise<{ ok: boolean; sha: string | null }>;
  createBranch(options: {
    dir: string;
    name: string;
    from?: string;
  }): Promise<NativeGitWriteResult>;
  switchBranch(options: { dir: string; branch: string }): Promise<NativeGitWriteResult>;
  commit(options: {
    dir: string;
    message: string;
    addAll?: boolean;
  }): Promise<NativeGitWriteResult>;
  push(options: {
    dir: string;
    remote?: string;
    ref?: string;
    setUpstream?: boolean;
    token?: string;
  }): Promise<NativeGitWriteResult>;
  fetch(options: {
    dir: string;
    remote?: string;
    refspec?: string;
    depth?: number;
    token?: string;
  }): Promise<NativeGitWriteResult>;

  readFile(options: { dir: string; path: string; startLine?: number; endLine?: number }): Promise<{
    content: string;
    truncated: boolean;
    totalLines?: number;
    error?: string;
    code?: string;
  }>;
  writeFile(options: {
    dir: string;
    path: string;
    content: string;
  }): Promise<{ ok: boolean; bytesWritten?: number; error?: string }>;
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
  commitWorkingTree(options: {
    dir: string;
    archiveBase64: string;
    message: string;
  }): Promise<{ committed: boolean; commitId: string | null; message?: string }>;
  archiveCommit(options: {
    dir: string;
    commitId: string;
  }): Promise<{ archiveBase64: string | null }>;
  listCheckpoints(options: { dir: string }): Promise<{
    checkpoints: Array<{ commitId: string; message: string; timestampMs: number }>;
  }>;
  pruneCheckpoints(options: { dir: string; keep: number }): Promise<{ pruned: number }>;
  dropCheckpoint(options: { dir: string; commitId: string }): Promise<{ dropped: boolean }>;
  clearCheckpoints(options: { dir: string }): Promise<{ cleared: boolean }>;
  listManifest(options: { dir: string }): Promise<{ manifest: Record<string, string> }>;
  commitDelta(options: {
    dir: string;
    deltaArchiveBase64: string;
    deletedPaths: string[];
    expectedManifest: Record<string, string>;
    message: string;
  }): Promise<{ committed: boolean; commitId: string | null; treeId: string | null }>;
}
