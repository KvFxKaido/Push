/**
 * Sandbox write-family tool handlers.
 *
 * Fifth and final extraction out of the `sandbox-tools.ts` dispatcher, after
 * the verification, git/release, read-only-inspection, and edit-family
 * extractions. This module owns the two bulk-write tools:
 *
 *   - `sandbox_write_file`     → {@link handleWriteFile}
 *   - `sandbox_apply_patchset` → {@link handleApplyPatchset}
 *
 * `handleApplyPatchset` is the most stateful handler in the sandbox-tools
 * surface — it does parallel symbolic guard checks with auto-expand caching,
 * parallel file reads that reuse guard caches, cross-file workspace-revision
 * validation, batch write with an HTTP 404/405 → sequential-write fallback,
 * and a full ledger-snapshot-based rollback path for when post-write checks
 * fail. Every shared-state seam flows through `WriteHandlerContext`; pure
 * utilities (hashline ops, diagnostics, patchset failure formatters) stay as
 * direct module imports so this module never imports from `sandbox-tools.ts`.
 */

import type {
  StructuredToolError,
  ToolExecutionResult,
  ToolMutationCheckResult,
  ToolMutationFilePostcondition,
  ToolMutationPostconditions,
} from '@/types';
import type {
  BatchWriteEntry,
  BatchWriteResult,
  BatchWriteResultEntry,
  ExecResult,
  FileReadResult,
  WriteResult,
} from './sandbox-client';
import type { HashlineOp } from './hashline';
import type { EditGuardVerdict, FileState, MutationProvenance } from './file-awareness-ledger';
import type { SandboxPatchsetEdit, SandboxToolCall } from './sandbox-tool-detection';

import { extractSignaturesWithLines } from './file-awareness-ledger';
import { applyHashlineEdits } from './hashline';
import { fileVersionKey } from './sandbox-file-version-cache';
import {
  buildHashlineRetryHints,
  buildPatchsetFailureDetail,
  buildRangeReplaceHashlineOps,
  isUnknownSymbolGuardReason,
  readFullFileByChunks,
  recordPatchsetStaleConflict,
  runPatchsetDiagnostics,
  runPerEditDiagnostics,
} from './sandbox-edit-ops';
import {
  classifyError,
  formatSandboxError,
  formatStructuredError,
  retryOnContainerError,
} from './sandbox-tool-utils';
import {
  appendMutationPostconditions,
  buildHashlineChangedSpans,
  buildPatchsetDiagnosticSummary,
  buildPerEditDiagnosticSummary,
} from './sandbox-mutation-postconditions';

type WriteFileArgs = Extract<SandboxToolCall, { tool: 'sandbox_write_file' }>['args'];
type ApplyPatchsetArgs = Extract<SandboxToolCall, { tool: 'sandbox_apply_patchset' }>['args'];

type ModifiedBy = MutationProvenance['modifiedBy'];

export interface WriteHandlerContext {
  sandboxId: string;

  // Sandbox I/O
  readFromSandbox: (
    sandboxId: string,
    path: string,
    startLine?: number,
    endLine?: number,
  ) => Promise<FileReadResult>;
  writeToSandbox: (
    sandboxId: string,
    path: string,
    content: string,
    expectedVersion?: string,
    expectedWorkspaceRevision?: number,
  ) => Promise<WriteResult>;
  batchWriteToSandbox: (
    sandboxId: string,
    entries: BatchWriteEntry[],
    expectedWorkspaceRevision?: number,
  ) => Promise<BatchWriteResult>;
  execInSandbox: (
    sandboxId: string,
    command: string,
    workdir?: string,
    options?: { markWorkspaceMutated?: boolean },
  ) => Promise<ExecResult>;

  // Version cache & workspace snapshots
  versionCacheGet: (key: string) => string | undefined;
  versionCacheSet: (key: string, version: string) => void;
  versionCacheDelete: (key: string) => void;
  versionCacheDeletePath: (sandboxId: string, path: string) => void;
  getWorkspaceRevisionByKey: (key: string) => number | undefined;
  setSandboxWorkspaceRevision: (sandboxId: string, revision: number) => void;
  setWorkspaceRevisionByKey: (key: string, revision: number) => void;
  syncReadSnapshot: (sandboxId: string, path: string, result: FileReadResult) => void;
  invalidateWorkspaceSnapshots: (
    sandboxId: string,
    currentWorkspaceRevision?: number | null,
  ) => number;

  // File-awareness ledger
  recordLedgerRead: (
    path: string,
    opts?: {
      startLine?: number;
      endLine?: number;
      truncated?: boolean;
      totalLines?: number;
      symbols?: ReturnType<typeof extractSignaturesWithLines>;
    },
  ) => void;
  recordLedgerAutoExpandAttempt: () => void;
  recordLedgerAutoExpandSuccess: () => void;
  recordLedgerSymbolAutoExpand: () => void;
  recordLedgerSymbolWarningSoftened: () => void;
  recordLedgerCreation: (path: string) => void;
  recordLedgerMutation: (path: string, by: ModifiedBy) => void;
  markLedgerStale: (path: string) => void;
  getLedgerStaleWarning: (path: string) => string | null;
  getLedgerState: (path: string) => FileState | undefined;
  getLedgerProvenance: (path: string) => MutationProvenance | undefined;
  restoreLedgerState: (path: string, state: FileState | undefined) => void;
  clearLedgerProvenance: (path: string) => void;
  checkWriteAllowed: (path: string) => EditGuardVerdict;
  checkSymbolicEditAllowed: (path: string, editContent: string) => EditGuardVerdict;
  checkLinesCovered: (path: string, lineNumbers: number[]) => EditGuardVerdict;

  // Symbol ledger
  invalidateSymbolLedger: (path: string) => void;

  // Metrics
  recordWriteFileMetric: (event: {
    durationMs: number;
    outcome: 'success' | 'error' | 'stale';
    errorCode?: string;
  }) => void;
}

