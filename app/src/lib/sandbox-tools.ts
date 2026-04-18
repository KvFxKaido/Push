/**
 * Sandbox tool execution — the main `executeSandboxToolCall()` dispatcher.
 *
 * Detection, validation, types, and protocol live in sandbox-tool-detection.ts.
 * Utility/error helpers live in sandbox-tool-utils.ts.
 * Edit operations (prefetch, chunked read, diagnostics) live in sandbox-edit-ops.ts.
 *
 * This file re-exports everything consumers expect so import paths don't change.
 */

import type {
  ToolExecutionResult,
  StructuredToolError,
  SandboxCardData,
  ToolMutationCheckResult,
  ToolMutationFilePostcondition,
  ToolMutationPostconditions,
} from '@/types';
import {
  execInSandbox,
  findReferencesInSandbox,
  getSandboxEnvironment,
  readFromSandbox,
  readSymbolsFromSandbox,
  writeToSandbox,
  batchWriteToSandbox,
  getSandboxDiff,
  listDirectory,
  downloadFromSandbox,
  type FileReadResult,
  type BatchWriteEntry,
  type BatchWriteResultEntry,
} from './sandbox-client';
import { runAuditor } from './auditor-agent';
import { fetchAuditorFileContexts } from './auditor-file-context';
import { recordReadFileMetric, recordWriteFileMetric } from './edit-metrics';
import { fileLedger, extractSignaturesWithLines } from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import { applyHashlineEdits, type HashlineOp } from './hashline';
import { getActiveGitHubToken } from './github-auth';
import { getApprovalMode } from './approval-mode';
import {
  fileVersionKey,
  getByKey as versionCacheGet,
  getWorkspaceRevisionByKey,
  setByKey as versionCacheSet,
  setWorkspaceRevisionByKey,
  setSandboxWorkspaceRevision,
  deleteByKey as versionCacheDelete,
  deleteFileVersion as versionCacheDeletePath,
  clearFileVersionCache,
} from './sandbox-file-version-cache';

// --- Imports from extracted modules ---
import {
  normalizeSandboxPath,
  normalizeSandboxWorkdir,
  formatSandboxError,
  diagnoseExecFailure,
  classifyError,
  formatStructuredError,
  retryOnContainerError,
  isLikelyMutatingSandboxExec,
  detectBlockedGitCommand,
  createGitHubRepo,
} from './sandbox-tool-utils';

import type {
  SandboxPatchsetEdit,
  SandboxToolCall,
  SandboxExecutionOptions,
} from './sandbox-tool-detection';

import {
  setPrefetchedEditFile,
  takePrefetchedEditFile,
  clearPrefetchedEditFileCache,
  syncReadSnapshot,
  invalidateWorkspaceSnapshots,
  isUnknownSymbolGuardReason,
  recordPatchsetStaleConflict,
  buildPatchsetFailureDetail,
  buildHashlineRetryHints,
  buildRangeReplaceHashlineOps,
  readFullFileByChunks,
  runPerEditDiagnostics,
  runPatchsetDiagnostics,
} from './sandbox-edit-ops';
import {
  handleRunTests,
  handleCheckTypes,
  handleVerifyWorkspace,
  type VerificationHandlerContext,
} from './sandbox-verification-handlers';
import {
  handleSandboxDiff,
  handlePrepareCommit,
  handleSandboxPush,
  handlePromoteToGithub,
  handleSaveDraft,
  type GitReleaseHandlerContext,
} from './sandbox-git-release-handlers';
import {
  handleFindReferences,
  handleListDir,
  handleReadFile,
  handleReadSymbols,
  handleSearch,
  type ReadOnlyInspectionHandlerContext,
} from './sandbox-read-only-inspection-handlers';
import {
  handleEditFile,
  handleEditRange,
  handleSearchReplace,
  type EditHandlerContext,
} from './sandbox-edit-handlers';
import {
  appendMutationPostconditions,
  buildHashlineChangedSpans,
  buildPatchsetDiagnosticSummary,
  buildPerEditDiagnosticSummary,
} from './sandbox-mutation-postconditions';

// --- Barrel re-exports (preserve existing consumer import paths) ---
export { clearFileVersionCache } from './sandbox-file-version-cache';
export { classifyError } from './sandbox-tool-utils';
export {
  type SandboxToolCall,
  type SandboxExecutionOptions,
  validateSandboxToolCall,
  IMPLEMENTED_SANDBOX_TOOLS,
  getUnrecognizedSandboxToolName,
  detectSandboxToolCall,
  SANDBOX_TOOL_PROTOCOL,
  getSandboxToolProtocol,
} from './sandbox-tool-detection';

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

// --- Execution ---

/**
 * Wire up the verification-handler context with the dispatcher's actual
 * infrastructure dependencies. Kept as a local helper (not exported) so
 * the extraction boundary stays one-way: the handler module never imports
 * from `sandbox-tools.ts`, and this wiring lives inside the dispatcher.
 */
