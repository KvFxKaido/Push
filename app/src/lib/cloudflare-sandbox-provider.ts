/**
 * Cloudflare implementation of the SandboxProvider interface.
 *
 * Always hits /api/sandbox-cf/* on the Worker (never /api/sandbox/*), so
 * selecting this class deliberately pins traffic to the CF backend —
 * independent of the server-side PUSH_SANDBOX_PROVIDER toggle that only
 * governs the shared /api/sandbox/* route. The wire format matches
 * Modal's snake_case convention (sandbox_id, owner_token,
 * github_identity, workspace_revision, exit_code, …) so a client going
 * through sandbox-client.ts can target either handler with the same body
 * when PUSH_SANDBOX_PROVIDER flips. This file only uses that format for
 * consistency and so test fixtures stay portable between the two paths.
 *
 * Owner tokens are cached in a per-instance Map keyed by sandboxId,
 * populated by create/connect and injected into every subsequent request
 * body. The server rejects any non-create route that doesn't present a
 * matching token.
 *
 * Capabilities:
 *   - snapshots: true (R2-backed archive snapshots — hibernate/restore/delete)
 *   - portForwarding: false (SDK supports it; wire later)
 *   - externalStorage: false (R2 bindings exist; wire later)
 *
 * Coexists with ModalSandboxProvider; the factory in modal-sandbox-provider.ts
 * picks between them based on the PUSH_SANDBOX_PROVIDER env/config value.
 */

import type {
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxManifest,
  SandboxSession,
  SandboxEnvironment,
  SandboxErrorCode,
  ExecResult,
  ExecOptions,
  ExecHandle,
  ExecBackgroundOptions,
  ExecBackgroundStatus,
  ExecLogsResult,
  ExecLogsOptions,
  FileReadResult,
  ReadFileOptions,
  WriteResult,
  WriteFileOptions,
  BatchWriteResult,
  BatchWriteFile,
  FileEntry,
  DiffResult,
  ArchiveResult,
  SnapshotHandle,
} from '@push/lib/sandbox-provider';
import { SandboxError } from '@push/lib/sandbox-provider';
import { resolveApiUrl } from './api-url';

const BASE = '/api/sandbox-cf';