// --- Patchset-local pure helpers ---

function isPatchsetRangeEdit(
  edit: SandboxPatchsetEdit,
): edit is Extract<SandboxPatchsetEdit, { start_line: number; end_line: number; content: string }> {
  return 'start_line' in edit;
}

function getPatchsetEditContent(edit: SandboxPatchsetEdit): string {
  if (isPatchsetRangeEdit(edit)) return edit.content;
  return edit.ops
    .filter((op): op is Extract<HashlineOp, { content: string }> => 'content' in op)
    .map((op) => op.content)
    .join('\n');
}

async function compilePatchsetEditOps(
  content: string,
  edit: SandboxPatchsetEdit,
): Promise<HashlineOp[]> {
  if (!isPatchsetRangeEdit(edit)) return edit.ops;
  const { ops } = await buildRangeReplaceHashlineOps(
    content,
    edit.start_line,
    edit.end_line,
    edit.content,
  );
  return ops;
}

function buildPatchsetTouchedFiles(
  editResults: ReadonlyArray<{
    path: string;
    version?: string;
    resolvedLines: number[];
    ops: HashlineOp[];
  }>,
  successfulWrites: ReadonlyMap<string, { bytesWritten?: number; versionAfter?: string | null }>,
): ToolMutationFilePostcondition[] {
  const touchedFiles: ToolMutationFilePostcondition[] = [];

  for (const editResult of editResults) {
    const success = successfulWrites.get(editResult.path);
    if (!success) continue;
    touchedFiles.push({
      path: editResult.path,
      mutation: 'patchset',
      bytesWritten: success.bytesWritten,
      versionBefore: editResult.version ?? null,
      versionAfter: success.versionAfter ?? null,
      changedSpans: buildHashlineChangedSpans(editResult.ops, editResult.resolvedLines),
    });
  }

  return touchedFiles;
}

// --- Handlers ---

