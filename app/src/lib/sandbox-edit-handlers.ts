/**
 * Sandbox edit-family tool handlers.
 *
 * Fourth extraction out of the `sandbox-tools.ts` dispatcher, after the
 * verification, git/release, and read-only-inspection families. This module
 * owns the three single-file mutation tools:
 *
 *   - `sandbox_edit_file`      → {@link handleEditFile}
 *   - `sandbox_edit_range`     → {@link handleEditRange}
 *   - `sandbox_search_replace` → {@link handleSearchReplace}
 *
 * `handleEditRange` and `handleSearchReplace` compile their input into a
 * hashline `HashlineOp[]` and then call `handleEditFile` directly. Before this
 * extraction they recursed through the dispatcher (`executeSandboxToolCall`)
 * to achieve the same hand-off; calling the handler directly removes a
 * dispatcher round-trip and a circular import risk between the handler module
 * and the dispatcher.
 *
 * The context surface (`EditHandlerContext`) names every seam that reaches
 * into shared harness state — file-version cache, workspace-revision
 * snapshots, prefetch edit cache, file-awareness ledger, symbol ledger,
 * sandbox I/O, and the write-verify read path. Pure utilities (hashline ops,
 * symbol extraction, path helpers, error formatting) stay as direct module
 * imports to keep the boundary one-way — this module never imports from
 * `sandbox-tools.ts`.
 */

import type { StructuredToolError, ToolExecutionResult, ToolMutationPostconditions } from '@/types';
import type { ExecResult, FileReadResult, WriteResult } from './sandbox-client';
import type { HashlineOp } from './hashline';
import type { EditGuardVerdict } from './file-awareness-ledger';
import type { SandboxToolCall } from './sandbox-tool-detection';
import type { PrefetchedEditFileState } from './sandbox-edit-ops';

import { extractSignaturesWithLines } from './file-awareness-ledger';
import { applyHashlineEdits, calculateLineHash } from './hashline';
import { fileVersionKey } from './sandbox-file-version-cache';
import {
  buildHashlineRetryHints,
  buildRangeReplaceHashlineOps,
  isUnknownSymbolGuardReason,
  parseLineQualifiedRef,
  readFullFileByChunks,
  refreshSameLineQualifiedRefs,
  runPerEditDiagnostics,
} from './sandbox-edit-ops';
import {
  classifyError,
  formatSandboxError,
  formatStructuredError,
  normalizeUnicode,
  retryOnContainerError,
} from './sandbox-tool-utils';
import {
  appendMutationPostconditions,
  buildHashlineChangedSpans,
  buildPerEditDiagnosticSummary,
} from './sandbox-mutation-postconditions';

type EditFileArgs = Extract<SandboxToolCall, { tool: 'sandbox_edit_file' }>['args'];
type EditRangeArgs = Extract<SandboxToolCall, { tool: 'sandbox_edit_range' }>['args'];
type SearchReplaceArgs = Extract<SandboxToolCall, { tool: 'sandbox_search_replace' }>['args'];

export interface EditHandlerContext {
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
  execInSandbox: (
    sandboxId: string,
    command: string,
    workdir?: string,
    options?: { markWorkspaceMutated?: boolean },
  ) => Promise<ExecResult>;

  // Version cache & workspace snapshots
  versionCacheSet: (key: string, version: string) => void;
  versionCacheDelete: (key: string) => void;
  getWorkspaceRevisionByKey: (key: string) => number | undefined;
  setSandboxWorkspaceRevision: (sandboxId: string, revision: number) => void;
  setWorkspaceRevisionByKey: (key: string, revision: number) => void;
  syncReadSnapshot: (sandboxId: string, path: string, result: FileReadResult) => void;
  invalidateWorkspaceSnapshots: (
    sandboxId: string,
    currentWorkspaceRevision?: number | null,
  ) => number;

  // Prefetch edit cache (used by edit_range / search_replace to prime handleEditFile)
  takePrefetchedEditFile: (sandboxId: string, path: string) => PrefetchedEditFileState | null;
  setPrefetchedEditFile: (
    sandboxId: string,
    path: string,
    content: string,
    version?: string,
    workspaceRevision?: number,
    truncated?: boolean,
  ) => void;

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
  recordLedgerMutation: (path: string, by: 'agent') => void;
  markLedgerStale: (path: string) => void;
  checkSymbolicEditAllowed: (path: string, editContent: string) => EditGuardVerdict;
  checkLinesCovered: (path: string, lineNumbers: number[]) => EditGuardVerdict;

  // Symbol ledger
  invalidateSymbolLedger: (path: string) => void;
}