async function call<T>(route: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(resolveApiUrl(`${BASE}/${route}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new SandboxError(
      `Invalid JSON response from sandbox-cf/${route}: ${text.slice(0, 200)}`,
      'UNKNOWN',
    );
  }

  if (!res.ok) {
    const errMsg = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`;
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    throw new SandboxError(errMsg, mapCfErrorCode(code, res.status), String(parsed.details ?? ''));
  }

  return parsed as T;
}

export function mapCfErrorCode(code: string | undefined, httpStatus: number): SandboxErrorCode {
  if (httpStatus === 503) return 'NOT_CONFIGURED';
  // 501 / SNAPSHOT_NOT_SUPPORTED is "feature unavailable", not "snapshot
  // missing" — map to SNAPSHOT_FAILED so callers don't misinterpret it as a
  // missing-entry cache miss they should retry against.
  if (httpStatus === 501) return 'SNAPSHOT_FAILED';
  // 413 / SNAPSHOT_TOO_LARGE: the workspace archive exceeds the snapshot size
  // ceiling. Distinct from SNAPSHOT_FAILED so callers can surface an actionable
  // "workspace too large to snapshot" message rather than a generic failure.
  if (httpStatus === 413) return 'SNAPSHOT_TOO_LARGE';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 403) return 'AUTH_FAILURE';
  switch (code) {
    case 'SNAPSHOT_TOO_LARGE':
      return 'SNAPSHOT_TOO_LARGE';
    case 'CF_NOT_CONFIGURED':
      return 'NOT_CONFIGURED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'CONTAINER_ERROR':
      return 'CONTAINER_ERROR';
    case 'DISK_FULL':
      return 'DISK_FULL';
    case 'STALE_FILE':
      return 'STALE_FILE';
    case 'WORKSPACE_CHANGED':
      return 'WORKSPACE_CHANGED';
    case 'SNAPSHOT_NOT_SUPPORTED':
      return 'SNAPSHOT_FAILED';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = 'cloudflare';

  readonly capabilities: SandboxProviderCapabilities = {
    snapshots: true,
    backgroundExec: true,
    portForwarding: false,
    externalStorage: false,
    staticPolicyEnforcement: false,
    dynamicPolicyEnforcement: false,
  };

  // Per-instance token cache. Keyed by sandboxId, populated on create/connect
  // and injected into every subsequent body. The web app typically has one
  // provider instance per session; on page reload the map resets and callers
  // must invoke connect() with a persisted token to repopulate.
  private ownerTokens = new Map<string, string>();

  private tokenFor(sandboxId: string): string {
    return this.ownerTokens.get(sandboxId) ?? '';
  }

  // -- Lifecycle ------------------------------------------------------------

  async create(manifest: SandboxManifest): Promise<SandboxSession> {
    const res = await call<{
      sandbox_id: string;
      owner_token?: string;
      status: 'ready' | 'error';
      error?: string;
      workspace_revision?: number;
      environment?: SandboxEnvironment;
    }>('create', {
      repo: manifest.repo,
      branch: manifest.branch,
      default_branch: manifest.defaultBranch,
      github_token: manifest.githubToken,
      github_identity: manifest.gitIdentity,
      seed_files: manifest.seedFiles,
    });

    if (res.status === 'error') {
      throw new SandboxError(res.error ?? 'Sandbox creation failed', 'CONTAINER_ERROR');
    }

    const ownerToken = res.owner_token ?? '';
    if (ownerToken) {
      this.ownerTokens.set(res.sandbox_id, ownerToken);
    }

    return {
      sandboxId: res.sandbox_id,
      ownerToken,
      status: res.status,
      workspaceRevision: res.workspace_revision,
      environment: res.environment,
    };
  }

  async connect(sandboxId: string, ownerToken: string): Promise<SandboxSession | null> {
    // Populate the token cache up front so this call itself carries the
    // token for the server's dispatch-level auth gate to verify.
    if (ownerToken) {
      this.ownerTokens.set(sandboxId, ownerToken);
    }
    try {
      const res = await call<{
        sandbox_id: string;
        owner_token?: string;
        status: 'ready' | 'error';
        workspace_revision?: number;
        environment?: SandboxEnvironment;
      }>('connect', { sandbox_id: sandboxId, owner_token: ownerToken });
      return {
        sandboxId: res.sandbox_id,
        ownerToken: res.owner_token ?? ownerToken,
        status: res.status,
        workspaceRevision: res.workspace_revision,
        environment: res.environment,
      };
    } catch (err) {
      if (err instanceof SandboxError && err.code === 'NOT_FOUND') {
        this.ownerTokens.delete(sandboxId);
        return null;
      }
      throw err;
    }
  }

  async cleanup(sandboxId: string): Promise<void> {
    try {
      await call<{ ok: boolean }>('cleanup', {
        sandbox_id: sandboxId,
        owner_token: this.tokenFor(sandboxId),
      });
      this.ownerTokens.delete(sandboxId);
    } catch (err) {
      // Idempotent — treat NOT_FOUND as success (already destroyed).
      if (err instanceof SandboxError && err.code === 'NOT_FOUND') {
        this.ownerTokens.delete(sandboxId);
        return;
      }
      throw err;
    }
  }

  // -- Execution ------------------------------------------------------------

  async exec(sandboxId: string, command: string, options?: ExecOptions): Promise<ExecResult> {
    const res = await call<{
      stdout: string;
      stderr: string;
      exit_code: number;
      truncated: boolean;
      error?: string;
      workspace_revision?: number;
      branch?: string;
    }>('exec', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      command,
      workdir: options?.workdir,
      timeout_ms: options?.timeoutMs,
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exit_code,
      truncated: res.truncated,
      error: res.error,
      workspaceRevision: res.workspace_revision,
      branch: res.branch,
    };
  }

  // -- Background execution -------------------------------------------------

  async execBackground(
    sandboxId: string,
    command: string,
    options?: ExecBackgroundOptions,
  ): Promise<ExecHandle> {
    const res = await call<{
      process_id: string;
      status: string;
      running: boolean;
      started_at?: string | null;
    }>('exec-start', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      command,
      workdir: options?.workdir,
      timeout_ms: options?.timeoutMs,
    });
    return {
      processId: res.process_id,
      status: res.status,
      running: res.running,
      startedAt: res.started_at ?? null,
    };
  }

  async execStatus(sandboxId: string, processId: string): Promise<ExecBackgroundStatus> {
    const res = await call<{
      process_id: string;
      status: string;
      running: boolean;
      exit_code: number | null;
      started_at?: string | null;
      ended_at?: string | null;
      branch?: string;
    }>('exec-status', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      process_id: processId,
    });
    return {
      processId: res.process_id,
      status: res.status,
      running: res.running,
      exitCode: res.exit_code,
      startedAt: res.started_at ?? null,
      endedAt: res.ended_at ?? null,
      branch: res.branch,
    };
  }

  async execLogs(
    sandboxId: string,
    processId: string,
    options?: ExecLogsOptions,
  ): Promise<ExecLogsResult> {
    const res = await call<{
      process_id: string;
      stdout: string;
      stderr: string;
      next_cursor_stdout: number;
      next_cursor_stderr: number;
      truncated: boolean;
    }>('exec-logs', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      process_id: processId,
      cursor_stdout: options?.cursorStdout,
      cursor_stderr: options?.cursorStderr,
    });
    return {
      processId: res.process_id,
      stdout: res.stdout,
      stderr: res.stderr,
      nextCursorStdout: res.next_cursor_stdout,
      nextCursorStderr: res.next_cursor_stderr,
      truncated: res.truncated,
    };
  }

  async execInterrupt(sandboxId: string, processId: string, signal?: string): Promise<void> {
    await call<{ ok: boolean }>('exec-kill', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      process_id: processId,
      signal,
    });
  }

  // -- File operations ------------------------------------------------------

  async readFile(
    sandboxId: string,
    path: string,
    options?: ReadFileOptions,
  ): Promise<FileReadResult> {
    return await call<FileReadResult>('read', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      path,
      start_line: options?.startLine,
      end_line: options?.endLine,
    });
  }

  async writeFile(
    sandboxId: string,
    path: string,
    content: string,
    options?: WriteFileOptions,
  ): Promise<WriteResult> {
    return await call<WriteResult>('write', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      path,
      content,
      expected_version: options?.expectedVersion,
      expected_workspace_revision: options?.expectedWorkspaceRevision,
    });
  }

  async batchWrite(
    sandboxId: string,
    files: BatchWriteFile[],
    expectedWorkspaceRevision?: number,
  ): Promise<BatchWriteResult> {
    return await call<BatchWriteResult>('batch-write', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      files: files.map((f) => ({
        path: f.path,
        content: f.content,
        expected_version: f.expectedVersion,
      })),
      expected_workspace_revision: expectedWorkspaceRevision,
    });
  }

  // DeleteFileOptions (expectedWorkspaceRevision) isn't plumbed yet — the CF
  // server-side stub treats delete as unconditional. Widen here when the
  // optimistic-concurrency parity gap is closed.
  async deleteFile(sandboxId: string, path: string): Promise<{ workspace_revision?: number }> {
    return await call<{ workspace_revision?: number }>('delete', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      path,
    });
  }

  async listDirectory(sandboxId: string, path: string): Promise<FileEntry[]> {
    const res = await call<{ entries: FileEntry[] }>('list', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      path,
    });
    return res.entries;
  }

  // -- Git ------------------------------------------------------------------

  async getDiff(sandboxId: string): Promise<DiffResult> {
    return await call<DiffResult>('diff', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
    });
  }

  // -- Archive --------------------------------------------------------------

  async createArchive(sandboxId: string, path?: string): Promise<ArchiveResult> {
    // The `download` route speaks the canonical Modal wire shape
    // ({ ok, archive_base64, size_bytes, format }), so map it onto the
    // abstraction's ArchiveResult here — same as ModalSandboxProvider does via
    // downloadFromSandbox.
    const res = await call<{
      ok?: boolean;
      archive_base64?: string;
      size_bytes?: number;
      error?: string;
    }>('download', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      path,
    });
    if (!res.ok || !res.archive_base64) {
      throw new SandboxError(res.error || 'Archive creation failed', 'CONTAINER_ERROR');
    }
    return { archive: res.archive_base64, size: res.size_bytes };
  }

  async hydrateArchive(sandboxId: string, archive: string, path?: string): Promise<void> {
    await call<{ ok: boolean }>('restore', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      archive,
      path,
    });
  }

  // -- Environment ----------------------------------------------------------

  async probeEnvironment(sandboxId: string): Promise<SandboxEnvironment> {
    return await call<SandboxEnvironment>('probe', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
    });
  }

  // -- Snapshots (R2-backed archives) ---------------------------------------
  // hibernate tars /workspace (source + .git, minus node_modules/build caches)
  // into R2 and frees the container; restore-snapshot pulls it into a fresh
  // sandbox. Wire shape matches Modal's hibernate/restore-snapshot routes.

  async snapshot(sandboxId: string): Promise<SnapshotHandle> {
    const res = await call<{
      ok?: boolean;
      snapshot_id?: string;
      restore_token?: string;
      size_bytes?: number;
      error?: string;
    }>('hibernate', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
    });
    if (!res.ok || !res.snapshot_id || !res.restore_token) {
      throw new SandboxError(res.error || 'Snapshot failed', 'SNAPSHOT_FAILED');
    }
    // The container is terminated by hibernate — drop its cached token.
    this.ownerTokens.delete(sandboxId);
    return {
      snapshotId: res.snapshot_id,
      restoreToken: res.restore_token,
      metadata: res.size_bytes != null ? { sizeBytes: res.size_bytes } : undefined,
    };
  }

  async restore(handle: SnapshotHandle): Promise<SandboxSession> {
    if (!handle.restoreToken) {
      throw new SandboxError('Missing restore token', 'AUTH_FAILURE');
    }
    const res = await call<{
      ok?: boolean;
      sandbox_id?: string;
      owner_token?: string;
      status?: 'ready' | 'error';
      workspace_revision?: number;
      environment?: SandboxEnvironment;
      error?: string;
    }>('restore-snapshot', {
      snapshot_id: handle.snapshotId,
      restore_token: handle.restoreToken,
    });
    if (!res.ok || !res.sandbox_id) {
      throw new SandboxError(res.error || 'Snapshot restore failed', 'SNAPSHOT_NOT_FOUND');
    }
    const ownerToken = res.owner_token ?? '';
    if (ownerToken) {
      this.ownerTokens.set(res.sandbox_id, ownerToken);
    }
    return {
      sandboxId: res.sandbox_id,
      ownerToken,
      status: res.status ?? 'ready',
      workspaceRevision: res.workspace_revision,
      environment: res.environment,
    };
  }

  async deleteSnapshot(handle: SnapshotHandle): Promise<void> {
    if (!handle.restoreToken) {
      throw new SandboxError('Missing restore token', 'AUTH_FAILURE');
    }
    await call<{ ok: boolean }>('delete-snapshot', {
      snapshot_id: handle.snapshotId,
      restore_token: handle.restoreToken,
    });
  }
}
