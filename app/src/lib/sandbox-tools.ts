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
  DiffPreviewCardData,
  FileListCardData,
  ToolMutationCheckResult,
  ToolMutationDiagnostic,
  ToolMutationFilePostcondition,
  ToolMutationPostconditions,
  ToolMutationSpan,
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
import { parseDiffStats } from './diff-utils';
import { recordReadFileMetric, recordWriteFileMetric } from './edit-metrics';
import {
  fileLedger,
  extractSignatures,
  extractSignaturesWithLines,
  type SymbolRead,
  type SymbolKind,
} from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import {
  adaptiveHashDisplayLength,
  applyHashlineEdits,
  calculateLineHash,
  type HashlineOp,
} from './hashline';
import {
  filterSensitiveDirectoryEntries,
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard';
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
  formatSandboxDisplayPath,
  formatSandboxDisplayScope,
  normalizeUnicode,
  extractSandboxSearchResultPath,
  formatSandboxError,
  diagnoseExecFailure,
  classifyError,
  formatStructuredError,
  buildSearchNoResultsHints,
  buildSearchPathErrorHints,
  retryOnContainerError,
  shellEscape,
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
  parseLineQualifiedRef,
  recordPatchsetStaleConflict,
  buildPatchsetFailureDetail,
  buildHashlineRetryHints,
  refreshSameLineQualifiedRefs,
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
  type GitReleaseHandlerContext,
} from './sandbox-git-release-handlers';

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

const POSTCONDITION_OUTPUT_LIMIT = 1200;
const SUPPORTED_PER_EDIT_DIAGNOSTIC_EXT_RE = /\.(ts|tsx|js|jsx|py)$/i;
const SUPPORTED_PATCHSET_DIAGNOSTIC_EXT_RE = /\.(ts|tsx)$/i;

function buildLineRanges(
  lineNumbers: readonly number[],
): Array<{ startLine: number; endLine: number }> {
  const sorted = [
    ...new Set(lineNumbers.filter((lineNo) => Number.isFinite(lineNo) && lineNo > 0)),
  ].sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const ranges: Array<{ startLine: number; endLine: number }> = [];
  let startLine = sorted[0];
  let endLine = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const lineNo = sorted[i];
    if (lineNo === endLine + 1) {
      endLine = lineNo;
      continue;
    }
    ranges.push({ startLine, endLine });
    startLine = lineNo;
    endLine = lineNo;
  }

  ranges.push({ startLine, endLine });
  return ranges;
}

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

function buildHashlineChangedSpans(
  ops: readonly HashlineOp[],
  resolvedLines: readonly number[],
): ToolMutationSpan[] {
  const refs = [...new Set(ops.map((op) => op.ref))];
  const opNames = [...new Set(ops.map((op) => op.op))];
  const ranges = buildLineRanges(resolvedLines);

  if (ranges.length === 0) {
    return [{ kind: 'hashline', refs, ops: opNames }];
  }

  return ranges.map(({ startLine, endLine }) => ({
    kind: 'hashline',
    startLine,
    endLine,
    lineNumbers: resolvedLines.filter((lineNo) => lineNo >= startLine && lineNo <= endLine),
    refs,
    ops: opNames,
  }));
}

function buildPerEditDiagnosticSummary(
  filePath: string,
  output: string | null,
): ToolMutationDiagnostic {
  return {
    scope: 'single-file',
    label: 'syntax check',
    path: filePath,
    status: output
      ? 'issues'
      : SUPPORTED_PER_EDIT_DIAGNOSTIC_EXT_RE.test(filePath)
        ? 'clean'
        : 'skipped',
    ...(output ? { output } : {}),
  };
}

function buildPatchsetDiagnosticSummary(
  changedFiles: readonly string[],
  enabled: boolean,
  output: string | null,
): ToolMutationDiagnostic {
  const hasSupportedFile = changedFiles.some((filePath) =>
    SUPPORTED_PATCHSET_DIAGNOSTIC_EXT_RE.test(filePath),
  );
  return {
    scope: 'project',
    label: 'project typecheck',
    status: !enabled ? 'skipped' : output ? 'issues' : hasSupportedFile ? 'clean' : 'skipped',
    ...(output ? { output } : {}),
  };
}

function truncatePostconditionOutput(output?: string): string | undefined {
  const trimmed = output?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= POSTCONDITION_OUTPUT_LIMIT) return trimmed;
  return `${trimmed.slice(0, POSTCONDITION_OUTPUT_LIMIT)}\n[truncated]`;
}

function formatVersionTransition(before?: string | null, after?: string | null): string | null {
  if (!before && !after) return null;
  return `${before ?? 'unknown'}→${after ?? 'unknown'}`;
}

