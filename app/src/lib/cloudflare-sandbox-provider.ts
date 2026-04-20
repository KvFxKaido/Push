/**
 * Cloudflare implementation of the SandboxProvider interface.
 *
 * Calls /api/sandbox-cf/* on the Worker, which proxies to the Sandbox SDK
 * (see app/src/worker/worker-cf-sandbox.ts). Speaks the same snake_case
 * wire format as the Modal handler (sandbox_id, owner_token,
 * github_identity, workspace_revision, exit_code, …) so the Worker-side
 * provider toggle can switch backends without client-side changes. Owner
 * tokens are cached in a per-instance Map keyed by sandboxId, populated by
 * create/connect and injected into every subsequent request body. The
 * server rejects any non-create route that doesn't present a matching token.
 *
 * Capabilities:
 *   - snapshots: false (follow-up PR adds R2-backed archive snapshots)
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

const BASE = '/api/sandbox-cf';

async function call<T>(route: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
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

function mapCfErrorCode(code: string | undefined, httpStatus: number): SandboxErrorCode {
  if (httpStatus === 503) return 'NOT_CONFIGURED';
  // 501 / SNAPSHOT_NOT_SUPPORTED is "feature unavailable", not "snapshot
  // missing" — map to SNAPSHOT_FAILED so callers don't misinterpret it as a
  // missing-entry cache miss they should retry against.
  if (httpStatus === 501) return 'SNAPSHOT_FAILED';
  if (httpStatus === 404) return 'NOT_FOUND';
  if (httpStatus === 403) return 'AUTH_FAILURE';
  switch (code) {
    case 'CF_NOT_CONFIGURED':
      return 'NOT_CONFIGURED';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'NOT_FOUND':
      return 'NOT_FOUND';
    case 'CONTAINER_ERROR':
      return 'CONTAINER_ERROR';
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
    snapshots: false,
    portForwarding: false,
    externalStorage: false,
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
    }>('exec', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      command,
      workdir: options?.workdir,
    });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exit_code,
      truncated: res.truncated,
      error: res.error,
      workspaceRevision: res.workspace_revision,
    };
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
    return await call<ArchiveResult>('download', {
      sandbox_id: sandboxId,
      owner_token: this.tokenFor(sandboxId),
      path,
    });
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

  // -- Snapshots (not supported on CF provider yet) -------------------------
  // Class methods may take fewer params than the interface requires; callers
  // still pass their args and TS accepts the contravariant signature.

  async snapshot(): Promise<SnapshotHandle> {
    throw new SandboxError(
      'Snapshots are not supported on the Cloudflare provider yet',
      'SNAPSHOT_FAILED',
    );
  }

  async restore(): Promise<SandboxSession> {
    throw new SandboxError(
      'Snapshot restore is not supported on the Cloudflare provider yet',
      'SNAPSHOT_NOT_FOUND',
    );
  }

  async deleteSnapshot(): Promise<void> {
    throw new SandboxError(
      'Snapshot delete is not supported on the Cloudflare provider yet',
      'SNAPSHOT_NOT_FOUND',
    );
  }
}