function buildVerificationContext(sandboxId: string): VerificationHandlerContext {
  return {
    sandboxId,
    execInSandbox,
    getSandboxEnvironment,
    clearFileVersionCache,
    clearPrefetchedEditFileCache,
  };
}

/**
 * Wire up the git/release-handler context with the dispatcher's actual
 * infrastructure dependencies. Kept as a local helper (not exported) so
 * the extraction boundary stays one-way: the handler module never imports
 * from `sandbox-tools.ts`, and this wiring lives inside the dispatcher.
 */
function buildGitReleaseContext(sandboxId: string): GitReleaseHandlerContext {
  return {
    sandboxId,
    execInSandbox,
    getSandboxDiff,
    readFromSandbox,
    runAuditor,
    fetchAuditorFileContexts,
    createGitHubRepo,
    getActiveGitHubToken,
    clearFileVersionCache,
    clearPrefetchedEditFileCache,
  };
}

function buildReadOnlyInspectionContext(sandboxId: string): ReadOnlyInspectionHandlerContext {
  return {
    sandboxId,
    readFromSandbox,
    execInSandbox,
    listDirectory,
    readSymbolsFromSandbox,
    findReferencesInSandbox,
    syncReadSnapshot,
    invalidateWorkspaceSnapshots,
    deleteFileVersion: versionCacheDeletePath,
    recordReadFileMetric,
    recordLedgerRead: (path, opts) => fileLedger.recordRead(path, opts),
    lookupCachedSymbols: (filePath) => symbolLedger.lookup(filePath),
    storeCachedSymbols: (filePath, symbols, totalLines) => {
      symbolLedger.store(filePath, symbols, totalLines);
    },
  };
}

function buildEditContext(sandboxId: string): EditHandlerContext {
  return {
    sandboxId,
    readFromSandbox,
    writeToSandbox,
    execInSandbox,
    versionCacheSet,
    versionCacheDelete,
    getWorkspaceRevisionByKey,
    setSandboxWorkspaceRevision,
    setWorkspaceRevisionByKey,
    syncReadSnapshot,
    invalidateWorkspaceSnapshots,
    takePrefetchedEditFile,
    setPrefetchedEditFile,
    recordLedgerRead: (path, opts) => fileLedger.recordRead(path, opts),
    recordLedgerAutoExpandAttempt: () => fileLedger.recordAutoExpandAttempt(),
    recordLedgerAutoExpandSuccess: () => fileLedger.recordAutoExpandSuccess(),
    recordLedgerSymbolAutoExpand: () => fileLedger.recordSymbolAutoExpand(),
    recordLedgerSymbolWarningSoftened: () => fileLedger.recordSymbolWarningSoftened(),
    recordLedgerCreation: (path) => fileLedger.recordCreation(path),
    recordLedgerMutation: (path, by) => fileLedger.recordMutation(path, by),
    markLedgerStale: (path) => fileLedger.markStale(path),
    checkSymbolicEditAllowed: (path, editContent) =>
      fileLedger.checkSymbolicEditAllowed(path, editContent),
    checkLinesCovered: (path, lineNumbers) => fileLedger.checkLinesCovered(path, lineNumbers),
    invalidateSymbolLedger: (path) => symbolLedger.invalidate(path),
  };
}

