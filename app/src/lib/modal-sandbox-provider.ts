/**
 * Modal implementation of the SandboxProvider interface.
 *
 * Thin adapter around the existing sandbox-client.ts HTTP functions.
 * No behavior changes — all retry logic, tracing, version caching, and
 * owner-token management remain in sandbox-client.ts. This module just
 * translates between the provider-agnostic interface types and the
 * current sandbox-client API.
 *
 * Migration path:
 *   1. Callers that currently import from sandbox-client.ts continue working.
 *   2. New code can go through SandboxProvider for provider-agnostic access.
 *   3. Once a second provider exists, sandbox-tools.ts switches to the
 *      provider interface and sandbox-client.ts becomes an internal detail
 *      of this adapter.
 */

import type {
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxManifest,
  SandboxSession,
  SandboxEnvironment,
  ExecResult,
  ExecOptions,
  FileReadResult,
  ReadFileOptions,
  WriteResult,
  WriteFileOptions,
  BatchWriteResult,
  BatchWriteFile,
  DeleteFileOptions,
  FileEntry,
  DiffResult,
  ArchiveResult,
} from '@push/lib/sandbox-provider';
import { SandboxError } from '@push/lib/sandbox-provider';

import {
  createSandbox,
  execInSandbox,
  readFromSandbox,
  writeToSandbox,
  batchWriteToSandbox,
  deleteFromSandbox,
  listDirectory as listDir,
  getSandboxDiff,
  cleanupSandbox,
  downloadFromSandbox,
  hydrateSnapshotInSandbox,
  probeSandboxEnvironment,
  setSandboxOwnerToken,
  mapSandboxErrorCode,
} from './sandbox-client';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map the MODAL_* error codes from sandbox-client.ts to provider-agnostic
 * SandboxErrorCode values. Keeps all the Modal-specific strings contained
 * in this adapter.
 */
function toSandboxError(err: unknown): SandboxError {
  const message = err instanceof Error ? err.message : String(err);

  // Extract error code from the parenthesized suffix, e.g. "(MODAL_TIMEOUT)"
  const codeMatch = message.match(/\(([A-Z_]+)\)/);
  const rawCode = codeMatch?.[1] ?? '';

  // Map through the existing sandbox-client mapper, then to our codes
  const toolErrorType = rawCode ? mapSandboxErrorCode(rawCode) : 'UNKNOWN';

  const codeMap: Record<string, import('@push/lib/sandbox-provider').SandboxErrorCode> = {
    EXEC_TIMEOUT: 'TIMEOUT',
    SANDBOX_UNREACHABLE: 'NETWORK_ERROR',
    AUTH_FAILURE: 'AUTH_FAILURE',
    STALE_FILE: 'STALE_FILE',
    WORKSPACE_CHANGED: 'WORKSPACE_CHANGED',
    UNKNOWN: 'UNKNOWN',
  };

  // Refine NETWORK_ERROR into more specific codes when possible
  let code = codeMap[toolErrorType] ?? 'UNKNOWN';
  if (rawCode === 'MODAL_NOT_CONFIGURED') code = 'NOT_CONFIGURED';
  if (rawCode === 'MODAL_NOT_FOUND') code = 'NOT_FOUND';
  if (rawCode === 'CONTAINER_ERROR' || rawCode === 'MODAL_ERROR') code = 'CONTAINER_ERROR';

  return new SandboxError(message, code);
}

/** Wrap an async operation so all errors become SandboxError. */
async function wrapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    throw toSandboxError(err);
  }
}

// ---------------------------------------------------------------------------
// ModalSandboxProvider
// ---------------------------------------------------------------------------

export class ModalSandboxProvider implements SandboxProvider {
  readonly name = 'modal';

  readonly capabilities: SandboxProviderCapabilities = {
    // Snapshots will be enabled once Modal Sandbox Snapshots Design Phase 0
    // spike confirms the API works on our plan.
    snapshots: false,
    portForwarding: false,
    externalStorage: false,
  };

  // -- Lifecycle ------------------------------------------------------------

  async create(manifest: SandboxManifest): Promise<SandboxSession> {
    return wrapErrors(async () => {
      const session = await createSandbox(
        manifest.repo,
        manifest.branch,
        manifest.githubToken,
        manifest.gitIdentity,
      );

      if (session.status === 'error') {
        throw new SandboxError(
          session.error || 'Sandbox creation failed',
          'CONTAINER_ERROR',
        );
      }

      return {
        sandboxId: session.sandboxId,
        ownerToken: session.ownerToken ?? '',
        status: session.status,
        workspaceRevision: session.workspaceRevision,
        environment: session.environment as SandboxEnvironment | undefined,
      };
    });
  }

  async connect(sandboxId: string, ownerToken: string): Promise<SandboxSession | null> {
    return wrapErrors(async () => {
      // Restore the owner token so subsequent calls are authenticated.
      setSandboxOwnerToken(ownerToken, sandboxId);

      // Probe the environment to confirm the sandbox is alive.
      const env = await probeSandboxEnvironment(sandboxId);
      if (!env) return null;

      return {
        sandboxId,
        ownerToken,
        status: 'ready' as const,
        environment: env as SandboxEnvironment,
      };
    });
  }

