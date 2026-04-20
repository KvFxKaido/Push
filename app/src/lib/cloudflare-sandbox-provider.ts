/**
 * Cloudflare implementation of the SandboxProvider interface.
 *
 * Calls /api/sandbox-cf/* on the Worker, which proxies to the Sandbox SDK
 * (see app/src/worker/worker-cf-sandbox.ts). Owner tokens are not yet used —
 * the CF path currently relies on origin validation + rate limiting for auth.
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
  if (httpStatus === 501) return 'SNAPSHOT_NOT_FOUND';
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
      return 'SNAPSHOT_NOT_FOUND';
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

  // -- Lifecycle ------------------------------------------------------------

  async create(manifest: SandboxManifest): Promise<SandboxSession> {
    const res = await call<{
      sandboxId: string;
      ownerToken?: string;
      status: 'ready' | 'error';
      error?: string;
      workspaceRevision?: number;
      environment?: SandboxEnvironment;
    }>('create', {
      repo: manifest.repo,
      branch: manifest.branch,
      githubToken: manifest.githubToken,
      gitIdentity: manifest.gitIdentity,
      seedFiles: manifest.seedFiles,
    });

    if (res.status === 'error') {
      throw new SandboxError(res.error ?? 'Sandbox creation failed', 'CONTAINER_ERROR');
    }

    return {
      sandboxId: res.sandboxId,
      ownerToken: res.ownerToken ?? '',
      status: res.status,
      workspaceRevision: res.workspaceRevision,
      environment: res.environment,
    };
  }

  async connect(sandboxId: string, ownerToken: string): Promise<SandboxSession | null> {
    try {
      const res = await call<{
        sandboxId: string;
        ownerToken?: string;
        status: 'ready' | 'error';
        workspaceRevision?: number;
        environment?: SandboxEnvironment;
      }>('connect', { sandboxId, ownerToken });
      return {
        sandboxId: res.sandboxId,
        ownerToken: res.ownerToken ?? ownerToken,
        status: res.status,
        workspaceRevision: res.workspaceRevision,
        environment: res.environment,
      };
    } catch (err) {
      if (err instanceof SandboxError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async cleanup(sandboxId: string): Promise<void> {
    try {
      await call<{ ok: boolean }>('cleanup', { sandboxId });
    } catch (err) {
      // Idempotent — treat NOT_FOUND as success (already destroyed).
      if (err instanceof SandboxError && err.code === 'NOT_FOUND') return;
      throw err;
    }
  }

  // -- Execution ------------------------------------------------------------

  async exec(sandboxId: string, command: string, options?: ExecOptions): Promise<ExecResult> {
    const res = await call<{
      stdout: string;
      stderr: string;
      exitCode: number;
      truncated: boolean;
      error?: string;
      workspaceRevision?: number;
    }>('exec', {
      sandboxId,
      command,
      workdir: options?.workdir,
    });
    return res;
  }

  // -- File operations ------------------------------------------------------

  async readFile(
    sandboxId: string,
    path: string,
    options?: ReadFileOptions,
  ): Promise<FileReadResult> {
    return await call<FileReadResult>('read', {
      sandboxId,
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
      sandboxId,
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
      sandboxId,
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
    return await call<{ workspace_revision?: number }>('delete', { sandboxId, path });
  }

  async listDirectory(sandboxId: string, path: string): Promise<FileEntry[]> {
    const res = await call<{ entries: FileEntry[] }>('list', { sandboxId, path });
    return res.entries;
  }

  // -- Git ------------------------------------------------------------------

  async getDiff(sandboxId: string): Promise<DiffResult> {
    return await call<DiffResult>('diff', { sandboxId });
  }

  // -- Archive --------------------------------------------------------------

  async createArchive(sandboxId: string, path?: string): Promise<ArchiveResult> {
    return await call<ArchiveResult>('download', { sandboxId, path });
  }

  async hydrateArchive(sandboxId: string, archive: string, path?: string): Promise<void> {
    await call<{ ok: boolean }>('restore', { sandboxId, archive, path });
  }

  // -- Environment ----------------------------------------------------------

  async probeEnvironment(sandboxId: string): Promise<SandboxEnvironment> {
    return await call<SandboxEnvironment>('probe', { sandboxId });
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