export async function executeSandboxToolCall(
  call: SandboxToolCall,
  sandboxId: string,
  options?: SandboxExecutionOptions,
): Promise<ToolExecutionResult> {
  if (!sandboxId) {
    const err = classifyError('Sandbox unreachable — no active sandbox', 'executeSandboxToolCall');
    return {
      text: formatStructuredError(err, '[Tool Error] No active sandbox — start one first.'),
      structuredError: err,
    };
  }

  try {
    switch (call.tool) {
      case 'sandbox_exec': {
        // Git guard: block direct git mutations unless user explicitly approved
        // In full-auto mode, allow direct git — the system has granted blanket permission
        const blockedGitOp = detectBlockedGitCommand(call.args.command);
        const currentApprovalMode = getApprovalMode();
        if (blockedGitOp && !call.args.allowDirectGit && currentApprovalMode !== 'full-auto') {
          const guardDetail =
            currentApprovalMode === 'autonomous'
              ? 'Use sandbox_prepare_commit + sandbox_push for the audited flow, or retry with allowDirectGit: true.'
              : 'Use sandbox_prepare_commit + sandbox_push for the audited flow, or get explicit user approval before retrying with allowDirectGit.';
          const guardErr: StructuredToolError = {
            type: 'GIT_GUARD_BLOCKED',
            retryable: false,
            message: `Direct "${blockedGitOp}" is blocked`,
            detail: guardDetail,
          };
          const guidance =
            currentApprovalMode === 'autonomous'
              ? `Direct "${blockedGitOp}" is blocked. Use sandbox_prepare_commit + sandbox_push for the audited flow. If the standard flow fails, retry with "allowDirectGit": true — you have autonomous permission.`
              : [
                  `Direct "${blockedGitOp}" is blocked. Commits must go through sandbox_prepare_commit (Auditor review) and pushes through sandbox_push.`,
                  ``,
                  `If the standard flow is failing, use ask_user to explain the problem and request explicit permission from the user.`,
                  `If the user approves, retry with "allowDirectGit": true in your sandbox_exec args.`,
                ].join('\n');
          return {
            text: formatStructuredError(guardErr, `[Tool Blocked — sandbox_exec]\n${guidance}`),
            structuredError: guardErr,
          };
        }

        const start = Date.now();
        const markWorkspaceMutated = isLikelyMutatingSandboxExec(call.args.command);
        const normalizedWorkdir = normalizeSandboxWorkdir(call.args.workdir);
        const result = markWorkspaceMutated
          ? await execInSandbox(sandboxId, call.args.command, normalizedWorkdir, {
              markWorkspaceMutated: true,
            })
          : await execInSandbox(sandboxId, call.args.command, normalizedWorkdir);
        const durationMs = Date.now() - start;

        // Exit code -1 means the command was never dispatched — the container
        // is unreachable (expired, terminated, or unhealthy).
        if (result.exitCode === -1) {
          const reason = result.error || 'Sandbox unavailable';
          const err = classifyError(reason, call.args.command);
          // Override to SANDBOX_UNREACHABLE since -1 always means the container is gone
          err.type = 'SANDBOX_UNREACHABLE';
          err.retryable = false;
          const cardData: SandboxCardData = {
            command: call.args.command,
            stdout: '',
            stderr: reason,
            exitCode: -1,
            truncated: false,
            durationMs,
          };
          return {
            text: formatStructuredError(
              err,
              `[Tool Error — sandbox_exec]\nCommand was not executed. ${reason}\nThe sandbox container is no longer reachable. Please restart the sandbox to continue.`,
            ),
            card: { type: 'sandbox', data: cardData },
            structuredError: err,
          };
        }

        const lines: string[] = [
          `[Tool Result — sandbox_exec]`,
          `Command: ${call.args.command}`,
          `Exit code: ${result.exitCode}`,
        ];
        if (result.stdout) lines.push(`\nStdout:\n${result.stdout}`);
        if (result.stderr) lines.push(`\nStderr:\n${result.stderr}`);
        if (result.truncated) lines.push(`\n[Output truncated]`);

        // On non-zero exit, append a corrective hint if stderr matches a known pattern
        if (result.exitCode !== 0 && result.stderr) {
          const hint = diagnoseExecFailure(result.stderr);
          if (hint) lines.push(`\n[Hint] ${hint}`);
        }

        if (markWorkspaceMutated) {
          // Mutating execs can change files outside the normal write path.
          clearFileVersionCache(sandboxId);
          clearPrefetchedEditFileCache(sandboxId);
          const staleMarked = fileLedger.markAllStale();
          if (staleMarked > 0) {
            lines.push(
              `\n[Context] Marked ${staleMarked} previously-read file(s) as stale after sandbox_exec. Re-read before editing.`,
            );
          }
        }

        const cardData: SandboxCardData = {
          command: call.args.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          durationMs,
        };

        return { text: lines.join('\n'), card: { type: 'sandbox', data: cardData } };
      }

      case 'sandbox_read_file': {
        return handleReadFile(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_search': {
        return handleSearch(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_list_dir': {
        return handleListDir(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_edit_file': {
        return handleEditFile(buildEditContext(sandboxId), call.args);
      }

      case 'sandbox_edit_range': {
        return handleEditRange(buildEditContext(sandboxId), call.args);
      }

      case 'sandbox_search_replace': {
        return handleSearchReplace(buildEditContext(sandboxId), call.args);
      }

      case 'sandbox_write_file': {
        const writeStart = Date.now();
        const cacheKey = fileVersionKey(sandboxId, call.args.path);

        // --- Edit Guard: check that the model has read this file ---
        const guardVerdict = fileLedger.checkWriteAllowed(call.args.path);
        if (!guardVerdict.allowed) {
          // Phase 3: Scoped Auto-Expand — try to auto-read the file and allow the write
          fileLedger.recordAutoExpandAttempt();
          try {
            const autoReadResult = (await readFromSandbox(
              sandboxId,
              call.args.path,
            )) as FileReadResult & { error?: string };
            if (!autoReadResult.error && autoReadResult.content !== undefined) {
              // Record the auto-read in the ledger
              let autoReadContent = autoReadResult.content;
              let autoReadVersion = autoReadResult.version;
              let autoReadWorkspaceRevision = autoReadResult.workspace_revision;
              let autoReadTruncated = Boolean(autoReadResult.truncated);
              if (autoReadTruncated) {
                const expanded = await readFullFileByChunks(
                  sandboxId,
                  call.args.path,
                  autoReadResult.version,
                );
                autoReadContent = expanded.content;
                autoReadVersion = expanded.version ?? autoReadVersion;
                autoReadWorkspaceRevision = expanded.workspaceRevision ?? autoReadWorkspaceRevision;
                autoReadTruncated = expanded.truncated;
              }

              const autoLineCount = autoReadContent.split('\n').length;
              fileLedger.recordRead(call.args.path, {
                truncated: autoReadTruncated,
                totalLines: autoLineCount,
              });
              syncReadSnapshot(sandboxId, call.args.path, {
                content: autoReadContent,
                truncated: autoReadTruncated,
                version: autoReadVersion ?? undefined,
                workspace_revision: autoReadWorkspaceRevision,
              });
              fileLedger.recordAutoExpandSuccess();
              console.debug(
                `[edit-guard] Auto-expanded "${call.args.path}" (${autoLineCount} lines) — proceeding with write.`,
              );
              // Re-check guard after auto-expand (should pass now unless still partial)
              const retryVerdict = fileLedger.checkWriteAllowed(call.args.path);
              if (!retryVerdict.allowed) {
                // Still blocked after auto-expand (e.g. truncated partial read)
                recordWriteFileMetric({
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
              // If the error looks like a missing file, allow the write.
              const errMsg =
                typeof autoReadResult.error === 'string' ? autoReadResult.error.toLowerCase() : '';
              if (
                errMsg.includes('no such file') ||
                errMsg.includes('not found') ||
                errMsg.includes('does not exist')
              ) {
                fileLedger.recordCreation(call.args.path);
                fileLedger.recordMutation(call.args.path, 'agent');
                symbolLedger.invalidate(call.args.path);
                fileLedger.recordAutoExpandSuccess();
                console.debug(
                  `[edit-guard] File "${call.args.path}" does not exist — allowing new file creation.`,
                );
              } else {
                recordWriteFileMetric({
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
                    [
                      `[Tool Error — sandbox_write_file]`,
                      `Edit guard: ${guardVerdict.reason}`,
                    ].join('\n'),
                  ),
                  structuredError: guardErr2,
                };
              }
            }
          } catch {
            // Auto-read threw — return the original guard error
            recordWriteFileMetric({
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
                [`[Tool Error — sandbox_write_file]`, `Edit guard: ${guardVerdict.reason}`].join(
                  '\n',
                ),
              ),
              structuredError: guardErr3,
            };
          }
        }

        // After auto-expand, the version cache may have been updated — refresh.
        // Prefer the cache (most recently observed version) over the caller's
        // expected_version, which may be stale from an earlier read.
        const freshVersion = versionCacheGet(cacheKey) || call.args.expected_version;
        const freshWorkspaceRevision = getWorkspaceRevisionByKey(cacheKey);

        // Stale warning (soft — doesn't block, just informs)
        const staleWarning = fileLedger.getStaleWarning(call.args.path);

        try {
          const result = await retryOnContainerError('sandbox_write_file', () =>
            freshWorkspaceRevision === undefined
              ? writeToSandbox(sandboxId, call.args.path, call.args.content, freshVersion)
              : writeToSandbox(
                  sandboxId,
                  call.args.path,
                  call.args.content,
                  freshVersion,
                  freshWorkspaceRevision,
                ),
          );

          if (!result.ok) {
            if (result.code === 'WORKSPACE_CHANGED') {
              const staleMarked = invalidateWorkspaceSnapshots(
                sandboxId,
                result.current_workspace_revision ?? result.workspace_revision,
              );
              recordWriteFileMetric({
                durationMs: Date.now() - writeStart,
                outcome: 'stale',
                errorCode: 'WORKSPACE_CHANGED',
              });
              const expected =
                result.expected_workspace_revision ?? freshWorkspaceRevision ?? 'unknown';
              const current =
                result.current_workspace_revision ?? result.workspace_revision ?? 'unknown';
              const err: StructuredToolError = {
                type: 'WORKSPACE_CHANGED',
                retryable: false,
                message: `Workspace changed before ${call.args.path} could be written.`,
                detail: `expected_revision=${expected} current_revision=${current}`,
              };
              return {
                text: formatStructuredError(
                  err,
                  [
                    `[Tool Error — sandbox_write_file]`,
                    `Workspace changed before ${call.args.path} could be written.`,
                    `Expected workspace revision: ${expected}`,
                    `Current workspace revision: ${current}`,
                    staleMarked > 0
                      ? `Marked ${staleMarked} previously-read file(s) as stale.`
                      : null,
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
                versionCacheSet(cacheKey, result.current_version);
              } else {
                versionCacheDelete(cacheKey);
              }
              fileLedger.markStale(call.args.path);
              symbolLedger.invalidate(call.args.path);
              recordWriteFileMetric({
                durationMs: Date.now() - writeStart,
                outcome: 'stale',
                errorCode: 'STALE_FILE',
              });
              const expected = result.expected_version || freshVersion || 'unknown';
              const current = result.current_version || 'missing';
              const err: StructuredToolError = {
                type: 'STALE_FILE',
                retryable: false,
                message: `Stale write rejected for ${call.args.path}.`,
                detail: `expected=${expected} current=${current}`,
              };
              return {
                text: formatStructuredError(
                  err,
                  [
                    `[Tool Error — sandbox_write_file]`,
                    `Stale write rejected for ${call.args.path}.`,
                    `Expected version: ${expected}`,
                    `Current version: ${current}`,
                    `Re-read the file with sandbox_read_file, apply edits to the latest content, then retry.`,
                  ].join('\n'),
                ),
                structuredError: err,
              };
            }

            const errorCode = result.code || 'WRITE_FAILED';
            recordWriteFileMetric({
              durationMs: Date.now() - writeStart,
              outcome: 'error',
              errorCode,
            });
            const detail = result.error || 'Unknown error';
            const writeErr = classifyError(detail, call.args.path);
            return {
              text: formatStructuredError(writeErr, formatSandboxError(detail, call.args.path)),
              structuredError: writeErr,
            };
          }

          const previousVersion = versionCacheGet(cacheKey);
          if (typeof result.new_version === 'string' && result.new_version) {
            versionCacheSet(cacheKey, result.new_version);
          }
          if (typeof result.workspace_revision === 'number') {
            setSandboxWorkspaceRevision(sandboxId, result.workspace_revision);
            setWorkspaceRevisionByKey(cacheKey, result.workspace_revision);
          }

          // Build result message — no extra HTTP round-trip for git verification.
          // The write result already provides bytes_written and new_version.
          const lines: string[] = [
            `[Tool Result — sandbox_write_file]`,
            `Wrote ${call.args.path} (${result.bytes_written ?? call.args.content.length} bytes)`,
          ];
          if (result.new_version) {
            lines.push(`New version: ${result.new_version}`);
          }

          // Detect identical content by comparing version hashes (local check, no HTTP call)
          if (previousVersion && result.new_version === previousVersion) {
            lines.push(
              `⚠ Note: Content is identical to the previous version — no effective change.`,
            );
          } else if (!call.args.path.startsWith('/workspace')) {
            lines.push(`⚠ Note: File is outside /workspace — git will not track this file.`);
          }

          // Stale warning from edit guard (soft, non-blocking)
          if (staleWarning) {
            lines.push(`⚠ ${staleWarning}`);
          }

          // Record successful write — model now "owns" this file content
          fileLedger.recordCreation(call.args.path);
          fileLedger.recordMutation(call.args.path, 'agent');
          symbolLedger.invalidate(call.args.path);

          const writeDiagnostics = await runPerEditDiagnostics(sandboxId, call.args.path);
          if (writeDiagnostics) {
            lines.push('', '[DIAGNOSTICS]', writeDiagnostics);
          }

          const writePostconditions: ToolMutationPostconditions = {
            touchedFiles: [
              {
                path: call.args.path,
                mutation: 'write',
                bytesWritten: result.bytes_written ?? call.args.content.length,
                versionBefore: freshVersion ?? previousVersion ?? null,
                versionAfter: result.new_version ?? null,
                changedSpans: [{ kind: 'full_write' }],
              },
            ],
            diagnostics: [buildPerEditDiagnosticSummary(call.args.path, writeDiagnostics)],
            guardWarnings: staleWarning ? [staleWarning] : undefined,
          };
          appendMutationPostconditions(lines, writePostconditions);

          recordWriteFileMetric({
            durationMs: Date.now() - writeStart,
            outcome: 'success',
          });
          return { text: lines.join('\n'), postconditions: writePostconditions };
        } catch (writeErr) {
          const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          const errCode = errMsg.match(/\(([A-Z_]+)\)/)?.[1] || 'WRITE_EXCEPTION';
          recordWriteFileMetric({
            durationMs: Date.now() - writeStart,
            outcome: 'error',
            errorCode: errCode,
          });
          const writeError = classifyError(errMsg, call.args.path);
          return {
            text: formatStructuredError(writeError, formatSandboxError(errMsg, call.args.path)),
            structuredError: writeError,
          };
        }
      }

      case 'sandbox_diff': {
        return handleSandboxDiff(buildGitReleaseContext(sandboxId));
      }

      case 'sandbox_prepare_commit': {
        return handlePrepareCommit(buildGitReleaseContext(sandboxId), call.args, {
          providerOverride: options?.auditorProviderOverride,
          modelOverride: options?.auditorModelOverride,
        });
      }

      case 'sandbox_push': {
        return handleSandboxPush(buildGitReleaseContext(sandboxId));
      }

      case 'sandbox_run_tests': {
        return handleRunTests(buildVerificationContext(sandboxId), call.args);
      }

      case 'sandbox_check_types': {
        return handleCheckTypes(buildVerificationContext(sandboxId));
      }

      case 'sandbox_verify_workspace': {
        return handleVerifyWorkspace(buildVerificationContext(sandboxId));
      }

      case 'sandbox_download': {
        const archivePath = normalizeSandboxPath(call.args.path || '/workspace');
        const result = await downloadFromSandbox(sandboxId, archivePath);

        if (!result.ok || !result.archiveBase64) {
          return { text: `[Tool Error] Download failed: ${result.error || 'Unknown error'}` };
        }

        const sizeKB = Math.round((result.sizeBytes || 0) / 1024);
        return {
          text: `[Tool Result — sandbox_download]\nArchive ready: ${result.format} (${sizeKB} KB)`,
          card: {
            type: 'sandbox-download',
            data: {
              path: archivePath,
              format: result.format || 'tar.gz',
              sizeBytes: result.sizeBytes || 0,
              archiveBase64: result.archiveBase64,
            },
          },
        };
      }

      case 'sandbox_save_draft': {
        return handleSaveDraft(buildGitReleaseContext(sandboxId), call.args);
      }

      case 'promote_to_github': {
        return handlePromoteToGithub(buildGitReleaseContext(sandboxId), call.args);
      }

      case 'sandbox_read_symbols': {
        return handleReadSymbols(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_find_references': {
        return handleFindReferences(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_apply_patchset': {
        const { edits, dryRun, checks, rollbackOnFailure } = call.args;

        if (!edits || edits.length === 0) {
          return { text: '[Tool Error — sandbox_apply_patchset] No edits provided.' };
        }

        // Reject duplicate file paths — each path must appear exactly once
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

        // --- Edit Guard: symbolic check for each file in the patchset ---
        // Run guard checks in parallel, caching auto-expand results for reuse in Phase 1
        const guardCachedFiles = new Map<
          string,
          { content: string; version?: string; workspaceRevision?: number }
        >();
        const guardBlocked: string[] = [];
        const guardWarnings: string[] = [];
        const guardChecks = edits.map(async (edit) => {
          const patchEditContent = getPatchsetEditContent(edit);
          const patchVerdict = fileLedger.checkSymbolicEditAllowed(edit.path, patchEditContent);
          if (!patchVerdict.allowed) {
            // Auto-expand: try reading the file to populate ledger
            fileLedger.recordAutoExpandAttempt();
            try {
              const autoRead = (await readFromSandbox(sandboxId, edit.path)) as FileReadResult & {
                error?: string;
              };
              if (!autoRead.error && autoRead.content !== undefined) {
                let content = autoRead.content;
                let version = autoRead.version;
                let workspaceRevision = autoRead.workspace_revision;
                let truncated = Boolean(autoRead.truncated);
                if (truncated) {
                  const expanded = await readFullFileByChunks(
                    sandboxId,
                    edit.path,
                    autoRead.version,
                  );
                  content = expanded.content;
                  version = expanded.version ?? version;
                  workspaceRevision = expanded.workspaceRevision ?? workspaceRevision;
                  truncated = expanded.truncated;
                }
                const lineCount = content.split('\n').length;
                const symbols = extractSignaturesWithLines(content);
                fileLedger.recordRead(edit.path, {
                  truncated,
                  totalLines: lineCount,
                  symbols,
                });
                syncReadSnapshot(sandboxId, edit.path, {
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
                fileLedger.recordAutoExpandSuccess();
                if (symbols.length > 0) fileLedger.recordSymbolAutoExpand();
                // Cache the fetched content so Phase 1 can reuse it
                guardCachedFiles.set(edit.path, {
                  content,
                  version: typeof version === 'string' ? version : undefined,
                  workspaceRevision:
                    typeof workspaceRevision === 'number' ? workspaceRevision : undefined,
                });
                // Re-check after auto-expand
                const retryVerdict = fileLedger.checkSymbolicEditAllowed(
                  edit.path,
                  patchEditContent,
                );
                if (!retryVerdict.allowed) {
                  if (isUnknownSymbolGuardReason(retryVerdict.reason) && !truncated) {
                    guardWarnings.push(
                      `${edit.path}: ${retryVerdict.reason} (proceeded after full auto-read)`,
                    );
                    fileLedger.recordSymbolWarningSoftened();
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
              guardBlocked.push(
                `${edit.path}: ${patchVerdict.reason} (auto-read threw: ${errMsg})`,
              );
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

        // Read all files in parallel (reuse cached content from guard auto-expand)
        const readPromises = edits.map(async (edit) => {
          // If the guard already fetched this file, reuse it
          const cached = guardCachedFiles.get(edit.path);
          if (cached) {
            fileContents.set(edit.path, cached);
            return;
          }
          try {
            const readResult = (await readFromSandbox(sandboxId, edit.path)) as FileReadResult & {
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
              const expanded = await readFullFileByChunks(sandboxId, edit.path, readResult.version);
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
            syncReadSnapshot(sandboxId, edit.path, {
              content,
              truncated: false,
              version: typeof version === 'string' ? version : undefined,
              workspace_revision: workspaceRevision,
            });
            fileContents.set(edit.path, {
              content,
              version: typeof version === 'string' ? version : undefined,
              workspaceRevision:
                typeof workspaceRevision === 'number' ? workspaceRevision : undefined,
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
          const staleMarked = invalidateWorkspaceSnapshots(
            sandboxId,
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
          if (!fileData) continue; // shouldn't happen given the check above

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
            const retryHints = await buildHashlineRetryHints(
              fileData.content,
              compiledOps,
              edit.path,
            );
            validationErrors.push(
              [
                `${edit.path}: ${editResult.errors.join('; ')}`,
                ...(retryHints.length > 0 ? [`retry hints: ${retryHints.join(' ')}`] : []),
              ].join(' '),
            );
          } else {
            if (editResult.warnings.length > 0) {
              guardWarnings.push(
                ...editResult.warnings.map((warning) => `${edit.path}: ${warning}`),
              );
            }
            // Truncation-hashline sync: verify resolved lines fall within read ranges
            if (editResult.resolvedLines.length > 0) {
              const coverageVerdict = fileLedger.checkLinesCovered(
                edit.path,
                editResult.resolvedLines,
              );
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

        // Surface coverage guard failures as EDIT_GUARD_BLOCKED (not hash mismatch)
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
          {
            state: ReturnType<typeof fileLedger.getState>;
            provenance: ReturnType<typeof fileLedger.getProvenance>;
          }
        >();
        if (checks?.length && rollbackOnFailure) {
          for (const edit of edits) {
            ledgerSnapshots.set(edit.path, {
              state: fileLedger.getState(edit.path),
              provenance: fileLedger.getProvenance(edit.path),
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

        // Build index for lookup by path
        const editResultsByPath = new Map(editResults.map((r) => [r.path, r]));

        try {
          const batchEntries: BatchWriteEntry[] = editResults.map((r) => ({
            path: r.path,
            content: r.content,
            expected_version: r.version,
          }));
          const batchResult = await retryOnContainerError('sandbox_apply_patchset', () =>
            patchsetWorkspaceRevision === undefined
              ? batchWriteToSandbox(sandboxId, batchEntries)
              : batchWriteToSandbox(sandboxId, batchEntries, patchsetWorkspaceRevision),
          );

          // Batch-level failure: the backend returned ok:false with no per-file results
          // (e.g. CONTAINER_ERROR after retry, or an unexpected server error).
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
            const staleMarked = invalidateWorkspaceSnapshots(
              sandboxId,
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
                  staleMarked > 0
                    ? `Marked ${staleMarked} previously-read file(s) as stale.`
                    : null,
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
              // Update version cache
              const cacheKey = fileVersionKey(sandboxId, entry.path);
              if (typeof entry.new_version === 'string' && entry.new_version) {
                versionCacheSet(cacheKey, entry.new_version);
              }
              if (typeof batchResult.workspace_revision === 'number') {
                setSandboxWorkspaceRevision(sandboxId, batchResult.workspace_revision);
                setWorkspaceRevisionByKey(cacheKey, batchResult.workspace_revision);
              }
              fileLedger.recordCreation(entry.path);
              fileLedger.recordMutation(entry.path, 'agent');
              symbolLedger.invalidate(entry.path);
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
                    sandboxId,
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
          // fully succeeded server-side — replaying would risk STALE_FILE /
          // WORKSPACE_CHANGED conflicts against already-written content.
          const statusCode = (batchErr as { statusCode?: number }).statusCode;
          if (statusCode !== 404 && statusCode !== 405) {
            // Ambiguous state — batch may have partially succeeded.
            // Full invalidation: version cache, prefetch cache, and file-awareness
            // ledger so the agent must re-read before any follow-up write.
            invalidateWorkspaceSnapshots(sandboxId);
            const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
            const err: StructuredToolError = {
              type: 'WRITE_FAILED',
              retryable: false,
              message: `Batch write failed with ambiguous state (${statusCode ? `HTTP ${statusCode}` : 'timeout/network'}). Some files may have been written. Re-read affected files before retrying.`,
              detail: errMsg,
            };
            return {
              text: formatStructuredError(
                err,
                `[Tool Error — sandbox_apply_patchset] ${err.message}`,
              ),
              structuredError: err,
            };
          }

          // HTTP 404/405 — batch endpoint unavailable, safe to retry sequentially.
          // Drop workspace revision guard: each sequential write bumps the revision,
          // so passing the original would cause WORKSPACE_CHANGED on file 2+.
          // Per-file expected_version still guards content integrity.
          console.warn(
            '[sandbox-tools] batch endpoint unavailable (404/405), falling back to sequential writes',
          );
          for (const r of editResults) {
            versionCacheDeletePath(sandboxId, r.path);
          }
          for (const r of editResults) {
            try {
              const writeResult = await writeToSandbox(sandboxId, r.path, r.content, r.version);
              if (!writeResult.ok) {
                if (writeResult.code === 'STALE_FILE') {
                  staleFailureCount += 1;
                  writeFailures.push(
                    recordPatchsetStaleConflict(
                      sandboxId,
                      r.path,
                      writeResult.expected_version || r.version,
                      writeResult.current_version,
                    ),
                  );
                } else {
                  writeFailures.push(`${r.path}: ${writeResult.error || 'write failed'}`);
                }
              } else {
                const cacheKey = fileVersionKey(sandboxId, r.path);
                if (typeof writeResult.new_version === 'string' && writeResult.new_version) {
                  versionCacheSet(cacheKey, writeResult.new_version);
                }
                if (typeof writeResult.workspace_revision === 'number') {
                  setSandboxWorkspaceRevision(sandboxId, writeResult.workspace_revision);
                  setWorkspaceRevisionByKey(cacheKey, writeResult.workspace_revision);
                }
                fileLedger.recordCreation(r.path);
                fileLedger.recordMutation(r.path, 'agent');
                symbolLedger.invalidate(r.path);
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
          lines.push(
            'Re-read failed files before retrying to avoid stale or partial-overwrite risk.',
          );
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
              // Single-quote the command to prevent shell expansion ($VAR, $(cmd), backticks)
              const escaped = check.command.replace(/'/g, "'\\''");
              const wrappedCommand = `timeout ${timeoutSec} sh -c '${escaped}' 2>&1`;
              const result = await execInSandbox(sandboxId, wrappedCommand);
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
              // Write back original content without version check (force restore)
              const restoreResult = await writeToSandbox(sandboxId, edit.path, original.content);
              if (restoreResult.ok) {
                // Update version cache with restored version
                const cacheKey = fileVersionKey(sandboxId, edit.path);
                if (typeof restoreResult.new_version === 'string' && restoreResult.new_version) {
                  versionCacheSet(cacheKey, restoreResult.new_version);
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
              fileLedger.restoreState(edit.path, snapshot.state);
              if (snapshot.provenance) {
                fileLedger.recordMutation(edit.path, snapshot.provenance.modifiedBy);
              } else {
                fileLedger.clearProvenance(edit.path);
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
              const truncOutput =
                cr.output.length > 800 ? cr.output.slice(0, 800) + '…' : cr.output;
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

        // Append check results if checks passed
        if (checksResults.length > 0) {
          lines.push('', 'Post-write checks:');
          for (const cr of checksResults) {
            lines.push(`  ✓ ${cr.command} (exit ${cr.exitCode})`);
          }
        }

        // Tier 2 ambient diagnostics: full project typecheck after patchset (1A)
        let patchDiagnostics: string | null = null;
        if (call.args.diagnostics !== false) {
          const changedPaths = editResults.map((r) => r.path);
          patchDiagnostics = await runPatchsetDiagnostics(sandboxId, changedPaths);
          if (patchDiagnostics) {
            lines.push('', '[DIAGNOSTICS — project typecheck]', patchDiagnostics);
          }
        }
        const patchsetPostconditions: ToolMutationPostconditions = {
          touchedFiles: buildPatchsetTouchedFiles(editResults, successfulWrites),
          diagnostics: [
            buildPatchsetDiagnosticSummary(
              editResults.map((result) => result.path),
              call.args.diagnostics !== false,
              patchDiagnostics,
            ),
          ],
          checks: checksResults.length > 0 ? checksResults : undefined,
          guardWarnings: guardWarnings.length > 0 ? guardWarnings : undefined,
        };
        appendMutationPostconditions(lines, patchsetPostconditions);

        return { text: lines.join('\n'), postconditions: patchsetPostconditions };
      }

      default:
        return {
          text: `[Tool Error] Unknown sandbox tool: ${String((call as { tool?: unknown }).tool ?? 'unknown')}`,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Push] Sandbox tool error:', msg);
    const catchErr = classifyError(msg, String((call as { tool?: unknown }).tool ?? 'unknown'));
    return {
      text: formatStructuredError(catchErr, `[Tool Error] ${msg}`),
      structuredError: catchErr,
    };
  }
}
