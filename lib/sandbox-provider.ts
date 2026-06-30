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

import type { DynamicPolicy, SandboxPolicy } from './sandbox-policy';

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
  /** Repository default branch, when known. Lets providers identify default-branch starts. */
  defaultBranch?: string;
  /** GitHub PAT for private repo access. */
  githubToken?: string;
  /** Git commit identity for the sandbox. */
  gitIdentity?: { name: string; email: string };
  /** Files to write into the workspace after clone. */
  seedFiles?: ManifestFileEntry[];
  /** Environment variables available to sandbox commands. */
  env?: ManifestEnvVar[];
  /**
   * Isolation policy for the sandbox. Static sections (filesystem, process)
   * are applied at creation by providers that set
   * `capabilities.staticPolicyEnforcement = true`. Dynamic sections
   * (network, inference) are applied at creation AND may be hot-reloaded
   * later via `applyPolicy()` on providers with
   * `capabilities.dynamicPolicyEnforcement = true`. Providers that
   * declare neither capability ignore this field; host-side enforcement
   * (see `evaluateProcess`/`evaluateNetwork`) remains the caller's
   * responsibility in that case.
   */
  policy?: SandboxPolicy;
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
  /** Authorization token required to restore this snapshot. */
  restoreToken?: string;
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
  /** Workspace git branch after the command completed. Omitted when unavailable. */
  branch?: string;
}

// -- Background execution -----------------------------------------------------
// Detached counterpart to `exec()`. Where `exec()` buffers and returns once the
// command finishes, `execBackground()` returns a handle immediately and the
// command keeps running independent of the request that started it. Output is
// fetched incrementally by cursor (`execLogs`) so a client that disconnects
// mid-run can reconnect and resume from its last offset rather than losing the
// stream — the property cursor polling has that SSE does not. Providers that
// support this set `capabilities.backgroundExec = true` and implement all four
// methods; others omit them.

/** Handle returned by `execBackground` — identifies a detached process. */
export interface ExecHandle {
  processId: string;
  /** Provider-native status string at start (e.g. "starting" | "running"). */
  status: string;
  running: boolean;
  startedAt?: string | null;
}

/** Point-in-time status of a detached process. */
export interface ExecBackgroundStatus {
  processId: string;
  status: string;
  running: boolean;
  /** Exit code once finished; null while still running. */
  exitCode: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  /** Workspace git branch after the process finished. Omitted when unavailable/running. */
  branch?: string;
}

/**
 * Incremental log slice for a detached process. `nextCursor*` advance only by
 * what was actually returned, so a truncated read stays resumable: pass them
 * back on the next call to continue exactly where this slice was cut.
 */
export interface ExecLogsResult {
  processId: string;
  stdout: string;
  stderr: string;
  nextCursorStdout: number;
  nextCursorStderr: number;
  truncated: boolean;
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
  code?: string;
  expected_workspace_revision?: number;
  current_workspace_revision?: number;
}

export interface WriteResult {
  ok: boolean;
  error?: string;
  code?: string;
  bytes_written?: number;
  expected_version?: string;
  current_version?: string | null;
  new_version?: string | null;
  workspace_revision?: number;
  expected_workspace_revision?: number;
  current_workspace_revision?: number;
}

export interface BatchWriteResult {
  ok: boolean;
  error?: string;
  code?: string;
  results?: Array<{
    path: string;
    ok: boolean;
    error?: string;
    code?: string;
    bytes_written?: number;
    new_version?: string | null;
    expected_version?: string;
    current_version?: string | null;
  }>;
  workspace_revision?: number;
  expected_workspace_revision?: number;
  current_workspace_revision?: number;
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
  markWorkspaceMutated?: boolean;
  /**
   * Caller-supplied per-command deadline in milliseconds. Providers enforce it
   * as a hard bound that can only tighten the provider's own ceiling, never
   * extend past it. Omit to use the provider default.
   */
  timeoutMs?: number;
}

export interface ExecBackgroundOptions {
  workdir?: string;
  /** Optional deadline for the detached command; omit for unbounded. */
  timeoutMs?: number;
}

