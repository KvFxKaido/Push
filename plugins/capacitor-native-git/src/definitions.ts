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
}