export async function handleWriteFile(
  ctx: WriteHandlerContext,
  args: WriteFileArgs,
): Promise<ToolExecutionResult> {
  const writeStart = Date.now();
  const cacheKey = fileVersionKey(ctx.sandboxId, args.path);

  // --- Edit Guard: check that the model has read this file ---
  const guardVerdict = ctx.checkWriteAllowed(args.path);
  if (!guardVerdict.allowed) {
    // Scoped Auto-Expand — try to auto-read the file and allow the write.
    ctx.recordLedgerAutoExpandAttempt();
    try {
      const autoReadResult = (await ctx.readFromSandbox(
        ctx.sandboxId,
        args.path,
      )) as FileReadResult & {
        error?: string;
      };
      if (!autoReadResult.error && autoReadResult.content !== undefined) {
        let autoReadContent = autoReadResult.content;
        let autoReadVersion = autoReadResult.version;
        let autoReadWorkspaceRevision = autoReadResult.workspace_revision;
        let autoReadTruncated = Boolean(autoReadResult.truncated);
        if (autoReadTruncated) {
          const expanded = await readFullFileByChunks(
            ctx.sandboxId,
            args.path,
            autoReadResult.version,
          );
          autoReadContent = expanded.content;
          autoReadVersion = expanded.version ?? autoReadVersion;
          autoReadWorkspaceRevision = expanded.workspaceRevision ?? autoReadWorkspaceRevision;
          autoReadTruncated = expanded.truncated;
        }

        const autoLineCount = autoReadContent.split('\n').length;
        ctx.recordLedgerRead(args.path, {
          truncated: autoReadTruncated,
          totalLines: autoLineCount,
        });
        ctx.syncReadSnapshot(ctx.sandboxId, args.path, {
          content: autoReadContent,
          truncated: autoReadTruncated,
          version: autoReadVersion ?? undefined,
          workspace_revision: autoReadWorkspaceRevision,
        });
        ctx.recordLedgerAutoExpandSuccess();
        console.debug(
          `[edit-guard] Auto-expanded "${args.path}" (${autoLineCount} lines) — proceeding with write.`,
        );

        const retryVerdict = ctx.checkWriteAllowed(args.path);
        if (!retryVerdict.allowed) {
          ctx.recordWriteFileMetric({
            durationMs: Date.now() - writeStart,
            outcome: 'error',
            errorCode: 'EDIT_GUARD_BLOCKED',
          });
          const guardErr: StructuredToolError = {
            type: 'EDIT_GUARD_BLOCKED',
            retryable: false,
            message: `Edit guard: ${retryVerdict.reason}`,
            detail: 'File too large for auto-expand',
          };
          return {
            text: formatStructuredError(
              guardErr,
              [
                `[Tool Error — sandbox_write_file]`,
                `Edit guard: ${retryVerdict.reason}`,
                `The file was auto-read but is too large to fully load. Use sandbox_read_file with start_line/end_line to read the sections you need to edit, then retry.`,
              ].join('\n'),
            ),
            structuredError: guardErr,
          };
        }
      } else {
        // Auto-read failed — the file may not exist (new file creation).
        const errMsg =
          typeof autoReadResult.error === 'string' ? autoReadResult.error.toLowerCase() : '';
        if (
          errMsg.includes('no such file') ||
          errMsg.includes('not found') ||
          errMsg.includes('does not exist')
        ) {
          ctx.recordLedgerCreation(args.path);
          ctx.recordLedgerMutation(args.path, 'agent');
          ctx.invalidateSymbolLedger(args.path);
          ctx.recordLedgerAutoExpandSuccess();
          console.debug(
            `[edit-guard] File "${args.path}" does not exist — allowing new file creation.`,
          );
        } else {
          ctx.recordWriteFileMetric({
            durationMs: Date.now() - writeStart,
            outcome: 'error',
            errorCode: 'EDIT_GUARD_BLOCKED',
          });
          const guardErr2: StructuredToolError = {
            type: 'EDIT_GUARD_BLOCKED',
            retryable: false,
            message: `Edit guard: ${guardVerdict.reason}`,
          };
          return {
            text: formatStructuredError(
              guardErr2,
              [`[Tool Error — sandbox_write_file]`, `Edit guard: ${guardVerdict.reason}`].join(
                '\n',
              ),
            ),
            structuredError: guardErr2,
          };
        }
      }
    } catch {
      ctx.recordWriteFileMetric({
        durationMs: Date.now() - writeStart,
        outcome: 'error',
        errorCode: 'EDIT_GUARD_BLOCKED',
      });
      const guardErr3: StructuredToolError = {
        type: 'EDIT_GUARD_BLOCKED',
        retryable: false,
        message: `Edit guard: ${guardVerdict.reason}`,
        detail: 'Auto-read threw an exception',
      };
      return {
        text: formatStructuredError(
          guardErr3,
          [`[Tool Error — sandbox_write_file]`, `Edit guard: ${guardVerdict.reason}`].join('\n'),
        ),
        structuredError: guardErr3,
      };
    }
  }

  // After auto-expand, the version cache may have been updated — refresh.
  const freshVersion = ctx.versionCacheGet(cacheKey) || args.expected_version;
  const freshWorkspaceRevision = ctx.getWorkspaceRevisionByKey(cacheKey);

  // Stale warning (soft — doesn't block, just informs)
  const staleWarning = ctx.getLedgerStaleWarning(args.path);

  try {
    const result = await retryOnContainerError('sandbox_write_file', () =>
      freshWorkspaceRevision === undefined
        ? ctx.writeToSandbox(ctx.sandboxId, args.path, args.content, freshVersion)
        : ctx.writeToSandbox(
            ctx.sandboxId,
            args.path,
            args.content,
            freshVersion,
            freshWorkspaceRevision,
          ),
    );

    if (!result.ok) {
      if (result.code === 'WORKSPACE_CHANGED') {
        const staleMarked = ctx.invalidateWorkspaceSnapshots(
          ctx.sandboxId,
          result.current_workspace_revision ?? result.workspace_revision,
        );
        ctx.recordWriteFileMetric({
          durationMs: Date.now() - writeStart,
          outcome: 'stale',
          errorCode: 'WORKSPACE_CHANGED',
        });
        const expected = result.expected_workspace_revision ?? freshWorkspaceRevision ?? 'unknown';
        const current = result.current_workspace_revision ?? result.workspace_revision ?? 'unknown';
        const err: StructuredToolError = {
          type: 'WORKSPACE_CHANGED',
          retryable: false,
          message: `Workspace changed before ${args.path} could be written.`,
          detail: `expected_revision=${expected} current_revision=${current}`,
        };
        return {
          text: formatStructuredError(
            err,
            [
              `[Tool Error — sandbox_write_file]`,
              `Workspace changed before ${args.path} could be written.`,
              `Expected workspace revision: ${expected}`,
              `Current workspace revision: ${current}`,
              staleMarked > 0 ? `Marked ${staleMarked} previously-read file(s) as stale.` : null,
              `Re-read the file with sandbox_read_file, apply edits to the latest content, then retry.`,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
          structuredError: err,
        };
      }
      if (result.code === 'STALE_FILE') {
        if (typeof result.current_version === 'string' && result.current_version) {
          ctx.versionCacheSet(cacheKey, result.current_version);
        } else {
          ctx.versionCacheDelete(cacheKey);
        }
        ctx.markLedgerStale(args.path);
        ctx.invalidateSymbolLedger(args.path);
        ctx.recordWriteFileMetric({
          durationMs: Date.now() - writeStart,
          outcome: 'stale',
          errorCode: 'STALE_FILE',
        });
        const expected = result.expected_version || freshVersion || 'unknown';
        const current = result.current_version || 'missing';
        const err: StructuredToolError = {
          type: 'STALE_FILE',
          retryable: false,
          message: `Stale write rejected for ${args.path}.`,
          detail: `expected=${expected} current=${current}`,
        };
        return {
          text: formatStructuredError(
            err,
            [
              `[Tool Error — sandbox_write_file]`,
              `Stale write rejected for ${args.path}.`,
              `Expected version: ${expected}`,
              `Current version: ${current}`,
              `Re-read the file with sandbox_read_file, apply edits to the latest content, then retry.`,
            ].join('\n'),
          ),
          structuredError: err,
        };
      }

      const errorCode = result.code || 'WRITE_FAILED';
      ctx.recordWriteFileMetric({
        durationMs: Date.now() - writeStart,
        outcome: 'error',
        errorCode,
      });
      const detail = result.error || 'Unknown error';
      const writeErr = classifyError(detail, args.path);
      return {
        text: formatStructuredError(writeErr, formatSandboxError(detail, args.path)),
        structuredError: writeErr,
      };
    }

    const previousVersion = ctx.versionCacheGet(cacheKey);
    if (typeof result.new_version === 'string' && result.new_version) {
      ctx.versionCacheSet(cacheKey, result.new_version);
    }
    if (typeof result.workspace_revision === 'number') {
      ctx.setSandboxWorkspaceRevision(ctx.sandboxId, result.workspace_revision);
      ctx.setWorkspaceRevisionByKey(cacheKey, result.workspace_revision);
    }

    const lines: string[] = [
      `[Tool Result — sandbox_write_file]`,
      `Wrote ${args.path} (${result.bytes_written ?? args.content.length} bytes)`,
    ];
    if (result.new_version) {
      lines.push(`New version: ${result.new_version}`);
    }

    if (previousVersion && result.new_version === previousVersion) {
      lines.push(`⚠ Note: Content is identical to the previous version — no effective change.`);
    } else if (!args.path.startsWith('/workspace')) {
      lines.push(`⚠ Note: File is outside /workspace — git will not track this file.`);
    }

    if (staleWarning) {
      lines.push(`⚠ ${staleWarning}`);
    }

    ctx.recordLedgerCreation(args.path);
    ctx.recordLedgerMutation(args.path, 'agent');
    ctx.invalidateSymbolLedger(args.path);

    const writeDiagnostics = await runPerEditDiagnostics(ctx.sandboxId, args.path);
    if (writeDiagnostics) {
      lines.push('', '[DIAGNOSTICS]', writeDiagnostics);
    }

    const writePostconditions: ToolMutationPostconditions = {
      touchedFiles: [
        {
          path: args.path,
          mutation: 'write',
          bytesWritten: result.bytes_written ?? args.content.length,
          versionBefore: freshVersion ?? previousVersion ?? null,
          versionAfter: result.new_version ?? null,
          changedSpans: [{ kind: 'full_write' }],
        },
      ],
      diagnostics: [buildPerEditDiagnosticSummary(args.path, writeDiagnostics)],
      guardWarnings: staleWarning ? [staleWarning] : undefined,
    };
    appendMutationPostconditions(lines, writePostconditions);

    ctx.recordWriteFileMetric({
      durationMs: Date.now() - writeStart,
      outcome: 'success',
    });
    return { text: lines.join('\n'), postconditions: writePostconditions };
  } catch (writeErr) {
    const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    const errCode = errMsg.match(/\(([A-Z_]+)\)/)?.[1] || 'WRITE_EXCEPTION';
    ctx.recordWriteFileMetric({
      durationMs: Date.now() - writeStart,
      outcome: 'error',
      errorCode: errCode,
    });
    const writeError = classifyError(errMsg, args.path);
    return {
      text: formatStructuredError(writeError, formatSandboxError(errMsg, args.path)),
      structuredError: writeError,
    };
  }
}

export async function handleApplyPatchset(
  ctx: WriteHandlerContext,
  args: ApplyPatchsetArgs,
): Promise<ToolExecutionResult> {
  const { edits, dryRun, checks, rollbackOnFailure } = args;

  if (!edits || edits.length === 0) {
    return { text: '[Tool Error — sandbox_apply_patchset] No edits provided.' };
  }

  // Reject duplicate file paths.
  const pathCounts = new Map<string, number>();
  for (const edit of edits) {
    pathCounts.set(edit.path, (pathCounts.get(edit.path) || 0) + 1);
  }
  const duplicates = [...pathCounts.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    return {
      text: [
        `[Tool Error — sandbox_apply_patchset]`,
        `Duplicate file paths are not allowed in a single patchset:`,
        ...duplicates.map(([path, count]) => `  - ${path} (appears ${count} times)`),
        `Combine all ops for each file into one entry.`,
      ].join('\n'),
    };
  }

  // --- Edit Guard: parallel symbolic check with auto-expand caching ---
  const guardCachedFiles = new Map<
    string,
    { content: string; version?: string; workspaceRevision?: number }
  >();
  const guardBlocked: string[] = [];
  const guardWarnings: string[] = [];
  const guardChecks = edits.map(async (edit) => {
    const patchEditContent = getPatchsetEditContent(edit);
    const patchVerdict = ctx.checkSymbolicEditAllowed(edit.path, patchEditContent);
    if (!patchVerdict.allowed) {
      ctx.recordLedgerAutoExpandAttempt();
      try {
        const autoRead = (await ctx.readFromSandbox(ctx.sandboxId, edit.path)) as FileReadResult & {
          error?: string;
        };
        if (!autoRead.error && autoRead.content !== undefined) {
          let content = autoRead.content;
          let version = autoRead.version;
          let workspaceRevision = autoRead.workspace_revision;
          let truncated = Boolean(autoRead.truncated);
          if (truncated) {
            const expanded = await readFullFileByChunks(ctx.sandboxId, edit.path, autoRead.version);
            content = expanded.content;
            version = expanded.version ?? version;
            workspaceRevision = expanded.workspaceRevision ?? workspaceRevision;
            truncated = expanded.truncated;
          }
          const lineCount = content.split('\n').length;
          const symbols = extractSignaturesWithLines(content);
          ctx.recordLedgerRead(edit.path, {
            truncated,
            totalLines: lineCount,
            symbols,
          });
          ctx.syncReadSnapshot(ctx.sandboxId, edit.path, {
            content,
            truncated,
            version: typeof version === 'string' ? version : undefined,
            workspace_revision: workspaceRevision,
          });
          if (truncated) {
            guardBlocked.push(
              `${edit.path}: file is too large to fully load safely (chunk hydration remained truncated)`,
            );
            return;
          }
          ctx.recordLedgerAutoExpandSuccess();
          if (symbols.length > 0) ctx.recordLedgerSymbolAutoExpand();
          guardCachedFiles.set(edit.path, {
            content,
            version: typeof version === 'string' ? version : undefined,
            workspaceRevision:
              typeof workspaceRevision === 'number' ? workspaceRevision : undefined,
          });
          const retryVerdict = ctx.checkSymbolicEditAllowed(edit.path, patchEditContent);
          if (!retryVerdict.allowed) {
            if (isUnknownSymbolGuardReason(retryVerdict.reason) && !truncated) {
              guardWarnings.push(
                `${edit.path}: ${retryVerdict.reason} (proceeded after full auto-read)`,
              );
              ctx.recordLedgerSymbolWarningSoftened();
            } else {
              guardBlocked.push(`${edit.path}: ${retryVerdict.reason}`);
            }
          }
        } else {
          guardBlocked.push(
            `${edit.path}: ${patchVerdict.reason}${autoRead.error ? ` (auto-read error: ${autoRead.error})` : ''}`,
          );
        }
      } catch (guardErr) {
        const errMsg = guardErr instanceof Error ? guardErr.message : String(guardErr);
        guardBlocked.push(`${edit.path}: ${patchVerdict.reason} (auto-read threw: ${errMsg})`);
      }
    }
  });
  await Promise.all(guardChecks);
  if (guardBlocked.length > 0) {
    const guardErr: StructuredToolError = {
      type: 'EDIT_GUARD_BLOCKED',
      retryable: false,
      message: `Edit guard blocked ${guardBlocked.length} file(s) in patchset`,
      detail: guardBlocked.join('; '),
    };
    return {
      text: formatStructuredError(
        guardErr,
        [
          `[Tool Error — sandbox_apply_patchset]`,
          `Edit guard blocked ${guardBlocked.length} file(s):`,
          ...guardBlocked.map((b) => `  - ${b}`),
          `Use sandbox_read_file to read the relevant files/sections, then retry.`,
        ].join('\n'),
      ),
      structuredError: guardErr,
    };
  }

  // Phase 1: Read all files and validate all hashline ops
  const fileContents = new Map<
    string,
    { content: string; version?: string; workspaceRevision?: number }
  >();
  const validationErrors: string[] = [];
  const phase1HydrationBlocked: string[] = [];
  const editResults: Array<{
    path: string;
    content: string;
    applied: number;
    version?: string;
    workspaceRevision?: number;
    resolvedLines: number[];
    ops: HashlineOp[];
  }> = [];

  const readPromises = edits.map(async (edit) => {
    const cached = guardCachedFiles.get(edit.path);
    if (cached) {
      fileContents.set(edit.path, cached);
      return;
    }
    try {
      const readResult = (await ctx.readFromSandbox(ctx.sandboxId, edit.path)) as FileReadResult & {
        error?: string;
      };
      if (readResult.error) {
        validationErrors.push(`${edit.path}: ${readResult.error}`);
        return;
      }
      let content = readResult.content;
      let version = readResult.version;
      let workspaceRevision = readResult.workspace_revision;
      if (readResult.truncated) {
        const expanded = await readFullFileByChunks(ctx.sandboxId, edit.path, readResult.version);
        content = expanded.content;
        version = expanded.version ?? version;
        workspaceRevision = expanded.workspaceRevision ?? workspaceRevision;
        if (expanded.truncated) {
          phase1HydrationBlocked.push(
            `${edit.path}: file is too large to fully load safely (chunk hydration remained truncated)`,
          );
          return;
        }
      }
      ctx.syncReadSnapshot(ctx.sandboxId, edit.path, {
        content,
        truncated: false,
        version: typeof version === 'string' ? version : undefined,
        workspace_revision: workspaceRevision,
      });
      fileContents.set(edit.path, {
        content,
        version: typeof version === 'string' ? version : undefined,
        workspaceRevision: typeof workspaceRevision === 'number' ? workspaceRevision : undefined,
      });
    } catch (e) {
      validationErrors.push(`${edit.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  await Promise.all(readPromises);

  if (phase1HydrationBlocked.length > 0) {
    const err: StructuredToolError = {
      type: 'EDIT_GUARD_BLOCKED',
      retryable: false,
      message: `Edit guard blocked ${phase1HydrationBlocked.length} file(s) in patchset`,
      detail: phase1HydrationBlocked.join('; '),
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_apply_patchset]`,
          `Edit guard blocked ${phase1HydrationBlocked.length} file(s):`,
          ...phase1HydrationBlocked.map((e) => `  - ${e}`),
          `Use sandbox_read_file with narrower start_line/end_line ranges, then retry with targeted edits.`,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  if (validationErrors.length > 0) {
    const err: StructuredToolError = {
      type: 'FILE_NOT_FOUND',
      retryable: false,
      message: `Failed to read ${validationErrors.length} file(s)`,
      detail: validationErrors.join('; '),
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_apply_patchset]`,
          `Failed to read ${validationErrors.length} file(s):`,
          ...validationErrors.map((e) => `  - ${e}`),
          `No changes were written.`,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  const workspaceRevisions = [
    ...new Set(
      [...fileContents.values()]
        .map((file) => file.workspaceRevision)
        .filter((revision): revision is number => typeof revision === 'number'),
    ),
  ];
  if (workspaceRevisions.length > 1) {
    const staleMarked = ctx.invalidateWorkspaceSnapshots(
      ctx.sandboxId,
      Math.max(...workspaceRevisions),
    );
    const err: StructuredToolError = {
      type: 'WORKSPACE_CHANGED',
      retryable: false,
      message: 'Workspace changed while validating the patchset.',
      detail: workspaceRevisions.join(', '),
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_apply_patchset]`,
          `Workspace changed while validating the patchset.`,
          `Observed workspace revisions: ${workspaceRevisions.join(', ')}`,
          staleMarked > 0 ? `Marked ${staleMarked} previously-read file(s) as stale.` : null,
          `Re-read the affected files, then retry the patchset.`,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      structuredError: err,
    };
  }
  const patchsetWorkspaceRevision = workspaceRevisions[0];

  // Validate all hashline ops against file contents
  const coverageErrors: string[] = [];
  for (const edit of edits) {
    const fileData = fileContents.get(edit.path);
    if (!fileData) continue;

    let compiledOps: HashlineOp[];
    try {
      compiledOps = await compilePatchsetEditOps(fileData.content, edit);
    } catch (compileErr) {
      validationErrors.push(
        `${edit.path}: ${compileErr instanceof Error ? compileErr.message : String(compileErr)}`,
      );
      continue;
    }

    const editResult = await applyHashlineEdits(fileData.content, compiledOps);
    if (editResult.failed > 0) {
      const retryHints = await buildHashlineRetryHints(fileData.content, compiledOps, edit.path);
      validationErrors.push(
        [
          `${edit.path}: ${editResult.errors.join('; ')}`,
          ...(retryHints.length > 0 ? [`retry hints: ${retryHints.join(' ')}`] : []),
        ].join(' '),
      );
    } else {
      if (editResult.warnings.length > 0) {
        guardWarnings.push(...editResult.warnings.map((warning) => `${edit.path}: ${warning}`));
      }
      if (editResult.resolvedLines.length > 0) {
        const coverageVerdict = ctx.checkLinesCovered(edit.path, editResult.resolvedLines);
        if (!coverageVerdict.allowed) {
          coverageErrors.push(`${edit.path}: ${coverageVerdict.reason}`);
          continue;
        }
      }
      editResults.push({
        path: edit.path,
        content: editResult.content,
        applied: editResult.applied,
        version: fileData.version,
        workspaceRevision: fileData.workspaceRevision,
        resolvedLines: [...editResult.resolvedLines],
        ops: [...compiledOps],
      });
    }
  }

  if (coverageErrors.length > 0) {
    const err: StructuredToolError = {
      type: 'EDIT_GUARD_BLOCKED',
      retryable: false,
      message: `Truncation guard: edit targets lines outside the model read range in ${coverageErrors.length} file(s)`,
      detail: coverageErrors.join('; '),
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_apply_patchset]`,
          `Edit guard blocked ${coverageErrors.length} file(s):`,
          ...coverageErrors.map((e) => `  - ${e}`),
          `No changes were written. Read the target lines first, then retry the patchset.`,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  if (validationErrors.length > 0) {
    const err: StructuredToolError = {
      type: 'EDIT_HASH_MISMATCH',
      retryable: false,
      message: `Hash mismatch in ${validationErrors.length} file(s)`,
      detail: validationErrors.join('; '),
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_apply_patchset]`,
          `Validation failed for ${validationErrors.length} file(s):`,
          ...validationErrors.map((e) => `  - ${e}`),
          `No changes were written. Re-read the affected files and retry.`,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  // Dry run — return validation success without writing
  if (dryRun) {
    const lines: string[] = [
      `[Tool Result — sandbox_apply_patchset] (dry run)`,
      `All ${edits.length} file(s) validated successfully:`,
    ];
    for (const r of editResults) {
      lines.push(`  ${r.path}: ${r.applied} op(s) would apply`);
    }
    if (guardWarnings.length > 0) {
      lines.push('Guard warnings:');
      lines.push(...guardWarnings.map((w) => `  ⚠ ${w}`));
    }
    return { text: lines.join('\n') };
  }

  // Snapshot ledger state before Phase 2 writes (for rollback)
  const ledgerSnapshots = new Map<
    string,
    { state: FileState | undefined; provenance: MutationProvenance | undefined }
  >();
  if (checks?.length && rollbackOnFailure) {
    for (const edit of edits) {
      ledgerSnapshots.set(edit.path, {
        state: ctx.getLedgerState(edit.path),
        provenance: ctx.getLedgerProvenance(edit.path),
      });
    }
  }

  // Phase 2: Batch write all files in a single HTTP request
  const writeResults: string[] = [];
  const writeFailures: string[] = [];
  const successfulWrites = new Map<
    string,
    { bytesWritten?: number; versionAfter?: string | null }
  >();
  let staleFailureCount = 0;

  const editResultsByPath = new Map(editResults.map((r) => [r.path, r]));

  try {
    const batchEntries: BatchWriteEntry[] = editResults.map((r) => ({
      path: r.path,
      content: r.content,
      expected_version: r.version,
    }));
    const batchResult = await retryOnContainerError('sandbox_apply_patchset', () =>
      patchsetWorkspaceRevision === undefined
        ? ctx.batchWriteToSandbox(ctx.sandboxId, batchEntries)
        : ctx.batchWriteToSandbox(ctx.sandboxId, batchEntries, patchsetWorkspaceRevision),
    );

    if (!batchResult.ok && (!batchResult.results || batchResult.results.length === 0)) {
      const errCode = batchResult.code || 'WRITE_FAILED';
      const errMsg = batchResult.error || 'Batch write failed with no results';
      const err = classifyError(`${errMsg} (${errCode})`, 'sandbox_apply_patchset');
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_apply_patchset]`,
            errMsg,
            batchResult.code ? `Error code: ${batchResult.code}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        structuredError: err,
      };
    }

    if (batchResult.code === 'WORKSPACE_CHANGED') {
      const staleMarked = ctx.invalidateWorkspaceSnapshots(
        ctx.sandboxId,
        batchResult.current_workspace_revision ?? batchResult.workspace_revision,
      );
      const expected =
        batchResult.expected_workspace_revision ?? patchsetWorkspaceRevision ?? 'unknown';
      const current =
        batchResult.current_workspace_revision ?? batchResult.workspace_revision ?? 'unknown';
      const err: StructuredToolError = {
        type: 'WORKSPACE_CHANGED',
        retryable: false,
        message: 'Workspace changed before the patchset could be written.',
        detail: `expected_revision=${expected} current_revision=${current}`,
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_apply_patchset]`,
            `Workspace changed before the patchset could be written.`,
            `Expected workspace revision: ${expected}`,
            `Current workspace revision: ${current}`,
            staleMarked > 0 ? `Marked ${staleMarked} previously-read file(s) as stale.` : null,
            `Re-read the affected files, then retry.`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        structuredError: err,
      };
    }

    for (const entry of batchResult.results) {
      const editInfo = editResultsByPath.get(entry.path);
      if (entry.ok) {
        const cacheKey = fileVersionKey(ctx.sandboxId, entry.path);
        if (typeof entry.new_version === 'string' && entry.new_version) {
          ctx.versionCacheSet(cacheKey, entry.new_version);
        }
        if (typeof batchResult.workspace_revision === 'number') {
          ctx.setSandboxWorkspaceRevision(ctx.sandboxId, batchResult.workspace_revision);
          ctx.setWorkspaceRevisionByKey(cacheKey, batchResult.workspace_revision);
        }
        ctx.recordLedgerCreation(entry.path);
        ctx.recordLedgerMutation(entry.path, 'agent');
        ctx.invalidateSymbolLedger(entry.path);
        successfulWrites.set(entry.path, {
          bytesWritten: entry.bytes_written,
          versionAfter: entry.new_version ?? null,
        });
        writeResults.push(
          `${entry.path}: ${editInfo?.applied ?? '?'} op(s) applied, ${entry.bytes_written ?? 0} bytes written`,
        );
      } else {
        if (entry.code === 'STALE_FILE') {
          const staleEntry = entry as BatchWriteResultEntry;
          staleFailureCount += 1;
          writeFailures.push(
            recordPatchsetStaleConflict(
              ctx.sandboxId,
              staleEntry.path,
              staleEntry.expected_version || editInfo?.version,
              staleEntry.current_version,
            ),
          );
        } else {
          writeFailures.push(`${entry.path}: ${entry.error || 'write failed'}`);
        }
      }
    }
  } catch (batchErr) {
    // Only fall back to sequential writes for "endpoint not available" errors
    // (HTTP 404/405). Timeout/network errors may mean the batch partially or
    // fully succeeded server-side.
    const statusCode = (batchErr as { statusCode?: number }).statusCode;
    if (statusCode !== 404 && statusCode !== 405) {
      ctx.invalidateWorkspaceSnapshots(ctx.sandboxId);
      const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      const err: StructuredToolError = {
        type: 'WRITE_FAILED',
        retryable: false,
        message: `Batch write failed with ambiguous state (${statusCode ? `HTTP ${statusCode}` : 'timeout/network'}). Some files may have been written. Re-read affected files before retrying.`,
        detail: errMsg,
      };
      return {
        text: formatStructuredError(err, `[Tool Error — sandbox_apply_patchset] ${err.message}`),
        structuredError: err,
      };
    }

    // HTTP 404/405 — batch endpoint unavailable, safe to retry sequentially.
    console.warn(
      '[sandbox-tools] batch endpoint unavailable (404/405), falling back to sequential writes',
    );
    for (const r of editResults) {
      ctx.versionCacheDeletePath(ctx.sandboxId, r.path);
    }
    for (const r of editResults) {
      try {
        const writeResult = await ctx.writeToSandbox(ctx.sandboxId, r.path, r.content, r.version);
        if (!writeResult.ok) {
          if (writeResult.code === 'STALE_FILE') {
            staleFailureCount += 1;
            writeFailures.push(
              recordPatchsetStaleConflict(
                ctx.sandboxId,
                r.path,
                writeResult.expected_version || r.version,
                writeResult.current_version,
              ),
            );
          } else {
            writeFailures.push(`${r.path}: ${writeResult.error || 'write failed'}`);
          }
        } else {
          const cacheKey = fileVersionKey(ctx.sandboxId, r.path);
          if (typeof writeResult.new_version === 'string' && writeResult.new_version) {
            ctx.versionCacheSet(cacheKey, writeResult.new_version);
          }
          if (typeof writeResult.workspace_revision === 'number') {
            ctx.setSandboxWorkspaceRevision(ctx.sandboxId, writeResult.workspace_revision);
            ctx.setWorkspaceRevisionByKey(cacheKey, writeResult.workspace_revision);
          }
          ctx.recordLedgerCreation(r.path);
          ctx.recordLedgerMutation(r.path, 'agent');
          ctx.invalidateSymbolLedger(r.path);
          successfulWrites.set(r.path, {
            bytesWritten: writeResult.bytes_written ?? r.content.length,
            versionAfter: writeResult.new_version ?? null,
          });
          writeResults.push(
            `${r.path}: ${r.applied} op(s) applied, ${writeResult.bytes_written ?? r.content.length} bytes written`,
          );
        }
      } catch (e) {
        writeFailures.push(`${r.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (writeFailures.length > 0) {
    const detail = buildPatchsetFailureDetail(writeFailures);
    const err: StructuredToolError =
      staleFailureCount > 0
        ? {
            type: 'STALE_FILE',
            retryable: false,
            message: `Patchset write failed for ${writeFailures.length} file(s), including ${staleFailureCount} stale version conflict(s).`,
            detail,
          }
        : {
            type: 'WRITE_FAILED',
            retryable: false,
            message: `Patchset write failed for ${writeFailures.length} file(s).`,
            detail,
          };
    const lines: string[] = [
      `[Tool Error — sandbox_apply_patchset] (partial failure)`,
      `${writeResults.length} of ${editResults.length} file(s) written successfully:`,
    ];
    if (writeResults.length > 0) {
      lines.push(...writeResults.map((r) => `  ✓ ${r}`));
    }
    lines.push(`${writeFailures.length} file(s) failed:`);
    lines.push(...writeFailures.map((f) => `  ✗ ${f}`));
    if (guardWarnings.length > 0) {
      lines.push('Guard warnings:');
      lines.push(...guardWarnings.map((w) => `  ⚠ ${w}`));
    }
    lines.push('Re-read failed files before retrying to avoid stale or partial-overwrite risk.');
    const partialPostconditions =
      successfulWrites.size > 0
        ? ({
            touchedFiles: buildPatchsetTouchedFiles(editResults, successfulWrites),
            guardWarnings: guardWarnings.length > 0 ? guardWarnings : undefined,
          } satisfies ToolMutationPostconditions)
        : undefined;
    appendMutationPostconditions(lines, partialPostconditions);
    return {
      text: formatStructuredError(err, lines.join('\n')),
      structuredError: err,
      ...(partialPostconditions ? { postconditions: partialPostconditions } : {}),
    };
  }

  // Phase 3: Run post-write checks (if provided)
  const checksResults: ToolMutationCheckResult[] = [];
  let checksFailed = false;
  if (checks?.length) {
    for (const check of checks) {
      const timeoutMs = check.timeoutMs ?? 10000;
      const expectedExit = check.exitCode ?? 0;
      try {
        const timeoutSec = Math.ceil(timeoutMs / 1000);
        const escaped = check.command.replace(/'/g, "'\\''");
        const wrappedCommand = `timeout ${timeoutSec} sh -c '${escaped}' 2>&1`;
        const result = await ctx.execInSandbox(ctx.sandboxId, wrappedCommand);
        const output =
          (result.stdout || '').slice(0, 4000) +
          (result.stderr ? '\n' + result.stderr.slice(0, 1000) : '');
        const passed = result.exitCode === expectedExit;
        checksResults.push({
          command: check.command,
          passed,
          exitCode: result.exitCode,
          output: output.trim(),
        });
        if (!passed) {
          checksFailed = true;
          break;
        }
      } catch (checkErr) {
        const errMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
        checksResults.push({
          command: check.command,
          passed: false,
          exitCode: -1,
          output: errMsg,
        });
        checksFailed = true;
        break;
      }
    }
  }

  // Phase 4: Rollback if checks failed and rollbackOnFailure is set
  if (checksFailed && rollbackOnFailure) {
    const rollbackResults: string[] = [];
    const rollbackErrors: string[] = [];
    const rollbackWrites = new Map<
      string,
      { bytesWritten?: number; versionAfter?: string | null }
    >();
    for (const edit of edits) {
      const original = fileContents.get(edit.path);
      if (!original) {
        rollbackErrors.push(`${edit.path}: no snapshot available`);
        continue;
      }
      try {
        const restoreResult = await ctx.writeToSandbox(ctx.sandboxId, edit.path, original.content);
        if (restoreResult.ok) {
          const cacheKey = fileVersionKey(ctx.sandboxId, edit.path);
          if (typeof restoreResult.new_version === 'string' && restoreResult.new_version) {
            ctx.versionCacheSet(cacheKey, restoreResult.new_version);
          }
          rollbackWrites.set(edit.path, {
            bytesWritten: original.content.length,
            versionAfter: restoreResult.new_version ?? original.version ?? null,
          });
          rollbackResults.push(edit.path);
        } else {
          rollbackErrors.push(`${edit.path}: ${restoreResult.error || 'restore failed'}`);
        }
      } catch (rollbackErr) {
        rollbackErrors.push(
          `${edit.path}: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        );
      }
    }

    // Restore file-awareness ledger state (undo recordCreation/recordMutation from Phase 2)
    for (const edit of edits) {
      const snapshot = ledgerSnapshots.get(edit.path);
      if (snapshot) {
        ctx.restoreLedgerState(edit.path, snapshot.state);
        if (snapshot.provenance) {
          ctx.recordLedgerMutation(edit.path, snapshot.provenance.modifiedBy);
        } else {
          ctx.clearLedgerProvenance(edit.path);
        }
      }
    }

    const rollbackLabel =
      rollbackErrors.length > 0
        ? `(partial rollback — ${rollbackErrors.length} file(s) failed to restore)`
        : '(rolled back)';
    const rollbackLines: string[] = [
      `[Tool Result — sandbox_apply_patchset] ${rollbackLabel}`,
      `All ${editResults.length} file(s) were patched, but a post-write check failed:`,
      '',
    ];
    for (const cr of checksResults) {
      rollbackLines.push(`  ${cr.passed ? '✓' : '✗'} ${cr.command} (exit ${cr.exitCode})`);
      if (cr.output) {
        const truncOutput = cr.output.length > 800 ? cr.output.slice(0, 800) + '…' : cr.output;
        for (const line of truncOutput.split('\n').slice(0, 15)) {
          rollbackLines.push(`    ${line}`);
        }
      }
    }
    rollbackLines.push('');
    if (rollbackResults.length > 0) {
      rollbackLines.push(
        `Rolled back ${rollbackResults.length} file(s): ${rollbackResults.join(', ')}`,
      );
    }
    if (rollbackErrors.length > 0) {
      rollbackLines.push(`Rollback errors: ${rollbackErrors.join('; ')}`);
    }
    rollbackLines.push('Fix the issue and retry the patchset.');
    const rollbackPostconditions: ToolMutationPostconditions = {
      touchedFiles: buildPatchsetTouchedFiles(editResults, rollbackWrites),
      checks: checksResults,
      guardWarnings: guardWarnings.length > 0 ? guardWarnings : undefined,
      rollbackApplied: true,
    };
    appendMutationPostconditions(rollbackLines, rollbackPostconditions);
    return { text: rollbackLines.join('\n'), postconditions: rollbackPostconditions };
  }

  const lines: string[] = [
    `[Tool Result — sandbox_apply_patchset]`,
    `All ${editResults.length} file(s) patched successfully:`,
    ...writeResults.map((r) => `  ✓ ${r}`),
  ];
  if (guardWarnings.length > 0) {
    lines.push('Guard warnings:');
    lines.push(...guardWarnings.map((w) => `  ⚠ ${w}`));
  }

  if (checksResults.length > 0) {
    lines.push('', 'Post-write checks:');
    for (const cr of checksResults) {
      lines.push(`  ✓ ${cr.command} (exit ${cr.exitCode})`);
    }
  }

  let patchDiagnostics: string | null = null;
  if (args.diagnostics !== false) {
    const changedPaths = editResults.map((r) => r.path);
    patchDiagnostics = await runPatchsetDiagnostics(ctx.sandboxId, changedPaths);
    if (patchDiagnostics) {
      lines.push('', '[DIAGNOSTICS — project typecheck]', patchDiagnostics);
    }
  }
  const patchsetPostconditions: ToolMutationPostconditions = {
    touchedFiles: buildPatchsetTouchedFiles(editResults, successfulWrites),
    diagnostics: [
      buildPatchsetDiagnosticSummary(
        editResults.map((result) => result.path),
        args.diagnostics !== false,
        patchDiagnostics,
      ),
    ],
    checks: checksResults.length > 0 ? checksResults : undefined,
    guardWarnings: guardWarnings.length > 0 ? guardWarnings : undefined,
  };
  appendMutationPostconditions(lines, patchsetPostconditions);

  return { text: lines.join('\n'), postconditions: patchsetPostconditions };
}