function summarizeChangedSpans(spans?: readonly ToolMutationSpan[]): string | null {
  if (!spans || spans.length === 0) return null;
  const lineNumbers = new Set<number>();
  for (const span of spans) {
    if (typeof span.startLine === 'number' && typeof span.endLine === 'number') {
      for (let line = span.startLine; line <= span.endLine; line += 1) lineNumbers.add(line);
      continue;
    }
    for (const line of span.lineNumbers ?? []) lineNumbers.add(line);
  }
  if (lineNumbers.size === 0) return `${spans.length} span${spans.length === 1 ? '' : 's'}`;
  const ordered = [...lineNumbers].sort((a, b) => a - b);
  const ranges = buildLineRanges(ordered).map(({ startLine, endLine }) =>
    startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`,
  );
  return `lines ${ranges.join(', ')}`;
}

function appendMutationPostconditions(
  lines: string[],
  postconditions?: ToolMutationPostconditions,
): void {
  if (!postconditions || postconditions.touchedFiles.length === 0) return;

  lines.push('', '[POSTCONDITIONS]');

  const touchedFiles = postconditions.touchedFiles.slice(0, 6);
  lines.push(`touched files: ${postconditions.touchedFiles.length}`);
  for (const touched of touchedFiles) {
    const details = [
      summarizeChangedSpans(touched.changedSpans),
      touched.bytesWritten !== undefined ? `${touched.bytesWritten}B` : null,
      formatVersionTransition(touched.versionBefore, touched.versionAfter),
    ].filter(Boolean);
    lines.push(
      `- ${touched.mutation} ${touched.path}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`,
    );
  }
  if (postconditions.touchedFiles.length > touchedFiles.length) {
    lines.push(
      `- …and ${postconditions.touchedFiles.length - touchedFiles.length} more touched file(s)`,
    );
  }

  if (postconditions.diagnostics?.length) {
    lines.push(`diagnostics: ${postconditions.diagnostics.length}`);
    for (const diagnostic of postconditions.diagnostics.slice(0, 4)) {
      const target = diagnostic.path ? ` ${diagnostic.path}` : '';
      lines.push(`- ${diagnostic.label}: ${diagnostic.status}${target}`);
      const output =
        diagnostic.status === 'issues' ? truncatePostconditionOutput(diagnostic.output) : undefined;
      if (output) {
        lines.push(output);
      }
    }
    if (postconditions.diagnostics.length > 4) {
      lines.push(`- …and ${postconditions.diagnostics.length - 4} more diagnostic result(s)`);
    }
  }

  if (postconditions.checks?.length) {
    lines.push(`checks: ${postconditions.checks.length}`);
    for (const check of postconditions.checks.slice(0, 4)) {
      lines.push(
        `- ${check.passed ? 'passed' : 'failed'} exit=${check.exitCode}: ${check.command}`,
      );
      const output = check.passed ? undefined : truncatePostconditionOutput(check.output);
      if (output) {
        lines.push(output);
      }
    }
    if (postconditions.checks.length > 4) {
      lines.push(`- …and ${postconditions.checks.length - 4} more check result(s)`);
    }
  }

  if (postconditions.guardWarnings?.length) {
    lines.push(`guard warnings: ${postconditions.guardWarnings.length}`);
    for (const warning of postconditions.guardWarnings.slice(0, 3)) {
      lines.push(`- ${warning}`);
    }
    if (postconditions.guardWarnings.length > 3) {
      lines.push(`- …and ${postconditions.guardWarnings.length - 3} more guard warning(s)`);
    }
  }

  if (typeof postconditions.writeVerified === 'boolean') {
    lines.push(`write verified: ${postconditions.writeVerified ? 'yes' : 'no'}`);
  }
  if (postconditions.rollbackApplied) {
    lines.push('rollback applied: yes');
  }

  lines.push('[/POSTCONDITIONS]');
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
        if (isSensitivePath(call.args.path)) {
          return { text: formatSensitivePathToolError(call.args.path) };
        }
        const isRangeRead = call.args.start_line !== undefined || call.args.end_line !== undefined;
        const result = (await readFromSandbox(
          sandboxId,
          call.args.path,
          call.args.start_line,
          call.args.end_line,
        )) as FileReadResult & { error?: string };
        const cacheKey = fileVersionKey(sandboxId, call.args.path);

        // Handle directory or read errors (e.g. "cat: /path: Is a directory")
        if (result.error) {
          if (result.code === 'WORKSPACE_CHANGED') {
            invalidateWorkspaceSnapshots(sandboxId, result.current_workspace_revision);
          }
          versionCacheDelete(cacheKey);
          recordReadFileMetric({
            outcome: 'error',
            payloadChars: 0,
            isRangeRead,
            errorCode: 'READ_ERROR',
          });
          const err = classifyError(result.error, call.args.path);
          return {
            text: formatStructuredError(err, formatSandboxError(result.error, call.args.path)),
            structuredError: err,
          };
        }

        syncReadSnapshot(sandboxId, call.args.path, result);

        const rangeStart =
          typeof result.start_line === 'number' ? result.start_line : (call.args.start_line ?? 1);
        const rangeEnd = typeof result.end_line === 'number' ? result.end_line : call.args.end_line;

        // For every read: add hashline anchors and line numbers to the tool result text
        let toolResultContent = '';
        const emptyRangeWarning = '';
        let visibleLineCount = 0;
        const safeContentResult = redactSensitiveText(result.content);
        const safeContent = safeContentResult.text;
        if (safeContent) {
          const contentLines = safeContent.split('\n');
          // If content ends with a trailing newline, the last split element is empty — don't number it
          const hasTrailingNewline = safeContent.endsWith('\n') && contentLines.length > 1;
          const linesToNumber = hasTrailingNewline ? contentLines.slice(0, -1) : contentLines;
          visibleLineCount = linesToNumber.length;
          const maxLineNum = Math.max(rangeStart, rangeStart + linesToNumber.length - 1);
          const padWidth = String(maxLineNum).length;

          const fullHashPromises = linesToNumber.map((line) => calculateLineHash(line, 12));
          const fullHashes = await Promise.all(fullHashPromises);
          const hashDisplayLen = adaptiveHashDisplayLength(fullHashes);
          const lineHashes = fullHashes.map((h) => h.slice(0, hashDisplayLen));

          toolResultContent = linesToNumber
            .map(
              (line, idx) =>
                `${String(rangeStart + idx).padStart(padWidth)}:${lineHashes[idx]}\t${line}`,
            )
            .join('\n');
        }

        // --- File Awareness Ledger: record what the model has seen ---
        const contentLineCount = visibleLineCount;
        // If start_line was provided without end_line and the result wasn't
        // truncated, the server returned the entire file from that offset —
        // treat it as a full read so the ledger doesn't false-positive as
        // partial_read.
        const effectivelyFullRead = isRangeRead && !rangeEnd && !result.truncated;
        // Extract symbols for ledger tracking
        const readStartLine = isRangeRead && !effectivelyFullRead ? rangeStart : 1;
        const symbols = result.content
          ? extractSignaturesWithLines(result.content, readStartLine)
          : [];
        if (!emptyRangeWarning) {
          fileLedger.recordRead(call.args.path, {
            startLine: isRangeRead && !effectivelyFullRead ? rangeStart : undefined,
            endLine:
              isRangeRead && !effectivelyFullRead
                ? (rangeEnd ?? rangeStart + contentLineCount - 1)
                : undefined,
            truncated: Boolean(result.truncated),
            totalLines: contentLineCount,
            symbols,
          });
        }

        // --- Phase 2: Signature extraction for truncated reads ---
        // When content is truncated, extract structural signatures from the
        // visible portion so the model knows what functions/classes exist
        // beyond the truncation point. Appended to the truncation notice.
        let signatureHint = '';
        if (result.truncated && result.content) {
          const sigs = extractSignatures(result.content);
          if (sigs) {
            signatureHint = `[Truncated content ${sigs}]`;
          }
        }

        const truncationLines = result.truncated
          ? [
              typeof result.truncated_at_line === 'number'
                ? `truncated_at_line: ${result.truncated_at_line}`
                : null,
              typeof result.remaining_bytes === 'number'
                ? `remaining_bytes: ${result.remaining_bytes}`
                : null,
            ].filter((line): line is string => Boolean(line))
          : [];

        const fileLabel = isRangeRead
          ? `Lines ${rangeStart}-${rangeEnd ?? '∞'} of ${call.args.path}`
          : `File: ${call.args.path}`;

        const lines: string[] = [
          `[Tool Result — sandbox_read_file]`,
          fileLabel,
          `Version: ${result.version || 'unknown'}`,
          result.truncated ? `(truncated)` : '',
          safeContentResult.redacted ? `Redactions: secret-like values hidden.` : '',
          ...truncationLines,
          signatureHint,
          emptyRangeWarning,
          toolResultContent,
        ].filter(Boolean);

        const emptyRange = isRangeRead && !result.content;
        recordReadFileMetric({
          outcome: 'success',
          payloadChars: result.content.length,
          isRangeRead,
          truncated: Boolean(result.truncated),
          emptyRange,
        });

        // Guess language from extension
        const ext = call.args.path.split('.').pop()?.toLowerCase() || '';
        const sandboxLangMap: Record<string, string> = {
          ts: 'typescript',
          tsx: 'typescript',
          js: 'javascript',
          jsx: 'javascript',
          py: 'python',
          rs: 'rust',
          go: 'go',
          rb: 'ruby',
          java: 'java',
          md: 'markdown',
          json: 'json',
          yaml: 'yaml',
          yml: 'yaml',
          css: 'css',
          html: 'html',
          sh: 'shell',
          bash: 'shell',
          toml: 'toml',
          sql: 'sql',
          c: 'c',
          cpp: 'cpp',
          h: 'c',
        };
        const language = sandboxLangMap[ext] || ext;

        return {
          text: lines.join('\n'),
          card: {
            type: 'editor',
            data: {
              path: call.args.path,
              content: safeContent, // Card gets clean content — no line numbers
              language,
              truncated: result.truncated,
              version: typeof result.version === 'string' ? result.version : undefined,
              workspaceRevision:
                typeof result.workspace_revision === 'number'
                  ? result.workspace_revision
                  : undefined,
              source: 'sandbox' as const,
              sandboxId,
            },
          },
        };
      }

      case 'sandbox_search': {
        const query = call.args.query.trim();
        const searchPath = normalizeSandboxPath(
          (call.args.path || '/workspace').trim() || '/workspace',
        );

        if (!query) {
          return { text: '[Tool Error] sandbox_search requires a non-empty query.' };
        }
        if (isSensitivePath(searchPath)) {
          return { text: formatSensitivePathToolError(searchPath) };
        }

        const escapedQuery = shellEscape(query);
        const escapedPath = shellEscape(searchPath);
        const command = [
          'set -o pipefail;',
          'if command -v rg >/dev/null 2>&1; then',
          `  rg -n --hidden --glob '!.git' --color never -- ${escapedQuery} ${escapedPath} | head -n 121;`,
          'else',
          `  grep -RIn --exclude-dir=.git -- ${escapedQuery} ${escapedPath} | head -n 121;`,
          'fi',
        ].join(' ');

        const result = await execInSandbox(sandboxId, command);
        if (result.exitCode !== 0 && !result.stdout.trim()) {
          // rg returns exit code 1 when no matches; treat as a normal "no results" case.
          if (result.exitCode === 1) {
            const hints = buildSearchNoResultsHints(query, searchPath);
            return {
              text: [
                `[Tool Result — sandbox_search]`,
                `No matches for "${query}" in ${searchPath}.`,
                '',
                'Suggestions:',
                ...hints.map((h) => `- ${h}`),
              ].join('\n'),
            };
          }
          // Exit code 2+ usually means path or argument error — provide specific guidance
          const pathHint = buildSearchPathErrorHints(result.stderr || '', searchPath);
          if (pathHint) {
            return { text: pathHint };
          }
          return {
            text: formatSandboxError(
              result.stderr || 'Search failed',
              `sandbox_search (${searchPath})`,
            ),
          };
        }

        const output = result.stdout.trim();
        if (!output) {
          const hints = buildSearchNoResultsHints(query, searchPath);
          return {
            text: [
              `[Tool Result — sandbox_search]`,
              `No matches for "${query}" in ${searchPath}.`,
              '',
              'Suggestions:',
              ...hints.map((h) => `- ${h}`),
            ].join('\n'),
          };
        }

        const visibleLines: string[] = [];
        let hiddenMatches = 0;
        let redactedMatches = false;
        for (const rawLine of output.split('\n').slice(0, 120)) {
          const matchPath = extractSandboxSearchResultPath(rawLine);
          if (matchPath && isSensitivePath(matchPath)) {
            hiddenMatches += 1;
            continue;
          }
          const safeLine = redactSensitiveText(rawLine);
          redactedMatches ||= safeLine.redacted;
          visibleLines.push(
            safeLine.text.length > 320 ? `${safeLine.text.slice(0, 320)}...` : safeLine.text,
          );
        }

        if (visibleLines.length === 0 && hiddenMatches > 0) {
          return {
            text: [
              '[Tool Result — sandbox_search]',
              `Query: ${query}`,
              `Path: ${searchPath}`,
              'Matches were found only in protected secret files and were hidden.',
            ].join('\n'),
          };
        }

        const matchCount = visibleLines.length;
        const truncated = output.split('\n').length > visibleLines.length || result.truncated;

        return {
          text: [
            '[Tool Result — sandbox_search]',
            `Query: ${query}`,
            `Path: ${searchPath}`,
            `Matches: ${matchCount}${truncated ? ' (truncated)' : ''}`,
            hiddenMatches > 0
              ? `Hidden matches: ${hiddenMatches} secret-file result${hiddenMatches === 1 ? '' : 's'}`
              : '',
            redactedMatches ? 'Redactions: secret-like values hidden.' : '',
            '',
            ...visibleLines,
          ].join('\n'),
        };
      }

      case 'sandbox_list_dir': {
        const dirPath = normalizeSandboxPath(call.args.path || '/workspace');
        if (isSensitivePath(dirPath)) {
          return { text: formatSensitivePathToolError(dirPath) };
        }
        const entries = await listDirectory(sandboxId, dirPath);
        const filtered = filterSensitiveDirectoryEntries(dirPath, entries);

        const dirs = filtered.entries.filter((e) => e.type === 'directory');
        const files = filtered.entries.filter((e) => e.type === 'file');

        const lines: string[] = [
          `[Tool Result — sandbox_list_dir]`,
          `Directory: ${dirPath}`,
          `${dirs.length} directories, ${files.length} files\n`,
          filtered.hiddenCount > 0
            ? `(${filtered.hiddenCount} sensitive entr${filtered.hiddenCount === 1 ? 'y' : 'ies'} hidden)\n`
            : '',
        ];

        for (const d of dirs) {
          lines.push(`  📁 ${d.name}/`);
        }
        for (const f of files) {
          const size = f.size ? ` (${f.size} bytes)` : '';
          lines.push(`  📄 ${f.name}${size}`);
        }

        const cardData: FileListCardData = {
          path: dirPath,
          entries: [
            ...dirs.map((d) => ({ name: d.name, type: 'directory' as const })),
            ...files.map((f) => ({
              name: f.name,
              type: 'file' as const,
              size: f.size || undefined,
            })),
          ],
        };

        return { text: lines.join('\n'), card: { type: 'file-list', data: cardData } };
      }

      case 'sandbox_edit_file': {
        const { path, edits } = call.args;

        // --- Edit Guard: symbolic check before editing ---
        // Build a combined string from all edit ops to extract symbols the edit touches
        const editContentForGuard = edits
          .filter((op): op is Extract<HashlineOp, { content: string }> => 'content' in op)
          .map((op) => op.content)
          .join('\n');
        // Cache auto-expand result so Step 1 can reuse it instead of re-fetching
        let guardCachedContent: string | null = null;
        let guardCachedVersion: string | null = null;
        let guardCachedWorkspaceRevision: number | null = null;
        let guardCachedTruncated = false;
        let symbolicWarning: string | null = null;
        const prefetched = takePrefetchedEditFile(sandboxId, path);
        if (prefetched) {
          const prefetchedLineCount = prefetched.content.split('\n').length;
          const prefetchedSymbols = extractSignaturesWithLines(prefetched.content);
          fileLedger.recordRead(path, {
            truncated: prefetched.truncated,
            totalLines: prefetchedLineCount,
            symbols: prefetchedSymbols,
          });
          if (typeof prefetched.version === 'string' && prefetched.version) {
            versionCacheSet(fileVersionKey(sandboxId, path), prefetched.version);
          }
          if (typeof prefetched.workspaceRevision === 'number') {
            setSandboxWorkspaceRevision(sandboxId, prefetched.workspaceRevision);
            setWorkspaceRevisionByKey(
              fileVersionKey(sandboxId, path),
              prefetched.workspaceRevision,
            );
          }
          guardCachedContent = prefetched.content;
          guardCachedVersion = typeof prefetched.version === 'string' ? prefetched.version : null;
          guardCachedWorkspaceRevision =
            typeof prefetched.workspaceRevision === 'number' ? prefetched.workspaceRevision : null;
          guardCachedTruncated = prefetched.truncated;
        }
        const symbolicVerdict = fileLedger.checkSymbolicEditAllowed(path, editContentForGuard);
        if (!symbolicVerdict.allowed) {
          // Auto-expand: try reading the file so the ledger has coverage
          fileLedger.recordAutoExpandAttempt();
          try {
            const autoReadResult = (await readFromSandbox(sandboxId, path)) as FileReadResult & {
              error?: string;
            };
            if (!autoReadResult.error && autoReadResult.content !== undefined) {
              let autoContent = autoReadResult.content;
              let autoVersion = autoReadResult.version;
              let autoWorkspaceRevision = autoReadResult.workspace_revision;
              let autoTruncated = Boolean(autoReadResult.truncated);
              if (autoTruncated) {
                const expanded = await readFullFileByChunks(
                  sandboxId,
                  path,
                  autoReadResult.version,
                );
                autoContent = expanded.content;
                autoVersion = expanded.version ?? autoVersion;
                autoWorkspaceRevision = expanded.workspaceRevision ?? autoWorkspaceRevision;
                autoTruncated = expanded.truncated;
              }
              const autoLineCount = autoContent.split('\n').length;
              const autoSymbols = extractSignaturesWithLines(autoContent);
              fileLedger.recordRead(path, {
                truncated: autoTruncated,
                totalLines: autoLineCount,
                symbols: autoSymbols,
              });
              syncReadSnapshot(sandboxId, path, {
                content: autoContent,
                truncated: autoTruncated,
                version: autoVersion ?? undefined,
                workspace_revision: autoWorkspaceRevision,
              });
              fileLedger.recordAutoExpandSuccess();
              if (autoSymbols.length > 0) fileLedger.recordSymbolAutoExpand();
              console.debug(
                `[edit-guard] Auto-expanded "${path}" for sandbox_edit_file (${autoLineCount} lines, ${autoSymbols.length} symbols).`,
              );
              // Cache for reuse in Step 1
              guardCachedContent = autoContent;
              guardCachedVersion = typeof autoVersion === 'string' ? autoVersion : null;
              guardCachedWorkspaceRevision =
                typeof autoWorkspaceRevision === 'number' ? autoWorkspaceRevision : null;
              guardCachedTruncated = autoTruncated;
              // Re-check after auto-expand
              const retryVerdict = fileLedger.checkSymbolicEditAllowed(path, editContentForGuard);
              if (!retryVerdict.allowed) {
                if (isUnknownSymbolGuardReason(retryVerdict.reason) && !autoTruncated) {
                  symbolicWarning = `${retryVerdict.reason} Proceeding because the file was fully auto-read.`;
                  fileLedger.recordSymbolWarningSoftened();
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
              // Auto-read failed — block the edit
              const guardErr: StructuredToolError = {
                type: 'EDIT_GUARD_BLOCKED',
                retryable: false,
                message: `Edit guard: ${symbolicVerdict.reason}`,
                detail: autoReadResult.error
                  ? `Auto-read error: ${autoReadResult.error}`
                  : undefined,
              };
              return {
                text: formatStructuredError(
                  guardErr,
                  [
                    `[Tool Error — sandbox_edit_file]`,
                    `Edit guard: ${symbolicVerdict.reason}`,
                  ].join('\n'),
                ),
                structuredError: guardErr,
              };
            }
          } catch (autoExpandErr) {
            const errMsg =
              autoExpandErr instanceof Error ? autoExpandErr.message : String(autoExpandErr);
            const guardErr: StructuredToolError = {
              type: 'EDIT_GUARD_BLOCKED',
              retryable: false,
              message: `Edit guard: ${symbolicVerdict.reason}`,
              detail: `Auto-read threw: ${errMsg}`,
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
          readResult = (await readFromSandbox(sandboxId, path)) as FileReadResult & {
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
        syncReadSnapshot(sandboxId, path, readResult);

        if (readResult.truncated) {
          const expanded = await readFullFileByChunks(sandboxId, path, readResult.version);
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
          syncReadSnapshot(sandboxId, path, readResult);
        }
        // 2. Apply hashline edits (with narrow auto-recovery for stale
        // line-qualified refs to reduce manual correction loops).
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
              let retryRead = (await readFromSandbox(sandboxId, path)) as FileReadResult & {
                error?: string;
              };
              if (!retryRead.error) {
                if (retryRead.truncated) {
                  const expanded = await readFullFileByChunks(sandboxId, path, retryRead.version);
                  if (expanded.truncated) {
                    autoRetryNote = 'Auto-retry skipped: latest file hydration remained truncated.';
                  } else {
                    retryRead = {
                      ...retryRead,
                      content: expanded.content,
                      truncated: expanded.truncated,
                      version: expanded.version ?? retryRead.version,
                      workspace_revision:
                        expanded.workspaceRevision ?? retryRead.workspace_revision,
                    };
                  }
                }

                if (!retryRead.truncated) {
                  syncReadSnapshot(sandboxId, path, retryRead);
                  // Strip line-number prefixes and retry by hash only when the target
                  // content may have moved elsewhere in the file.
                  const hashOnlyEdits = edits.map((op) => {
                    const m = op.ref.trim().match(/^\d+:([a-f0-9]{7,12})$/i);
                    return m ? { ...op, ref: m[1] } : op;
                  });
                  const retryEditResult = await applyHashlineEdits(
                    retryRead.content,
                    hashOnlyEdits,
                  );
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
        // the model's read ranges. This is a belt-and-suspenders guard — the model
        // normally can't produce valid hashes for unseen lines, but an explicit
        // cross-check closes the gap between the hashline and ledger systems.
        if (editResult.resolvedLines.length > 0) {
          const coverageVerdict = fileLedger.checkLinesCovered(path, editResult.resolvedLines);
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

        // 3. Write the edited content directly (instead of delegating to sandbox_write_file)
        // Transient failures (5xx, timeout, network) are retried by sandbox-client withRetry().
        const beforeVersion = readResult.version || 'unknown';
        // Always prefer the version from the fresh read we just performed.
        // A caller-provided expected_version may be stale from a previous read, and
        // using it here would cause a spurious STALE_FILE rejection on the server.
        const editCacheKey = fileVersionKey(sandboxId, path);
        const editWriteVersion = readResult.version || undefined;
        const editWriteWorkspaceRevision =
          typeof readResult.workspace_revision === 'number'
            ? readResult.workspace_revision
            : getWorkspaceRevisionByKey(editCacheKey);
        const editWriteResult = await retryOnContainerError('sandbox_edit_file', () =>
          editWriteWorkspaceRevision === undefined
            ? writeToSandbox(sandboxId, path, editResult.content, editWriteVersion)
            : writeToSandbox(
                sandboxId,
                path,
                editResult.content,
                editWriteVersion,
                editWriteWorkspaceRevision,
              ),
        );

        if (!editWriteResult.ok) {
          if (editWriteResult.code === 'WORKSPACE_CHANGED') {
            const staleMarked = invalidateWorkspaceSnapshots(
              sandboxId,
              editWriteResult.current_workspace_revision ?? editWriteResult.workspace_revision,
            );
            const expected =
              editWriteResult.expected_workspace_revision ??
              editWriteWorkspaceRevision ??
              'unknown';
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
                  staleMarked > 0
                    ? `Marked ${staleMarked} previously-read file(s) as stale.`
                    : null,
                  `Re-read the file, then retry the edit.`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              ),
              structuredError: workspaceErr,
            };
          }
          if (editWriteResult.code === 'STALE_FILE') {
            if (
              typeof editWriteResult.current_version === 'string' &&
              editWriteResult.current_version
            ) {
              versionCacheSet(editCacheKey, editWriteResult.current_version);
            } else {
              versionCacheDelete(editCacheKey);
            }
            fileLedger.markStale(path);
            symbolLedger.invalidate(path);
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

        // Update version cache and clear any stale prefetch for this path
        if (typeof editWriteResult.new_version === 'string' && editWriteResult.new_version) {
          versionCacheSet(editCacheKey, editWriteResult.new_version);
        }
        // Ensure any prefetch cache entry for this file is cleared after write
        // (normally consumed by takePrefetchedEditFile, but clear defensively to
        // prevent stale reads if the same file is re-edited without a fresh read)
        takePrefetchedEditFile(sandboxId, path);
        fileLedger.recordCreation(path);
        fileLedger.recordMutation(path, 'agent');
        symbolLedger.invalidate(path);

        // 4. Post-write verification: read back and compare version to confirm
        // the write actually persisted on disk. This catches cases where the
        // sandbox reports ok but file state didn't change (e.g. stale container).
        let writeVerified = true;
        let verifyWarning: string | null = null;
        try {
          const verifyRead = (await readFromSandbox(sandboxId, path, 1, 1)) as FileReadResult & {
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
            // Update caches with the actual version
            versionCacheSet(editCacheKey, verifyRead.version);
            fileLedger.markStale(path);
          } else {
            // Write confirmed — update workspace revision from the verify read
            syncReadSnapshot(sandboxId, path, verifyRead);
          }
        } catch (verifyErr) {
          // Non-critical — don't fail the edit, but flag that verification didn't run
          writeVerified = false;
          const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          verifyWarning = `Post-write verification failed: ${msg}. The edit may not have persisted.`;
        }

        // 5. Get the diff hunks for this file
        const escapedPath = path.replace(/'/g, "'\\''");
        const diffResult = await execInSandbox(
          sandboxId,
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
          // Limit diff output to prevent context bloat
          const maxDiffLen = 3000;
          const truncatedDiff =
            diffHunks.length > maxDiffLen
              ? diffHunks.slice(0, maxDiffLen) + '\n[diff truncated]'
              : diffHunks;
          editLines.push('', 'Diff:', truncatedDiff);
        } else {
          editLines.push('', 'No diff hunks (file may be outside git or content identical).');
        }

        // Tier 1 ambient diagnostics: fast per-edit syntax check (1A)
        const diagnostics = await runPerEditDiagnostics(sandboxId, path);
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

      case 'sandbox_edit_range': {
        const { path, start_line, end_line, content, expected_version } = call.args;
        const baseRead = (await readFromSandbox(sandboxId, path)) as FileReadResult & {
          error?: string;
        };
        if (baseRead.error) {
          const err = classifyError(baseRead.error, path);
          return {
            text: formatStructuredError(err, formatSandboxError(baseRead.error, path)),
            structuredError: err,
          };
        }
        syncReadSnapshot(sandboxId, path, baseRead);

        let hydrated = baseRead;
        if (hydrated.truncated) {
          const expanded = await readFullFileByChunks(sandboxId, path, hydrated.version);
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
          syncReadSnapshot(sandboxId, path, hydrated);
        }

        try {
          const { ops } = await buildRangeReplaceHashlineOps(
            hydrated.content,
            start_line,
            end_line,
            content,
          );

          // Prime the edit guard/read path so delegated sandbox_edit_file does not
          // need to re-read just to establish awareness.
          const hydratedLineCount = hydrated.content.split('\n').length;
          const hydratedSymbols = extractSignaturesWithLines(hydrated.content);
          fileLedger.recordRead(path, {
            truncated: hydrated.truncated,
            totalLines: hydratedLineCount,
            symbols: hydratedSymbols,
          });
          syncReadSnapshot(sandboxId, path, hydrated);
          setPrefetchedEditFile(
            sandboxId,
            path,
            hydrated.content,
            typeof hydrated.version === 'string' ? hydrated.version : undefined,
            typeof hydrated.workspace_revision === 'number'
              ? hydrated.workspace_revision
              : undefined,
            hydrated.truncated,
          );

          return executeSandboxToolCall(
            {
              tool: 'sandbox_edit_file',
              args: {
                path,
                edits: ops,
                expected_version: expected_version ?? hydrated.version ?? undefined,
              },
            },
            sandboxId,
            options,
          );
        } catch (rangeErr) {
          const msg = rangeErr instanceof Error ? rangeErr.message : String(rangeErr);
          const err = classifyError(msg, path);
          return {
            text: formatStructuredError(err, [`[Tool Error — sandbox_edit_range]`, msg].join('\n')),
            structuredError: err,
          };
        }
      }

      case 'sandbox_search_replace': {
        const { path, search, replace, expected_version } = call.args;

        // Read the full file so we can locate the search string.
        const baseRead = (await readFromSandbox(sandboxId, path)) as FileReadResult & {
          error?: string;
        };
        if (baseRead.error) {
          const err = classifyError(baseRead.error, path);
          return {
            text: formatStructuredError(err, formatSandboxError(baseRead.error, path)),
            structuredError: err,
          };
        }
        syncReadSnapshot(sandboxId, path, baseRead);
        let hydrated = baseRead;
        if (hydrated.truncated) {
          const expanded = await readFullFileByChunks(sandboxId, path, hydrated.version);
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
          syncReadSnapshot(sandboxId, path, hydrated);
        }

        // Find the search string in the file content.
        // Support multi-line search strings (containing \n) by searching the
        // full content first, then falling back to per-line search for
        // single-line strings.
        const rawLines = hydrated.content.split('\n');
        const visibleLines = hydrated.content.endsWith('\n') ? rawLines.slice(0, -1) : rawLines;
        const isMultiLineSearch = search.includes('\n');

        // --- Multi-line search path ---
        // Search across the full content string rather than line-by-line.
        // This handles template strings, multi-line expressions, etc.
        if (isMultiLineSearch) {
          const visibleContent = visibleLines.join('\n');
          const firstIdx = visibleContent.indexOf(search);
          if (firstIdx === -1) {
            // Try Unicode normalization fallback
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

          // Check for ambiguous matches
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

          // Unique multi-line match found — compute the line range and build ops.
          // Preserve any text on the first/last matched lines that falls outside
          // the search match (prefix before match start, suffix after match end)
          // to avoid data loss when the match doesn't align to line boundaries.
          const matchEndIdx = firstIdx + search.length;
          const matchStartLine = visibleContent.slice(0, firstIdx).split('\n').length; // 1-indexed
          const matchEndLine = visibleContent.slice(0, matchEndIdx).split('\n').length;

          // Extract prefix (text before match on first matched line) and suffix
          // (text after match on last matched line).
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

          // Prime the edit guard/read path
          const hydratedLineCount = hydrated.content.split('\n').length;
          const hydratedSymbols = extractSignaturesWithLines(hydrated.content);
          fileLedger.recordRead(path, {
            truncated: hydrated.truncated,
            totalLines: hydratedLineCount,
            symbols: hydratedSymbols,
          });
          syncReadSnapshot(sandboxId, path, hydrated);
          setPrefetchedEditFile(
            sandboxId,
            path,
            hydrated.content,
            typeof hydrated.version === 'string' ? hydrated.version : undefined,
            typeof hydrated.workspace_revision === 'number'
              ? hydrated.workspace_revision
              : undefined,
            hydrated.truncated,
          );

          return executeSandboxToolCall(
            {
              tool: 'sandbox_edit_file',
              args: {
                path,
                edits: ops,
                expected_version: expected_version ?? hydrated.version ?? undefined,
              },
            },
            sandboxId,
            options,
          );
        }

        // --- Single-line search path (original) ---
        const matchingIndices = visibleLines
          .map((line, i) => (line.includes(search) ? i : -1))
          .filter((i) => i !== -1);

        if (matchingIndices.length === 0) {
          // Before giving up, check if the mismatch is due to Unicode encoding
          // artifacts (smart quotes, em-dashes, mojibake like â€" etc.).
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

        // Exactly one match — build hashline ops and delegate to sandbox_edit_file.
        // The new content of the matched line is the original with the search substring replaced.
        const targetIdx = matchingIndices[0];
        const originalLine = visibleLines[targetIdx];
        const newContent = originalLine.replace(search, () => replace);
        const newLines = newContent.split('\n');
        const lineNo = targetIdx + 1; // 1-indexed
        const anchorHash = await calculateLineHash(originalLine, 7);
        const anchorRef = `${lineNo}:${anchorHash}`;

        const ops: HashlineOp[] = [{ op: 'replace_line', ref: anchorRef, content: newLines[0] }];
        if (newLines.length > 1) {
          // Use the original anchor ref — applyHashlineEdits resolves all refs
          // against the original content, so a post-replace hash would fail.
          // Same-anchor insert_after ops are applied in declaration order
          // (applyHashlineEdits shifts indices for stacking), so no .reverse().
          for (const line of newLines.slice(1)) {
            ops.push({ op: 'insert_after', ref: anchorRef, content: line });
          }
        }

        // Prime the edit guard/read path so delegated sandbox_edit_file does not
        // need to re-read just to establish awareness.
        const hydratedLineCount = hydrated.content.split('\n').length;
        const hydratedSymbols = extractSignaturesWithLines(hydrated.content);
        fileLedger.recordRead(path, {
          truncated: hydrated.truncated,
          totalLines: hydratedLineCount,
          symbols: hydratedSymbols,
        });
        syncReadSnapshot(sandboxId, path, hydrated);
        setPrefetchedEditFile(
          sandboxId,
          path,
          hydrated.content,
          typeof hydrated.version === 'string' ? hydrated.version : undefined,
          typeof hydrated.workspace_revision === 'number' ? hydrated.workspace_revision : undefined,
          hydrated.truncated,
        );

        return executeSandboxToolCall(
          {
            tool: 'sandbox_edit_file',
            args: {
              path,
              edits: ops,
              expected_version: expected_version ?? hydrated.version ?? undefined,
            },
          },
          sandboxId,
          options,
        );
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
        // Step 1: Check for uncommitted changes
        const draftDiffResult = await getSandboxDiff(sandboxId);

        if (draftDiffResult.error) {
          return { text: `[Tool Error — sandbox_save_draft]\n${draftDiffResult.error}` };
        }

        if (!draftDiffResult.diff) {
          return {
            text: '[Tool Result — sandbox_save_draft]\nNo changes to save. Working tree is clean.',
          };
        }

        // Step 2: Get current branch
        const currentBranchResult = await execInSandbox(
          sandboxId,
          'cd /workspace && git branch --show-current',
        );
        const currentBranch =
          currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

        // Step 3: Determine draft branch name — must start with draft/ (unaudited path)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        if (call.args.branch_name && !call.args.branch_name.startsWith('draft/')) {
          return {
            text: '[Tool Error — sandbox_save_draft]\nbranch_name must start with "draft/". This tool skips Auditor review and is restricted to draft branches. Use sandbox_prepare_commit for non-draft branches.',
          };
        }
        const draftBranchName =
          call.args.branch_name || `draft/${currentBranch || 'main'}-${timestamp}`;

        // Step 4: Create draft branch if not already on one
        const needsNewBranch = !currentBranch.startsWith('draft/');
        if (needsNewBranch) {
          const checkoutResult = await execInSandbox(
            sandboxId,
            `cd /workspace && git checkout -b ${shellEscape(draftBranchName)}`,
            undefined,
            { markWorkspaceMutated: true },
          );
          if (checkoutResult.exitCode !== 0) {
            return {
              text: `[Tool Error — sandbox_save_draft]\nFailed to create draft branch: ${checkoutResult.stderr}`,
            };
          }
        }

        const activeDraftBranch = needsNewBranch ? draftBranchName : currentBranch;

        // Step 5: Stage all changes and commit (no Auditor — drafts are WIP)
        const draftMessage = call.args.message || 'WIP: draft save';
        const stageResult = await execInSandbox(
          sandboxId,
          'cd /workspace && git add -A',
          undefined,
          { markWorkspaceMutated: true },
        );
        if (stageResult.exitCode !== 0) {
          return {
            text: `[Tool Error — sandbox_save_draft]\nFailed to stage changes: ${stageResult.stderr}`,
          };
        }

        const commitResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git commit -m ${shellEscape(draftMessage)}`,
          undefined,
          { markWorkspaceMutated: true },
        );
        if (commitResult.exitCode !== 0) {
          return {
            text: `[Tool Error — sandbox_save_draft]\nFailed to commit draft: ${commitResult.stderr}`,
          };
        }
        // git add + commit changes file hashes tracked by git
        clearFileVersionCache(sandboxId);
        clearPrefetchedEditFileCache(sandboxId);

        // Step 6: Push to remote
        const pushResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git push -u origin ${shellEscape(activeDraftBranch)}`,
          undefined,
          { markWorkspaceMutated: true },
        );

        const pushOk = pushResult.exitCode === 0;
        const commitSha = commitResult.stdout.match(/\[.+? ([a-f0-9]+)\]/)?.[1] || 'unknown';
        const draftStats = parseDiffStats(draftDiffResult.diff);

        const draftLines: string[] = [
          `[Tool Result — sandbox_save_draft]`,
          `Draft saved to branch: ${activeDraftBranch}`,
          `Commit: ${commitSha}`,
          `Message: ${draftMessage}`,
          `${draftStats.filesChanged} file${draftStats.filesChanged !== 1 ? 's' : ''} changed, +${draftStats.additions} -${draftStats.deletions}`,
          pushOk
            ? 'Pushed to remote.'
            : `Push failed: ${pushResult.stderr}. Use sandbox_push() to retry.`,
        ];

        const draftCardData: DiffPreviewCardData = {
          diff: draftDiffResult.diff,
          filesChanged: draftStats.filesChanged,
          additions: draftStats.additions,
          deletions: draftStats.deletions,
          truncated: draftDiffResult.truncated,
        };

        return {
          text: draftLines.join('\n'),
          card: { type: 'diff-preview', data: draftCardData },
          // Propagate branch switch to app state so chat/merge context stays in sync
          ...(needsNewBranch ? { branchSwitch: activeDraftBranch } : {}),
        };
      }

      case 'promote_to_github': {
        return handlePromoteToGithub(buildGitReleaseContext(sandboxId), call.args);
      }

      case 'sandbox_read_symbols': {
        const filePath = call.args.path;
        const ext = filePath.split('.').pop()?.toLowerCase() || '';

        try {
          // Check the symbol persistence ledger first (cache-first read)
          const cached = symbolLedger.lookup(filePath);
          let symbols: { name: string; kind: string; line: number; signature: string }[];
          let totalLines: number;

          if (cached) {
            symbols = cached.symbols;
            totalLines = cached.totalLines;
          } else {
            const result = await readSymbolsFromSandbox(sandboxId, filePath);
            symbols = result.symbols;
            totalLines = result.totalLines;

            // Cache the result in the symbol persistence ledger (including empty
            // results so files with no symbols don't keep hitting the sandbox)
            symbolLedger.store(filePath, result.symbols, totalLines);
          }
          const lang = ['py'].includes(ext)
            ? 'Python'
            : ['ts', 'tsx', 'js', 'jsx'].includes(ext)
              ? 'TypeScript/JavaScript'
              : ext;

          // Record symbol reads in the ledger so edit guards can verify coverage
          if (symbols.length > 0) {
            const validKinds = new Set<string>([
              'function',
              'class',
              'interface',
              'export',
              'type',
            ]);
            const ledgerSymbols: SymbolRead[] = symbols
              .filter((s) => validKinds.has(s.kind))
              .map((s) => {
                // Normalize default export kind: the Python extractor emits 'function'
                // for `export default function Foo`, but the ledger's edit guard keys
                // default exports as 'export'. Check signature to detect this.
                let normalizedKind = s.kind as SymbolKind;
                if (
                  (normalizedKind === 'function' || normalizedKind === 'class') &&
                  /^export\s+default\b/.test(s.signature)
                ) {
                  normalizedKind = 'export';
                }
                return {
                  name: s.name,
                  kind: normalizedKind,
                  lineRange: { start: s.line, end: s.line },
                };
              });
            if (ledgerSymbols.length > 0) {
              // Record as a partial/truncated read — the model only saw a symbol index,
              // not the actual file content. Using truncated: true prevents recordRead
              // from upgrading the state to fully_read.
              fileLedger.recordRead(filePath, {
                symbols: ledgerSymbols,
                totalLines,
                truncated: true,
              });
            }
          }

          const lines: string[] = [
            `[Tool Result — sandbox_read_symbols]`,
            `File: ${filePath} (${totalLines} lines, ${lang})`,
            `Symbols: ${symbols.length}`,
            '',
          ];

          for (const sym of symbols) {
            lines.push(
              `  ${sym.kind.padEnd(10)} L${String(sym.line).padStart(4)}  ${sym.signature}`,
            );
          }

          if (symbols.length === 0) {
            lines.push('  (no symbols found)');
          }

          return { text: lines.join('\n') };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to extract symbols';
          const err = classifyError(message, filePath);
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_read_symbols]\n${message}`),
            structuredError: err,
          };
        }
      }

      case 'sandbox_find_references': {
        const symbol = call.args.symbol;
        const scope = normalizeSandboxPath(call.args.scope || '/workspace');

        try {
          const { references, truncated } = await findReferencesInSandbox(
            sandboxId,
            symbol,
            scope,
            30,
          );
          const shownCount = references.length;
          const fileWidth = Math.max(
            ...references.map((reference) => formatSandboxDisplayPath(reference.file).length),
            0,
          );
          const lines: string[] = [
            `[Tool Result — sandbox_find_references]`,
            `Symbol: ${symbol}`,
            `Scope: ${formatSandboxDisplayScope(scope)}`,
            `References: ${shownCount}${truncated ? '+' : ''} (showing ${shownCount})`,
            '',
          ];

          if (references.length === 0) {
            lines.push('  (no references found)');
          } else {
            for (const reference of references) {
              lines.push(
                `  ${reference.kind.padEnd(6)}  L ${String(reference.line).padStart(3)}  ${formatSandboxDisplayPath(reference.file).padEnd(fileWidth)}  ${reference.context}`,
              );
            }
          }

          return { text: lines.join('\n') };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to find references';
          const err = classifyError(message, symbol);
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_find_references]\n${message}`),
            structuredError: err,
          };
        }
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