  async cleanup(sandboxId: string): Promise<void> {
    return wrapErrors(async () => {
      try {
        await cleanupSandbox(sandboxId);
      } catch (err) {
        // Idempotent — ignore "not found" (already dead).
        if (err instanceof SandboxError && err.code === 'NOT_FOUND') return;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('MODAL_NOT_FOUND')) return;
        throw err;
      }
    });
  }

  // -- Execution ------------------------------------------------------------

  async exec(
    sandboxId: string,
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return wrapErrors(async () => {
      const result = await execInSandbox(sandboxId, command, options?.workdir, {
        markWorkspaceMutated: options?.markWorkspaceMutated,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated: result.truncated,
        error: result.error,
        workspaceRevision: result.workspaceRevision,
      };
    });
  }

  // -- File operations ------------------------------------------------------

  async readFile(
    sandboxId: string,
    path: string,
    options?: ReadFileOptions,
  ): Promise<FileReadResult> {
    return wrapErrors(async () => {
      return await readFromSandbox(sandboxId, path, options?.startLine, options?.endLine);
    });
  }

  async writeFile(
    sandboxId: string,
    path: string,
    content: string,
    options?: WriteFileOptions,
  ): Promise<WriteResult> {
    return wrapErrors(async () => {
      const result = await writeToSandbox(
        sandboxId,
        path,
        content,
        options?.expectedVersion,
        options?.expectedWorkspaceRevision,
      );
      return {
        ok: result.ok,
        error: result.error,
        code: result.code,
        bytes_written: result.bytes_written,
        new_version: result.new_version,
        workspace_revision: result.workspace_revision,
      };
    });
  }

  async batchWrite(
    sandboxId: string,
    files: BatchWriteFile[],
    expectedWorkspaceRevision?: number,
  ): Promise<BatchWriteResult> {
    return wrapErrors(async () => {
      const entries = files.map((f) => ({
        path: f.path,
        content: f.content,
        expected_version: f.expectedVersion,
      }));
      const result = await batchWriteToSandbox(sandboxId, entries, expectedWorkspaceRevision);
      return {
        ok: result.ok,
        error: result.error,
        results: result.results?.map((r) => ({
          path: r.path,
          ok: r.ok,
          error: r.error,
          new_version: r.new_version,
        })),
        workspace_revision: result.workspace_revision,
      };
    });
  }

  async deleteFile(
    sandboxId: string,
    path: string,
    options?: DeleteFileOptions,
  ): Promise<{ workspace_revision: number }> {
    return wrapErrors(async () => {
      const revision = await deleteFromSandbox(
        sandboxId,
        path,
        options?.expectedWorkspaceRevision,
      );
      return { workspace_revision: revision ?? 0 };
    });
  }

  async listDirectory(sandboxId: string, path: string): Promise<FileEntry[]> {
    return wrapErrors(async () => {
      const entries = await listDir(sandboxId, path);
      return entries.map((e) => ({
        name: e.name,
        type: e.type,
        size: e.size,
      }));
    });
  }

  // -- Git ------------------------------------------------------------------

  async getDiff(sandboxId: string): Promise<DiffResult> {
    return wrapErrors(async () => {
      return await getSandboxDiff(sandboxId);
    });
  }

  // -- Archive --------------------------------------------------------------

  async createArchive(sandboxId: string, path?: string): Promise<ArchiveResult> {
    return wrapErrors(async () => {
      const result = await downloadFromSandbox(sandboxId, path);
      if (!result.ok) {
        throw new SandboxError(
          result.error || 'Archive creation failed',
          'CONTAINER_ERROR',
        );
      }
      return {
        archive: result.archiveBase64 ?? '',
        size: result.sizeBytes,
      };
    });
  }

  async hydrateArchive(
    sandboxId: string,
    archive: string,
    path?: string,
  ): Promise<void> {
    return wrapErrors(async () => {
      const result = await hydrateSnapshotInSandbox(sandboxId, archive, path);
      if (!result.ok) {
        throw new SandboxError(
          result.error || 'Archive hydration failed',
          'CONTAINER_ERROR',
        );
      }
    });
  }

  // -- Environment ----------------------------------------------------------

  async probeEnvironment(sandboxId: string): Promise<SandboxEnvironment> {
    return wrapErrors(async () => {
      const env = await probeSandboxEnvironment(sandboxId);
      if (!env) {
        throw new SandboxError(
          'Environment probe failed — sandbox may be unreachable',
          'CONTAINER_ERROR',
        );
      }
      return env as SandboxEnvironment;
    });
  }

  // -- Snapshots (not yet available) ----------------------------------------
  // These methods will be implemented once Modal Sandbox Snapshots Design
  // Phase 0 spike confirms the API. For now, capabilities.snapshots = false
  // tells callers not to call these.
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the default sandbox provider for the current environment. */
export function createSandboxProvider(): SandboxProvider {
  // Today: Modal is the only backend.
  // Tomorrow: read from config/environment to select the provider.
  return new ModalSandboxProvider();
}