export async function handleEditFile(
  ctx: EditHandlerContext,
  args: EditFileArgs,
): Promise<ToolExecutionResult> {
  const { path, edits } = args;

  // --- Edit Guard: symbolic check before editing ---
  const editContentForGuard = edits
    .filter((op): op is Extract<HashlineOp, { content: string }> => 'content' in op)
    .map((op) => op.content)
    .join('\n');

  let guardCachedContent: string | null = null;
  let guardCachedVersion: string | null = null;
  let guardCachedWorkspaceRevision: number | null = null;
  let guardCachedTruncated = false;
  let symbolicWarning: string | null = null;

  const prefetched = ctx.takePrefetchedEditFile(ctx.sandboxId, path);
  if (prefetched) {
    const prefetchedLineCount = prefetched.content.split('\n').length;
    const prefetchedSymbols = extractSignaturesWithLines(prefetched.content);
    ctx.recordLedgerRead(path, {
      truncated: prefetched.truncated,
      totalLines: prefetchedLineCount,
      symbols: prefetchedSymbols,
    });
    if (typeof prefetched.version === 'string' && prefetched.version) {
      ctx.versionCacheSet(fileVersionKey(ctx.sandboxId, path), prefetched.version);
    }
    if (typeof prefetched.workspaceRevision === 'number') {
      ctx.setSandboxWorkspaceRevision(ctx.sandboxId, prefetched.workspaceRevision);
      ctx.setWorkspaceRevisionByKey(
        fileVersionKey(ctx.sandboxId, path),
        prefetched.workspaceRevision,
      );
    }
    guardCachedContent = prefetched.content;
    guardCachedVersion = typeof prefetched.version === 'string' ? prefetched.version : null;
    guardCachedWorkspaceRevision =
      typeof prefetched.workspaceRevision === 'number' ? prefetched.workspaceRevision : null;
    guardCachedTruncated = prefetched.truncated;
  }

  const symbolicVerdict = ctx.checkSymbolicEditAllowed(path, editContentForGuard);
  if (!symbolicVerdict.allowed) {
    ctx.recordLedgerAutoExpandAttempt();
    try {
      const autoReadResult = (await ctx.readFromSandbox(ctx.sandboxId, path)) as FileReadResult & {
        error?: string;
      };
      if (!autoReadResult.error && autoReadResult.content !== undefined) {
        let autoContent = autoReadResult.content;
        let autoVersion = autoReadResult.version;
        let autoWorkspaceRevision = autoReadResult.workspace_revision;
        let autoTruncated = Boolean(autoReadResult.truncated);
        if (autoTruncated) {
          const expanded = await readFullFileByChunks(ctx.sandboxId, path, autoReadResult.version);
          autoContent = expanded.content;
          autoVersion = expanded.version ?? autoVersion;
          autoWorkspaceRevision = expanded.workspaceRevision ?? autoWorkspaceRevision;
          autoTruncated = expanded.truncated;
        }
        const autoLineCount = autoContent.split('\n').length;
        const autoSymbols = extractSignaturesWithLines(autoContent);
        ctx.recordLedgerRead(path, {
          truncated: autoTruncated,
          totalLines: autoLineCount,
          symbols: autoSymbols,
        });
        ctx.syncReadSnapshot(ctx.sandboxId, path, {
          content: autoContent,
          truncated: autoTruncated,
          version: autoVersion ?? undefined,
          workspace_revision: autoWorkspaceRevision,
        });
        ctx.recordLedgerAutoExpandSuccess();
        if (autoSymbols.length > 0) ctx.recordLedgerSymbolAutoExpand();
        console.debug(
          `[edit-guard] Auto-expanded "${path}" for sandbox_edit_file (${autoLineCount} lines, ${autoSymbols.length} symbols).`,
        );
        guardCachedContent = autoContent;
        guardCachedVersion = typeof autoVersion === 'string' ? autoVersion : null;
        guardCachedWorkspaceRevision =
          typeof autoWorkspaceRevision === 'number' ? autoWorkspaceRevision : null;
        guardCachedTruncated = autoTruncated;

        const retryVerdict = ctx.checkSymbolicEditAllowed(path, editContentForGuard);
        if (!retryVerdict.allowed) {
          if (isUnknownSymbolGuardReason(retryVerdict.reason) && !autoTruncated) {
            symbolicWarning = `${retryVerdict.reason} Proceeding because the file was fully auto-read.`;
            ctx.recordLedgerSymbolWarningSoftened();
          } else {
            const guardErr: StructuredToolError = {
              type: 'EDIT_GUARD_BLOCKED',
              retryable: false,
              message: `Edit guard: ${retryVerdict.reason}`,
              detail: 'Blocked after auto-expand',
            };
            return {
              text: formatStructuredError(
                guardErr,
                [
                  `[Tool Error — sandbox_edit_file]`,
                  `Edit guard: ${retryVerdict.reason}`,
                  `The file was auto-read but the guard still blocks this edit. Use sandbox_read_file to read the relevant sections, then retry.`,
                ].join('\n'),
              ),
              structuredError: guardErr,
            };
          }
        }
      } else {
        const guardErr: StructuredToolError = {
          type: 'EDIT_GUARD_BLOCKED',
          retryable: false,
          message: `Edit guard: ${symbolicVerdict.reason}`,
          detail: autoReadResult.error ? `Auto-read error: ${autoReadResult.error}` : undefined,
        };
        return {
          text: formatStructuredError(
            guardErr,
            [`[Tool Error — sandbox_edit_file]`, `Edit guard: ${symbolicVerdict.reason}`].join(
              '\n',
            ),
          ),
          structuredError: guardErr,
        };
      }
    } catch (autoExpandErr) {
      const errMsg = autoExpandErr instanceof Error ? autoExpandErr.message : String(autoExpandErr);
      const guardErr: StructuredToolError = {
        type: 'EDIT_GUARD_BLOCKED',
        retryable: false,
        message: `Edit guard: ${symbolicVerdict.reason}`,
        detail: `Auto-read threw: ${errMsg}`,
      };
      return {
        text: formatStructuredError(
          guardErr,
          [`[Tool Error — sandbox_edit_file]`, `Edit guard: ${symbolicVerdict.reason}`].join('\n'),
        ),
        structuredError: guardErr,
      };
    }
  }

  // 1. Read the current file content (reuse auto-expand cache if available)
  let readResult: FileReadResult & { error?: string };
  if (guardCachedContent !== null) {
    readResult = {
      content: guardCachedContent,
      truncated: guardCachedTruncated,
      version: guardCachedVersion ?? undefined,
      workspace_revision: guardCachedWorkspaceRevision ?? undefined,
    } as FileReadResult & { error?: string };
  } else {
    readResult = (await ctx.readFromSandbox(ctx.sandboxId, path)) as FileReadResult & {
      error?: string;
    };
  }
  if (readResult.error) {
    const err = classifyError(readResult.error, path);
    return {
      text: formatStructuredError(err, formatSandboxError(readResult.error, path)),
      structuredError: err,
    };
  }
  ctx.syncReadSnapshot(ctx.sandboxId, path, readResult);

  if (readResult.truncated) {
    const expanded = await readFullFileByChunks(ctx.sandboxId, path, readResult.version);
    if (expanded.truncated) {
      const err: StructuredToolError = {
        type: 'EDIT_GUARD_BLOCKED',
        retryable: false,
        message: `Edit guard: ${path} is too large to fully load safely.`,
        detail: 'Chunk hydration remained truncated',
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_edit_file]`,
            `Edit guard: ${path} is too large to fully load safely.`,
            `Chunked hydration remained truncated (likely due to payload limits on a single line range).`,
            `Use sandbox_read_file with narrower start_line/end_line ranges and retry with targeted edits.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }
    readResult = {
      ...readResult,
      content: expanded.content,
      truncated: expanded.truncated,
      version: expanded.version ?? readResult.version,
      workspace_revision: expanded.workspaceRevision ?? readResult.workspace_revision,
    };
    ctx.syncReadSnapshot(ctx.sandboxId, path, readResult);
  }

  // 2. Apply hashline edits with narrow auto-recovery for stale line-qualified refs.
  let editResult = await applyHashlineEdits(readResult.content, edits);
  let autoRetryNote: string | null = null;

  const allLineQualifiedRefs =
    edits.length > 0 && edits.every((op) => parseLineQualifiedRef(op.ref) !== null);
  if (editResult.failed > 0 && allLineQualifiedRefs) {
    try {
      const sameLineRetry = await refreshSameLineQualifiedRefs(readResult.content, edits);
      if (sameLineRetry.refreshedCount > 0) {
        const sameLineRetryResult = await applyHashlineEdits(
          readResult.content,
          sameLineRetry.edits,
        );
        if (sameLineRetryResult.failed === 0) {
          editResult = sameLineRetryResult;
          autoRetryNote = `Auto-retry succeeded (refreshed ${sameLineRetry.refreshedCount} stale line-qualified ref(s) to current same-line hashes).`;
        } else {
          autoRetryNote = `Auto-retry refreshed ${sameLineRetry.refreshedCount} stale line-qualified ref(s) but still failed (${sameLineRetryResult.failed} op(s)).`;
        }
      }

      if (editResult.failed > 0) {
        let retryRead = (await ctx.readFromSandbox(ctx.sandboxId, path)) as FileReadResult & {
          error?: string;
        };
        if (!retryRead.error) {
          if (retryRead.truncated) {
            const expanded = await readFullFileByChunks(ctx.sandboxId, path, retryRead.version);
            if (expanded.truncated) {
              autoRetryNote = 'Auto-retry skipped: latest file hydration remained truncated.';
            } else {
              retryRead = {
                ...retryRead,
                content: expanded.content,
                truncated: expanded.truncated,
                version: expanded.version ?? retryRead.version,
                workspace_revision: expanded.workspaceRevision ?? retryRead.workspace_revision,
              };
            }
          }

          if (!retryRead.truncated) {
            ctx.syncReadSnapshot(ctx.sandboxId, path, retryRead);
            const hashOnlyEdits = edits.map((op) => {
              const m = op.ref.trim().match(/^\d+:([a-f0-9]{7,12})$/i);
              return m ? { ...op, ref: m[1] } : op;
            });
            const retryEditResult = await applyHashlineEdits(retryRead.content, hashOnlyEdits);
            if (retryEditResult.failed === 0) {
              editResult = retryEditResult;
              readResult = retryRead;
              autoRetryNote = `Auto-retry succeeded (re-located content by hash after file version change).`;
            } else {
              autoRetryNote = `Auto-retry attempted but still failed (${retryEditResult.failed} op(s)).`;
            }
          }
        } else {
          autoRetryNote = `Auto-retry skipped: ${retryRead.error}`;
        }
      }
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      autoRetryNote = `Auto-retry failed: ${retryMsg}`;
    }
  }

  if (editResult.failed > 0) {
    const err: StructuredToolError = {
      type: 'EDIT_HASH_MISMATCH',
      retryable: false,
      message: `Failed to apply ${editResult.failed} of ${edits.length} edits.`,
      detail: editResult.errors.join('; '),
    };
    const autoRetryLine = autoRetryNote ? `Auto-retry: ${autoRetryNote}` : null;
    const retryHints = await buildHashlineRetryHints(readResult.content, edits, path);
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_edit_file]`,
          `Failed to apply ${editResult.failed} of ${edits.length} edits.`,
          ...editResult.errors.map((e) => `- ${e}`),
          ...(retryHints.length > 0
            ? ['', 'Retry hints:', ...retryHints.map((hint) => `- ${hint}`)]
            : []),
          ...(autoRetryLine ? [autoRetryLine] : []),
          `No changes were saved. Review the file content and references then retry.`,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  // 2b. Truncation-hashline sync: verify resolved edit targets fall within
  // the model's read ranges.
  if (editResult.resolvedLines.length > 0) {
    const coverageVerdict = ctx.checkLinesCovered(path, editResult.resolvedLines);
    if (!coverageVerdict.allowed) {
      const err: StructuredToolError = {
        type: 'EDIT_GUARD_BLOCKED',
        retryable: false,
        message: `Truncation guard: ${coverageVerdict.reason}`,
        detail: 'Hashline edit targets lines outside the model read range',
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_edit_file]`,
            coverageVerdict.reason,
            `No changes were saved. Read the target lines first, then retry the edit.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }
  }

  // 3. Write the edited content. Always prefer the version from the fresh read —
  // a caller-provided expected_version may be stale from a previous read and
  // would cause a spurious STALE_FILE rejection on the server.
  const beforeVersion = readResult.version || 'unknown';
  const editCacheKey = fileVersionKey(ctx.sandboxId, path);
  const editWriteVersion = readResult.version || undefined;
  const editWriteWorkspaceRevision =
    typeof readResult.workspace_revision === 'number'
      ? readResult.workspace_revision
      : ctx.getWorkspaceRevisionByKey(editCacheKey);
  const editWriteResult = await retryOnContainerError('sandbox_edit_file', () =>
    editWriteWorkspaceRevision === undefined
      ? ctx.writeToSandbox(ctx.sandboxId, path, editResult.content, editWriteVersion)
      : ctx.writeToSandbox(
          ctx.sandboxId,
          path,
          editResult.content,
          editWriteVersion,
          editWriteWorkspaceRevision,
        ),
  );

  if (!editWriteResult.ok) {
    if (editWriteResult.code === 'WORKSPACE_CHANGED') {
      const staleMarked = ctx.invalidateWorkspaceSnapshots(
        ctx.sandboxId,
        editWriteResult.current_workspace_revision ?? editWriteResult.workspace_revision,
      );
      const expected =
        editWriteResult.expected_workspace_revision ?? editWriteWorkspaceRevision ?? 'unknown';
      const current =
        editWriteResult.current_workspace_revision ??
        editWriteResult.workspace_revision ??
        'unknown';
      const workspaceErr: StructuredToolError = {
        type: 'WORKSPACE_CHANGED',
        retryable: false,
        message: `Workspace changed before ${path} could be written.`,
        detail: `expected_revision=${expected} current_revision=${current}`,
      };
      return {
        text: formatStructuredError(
          workspaceErr,
          [
            `[Tool Error — sandbox_edit_file]`,
            `Workspace changed before ${path} could be written.`,
            `Expected workspace revision: ${expected}`,
            `Current workspace revision: ${current}`,
            staleMarked > 0 ? `Marked ${staleMarked} previously-read file(s) as stale.` : null,
            `Re-read the file, then retry the edit.`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        structuredError: workspaceErr,
      };
    }
    if (editWriteResult.code === 'STALE_FILE') {
      if (typeof editWriteResult.current_version === 'string' && editWriteResult.current_version) {
        ctx.versionCacheSet(editCacheKey, editWriteResult.current_version);
      } else {
        ctx.versionCacheDelete(editCacheKey);
      }
      ctx.markLedgerStale(path);
      ctx.invalidateSymbolLedger(path);
      const expected = editWriteResult.expected_version || editWriteVersion || 'unknown';
      const current = editWriteResult.current_version || 'missing';
      const staleErr: StructuredToolError = {
        type: 'STALE_FILE',
        retryable: false,
        message: `Stale write rejected for ${path}.`,
        detail: `expected=${expected} current=${current}`,
      };
      return {
        text: formatStructuredError(
          staleErr,
          [
            `[Tool Error — sandbox_edit_file]`,
            `Stale write rejected for ${path}.`,
            `Expected version: ${expected}`,
            `Current version: ${current}`,
            `Re-read the file with sandbox_read_file, then retry the edit.`,
          ].join('\n'),
        ),
        structuredError: staleErr,
      };
    }
    const wErr = classifyError(editWriteResult.error || 'Write failed', path);
    return {
      text: formatStructuredError(
        wErr,
        `[Tool Error — sandbox_edit_file]\n${editWriteResult.error || 'Write failed'}`,
      ),
      structuredError: wErr,
    };
  }

  if (typeof editWriteResult.new_version === 'string' && editWriteResult.new_version) {
    ctx.versionCacheSet(editCacheKey, editWriteResult.new_version);
  }
  ctx.takePrefetchedEditFile(ctx.sandboxId, path);
  ctx.recordLedgerCreation(path);
  ctx.recordLedgerMutation(path, 'agent');
  ctx.invalidateSymbolLedger(path);

  // 4. Post-write verification: read back and compare version to confirm
  // the write actually persisted on disk.
  let writeVerified = true;
  let verifyWarning: string | null = null;
  try {
    const verifyRead = (await ctx.readFromSandbox(ctx.sandboxId, path, 1, 1)) as FileReadResult & {
      error?: string;
    };
    if (verifyRead.error) {
      writeVerified = false;
      verifyWarning = `Post-write read-back failed: ${verifyRead.error}. The edit may not have persisted.`;
    } else if (
      editWriteResult.new_version &&
      typeof verifyRead.version === 'string' &&
      verifyRead.version !== editWriteResult.new_version
    ) {
      writeVerified = false;
      verifyWarning = `Post-write version mismatch: expected ${editWriteResult.new_version}, got ${verifyRead.version}. The file may have been overwritten or the edit did not persist.`;
      ctx.versionCacheSet(editCacheKey, verifyRead.version);
      ctx.markLedgerStale(path);
    } else {
      ctx.syncReadSnapshot(ctx.sandboxId, path, verifyRead);
    }
  } catch (verifyErr) {
    writeVerified = false;
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    verifyWarning = `Post-write verification failed: ${msg}. The edit may not have persisted.`;
  }

  // 5. Get the diff hunks for this file.
  const escapedPath = path.replace(/'/g, "'\\''");
  const diffResult = await ctx.execInSandbox(
    ctx.sandboxId,
    `cd /workspace && git diff -- '${escapedPath}'`,
  );
  const diffHunks = diffResult.exitCode === 0 ? diffResult.stdout.trim() : '';

  const editLines: string[] = [
    `[Tool Result — sandbox_edit_file]`,
    `Edited ${path}: ${editResult.applied} of ${edits.length} operations applied.`,
    `Before version: ${beforeVersion}`,
    `After version: ${editWriteResult.new_version || 'unknown'}`,
    `Bytes written: ${editWriteResult.bytes_written ?? editResult.content.length}`,
    ...(writeVerified ? [] : [`WARNING: ${verifyWarning}`]),
  ];
  if (symbolicWarning) {
    editLines.push(`Symbol guard warning: ${symbolicWarning}`);
  }
  if (autoRetryNote) {
    editLines.push(`Auto-retry: ${autoRetryNote}`);
  }
  if (editResult.warnings.length > 0) {
    editLines.push('Hashline warnings:');
    editLines.push(...editResult.warnings.map((warning) => `  ⚠ ${warning}`));
  }
  if (diffHunks) {
    const maxDiffLen = 3000;
    const truncatedDiff =
      diffHunks.length > maxDiffLen
        ? diffHunks.slice(0, maxDiffLen) + '\n[diff truncated]'
        : diffHunks;
    editLines.push('', 'Diff:', truncatedDiff);
  } else {
    editLines.push('', 'No diff hunks (file may be outside git or content identical).');
  }

  const diagnostics = await runPerEditDiagnostics(ctx.sandboxId, path);
  if (diagnostics) {
    editLines.push('', '[DIAGNOSTICS]', diagnostics);
  }
  const postconditionWarnings = [
    ...editResult.warnings,
    symbolicWarning,
    autoRetryNote,
    writeVerified ? null : verifyWarning,
  ].filter((warning): warning is string => Boolean(warning));
  const editPostconditions: ToolMutationPostconditions = {
    touchedFiles: [
      {
        path,
        mutation: 'edit',
        bytesWritten: editWriteResult.bytes_written ?? editResult.content.length,
        versionBefore: readResult.version ?? null,
        versionAfter: editWriteResult.new_version ?? null,
        changedSpans: buildHashlineChangedSpans(edits, editResult.resolvedLines),
      },
    ],
    diagnostics: [buildPerEditDiagnosticSummary(path, diagnostics)],
    guardWarnings: postconditionWarnings.length > 0 ? postconditionWarnings : undefined,
    writeVerified,
  };
  appendMutationPostconditions(editLines, editPostconditions);

  return { text: editLines.join('\n'), postconditions: editPostconditions };
}

export async function handleEditRange(
  ctx: EditHandlerContext,
  args: EditRangeArgs,
): Promise<ToolExecutionResult> {
  const { path, start_line, end_line, content, expected_version } = args;
  const baseRead = (await ctx.readFromSandbox(ctx.sandboxId, path)) as FileReadResult & {
    error?: string;
  };
  if (baseRead.error) {
    const err = classifyError(baseRead.error, path);
    return {
      text: formatStructuredError(err, formatSandboxError(baseRead.error, path)),
      structuredError: err,
    };
  }
  ctx.syncReadSnapshot(ctx.sandboxId, path, baseRead);

  let hydrated = baseRead;
  if (hydrated.truncated) {
    const expanded = await readFullFileByChunks(ctx.sandboxId, path, hydrated.version);
    if (expanded.truncated) {
      const err: StructuredToolError = {
        type: 'EDIT_GUARD_BLOCKED',
        retryable: false,
        message: `Edit guard: ${path} is too large to fully load safely.`,
        detail: 'Range edit requires full-file hydration',
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_edit_range]`,
            `Edit guard: ${path} is too large to fully load safely.`,
            `Chunked hydration remained truncated.`,
            `Use sandbox_read_file with narrow ranges and sandbox_edit_file with targeted hash refs instead.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }
    hydrated = {
      ...hydrated,
      content: expanded.content,
      truncated: expanded.truncated,
      version: expanded.version ?? hydrated.version,
      workspace_revision: expanded.workspaceRevision ?? hydrated.workspace_revision,
    };
    ctx.syncReadSnapshot(ctx.sandboxId, path, hydrated);
  }

  try {
    const { ops } = await buildRangeReplaceHashlineOps(
      hydrated.content,
      start_line,
      end_line,
      content,
    );

    // Prime the edit guard/read path so handleEditFile does not need to
    // re-read just to establish awareness.
    const hydratedLineCount = hydrated.content.split('\n').length;
    const hydratedSymbols = extractSignaturesWithLines(hydrated.content);
    ctx.recordLedgerRead(path, {
      truncated: hydrated.truncated,
      totalLines: hydratedLineCount,
      symbols: hydratedSymbols,
    });
    ctx.syncReadSnapshot(ctx.sandboxId, path, hydrated);
    ctx.setPrefetchedEditFile(
      ctx.sandboxId,
      path,
      hydrated.content,
      typeof hydrated.version === 'string' ? hydrated.version : undefined,
      typeof hydrated.workspace_revision === 'number' ? hydrated.workspace_revision : undefined,
      hydrated.truncated,
    );

    return handleEditFile(ctx, {
      path,
      edits: ops,
      expected_version: expected_version ?? hydrated.version ?? undefined,
    });
  } catch (rangeErr) {
    const msg = rangeErr instanceof Error ? rangeErr.message : String(rangeErr);
    const err = classifyError(msg, path);
    return {
      text: formatStructuredError(err, [`[Tool Error — sandbox_edit_range]`, msg].join('\n')),
      structuredError: err,
    };
  }
}

export async function handleSearchReplace(
  ctx: EditHandlerContext,
  args: SearchReplaceArgs,
): Promise<ToolExecutionResult> {
  const { path, search, replace, expected_version } = args;

  const baseRead = (await ctx.readFromSandbox(ctx.sandboxId, path)) as FileReadResult & {
    error?: string;
  };
  if (baseRead.error) {
    const err = classifyError(baseRead.error, path);
    return {
      text: formatStructuredError(err, formatSandboxError(baseRead.error, path)),
      structuredError: err,
    };
  }
  ctx.syncReadSnapshot(ctx.sandboxId, path, baseRead);
  let hydrated = baseRead;
  if (hydrated.truncated) {
    const expanded = await readFullFileByChunks(ctx.sandboxId, path, hydrated.version);
    if (expanded.truncated) {
      const err: StructuredToolError = {
        type: 'EDIT_GUARD_BLOCKED',
        retryable: false,
        message: `${path} is too large to fully load for search-replace.`,
        detail: 'Use sandbox_read_file with ranges and sandbox_edit_file instead.',
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_search_replace]`,
            `${path} is too large to fully load safely.`,
            `Use sandbox_read_file with narrow ranges and sandbox_edit_file with hash refs instead.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }
    hydrated = {
      ...hydrated,
      content: expanded.content,
      truncated: false,
      version: expanded.version ?? hydrated.version,
      workspace_revision: expanded.workspaceRevision ?? hydrated.workspace_revision,
    };
    ctx.syncReadSnapshot(ctx.sandboxId, path, hydrated);
  }

  const rawLines = hydrated.content.split('\n');
  const visibleLines = hydrated.content.endsWith('\n') ? rawLines.slice(0, -1) : rawLines;
  const isMultiLineSearch = search.includes('\n');

  // --- Multi-line search path ---
  if (isMultiLineSearch) {
    const visibleContent = visibleLines.join('\n');
    const firstIdx = visibleContent.indexOf(search);
    if (firstIdx === -1) {
      const normalizedSearch = normalizeUnicode(search);
      const normalizedContent = normalizeUnicode(visibleContent);
      const fuzzyIdx = normalizedContent.indexOf(normalizedSearch);
      if (fuzzyIdx !== -1) {
        const fuzzyLineNo = visibleContent.slice(0, fuzzyIdx).split('\n').length;
        const err: StructuredToolError = {
          type: 'EDIT_CONTENT_NOT_FOUND',
          retryable: true,
          message: `Multi-line search string has encoding mismatches. Found a match after Unicode normalization near line ${fuzzyLineNo}.`,
          detail: `Re-read the file with sandbox_read_file and copy the exact characters.`,
        };
        return {
          text: formatStructuredError(
            err,
            [
              `[Tool Error — sandbox_search_replace]`,
              `Encoding mismatch in multi-line search string for ${path}.`,
              `A match was found near line ${fuzzyLineNo} after Unicode normalization.`,
              `Re-read the file with sandbox_read_file and use the exact characters from the output.`,
            ].join('\n'),
          ),
          structuredError: err,
        };
      }
      const err: StructuredToolError = {
        type: 'EDIT_CONTENT_NOT_FOUND',
        retryable: false,
        message: `Multi-line search string not found in ${path}.`,
        detail: `"${search.slice(0, 120)}" matched nothing.`,
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_search_replace]`,
            `Multi-line search string not found in ${path}.`,
            `"${search.slice(0, 120)}" matched nothing.`,
            `Use sandbox_read_file to verify the exact content, or use sandbox_edit_range for line-range replacements.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }

    const secondIdx = visibleContent.indexOf(search, firstIdx + 1);
    if (secondIdx !== -1) {
      const firstLineNo = visibleContent.slice(0, firstIdx).split('\n').length;
      const secondLineNo = visibleContent.slice(0, secondIdx).split('\n').length;
      const err: StructuredToolError = {
        type: 'EDIT_HASH_MISMATCH',
        retryable: false,
        message: `Ambiguous: multi-line search matches at least 2 locations in ${path} (lines ${firstLineNo} and ${secondLineNo}).`,
        detail: `Add more surrounding context to make the search unique.`,
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_search_replace]`,
            `Ambiguous: multi-line search matches at least 2 locations in ${path}.`,
            `First match near line ${firstLineNo}, second near line ${secondLineNo}.`,
            `Add more surrounding context to make the search unique.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }

    const matchEndIdx = firstIdx + search.length;
    const matchStartLine = visibleContent.slice(0, firstIdx).split('\n').length;
    const matchEndLine = visibleContent.slice(0, matchEndIdx).split('\n').length;

    const prefixStartIdx = visibleContent.lastIndexOf('\n', firstIdx - 1) + 1;
    const prefix = visibleContent.slice(prefixStartIdx, firstIdx);
    const suffixEndIdx = visibleContent.indexOf('\n', matchEndIdx);
    const suffix = visibleContent.slice(
      matchEndIdx,
      suffixEndIdx === -1 ? undefined : suffixEndIdx,
    );
    const replacementContent = prefix + replace + suffix;

    const { ops } = await buildRangeReplaceHashlineOps(
      hydrated.content,
      matchStartLine,
      matchEndLine,
      replacementContent,
    );

    const hydratedLineCount = hydrated.content.split('\n').length;
    const hydratedSymbols = extractSignaturesWithLines(hydrated.content);
    ctx.recordLedgerRead(path, {
      truncated: hydrated.truncated,
      totalLines: hydratedLineCount,
      symbols: hydratedSymbols,
    });
    ctx.syncReadSnapshot(ctx.sandboxId, path, hydrated);
    ctx.setPrefetchedEditFile(
      ctx.sandboxId,
      path,
      hydrated.content,
      typeof hydrated.version === 'string' ? hydrated.version : undefined,
      typeof hydrated.workspace_revision === 'number' ? hydrated.workspace_revision : undefined,
      hydrated.truncated,
    );

    return handleEditFile(ctx, {
      path,
      edits: ops,
      expected_version: expected_version ?? hydrated.version ?? undefined,
    });
  }

  // --- Single-line search path ---
  const matchingIndices = visibleLines
    .map((line, i) => (line.includes(search) ? i : -1))
    .filter((i) => i !== -1);

  if (matchingIndices.length === 0) {
    const normalized = normalizeUnicode(search);
    const fuzzyMatches = visibleLines
      .map((line, i) => (normalizeUnicode(line).includes(normalized) ? i : -1))
      .filter((i) => i !== -1);

    if (fuzzyMatches.length > 0) {
      const shown = fuzzyMatches
        .slice(0, 3)
        .map((i) => `  L${i + 1}: ${visibleLines[i].trim().slice(0, 80)}`);
      const err: StructuredToolError = {
        type: 'EDIT_CONTENT_NOT_FOUND',
        retryable: true,
        message: `Search string has encoding mismatches (smart quotes, em-dashes, or mojibake). Found ${fuzzyMatches.length} line(s) that match after Unicode normalization.`,
        detail: `Your search contains characters that don't match the file exactly — common mismatches include mojibake (e.g. "\\u00e2\\u20ac\\u201c" instead of an em-dash), smart quotes (\\u201c/\\u201d instead of ASCII "), and typographic dashes (\\u2013/\\u2014 instead of -).\nMatching lines after normalization:\n${shown.join('\n')}\n\nRe-read the file with sandbox_read_file and copy the exact characters.`,
      };
      return {
        text: formatStructuredError(
          err,
          [
            `[Tool Error — sandbox_search_replace]`,
            `Encoding mismatch in search string for ${path}.`,
            `Your search contains Unicode artifacts (e.g. mojibake, smart quotes, or em-dashes that don't match the file).`,
            `These lines match after normalization:`,
            ...shown,
            ``,
            `Re-read the file with sandbox_read_file and use the exact characters from the output.`,
          ].join('\n'),
        ),
        structuredError: err,
      };
    }

    const err: StructuredToolError = {
      type: 'EDIT_CONTENT_NOT_FOUND',
      retryable: false,
      message: `Search string not found in ${path}.`,
      detail: `"${search.slice(0, 80)}" matched no lines.`,
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_search_replace]`,
          `Search string not found in ${path}.`,
          `"${search.slice(0, 80)}" matched no lines.`,
          `Use sandbox_search to locate the content first.`,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  if (matchingIndices.length > 1) {
    const MAX_SHOWN = 5;
    const shown = matchingIndices
      .slice(0, MAX_SHOWN)
      .map((i) => `  L${i + 1}: ${visibleLines[i].trim().slice(0, 60)}`);
    if (matchingIndices.length > MAX_SHOWN)
      shown.push(`  ... and ${matchingIndices.length - MAX_SHOWN} more`);
    const err: StructuredToolError = {
      type: 'EDIT_HASH_MISMATCH',
      retryable: false,
      message: `Ambiguous: "${search.slice(0, 80)}" matches ${matchingIndices.length} lines in ${path}.`,
      detail: shown.join('\n'),
    };
    return {
      text: formatStructuredError(
        err,
        [
          `[Tool Error — sandbox_search_replace]`,
          `Ambiguous: "${search.slice(0, 80)}" matches ${matchingIndices.length} lines in ${path}.`,
          `Add more surrounding context to make the search unique:`,
          ...shown,
        ].join('\n'),
      ),
      structuredError: err,
    };
  }

  const targetIdx = matchingIndices[0];
  const originalLine = visibleLines[targetIdx];
  const newContent = originalLine.replace(search, () => replace);
  const newLines = newContent.split('\n');
  const lineNo = targetIdx + 1;
  const anchorHash = await calculateLineHash(originalLine, 7);
  const anchorRef = `${lineNo}:${anchorHash}`;

  const ops: HashlineOp[] = [{ op: 'replace_line', ref: anchorRef, content: newLines[0] }];
  if (newLines.length > 1) {
    for (const line of newLines.slice(1)) {
      ops.push({ op: 'insert_after', ref: anchorRef, content: line });
    }
  }

  const hydratedLineCount = hydrated.content.split('\n').length;
  const hydratedSymbols = extractSignaturesWithLines(hydrated.content);
  ctx.recordLedgerRead(path, {
    truncated: hydrated.truncated,
    totalLines: hydratedLineCount,
    symbols: hydratedSymbols,
  });
  ctx.syncReadSnapshot(ctx.sandboxId, path, hydrated);
  ctx.setPrefetchedEditFile(
    ctx.sandboxId,
    path,
    hydrated.content,
    typeof hydrated.version === 'string' ? hydrated.version : undefined,
    typeof hydrated.workspace_revision === 'number' ? hydrated.workspace_revision : undefined,
    hydrated.truncated,
  );

  return handleEditFile(ctx, {
    path,
    edits: ops,
    expected_version: expected_version ?? hydrated.version ?? undefined,
  });
}
