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
import {
  LocalDaemonUnreachableError,
  execLocalDaemon,
  getDiffLocalDaemon,
  listDirLocalDaemon,
  readFileLocalDaemon,
  writeFileLocalDaemon,
} from './local-daemon-sandbox-client';
import {
  filterSensitiveDirectoryEntries,
  formatSensitivePathToolError,
  isSensitivePath,
  redactSensitiveText,
} from './sensitive-data-guard';
import { fetchAuditorFileContexts } from './auditor-file-context';
import { recordReadFileMetric, recordWriteFileMetric } from './edit-metrics';
import { fileLedger } from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import { getActiveGitHubToken } from './github-auth';
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
  createGitHubRepo,
  shellEscape,
} from './sandbox-tool-utils';
import { GIT_REF_VALIDATION_DETAIL, isInvalidGitRef } from './git-ref-validation';
import { sanitizeUntrustedSource } from '@push/lib/untrusted-content';

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
  LOCAL_PC_TOOL_PROTOCOL,
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

/**
 * Run a daemon-backed sandbox tool and map a `LocalDaemonUnreachableError`
 * to a structured `SANDBOX_UNREACHABLE` result with a re-pair hint. Per-
 * tool branches construct the success payload; this helper only handles
 * the transport-failure case. PR 3c.3.
 */
async function runLocalDaemonTool(
  toolName: string,
  fn: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    return await fn();
  } catch (caught) {
    if (caught instanceof LocalDaemonUnreachableError) {
      const err: StructuredToolError = {
        type: 'SANDBOX_UNREACHABLE',
        retryable: false,
        message: `Local PC daemon is unreachable: ${caught.reason}`,
        detail:
          'The daemon may have stopped or the bearer token may have been revoked. Re-pair to continue.',
      };
      return {
        text: formatStructuredError(
          err,
          `[Tool Error — ${toolName}]\nLocal PC daemon is unreachable: ${caught.reason}\nThe daemon may have stopped or the bearer token may have been revoked. Re-pair to continue.`,
        ),
        structuredError: err,
      };
    }
    throw caught;
  }
}

