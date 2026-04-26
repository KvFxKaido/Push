/**
 * Sandbox tool execution — the main `executeSandboxToolCall()` dispatcher.
 *
 * Detection, validation, types, and protocol live in sandbox-tool-detection.ts.
 * Utility/error helpers live in sandbox-tool-utils.ts.
 * Edit operations (prefetch, chunked read, diagnostics) live in sandbox-edit-ops.ts.
 *
 * This file re-exports everything consumers expect so import paths don't change.
 */

import type { ToolExecutionResult, StructuredToolError, SandboxCardData } from '@/types';
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
} from './sandbox-client';
import { runAuditor } from './auditor-agent';
import { fetchAuditorFileContexts } from './auditor-file-context';
import { recordReadFileMetric, recordWriteFileMetric } from './edit-metrics';
import { fileLedger } from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import { getActiveGitHubToken } from './github-auth';
import { getApprovalMode } from './approval-mode';
import {
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
  diagnoseExecFailure,
  classifyError,
  formatStructuredError,
  isLikelyMutatingSandboxExec,
  detectBlockedGitCommand,
  createGitHubRepo,
  shellEscape,
} from './sandbox-tool-utils';

import type { SandboxToolCall, SandboxExecutionOptions } from './sandbox-tool-detection';

import {
  setPrefetchedEditFile,
  takePrefetchedEditFile,
  clearPrefetchedEditFileCache,
  syncReadSnapshot,
  invalidateWorkspaceSnapshots,
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
  handleApplyPatchset,
  handleWriteFile,
  type WriteHandlerContext,
} from './sandbox-write-handlers';

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

function buildWriteContext(sandboxId: string): WriteHandlerContext {
  return {
    sandboxId,
    readFromSandbox,
    writeToSandbox,
    batchWriteToSandbox,
    execInSandbox,
    versionCacheGet,
    versionCacheSet,
    versionCacheDelete,
    versionCacheDeletePath,
    getWorkspaceRevisionByKey,
    setSandboxWorkspaceRevision,
    setWorkspaceRevisionByKey,
    syncReadSnapshot,
    invalidateWorkspaceSnapshots,
    recordLedgerRead: (path, opts) => fileLedger.recordRead(path, opts),
    recordLedgerAutoExpandAttempt: () => fileLedger.recordAutoExpandAttempt(),
    recordLedgerAutoExpandSuccess: () => fileLedger.recordAutoExpandSuccess(),
    recordLedgerSymbolAutoExpand: () => fileLedger.recordSymbolAutoExpand(),
    recordLedgerSymbolWarningSoftened: () => fileLedger.recordSymbolWarningSoftened(),
    recordLedgerCreation: (path) => fileLedger.recordCreation(path),
    recordLedgerMutation: (path, by) => fileLedger.recordMutation(path, by),
    markLedgerStale: (path) => fileLedger.markStale(path),
    getLedgerStaleWarning: (path) => fileLedger.getStaleWarning(path),
    getLedgerState: (path) => fileLedger.getState(path),
    getLedgerProvenance: (path) => fileLedger.getProvenance(path),
    restoreLedgerState: (path, state) => fileLedger.restoreState(path, state),
    clearLedgerProvenance: (path) => fileLedger.clearProvenance(path),
    checkWriteAllowed: (path) => fileLedger.checkWriteAllowed(path),
    checkSymbolicEditAllowed: (path, editContent) =>
      fileLedger.checkSymbolicEditAllowed(path, editContent),
    checkLinesCovered: (path, lineNumbers) => fileLedger.checkLinesCovered(path, lineNumbers),
    invalidateSymbolLedger: (path) => symbolLedger.invalidate(path),
    recordWriteFileMetric,
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
          const isBranchCreate =
            blockedGitOp === 'git checkout -b' || blockedGitOp === 'git switch -c';
          const guardDetail = isBranchCreate
            ? 'Use sandbox_create_branch to create a branch — it keeps Push and the sandbox in sync.'
            : currentApprovalMode === 'autonomous'
              ? 'Use sandbox_prepare_commit + sandbox_push for the audited flow, or retry with allowDirectGit: true.'
              : 'Use sandbox_prepare_commit + sandbox_push for the audited flow, or get explicit user approval before retrying with allowDirectGit.';
          const guardErr: StructuredToolError = {
            type: 'GIT_GUARD_BLOCKED',
            retryable: false,
            message: `Direct "${blockedGitOp}" is blocked`,
            detail: guardDetail,
          };
          const guidance = isBranchCreate
            ? `Direct "${blockedGitOp}" is blocked. Use sandbox_create_branch({"name": "<branch-name>"}) — it creates the branch in the sandbox and keeps Push's branch state in sync. Pass "from": "<base>" to branch from a specific ref instead of HEAD.`
            : currentApprovalMode === 'autonomous'
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
        return handleWriteFile(buildWriteContext(sandboxId), call.args);
      }

      case 'sandbox_diff': {
        return handleSandboxDiff(buildGitReleaseContext(sandboxId));
      }

      case 'sandbox_create_branch': {
        const name = call.args.name;
        // Strict ref validation: no shell metachars, no leading '-', no '..',
        // no leading/trailing slash. shellEscape quotes the value but defense
        // in depth — git itself rejects most of these too.
        const validRef =
          /^[A-Za-z0-9._/-]+$/.test(name) &&
          !name.startsWith('-') &&
          !name.startsWith('/') &&
          !name.endsWith('/') &&
          !name.includes('..');
        if (!validRef) {
          const err: StructuredToolError = {
            type: 'INVALID_ARG',
            retryable: false,
            message: 'Invalid branch name',
            detail:
              'Branch names may contain letters, digits, ".", "_", "/", "-" and may not start with "-" or contain "..".',
          };
          return {
            text: formatStructuredError(
              err,
              `[Tool Error — sandbox_create_branch] Invalid branch name "${name}".`,
            ),
            structuredError: err,
          };
        }

        const from = call.args.from;
        const cmd = from
          ? `cd /workspace && git checkout ${shellEscape(from)} && git checkout -b ${shellEscape(name)}`
          : `cd /workspace && git checkout -b ${shellEscape(name)}`;

        const result = await execInSandbox(sandboxId, cmd, undefined, {
          markWorkspaceMutated: true,
        });

        if (result.exitCode !== 0) {
          const reason = result.stderr || result.stdout || 'git checkout -b failed';
          const err = classifyError(reason, cmd);
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_create_branch]\n${reason}`),
            structuredError: err,
          };
        }

        return {
          text: [
            `[Tool Result — sandbox_create_branch]`,
            `Created and switched to ${name}${from ? ` from ${from}` : ''}.`,
          ].join('\n'),
          branchSwitch: name,
        };
      }

      case 'sandbox_prepare_commit': {
        return handlePrepareCommit(buildGitReleaseContext(sandboxId), call.args, {
          providerOverride: options?.auditorProviderOverride,
          modelOverride: options?.auditorModelOverride ?? undefined,
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
        return handleApplyPatchset(buildWriteContext(sandboxId), call.args);
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