export interface ExecLogsOptions {
  /**
   * Character offset (UTF-16 code unit, not byte) into accumulated stdout;
   * omit for a full read from 0. Treat as an opaque resume token — pass back
   * the `nextCursorStdout` from the previous read.
   */
  cursorStdout?: number;
  /** Character offset (UTF-16 code unit, not byte) into accumulated stderr. */
  cursorStderr?: number;
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
  /**
   * Provider supports detached background execution with resumable cursor
   * logs. When `true`, `execBackground`/`execStatus`/`execLogs`/`execInterrupt`
   * must all be implemented; when `false`, they must be omitted.
   */
  backgroundExec: boolean;
  /** Provider supports exposing sandbox ports to the user. */
  portForwarding: boolean;
  /** Provider supports mounting external storage (S3, GCS, R2). */
  externalStorage: boolean;
  /**
   * Provider compiles `SandboxPolicy.static` (filesystem, process) into
   * native rules at sandbox creation. When `false`, the manifest's static
   * policy is ignored by the provider and the caller is responsible for
   * any host-side enforcement.
   */
  staticPolicyEnforcement: boolean;
  /**
   * Provider compiles `SandboxPolicy.dynamic` (network, inference) into
   * native rules at creation AND supports `applyPolicy()` for hot reload.
   * When `false`, `applyPolicy()` must not be called.
   */
  dynamicPolicyEnforcement: boolean;
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
  // Workspace volume is out of space. Distinct from CONTAINER_ERROR because
  // the remediation is "delete files", not "restart the sandbox" — a restart
  // loses uncommitted work without fixing anything.
  | 'DISK_FULL'
  | 'STALE_FILE'
  | 'WORKSPACE_CHANGED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_FAILED'
  | 'SNAPSHOT_TOO_LARGE'
  | 'UNKNOWN';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly details?: string;

  constructor(message: string, code: SandboxErrorCode, details?: string) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.details = details;
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

  // -- Background execution (optional) ---------------------------------------
  // Providers with capabilities.backgroundExec = true must implement all four;
  // others must omit them.

  /** Start a detached command. Returns a handle immediately. */
  execBackground?(
    sandboxId: string,
    command: string,
    options?: ExecBackgroundOptions,
  ): Promise<ExecHandle>;

  /** Poll a detached process's status. Rejects NOT_FOUND once reclaimed. */
  execStatus?(sandboxId: string, processId: string): Promise<ExecBackgroundStatus>;

  /** Fetch a resumable log slice from the given cursors. */
  execLogs?(
    sandboxId: string,
    processId: string,
    options?: ExecLogsOptions,
  ): Promise<ExecLogsResult>;

  /** Interrupt a detached process. Idempotent — does not throw if already gone. */
  execInterrupt?(sandboxId: string, processId: string, signal?: string): Promise<void>;

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
  ): Promise<{ workspace_revision?: number }>;

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
   * Snapshot the sandbox filesystem and terminate the container.
   * Returns a handle that can be passed to `restore()` later to spin up
   * a new sandbox with the same state. The original sandbox is no longer
   * usable after this call — callers must use `restore()` to continue.
   */
  snapshot?(sandboxId: string): Promise<SnapshotHandle>;

  /**
   * Create a new sandbox from a previously-captured snapshot.
   * The returned session is a fresh sandbox with the snapshotted filesystem.
   */
  restore?(handle: SnapshotHandle): Promise<SandboxSession>;

  /** Delete a snapshot. Idempotent. */
  deleteSnapshot?(handle: SnapshotHandle): Promise<void>;

  // -- Policy (optional) ----------------------------------------------------
  // Providers with capabilities.dynamicPolicyEnforcement = true must
  // implement this; others must omit it. The replacement is atomic from
  // the caller's perspective — partial application is the provider's job
  // to handle.

  /**
   * Replace the live sandbox's DynamicPolicy (network, inference). The
   * StaticPolicy half is fixed at creation and cannot be mutated here —
   * recreate the sandbox to change it. Implementation is required when
   * `capabilities.dynamicPolicyEnforcement === true` and must be omitted
   * otherwise.
   */
  applyPolicy?(sandboxId: string, policy: DynamicPolicy): Promise<void>;
}