export async function executeSandboxToolCall(
  call: SandboxToolCall,
  sandboxId: string,
  options?: SandboxExecutionOptions,
): Promise<ToolExecutionResult> {
  // local-pc sessions intentionally carry sandboxId: null — the
  // dispatch fork below routes via the daemon binding instead. Reject
  // only when neither a sandbox nor a local binding is available
  // (PR #511 review: Codex P2 caught that the bare `!sandboxId` guard
  // would short-circuit local-pc dispatch as soon as 3c.2 threads the
  // binding through useChat).
  if (!sandboxId && !options?.localDaemonBinding) {
    const err = classifyError('Sandbox unreachable — no active sandbox', 'executeSandboxToolCall');
    return {
      text: formatStructuredError(err, '[Tool Error] No active sandbox — start one first.'),
      structuredError: err,
    };
  }

  try {
    switch (call.tool) {
      case 'sandbox_exec': {
        // Git guard ran as a `PreToolUse` hook before this executor was
        // called — see `lib/default-pre-hooks.ts:createGitGuardPreHook`.
        // The runtime registers it on the shared registry and short-
        // circuits with a structured `GIT_GUARD_BLOCKED` deny before we
        // get here. No inline check needed.
        const start = Date.now();
        const markWorkspaceMutated = isLikelyMutatingSandboxExec(call.args.command);
        const normalizedWorkdir = normalizeSandboxWorkdir(call.args.workdir);

        // PR 3c.1: when the active session is `kind: 'local-pc'`, route
        // sandbox_exec through the local daemon's WS instead of the
        // cloud sandbox endpoint. Same `ExecResult` shape — every
        // downstream consumer (card, sanitization, ledger stale-mark)
        // is transport-agnostic. Unreachable bindings get their own
        // error path with a "re-pair" recovery hint (the cloud
        // "restart the sandbox" message would be wrong here).
        let result: {
          stdout: string;
          stderr: string;
          exitCode: number;
          truncated: boolean;
          timedOut?: boolean;
          error?: string;
        };
        if (options?.localDaemonBinding) {
          try {
            const execOpts: Parameters<typeof execLocalDaemon>[2] = {};
            if (normalizedWorkdir) execOpts.cwd = normalizedWorkdir;
            if (options.abortSignal) execOpts.abortSignal = options.abortSignal;
            const localResult = await execLocalDaemon(
              options.localDaemonBinding,
              call.args.command,
              execOpts,
            );
            result = {
              stdout: localResult.stdout,
              stderr: localResult.stderr,
              exitCode: localResult.exitCode,
              truncated: localResult.truncated,
              timedOut: localResult.timedOut,
            };
          } catch (caught) {
            // Mid-run cancel surfaces as an AbortError from the
            // transient binding wrapper (the cancel_run envelope was
            // dispatched, the daemon SIGTERM'd the child). Synthesize
            // a clean tool-result envelope so the chat layer sees a
            // "Cancelled by user" outcome rather than a tool-error.
            // The caller's abortRef check immediately after will
            // short-circuit the round loop; the synthesized result
            // exists for the rare case the loop runs another tick
            // before observing the ref. No structuredError — cancel
            // is a user-initiated state, not an error class.
            if (caught instanceof Error && caught.name === 'AbortError') {
              const durationMs = Date.now() - start;
              const cardData: SandboxCardData = {
                command: call.args.command,
                stdout: '',
                stderr: '',
                exitCode: 124,
                truncated: false,
                durationMs,
              };
              return {
                text: `[Tool Result — sandbox_exec]\nCommand: ${call.args.command}\nExit code: 124\nCancelled by user.`,
                card: { type: 'sandbox', data: cardData },
              };
            }
            if (caught instanceof LocalDaemonUnreachableError) {
              const durationMs = Date.now() - start;
              const unreachableErr = classifyError(
                `Local daemon unreachable: ${caught.reason}`,
                call.args.command,
              );
              unreachableErr.type = 'SANDBOX_UNREACHABLE';
              unreachableErr.retryable = false;
              const cardData: SandboxCardData = {
                command: call.args.command,
                stdout: '',
                stderr: caught.reason,
                exitCode: -1,
                truncated: false,
                durationMs,
              };
              return {
                text: formatStructuredError(
                  unreachableErr,
                  `[Tool Error — sandbox_exec]\nLocal PC daemon is unreachable: ${caught.reason}\nThe daemon may have stopped or the bearer token may have been revoked. Re-pair to continue.`,
                ),
                card: { type: 'sandbox', data: cardData },
                structuredError: unreachableErr,
              };
            }
            throw caught;
          }
        } else {
          result = markWorkspaceMutated
            ? await execInSandbox(sandboxId, call.args.command, normalizedWorkdir, {
                markWorkspaceMutated: true,
              })
            : await execInSandbox(sandboxId, call.args.command, normalizedWorkdir);
        }
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
        // stdout/stderr is fully attacker-controlled (any program output, file
        // contents via `cat`, etc.). Sanitize: escape envelope markers, spoof
        // infrastructure tags, AND defang embedded JSON tool-call shapes that
        // the model could echo back next turn.
        if (result.stdout) lines.push(`\nStdout:\n${sanitizeUntrustedSource(result.stdout)}`);
        if (result.stderr) lines.push(`\nStderr:\n${sanitizeUntrustedSource(result.stderr)}`);
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
        if (options?.localDaemonBinding) {
          // Match cloud `handleReadFile` semantics: refuse sensitive paths
          // BEFORE they reach the daemon. The daemon also rejects these
          // server-side (defense in depth), but the web check keeps the
          // model's prompt context clean — no "I tried, it was blocked"
          // round-trip. Codex P1 / Kilo / Gemini on PR #515.
          if (isSensitivePath(call.args.path)) {
            return { text: formatSensitivePathToolError(call.args.path) };
          }
          return runLocalDaemonTool('sandbox_read_file', async () => {
            const local = await readFileLocalDaemon(options.localDaemonBinding!, call.args.path, {
              startLine: call.args.start_line,
              endLine: call.args.end_line,
            });
            if (local.error) {
              // Use classifyError so daemon and cloud paths surface the
              // same structured types (FILE_NOT_FOUND, AUTH_FAILURE,
              // etc.) with consistent retryability. Copilot PR #515.
              const err = classifyError(local.error, call.args.path);
              if (local.code === 'ENOENT') err.type = 'FILE_NOT_FOUND';
              err.detail = `Path: ${call.args.path}`;
              return {
                text: formatStructuredError(
                  err,
                  `[Tool Error — sandbox_read_file]\n${local.error}`,
                ),
                structuredError: err,
              };
            }
            // File contents are attacker-controlled. Two defenses, in
            // the same order the cloud `sandbox_exec` path applies them:
            //   1. `redactSensitiveText` strips committed secrets
            //      (.env-shaped content, AWS keys, etc.). Gemini PR #515.
            //   2. `sanitizeUntrustedSource` defangs envelope-boundary
            //      tags and embedded JSON tool-call shapes so the model
            //      can't echo malicious file content back as a turn.
            //      Copilot PR #515.
            const redaction = redactSensitiveText(local.content);
            const sanitized = sanitizeUntrustedSource(redaction.text);
            const header = `[Tool Result — sandbox_read_file]\nPath: ${call.args.path}${
              local.totalLines !== undefined ? ` (${local.totalLines} lines)` : ''
            }${local.truncated ? ' [truncated]' : ''}${
              redaction.redacted ? ' [secrets redacted]' : ''
            }`;
            return { text: `${header}\n\n${sanitized}` };
          });
        }
        return handleReadFile(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_search': {
        return handleSearch(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_list_dir': {
        if (options?.localDaemonBinding) {
          const dirPath = call.args.path ?? '(cwd)';
          // Match cloud `handleListDir` semantics for the directory itself
          // (refusing a list of e.g. `~/.ssh`). Individual sensitive
          // entries are filtered after the daemon returns, also matching
          // the cloud path.
          if (call.args.path && isSensitivePath(call.args.path)) {
            return { text: formatSensitivePathToolError(call.args.path) };
          }
          return runLocalDaemonTool('sandbox_list_dir', async () => {
            const local = await listDirLocalDaemon(options.localDaemonBinding!, call.args.path);
            if (local.error) {
              const err = classifyError(local.error, dirPath);
              err.detail = `Path: ${dirPath}`;
              return {
                text: formatStructuredError(err, `[Tool Error — sandbox_list_dir]\n${local.error}`),
                structuredError: err,
              };
            }
            const filtered = filterSensitiveDirectoryEntries(call.args.path ?? '', local.entries);
            const rows = filtered.entries
              .map((e) =>
                e.type === 'directory'
                  ? `${e.name}/`
                  : e.size !== undefined
                    ? `${e.name}\t${e.size}`
                    : e.name,
              )
              .join('\n');
            const hiddenNote =
              filtered.hiddenCount > 0
                ? ` (${filtered.hiddenCount} sensitive entr${
                    filtered.hiddenCount === 1 ? 'y' : 'ies'
                  } hidden)`
                : '';
            const header = `[Tool Result — sandbox_list_dir]\nPath: ${dirPath}${
              local.truncated ? ` [truncated to ${local.entries.length}]` : ''
            }${hiddenNote}`;
            return { text: `${header}\n\n${rows}` };
          });
        }
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
        if (options?.localDaemonBinding) {
          // The cloud `handleWriteFile` has its own guards (file ledger,
          // version cache, etc.); on the daemon side we have none of those
          // yet but we DO want to keep models from writing into
          // `.env`/`.ssh/...`/`.pem` paths regardless of session type.
          if (isSensitivePath(call.args.path)) {
            return { text: formatSensitivePathToolError(call.args.path) };
          }
          return runLocalDaemonTool('sandbox_write_file', async () => {
            const local = await writeFileLocalDaemon(
              options.localDaemonBinding!,
              call.args.path,
              call.args.content,
            );
            if (!local.ok || local.error) {
              const err = classifyError(local.error || 'Local-PC write failed', call.args.path);
              // Default classification will not pick WRITE_FAILED — set
              // it explicitly when the daemon didn't surface a known
              // error (EACCES, etc.) so the model still sees a write-
              // specific failure type.
              if (err.type === 'UNKNOWN') err.type = 'WRITE_FAILED';
              err.detail = `Path: ${call.args.path}`;
              return {
                text: formatStructuredError(
                  err,
                  `[Tool Error — sandbox_write_file]\n${err.message}`,
                ),
                structuredError: err,
              };
            }
            return {
              text:
                `[Tool Result — sandbox_write_file]\n` +
                `Path: ${call.args.path}\n` +
                `Bytes written: ${local.bytesWritten ?? 'n/a'}`,
            };
          });
        }
        return handleWriteFile(buildWriteContext(sandboxId), call.args);
      }

      case 'sandbox_diff': {
        if (options?.localDaemonBinding) {
          return runLocalDaemonTool('sandbox_diff', async () => {
            const local = await getDiffLocalDaemon(options.localDaemonBinding!);
            if (local.error && !local.diff) {
              const err = classifyError(local.error, 'sandbox_diff');
              return {
                text: formatStructuredError(err, `[Tool Error — sandbox_diff]\n${local.error}`),
                structuredError: err,
              };
            }
            const parts = [`[Tool Result — sandbox_diff]`];
            if (local.gitStatus) parts.push(`\nStatus:\n${local.gitStatus}`);
            if (local.diff) {
              parts.push(`\nDiff:\n${local.diff}`);
              if (local.truncated) parts.push(`\n[Diff truncated]`);
            } else {
              parts.push(`\n(no working-copy changes vs HEAD)`);
            }
            return { text: parts.join('\n') };
          });
        }
        return handleSandboxDiff(buildGitReleaseContext(sandboxId));
      }

      case 'sandbox_create_branch': {
        const name = call.args.name;
        if (isInvalidGitRef(name)) {
          const err: StructuredToolError = {
            type: 'INVALID_ARG',
            retryable: false,
            message: 'Invalid branch name',
            detail: GIT_REF_VALIDATION_DETAIL,
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
        if (from !== undefined && isInvalidGitRef(from)) {
          const err: StructuredToolError = {
            type: 'INVALID_ARG',
            retryable: false,
            message: 'Invalid base ref',
            detail: GIT_REF_VALIDATION_DETAIL,
          };
          return {
            text: formatStructuredError(
              err,
              `[Tool Error — sandbox_create_branch] Invalid base ref "${from}".`,
            ),
            structuredError: err,
          };
        }

        // Atomic form: `git checkout -b <name> [<from>]` only changes HEAD
        // on success. The previous chained form left HEAD on `<from>` if
        // branch creation failed, silently mutating branch state on the
        // error path.
        const cmd = from
          ? `cd /workspace && git checkout -b ${shellEscape(name)} ${shellEscape(from)}`
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

        // Branch switch changes the entire working tree — invalidate caches
        // and ledgers the same way sandbox_exec does for mutating commands,
        // otherwise subsequent edits use versions from the previous branch
        // and trip stale-write / workspace-changed errors.
        clearFileVersionCache(sandboxId);
        clearPrefetchedEditFileCache(sandboxId);
        const staleMarked = fileLedger.markAllStale();

        const lines = [
          `[Tool Result — sandbox_create_branch]`,
          `Created and switched to ${name}${from ? ` from ${from}` : ''}.`,
        ];
        if (staleMarked > 0) {
          lines.push(
            `\n[Context] Marked ${staleMarked} previously-read file(s) as stale after branch switch. Re-read before editing.`,
          );
        }

        return {
          text: lines.join('\n'),
          // 'forked' tells the foreground app the active conversation should
          // follow this branch (slice 2). Other producers (github_create_branch,
          // release_draft) emit 'switched' because their UX expectation is
          // "branch changed but conversation stays put".
          branchSwitch: { name, kind: 'forked', source: 'sandbox_create_branch' },
        };
      }

      case 'sandbox_switch_branch': {
        const branch = call.args.branch;
        if (isInvalidGitRef(branch)) {
          const err: StructuredToolError = {
            type: 'INVALID_ARG',
            retryable: false,
            message: 'Invalid branch name',
            detail: GIT_REF_VALIDATION_DETAIL,
          };
          return {
            text: formatStructuredError(
              err,
              `[Tool Error — sandbox_switch_branch] Invalid branch name "${branch}".`,
            ),
            structuredError: err,
          };
        }

        // Capture HEAD before switching so the result can carry `previous`.
        // `--abbrev-ref HEAD` returns the branch name, or literally "HEAD"
        // when detached. Failures here are non-fatal: we proceed without
        // `previous` rather than blocking the switch. `execInSandbox` can
        // throw on transport / timeout / non-2xx — wrap in try/catch so a
        // probe failure can never abort the actual switch we were asked
        // to perform.
        let previous: string | undefined;
        try {
          const headProbe = await execInSandbox(
            sandboxId,
            'cd /workspace && git rev-parse --abbrev-ref HEAD',
          );
          if (headProbe.exitCode === 0) {
            const head = headProbe.stdout.trim();
            if (head && head !== 'HEAD') previous = head;
          }
        } catch {
          // Probe failed; continue without `previous`.
        }

        // `git switch` (not `git checkout`): branch-only by spec, so a path
        // collision (e.g. `docs/` directory and no `docs` branch) fails fast
        // with non-zero exit instead of silently doing a path-mode checkout
        // that leaves HEAD where it was while we'd still emit `branchSwitch`.
        //
        // Fall back to a depth-1 fetch when the bare switch fails. The cf
        // sandbox provider clones with `--depth=1 --branch <create-branch>`,
        // which implies `--single-branch` and leaves only the create-time
        // branch's remote ref locally — switching to any other remote branch
        // in the same sandbox would otherwise fail with `invalid reference`.
        // The explicit `<branch>:refs/remotes/origin/<branch>` refspec works
        // even when remote.origin.fetch was set to single-branch by the
        // shallow clone. The first switch's stderr is suppressed because the
        // miss is an expected branch in the control flow, not a real error;
        // a real failure (e.g. branch missing on origin too) surfaces from
        // the second switch's stderr.
        const escapedBranch = shellEscape(branch);
        const cmd =
          `cd /workspace && (` +
          `git switch ${escapedBranch} 2>/dev/null || ` +
          `(git fetch --depth=1 origin ${escapedBranch}:refs/remotes/origin/${escapedBranch} && ` +
          `git switch ${escapedBranch})` +
          `)`;
        const result = await execInSandbox(sandboxId, cmd, undefined, {
          markWorkspaceMutated: true,
        });

        if (result.exitCode !== 0) {
          const reason = result.stderr || result.stdout || 'git switch failed';
          const err = classifyError(reason, cmd);
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_switch_branch]\n${reason}`),
            structuredError: err,
          };
        }

        // Same cache/ledger invalidation as sandbox_create_branch — switching
        // changes the entire working tree.
        clearFileVersionCache(sandboxId);
        clearPrefetchedEditFileCache(sandboxId);
        const staleMarked = fileLedger.markAllStale();

        const lines = [
          `[Tool Result — sandbox_switch_branch]`,
          previous ? `Switched from ${previous} to ${branch}.` : `Switched to ${branch}.`,
        ];
        if (staleMarked > 0) {
          lines.push(
            `\n[Context] Marked ${staleMarked} previously-read file(s) as stale after branch switch. Re-read before editing.`,
          );
        }

        return {
          text: lines.join('\n'),
          // 'switched' (not 'forked') — the foreground dispatcher routes the
          // conversation to the existing chat for `branch` via useChat's
          // per-branch filter, or auto-creates a fresh chat if none exists.
          // Conversation does NOT migrate.
          branchSwitch: {
            name: branch,
            kind: 'switched',
            ...(previous ? { previous } : {}),
            source: 'sandbox_switch_branch',
          },
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
