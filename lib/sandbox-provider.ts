/**
 * Provider-agnostic sandbox interface.
 *
 * Abstracts the lifecycle, file operations, command execution, and
 * snapshotting of a remote (or local) sandbox environment. The current
 * implementation speaks HTTP to a Modal backend via the Cloudflare Worker
 * proxy; this interface makes the backend pluggable so we can add
 * Cloudflare, E2B, or other providers without touching sandbox-client.ts
 * or sandbox-tools.ts.
 *
 * Design references:
 *   - OpenAI Agents SDK: Manifest + SandboxAgent + SandboxRunConfig
 *   - AgentScope Architecture Review: SandboxProvider extraction
 *   - Modal Sandbox Snapshots Design: snapshot/restore lifecycle
 *   - Vercel Open Agents Review §5.1–5.2: snapshots + port exposure
 */

// ---------------------------------------------------------------------------
// Workspace manifest — declarative workspace description
// ---------------------------------------------------------------------------

/** A file to seed into the workspace before the agent starts. */
export interface ManifestFileEntry {
  path: string;
  content: string;
}

/** An environment variable to inject into sandbox commands. */
export interface ManifestEnvVar {
  key: string;
  value: string;
}

/**
 * Portable workspace description. Providers use this to set up the sandbox
 * identically regardless of backend. The manifest is the input to
 * `SandboxProvider.create()`.
 */
export interface SandboxManifest {
  /** GitHub repo to clone (e.g. "owner/repo"). Empty string for scratch. */
  repo: string;
  /** Branch to check out. Defaults to "main". */
  branch?: string;
  /** GitHub PAT for private repo access. */
  githubToken?: string;
  /** Git commit identity for the sandbox. */
  gitIdentity?: { name: string; email: string };
  /** Files to write into the workspace after clone. */
  seedFiles?: ManifestFileEntry[];
  /** Environment variables available to sandbox commands. */
  env?: ManifestEnvVar[];
}

// ---------------------------------------------------------------------------
// Sandbox session — returned by create/restore
// ---------------------------------------------------------------------------

export interface SandboxEnvironment {
  tools: Record<string, string>;
  project_markers?: string[];
  warnings?: string[];
  disk_free?: string;
  scripts?: Record<string, string>;
  git_available?: boolean;
  container_ttl?: string;
  uptime_seconds?: number;
  writable_root?: string;
  readiness?: {
    package_manager?: string;
    dependencies?: 'installed' | 'missing' | 'unknown';
    test_command?: string;
    typecheck_command?: string;
    test_runner?: string;
  };
}

export interface SandboxSession {
  sandboxId: string;
  ownerToken: string;
  status: 'ready' | 'error';
  error?: string;
  workspaceRevision?: number;
  environment?: SandboxEnvironment;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface SnapshotHandle {
  snapshotId: string;
  /** Provider-specific metadata (e.g. Modal Image ID, size, creation time). */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Operation results
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  error?: string;
  workspaceRevision?: number;
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
  error?: string;
  truncated_at_line?: number;
  remaining_bytes?: number;
  version?: string | null;
  start_line?: number;
  end_line?: number;
  workspace_revision?: number;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  code?: string;
  bytes_written?: number;
  new_version?: string | null;
  workspace_revision?: number;
}

export interface BatchWriteResult {
  ok: boolean;
  error?: string;
  results?: Array<{
    path: string;
    ok: boolean;
    error?: string;
    new_version?: string | null;
  }>;
  workspace_revision?: number;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
}

export interface DiffResult {
  diff: string;
  truncated: boolean;
  git_status?: string;
  error?: string;
}

export interface ArchiveResult {
  archive: string; // base64-encoded tar.gz
  size?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Operation options
// ---------------------------------------------------------------------------

export interface ExecOptions {
  workdir?: string;
  timeoutMs?: number;
  markWorkspaceMutated?: boolean;
}

export interface ReadFileOptions {
  startLine?: number;
  endLine?: number;
}

export interface WriteFileOptions {
  expectedVersion?: string;
  expectedWorkspaceRevision?: number;
}

export interface BatchWriteFile {
  path: string;
  content: string;
  expectedVersion?: string;
}

export interface DeleteFileOptions {
  expectedWorkspaceRevision?: number;
}

// ---------------------------------------------------------------------------
// Provider capabilities — runtime feature discovery
// ---------------------------------------------------------------------------

/**
 * Declares which optional capabilities a provider supports.
 * Callers check these before attempting snapshot/restore/port operations.
 */
export interface SandboxProviderCapabilities {
  /** Provider supports filesystem snapshots and restore. */
  snapshots: boolean;
  /** Provider supports exposing sandbox ports to the user. */
  portForwarding: boolean;
  /** Provider supports mounting external storage (S3, GCS, R2). */
  externalStorage: boolean;
}

// ---------------------------------------------------------------------------
// Unified error codes (provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * Sandbox error codes independent of the backend. Each provider maps its
 * native errors to these codes so sandbox-client.ts and sandbox-tools.ts
 * don't need provider-specific switch statements.
 */
export type SandboxErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH_FAILURE'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CONTAINER_ERROR'
  | 'STALE_FILE'
  | 'WORKSPACE_CHANGED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_FAILED'
  | 'UNKNOWN';

export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly code: SandboxErrorCode,
    public readonly details?: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

// ---------------------------------------------------------------------------
// SandboxProvider — the interface providers implement
// ---------------------------------------------------------------------------

export interface SandboxProvider {
  /** Human-readable provider name (e.g. "modal", "cloudflare", "e2b"). */
  readonly name: string;

  /** Declares which optional features this provider supports. */
  readonly capabilities: SandboxProviderCapabilities;

  // -- Lifecycle ------------------------------------------------------------

  /** Create a new sandbox from a manifest. */
  create(manifest: SandboxManifest): Promise<SandboxSession>;

  /**
   * Reconnect to an existing sandbox by ID.
   * Returns null if the sandbox is dead/expired (caller should create or restore).
   */
  connect(sandboxId: string, ownerToken: string): Promise<SandboxSession | null>;

  /** Terminate a sandbox. Idempotent — does not throw if already dead. */
  cleanup(sandboxId: string): Promise<void>;

  // -- Execution ------------------------------------------------------------

  /** Run a shell command inside the sandbox. */
  exec(sandboxId: string, command: string, options?: ExecOptions): Promise<ExecResult>;

  // -- File operations ------------------------------------------------------

  readFile(sandboxId: string, path: string, options?: ReadFileOptions): Promise<FileReadResult>;

  writeFile(
    sandboxId: string,
    path: string,
    content: string,
    options?: WriteFileOptions,
  ): Promise<WriteResult>;

  batchWrite(
    sandboxId: string,
    files: BatchWriteFile[],
    expectedWorkspaceRevision?: number,
  ): Promise<BatchWriteResult>;

  deleteFile(
    sandboxId: string,
    path: string,
    options?: DeleteFileOptions,
  ): Promise<{ workspace_revision: number }>;

  listDirectory(sandboxId: string, path: string): Promise<FileEntry[]>;

  // -- Git ------------------------------------------------------------------

  getDiff(sandboxId: string): Promise<DiffResult>;

  // -- Archive --------------------------------------------------------------

  /** Download workspace (or a subtree) as a base64-encoded tar.gz. */
  createArchive(sandboxId: string, path?: string): Promise<ArchiveResult>;

  /** Upload and extract an archive into the workspace. */
  hydrateArchive(sandboxId: string, archive: string, path?: string): Promise<void>;

  // -- Environment ----------------------------------------------------------

  /** Probe the sandbox for installed tools, project markers, readiness. */
  probeEnvironment(sandboxId: string): Promise<SandboxEnvironment>;

  // -- Snapshots (optional) -------------------------------------------------
  // Providers that set capabilities.snapshots = true must implement these.

  /**
   * Snapshot the sandbox filesystem. Returns a handle that can be passed
   * to `restore()` later to spin up a new sandbox with the same state.
   */
  snapshot?(sandboxId: string): Promise<SnapshotHandle>;

  /**
   * Create a new sandbox from a previously-captured snapshot.
   * The returned session is a fresh sandbox with the snapshotted filesystem.
   */
  restore?(handle: SnapshotHandle): Promise<SandboxSession>;

  /** Delete a snapshot. Idempotent. */
  deleteSnapshot?(handle: SnapshotHandle): Promise<void>;
}
