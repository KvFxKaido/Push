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
  ToolErrorType,
  SandboxCardData,
} from '@/types';
import {
  execInSandbox,
  execLongRunningInSandbox,
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
import type {
  BatchWriteEntry,
  BatchWriteResult,
  ExecResult,
  FileReadResult,
  WriteResult,
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
import { extractSignaturesWithLines, fileLedger } from './file-awareness-ledger';
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
} from './sandbox-tool-utils';
import { GIT_REF_VALIDATION_DETAIL, isInvalidGitRef } from './git-ref-validation';
import { sanitizeUntrustedSource } from '@push/lib/untrusted-content';
import { createGitGuardPreHook } from '@push/lib/default-pre-hooks';
import { reduceToolOutput } from '@push/lib/tool-output-reducers';
import { retainReducedOutput } from '@push/lib/verbatim-retain';
import { PROJECT_INSTRUCTION_FILENAMES } from '@push/lib/project-instructions-source';
import { createSandboxPushGit } from './git-backend';
import { computeNativePushedDiff, createNativePushGit } from './native-git';
import { getApprovalMode } from './approval-mode';

import type { SandboxToolCall, SandboxExecutionOptions } from './sandbox-tool-detection';
import {
  resolveNativeFs,
  toWorktreeRelative,
  type NativeFsBackend,
  type NativeFsDiffResult,
  type NativeFsWriteResult,
} from './native-fs';

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
  handleShowCommit,
  handleSandboxCommit,
  handlePreparePush,
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
  LOCAL_DAEMON_TOOL_PROTOCOL,
} from './sandbox-tool-detection';

// --- Execution ---

/**
 * Wire up the verification-handler context with the dispatcher's actual
 * infrastructure dependencies. Kept as a local helper (not exported) so
 * the extraction boundary stays one-way: the handler module never imports
 * from `sandbox-tools.ts`, and this wiring lives inside the dispatcher.
 */
function buildVerificationContext(
  sandboxId: string,
  execOptions?: Pick<SandboxExecutionOptions, 'abortSignal' | 'onExecProgress'>,
): VerificationHandlerContext {
  return {
    sandboxId,
    execInSandbox,
    // Adapt the (sandboxId, command, workdir?, options?) handler signature onto
    // execLongRunningInSandbox's opts-bag shape. Detached on CF; transparently
    // falls back to buffered exec on backends without background routes.
    // The live-tail observer and abort signal ride the dispatcher's execution
    // options so a long verification run (test suite / cold install) streams
    // progress into the status bar and honours Stop — same as `sandbox_exec`.
    execLongRunning: (id, command, workdir, options) =>
      execLongRunningInSandbox(id, command, {
        workdir,
        markWorkspaceMutated: options?.markWorkspaceMutated,
        abortSignal: execOptions?.abortSignal,
        onProgress: execOptions?.onExecProgress,
      }),
    // Read the repo's `# test:` override sources in canonical instruction-file
    // precedence order. One bounded exec catting the candidate files; the
    // `head -c` cap keeps a large CLAUDE.md from bloating the result while the
    // directive block usually lives near the top of the instruction file.
    // Best-effort — a read
    // failure resolves to no override rather than blocking the test run.
    readValidationInstructions: async () => {
      try {
        const instructionFiles = PROJECT_INSTRUCTION_FILENAMES.join(' ');
        const probe = await execInSandbox(
          sandboxId,
          `cd /workspace && for f in ${instructionFiles}; do ` +
            'if [ -f "$f" ]; then printf "\\n===PUSH_VC_FILE===\\n"; head -c 20000 "$f"; fi; done',
        );
        return probe.stdout
          .split('===PUSH_VC_FILE===')
          .map((section) => section.trim())
          .filter((section) => section.length > 0);
      } catch (err) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'validation_instructions_read_failed',
            sandboxId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        return [];
      }
    },
    getSandboxEnvironment,
    clearFileVersionCache,
    clearPrefetchedEditFileCache,
  };
}

type ToolPushGitOptions = NonNullable<Parameters<typeof createSandboxPushGit>[1]>;

function createToolPushGit(
  sandboxId: string,
  nativeFs?: NativeFsBackend | null,
  opts?: ToolPushGitOptions,
) {
  if (!nativeFs) return createSandboxPushGit(sandboxId, opts);
  const tokenProvider = opts?.getGitHubToken ?? getActiveGitHubToken;
  return createNativePushGit({
    dir: nativeFs.dir,
    getToken: () => tokenProvider() || undefined,
    preCommit: opts?.preCommit,
    prePush: opts?.prePush,
    secretScan: opts?.secretScan,
    protectMain: opts?.protectMain,
    defaultBranch: opts?.defaultBranch,
    auditAtPush: opts?.auditAtPush,
  });
}

/**
 * Wire up the git/release-handler context with the dispatcher's actual
 * infrastructure dependencies. Kept as a local helper (not exported) so
 * the extraction boundary stays one-way: the handler module never imports
 * from `sandbox-tools.ts`, and this wiring lives inside the dispatcher.
 */
function buildGitReleaseContext(
  sandboxId: string,
  branchInfo?: { currentBranch?: string; defaultBranch?: string; isMainProtected?: boolean },
  nativeFs?: NativeFsBackend | null,
): GitReleaseHandlerContext {
  return {
    sandboxId,
    currentBranch: branchInfo?.currentBranch,
    defaultBranch: branchInfo?.defaultBranch,
    isMainProtected: branchInfo?.isMainProtected,
    execInSandbox,
    getSandboxDiff: nativeFs
      ? async () => sanitizeNativeDiff(await nativeFs.diff())
      : getSandboxDiff,
    readFromSandbox: nativeFs ? nativeReadFile(nativeFs) : readFromSandbox,
    runAuditor,
    fetchAuditorFileContexts,
    createGitHubRepo,
    getActiveGitHubToken,
    clearFileVersionCache,
    clearPrefetchedEditFileCache,
    ...(nativeFs
      ? {
          createPushGit: (opts?: ToolPushGitOptions) =>
            createToolPushGit(sandboxId, nativeFs, opts),
          computePushedDiff: (opts?: { ref?: string; remote?: string }) =>
            computeNativePushedDiff(nativeFs.dir, opts),
          computePushPlan: null,
          runPreCommitHook: async () => ({
            stdout: '',
            stderr: '',
            exitCode: 0,
            truncated: false,
          }),
          collectUntrackedDiff: async () => '',
          branchExists: async () => false,
          forkCommitTargetBranch: async (branch: string) => {
            const result = await createToolPushGit(sandboxId, nativeFs).createBranch(branch);
            return result.ok
              ? {
                  ok: true,
                  branchSwitch: {
                    name: branch,
                    kind: 'forked' as const,
                    source: 'sandbox_create_branch' as const,
                  },
                }
              : {
                  ok: false,
                  errorMessage: result.stderr || result.stdout || 'create branch failed',
                };
          },
        }
      : {}),
  };
}

function nativePathForEntry(parentPath: string, name: string): string {
  const base = parentPath.replace(/\/+$/, '') || '/workspace';
  return `${base}/${name}`.replace(/\/+/g, '/');
}

function nativeReadFile(
  nativeFs: NativeFsBackend,
): ReadOnlyInspectionHandlerContext['readFromSandbox'] {
  return async (_sandboxId, path, startLine, endLine): Promise<FileReadResult> => {
    const result = await nativeFs.readFile(path, { startLine, endLine });
    // Cloud-parity truncation metadata: a capped read reports where it
    // stopped so downstream ("use as the next start_line") pagination and the
    // truncation hint in the tool result keep working on native.
    const truncatedAtLine =
      result.truncated && !result.error && result.content
        ? (startLine ?? 1) + result.content.split('\n').length
        : undefined;
    return {
      content: result.content,
      truncated: result.truncated,
      ...(typeof startLine === 'number' ? { start_line: startLine } : {}),
      ...(typeof endLine === 'number' ? { end_line: endLine } : {}),
      ...(truncatedAtLine !== undefined ? { truncated_at_line: truncatedAtLine } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.code ? { code: result.code } : {}),
    };
  };
}

/** One place for the plugin write-result → `WriteResult` field mapping. */
function shapeNativeWriteResult(result: NativeFsWriteResult): WriteResult {
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(typeof result.bytesWritten === 'number' ? { bytes_written: result.bytesWritten } : {}),
  };
}

function nativeWriteFile(nativeFs: NativeFsBackend): EditHandlerContext['writeToSandbox'] {
  return async (_sandboxId, path, content): Promise<WriteResult> => {
    return shapeNativeWriteResult(await nativeFs.writeFile(path, content));
  };
}

function nativeBatchWrite(nativeFs: NativeFsBackend): WriteHandlerContext['batchWriteToSandbox'] {
  return async (_sandboxId, entries: BatchWriteEntry[]): Promise<BatchWriteResult> => {
    const results = await Promise.all(
      entries.map(async (entry) => ({
        path: entry.path,
        ...shapeNativeWriteResult(await nativeFs.writeFile(entry.path, entry.content)),
      })),
    );
    return {
      ok: results.every((result) => result.ok),
      results,
    };
  };
}

function nativeListDirectory(
  nativeFs: NativeFsBackend,
): NonNullable<ReadOnlyInspectionHandlerContext['listDirectoryDetailed']> {
  return async (_sandboxId, path = '/workspace') => {
    const result = await nativeFs.listDir(path);
    if (result.error) throw new Error(result.error);
    return {
      entries: result.entries
        .filter((entry) => entry.type === 'file' || entry.type === 'directory')
        .map((entry) => ({
          name: entry.name,
          path: nativePathForEntry(path, entry.name),
          type: entry.type === 'directory' ? ('directory' as const) : ('file' as const),
          size: entry.size ?? 0,
        })),
      // JGit caps listings at 500 entries; surface that instead of letting a
      // capped listing read as complete.
      truncated: result.truncated,
    };
  };
}

function nativeReadSymbols(
  nativeFs: NativeFsBackend,
): NonNullable<ReadOnlyInspectionHandlerContext['readSymbolsNative']> {
  return async (path) => {
    const result = await nativeFs.readFile(path);
    if (result.error) throw new Error(result.error);
    const sourceLines = result.content.split('\n');
    const symbols = extractSignaturesWithLines(result.content).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.lineRange.start,
      signature: sourceLines[symbol.lineRange.start - 1]?.trim() || symbol.name,
    }));
    return {
      symbols,
      totalLines: result.content ? sourceLines.length : 0,
    };
  };
}

/**
 * Per-file diff hunks for the edit-result card on native sessions (no shell,
 * so `git diff -- <path>` via exec isn't available). Reads the working-copy
 * diff from the git plugin and extracts just this file's block.
 */
function nativeFileDiffHunks(
  nativeFs: NativeFsBackend,
): NonNullable<EditHandlerContext['getFileDiffHunks']> {
  return async (_sandboxId, path) => {
    const rel = toWorktreeRelative(path);
    if (!rel) return null;
    const result = await nativeFs.diff();
    if (result.error || !result.diff) return null;
    const block = result.diff
      .split(/^(?=diff --git )/m)
      .find((candidate) => candidate.startsWith(`diff --git a/${rel} b/${rel}`));
    return block ? block.trimEnd() : null;
  };
}

/**
 * The native working-copy diff includes untracked files as additions so commit
 * preview/stats see the same files JGit will stage. It can carry contents no
 * other native read path would return raw, so apply the same defenses as
 * read/search: drop whole blocks for sensitive paths, value-redact the rest.
 */
function sanitizeNativeDiff(result: NativeFsDiffResult): NativeFsDiffResult {
  // Porcelain status names files too (`?? .env`) — filter it with the same
  // rule as the diff body so a consumer that prints git_status (the diff
  // handler's empty-diff branch does, and the commit handler's status lines
  // would) can't leak what the diff hides. Filtered even when the diff body
  // is empty — that IS the branch that prints status.
  const gitStatus = result.git_status
    ?.split('\n')
    .filter((line) => {
      if (!line || line.startsWith('##')) return true;
      // XY <path> (renames: `XY old -> new`) — drop the line if any named
      // path is sensitive.
      const paths = line.slice(3).split(' -> ');
      return !paths.some((p) => p.trim() && isSensitivePath(p.trim()));
    })
    .join('\n');
  const withStatus = (value: NativeFsDiffResult): NativeFsDiffResult => ({
    ...value,
    ...(result.git_status !== undefined ? { git_status: gitStatus } : {}),
  });
  if (!result.diff) return withStatus(result);
  let hidden = 0;
  const kept = result.diff.split(/^(?=diff --git )/m).filter((block) => {
    const header = /^diff --git a\/(\S+) /.exec(block);
    if (header && isSensitivePath(header[1])) {
      hidden += 1;
      return false;
    }
    return true;
  });
  const redaction = redactSensitiveText(kept.join(''));
  const notes = [
    ...(hidden > 0 ? [`[${hidden} sensitive file diff${hidden === 1 ? '' : 's'} hidden]`] : []),
    ...(redaction.redacted ? ['[secret-like values redacted]'] : []),
  ];
  const diff = [redaction.text.trimEnd(), ...notes].filter(Boolean).join('\n');
  return withStatus({ ...result, diff });
}

/**
 * Typed refusal for tools with no on-device implementation. A native session
 * must fail fast here: falling through would attempt cloud-sandbox calls with
 * an empty sandbox id (Codex P2 on #1356) — or, when a stale sandbox exists,
 * run against a workspace the on-device edits never touched.
 */
function nativeUnsupportedToolResult(tool: string, detail: string): ToolExecutionResult {
  const err: StructuredToolError = {
    type: 'NATIVE_TOOL_UNSUPPORTED',
    retryable: false,
    message: `${tool} is unavailable on the on-device working copy`,
    detail,
  };
  return {
    text: formatStructuredError(
      err,
      `[Tool Error — ${tool}]\n${tool} is not supported on the on-device working copy. ${detail}`,
    ),
    structuredError: err,
  };
}

function unsupportedNativeExec(): EditHandlerContext['execInSandbox'] {
  return async (): Promise<ExecResult> => ({
    stdout: '',
    stderr: 'shell execution is unavailable on the on-device working copy',
    exitCode: 127,
    truncated: false,
  });
}

function nativeSandboxStateId(
  sandboxId: string,
  scope: SandboxExecutionOptions['nativeFsScope'] | undefined,
): string {
  if (sandboxId) return sandboxId;
  if (!scope) return 'native:unknown';
  return `native:${scope.repoFullName}:${scope.branch}`;
}

function buildReadOnlyInspectionContext(
  sandboxId: string,
  nativeFs?: NativeFsBackend | null,
): ReadOnlyInspectionHandlerContext {
  return {
    sandboxId,
    readFromSandbox: nativeFs ? nativeReadFile(nativeFs) : readFromSandbox,
    execInSandbox,
    listDirectory,
    listDirectoryDetailed: nativeFs ? nativeListDirectory(nativeFs) : undefined,
    readSymbolsFromSandbox,
    findReferencesInSandbox,
    readSymbolsNative: nativeFs ? nativeReadSymbols(nativeFs) : undefined,
    searchNative: nativeFs ? (query, path) => nativeFs.search(query, path) : undefined,
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

const MAX_PRELOAD_FILES = 8;
const MAX_PRELOAD_TOTAL_CHARS = 24_000;

/**
 * Read the files an Orchestrator already inspected so they can be embedded in
 * a Coder's delegation brief — the Coder then starts with the contents (and
 * current line hashes) instead of spending its first rounds re-reading what
 * the Orchestrator already saw. Routes through `handleReadFile`, so it inherits
 * version priming (edits won't hit STALE_FILE), ledger recording, redaction,
 * and sensitive-path refusal. Returns '' when nothing usable was read.
 */
export async function readFilesForCoderPreload(
  sandboxId: string,
  paths: string[],
): Promise<string> {
  if (!sandboxId) return '';
  // Normalize first so repo-relative briefs (`app/src/auth.ts`) and absolute
  // `/workspace/...` paths resolve in the sandbox and dedupe to one key.
  const unique = Array.from(
    new Set(
      paths
        .map((p) => p.trim())
        .filter(Boolean)
        .map(normalizeSandboxPath),
    ),
  );
  if (unique.length === 0) return '';

  const selected = unique.slice(0, MAX_PRELOAD_FILES);
  // Files past the count cap are never read, so they never prime the ledger /
  // version cache — preserving the Coder's read-before-edit contract.
  const skipped: string[] = unique.slice(MAX_PRELOAD_FILES);
  const ctx = buildReadOnlyInspectionContext(sandboxId);

  const blocks: string[] = [];
  let total = 0;
  // Sequential with an early stop on budget: a file we never read is a file we
  // never prime. Reading everything in parallel and post-filtering would mark
  // budget-skipped files as "read" and let the Coder blind-edit them without an
  // explicit read — the read-before-edit hole flagged in review.
  for (const path of selected) {
    if (total >= MAX_PRELOAD_TOTAL_CHARS) {
      skipped.push(path);
      continue;
    }
    let text: string;
    try {
      const res = await handleReadFile(ctx, { path });
      if (res.structuredError) {
        skipped.push(path);
        continue;
      }
      text = res.text;
    } catch {
      skipped.push(path);
      continue;
    }
    // Empty read still counts as "known" (no content to embed); don't list it
    // as skipped, which would misleadingly suggest it wasn't inspected.
    if (!text) continue;
    blocks.push(text);
    total += text.length;
  }
  if (blocks.length === 0) return '';

  const skipNote =
    skipped.length > 0 ? `\nNot preloaded (read directly if needed): ${skipped.join(', ')}.` : '';
  return (
    '[PRELOADED_FILES] The Orchestrator already read these files for you. The line ' +
    'hashes below are current, so you can edit directly without re-reading; re-read a ' +
    `file only if an edit returns STALE_FILE or EDIT_HASH_MISMATCH.${skipNote}\n\n` +
    `${blocks.join('\n\n')}\n[/PRELOADED_FILES]`
  );
}

function buildEditContext(
  sandboxId: string,
  nativeFs?: NativeFsBackend | null,
): EditHandlerContext {
  return {
    sandboxId,
    readFromSandbox: nativeFs ? nativeReadFile(nativeFs) : readFromSandbox,
    writeToSandbox: nativeFs ? nativeWriteFile(nativeFs) : writeToSandbox,
    execInSandbox: nativeFs ? unsupportedNativeExec() : execInSandbox,
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
    runPerEditDiagnostics: nativeFs ? async () => null : undefined,
    getFileDiffHunks: nativeFs ? nativeFileDiffHunks(nativeFs) : undefined,
  };
}

function buildWriteContext(
  sandboxId: string,
  nativeFs?: NativeFsBackend | null,
): WriteHandlerContext {
  return {
    sandboxId,
    readFromSandbox: nativeFs ? nativeReadFile(nativeFs) : readFromSandbox,
    writeToSandbox: nativeFs ? nativeWriteFile(nativeFs) : writeToSandbox,
    batchWriteToSandbox: nativeFs ? nativeBatchWrite(nativeFs) : batchWriteToSandbox,
    execInSandbox: nativeFs ? unsupportedNativeExec() : execInSandbox,
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
    runPerEditDiagnostics: nativeFs ? async () => null : undefined,
    runPatchsetDiagnostics: nativeFs ? async () => null : undefined,
    // No shell on native: never run patchset `checks` through the exec stub —
    // its universal exit 127 would read as a failed check and roll back
    // writes that succeeded.
    checksUnavailable: nativeFs ? true : undefined,
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
        message: `Daemon is unreachable: ${caught.reason}`,
        detail:
          'The daemon may have stopped or the bearer token may have been revoked. Re-pair to continue.',
      };
      return {
        text: formatStructuredError(
          err,
          `[Tool Error — ${toolName}]\nDaemon is unreachable: ${caught.reason}\nThe daemon may have stopped or the bearer token may have been revoked. Re-pair to continue.`,
        ),
        structuredError: err,
      };
    }
    throw caught;
  }
}

/**
 * Run a native (on-device) file-op and map a plugin rejection to a structured
 * tool error. The `NativeGit` plugin rejects when a call reaches it off the
 * native shell (the web stub) or when JGit/File I/O throws; either surfaces as a
 * `SANDBOX_UNREACHABLE` so the model gets a typed failure rather than an
 * unhandled throw. Mirrors {@link runLocalDaemonTool} for the native FS path.
 */
async function runNativeFsTool(
  toolName: string,
  fn: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    return await fn();
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    const err: StructuredToolError = {
      type: 'SANDBOX_UNREACHABLE',
      retryable: false,
      message: `On-device working copy unavailable: ${reason}`,
      detail: 'The native git engine did not respond. The working copy may not be ready.',
    };
    return {
      text: formatStructuredError(err, `[Tool Error — ${toolName}]\n${reason}`),
      structuredError: err,
    };
  }
}

/**
 * Defense-in-depth git-guard for `sandbox_exec`. Runs the same lib hook
 * factory the runtime registers so the rule has a single source of
 * truth, but evaluates it inline so the web Coder bypass path (which
 * skips `WebToolExecutionRuntime` per the Coder Bypass decision doc)
 * stays covered. Returns a structured deny when the hook would block,
 * or null when the call should proceed.
 */
const inlineGitGuardEntry = createGitGuardPreHook({ modeProvider: getApprovalMode });

async function evaluateGitGuardForSandboxExec(
  args: Record<string, unknown>,
  isMainProtected?: boolean,
): Promise<ToolExecutionResult | null> {
  // Thread Protect Main through: the git-guard denies an exec `git push` under
  // Protect Main regardless of allowDirectGit (issue #977). The Coder-bypass
  // path reaches this inline evaluation, not the runtime pre-hook that carries
  // the flag, so it must be passed explicitly or the bypass stays open.
  const result = await inlineGitGuardEntry.hook('sandbox_exec', args, {
    sandboxId: null,
    allowedRepo: '',
    isMainProtected,
  });
  if (result.decision !== 'deny') return null;
  const reason = result.reason ?? 'Direct git mutation is blocked.';
  const err: StructuredToolError = {
    // Preserve the hook's specific code (e.g. PROTECT_MAIN_BLOCKED) so the
    // inline path classifies the same as the runtime pre-hook; fall back to the
    // generic guard code.
    type: (result.errorType as ToolErrorType | undefined) ?? 'GIT_GUARD_BLOCKED',
    retryable: false,
    message: reason,
  };
  return {
    text: `[Tool Blocked] ${reason}`,
    structuredError: err,
  };
}

/**
 * Public entry: dispatch the tool. Working-tree mutation signaling is rooted in
 * the sandbox client (`execInSandbox` / write endpoints) instead of enumerating
 * tools here, so any path that carries `markWorkspaceMutated` wakes auto-back.
 * Internal git/auto-back calls suppress that client-side signal explicitly.
 */
export async function executeSandboxToolCall(
  call: SandboxToolCall,
  sandboxId: string,
  options?: SandboxExecutionOptions,
): Promise<ToolExecutionResult> {
  return await executeSandboxToolCallInner(call, sandboxId, options);
}

async function executeSandboxToolCallInner(
  call: SandboxToolCall,
  sandboxId: string,
  options?: SandboxExecutionOptions,
): Promise<ToolExecutionResult> {
  // Daemon-bound sessions intentionally carry sandboxId: null — the
  // dispatch fork below routes via the daemon binding instead. Reject
  // only when neither a sandbox nor a daemon binding is available
  // (PR #511 review: Codex P2 caught that the bare `!sandboxId` guard
  // would short-circuit daemon dispatch as soon as 3c.2 threads the
  // binding through useChat).
  // Native (APK) file-op routing: when the session has a ready on-device clone,
  // file ops run against it instead of the cloud sandbox. `null` off native /
  // flag-off / no-ready-clone, so every other surface is unchanged. Resolved
  // once and shared across the file-op cases below.
  const nativeFs = resolveNativeFs(options?.nativeFsScope);
  const stateSandboxId = nativeSandboxStateId(sandboxId, options?.nativeFsScope);

  if (!sandboxId && !options?.localDaemonBinding && !nativeFs) {
    const err = classifyError('Sandbox unreachable — no active sandbox', 'executeSandboxToolCall');
    return {
      text: formatStructuredError(err, '[Tool Error] No active sandbox — start one first.'),
      structuredError: err,
    };
  }

  try {
    switch (call.tool) {
      case 'sandbox_exec': {
        // Git guard — defense-in-depth. The chat path runs this hook
        // via `WebToolExecutionRuntime` before reaching here, so the
        // call is a no-op (denials short-circuit upstream). The web
        // Coder path bypasses the runtime by design (see
        // `docs/decisions/Coder Bypass of WebToolExecutionRuntime.md`)
        // and dispatches straight into `executeSandboxToolCall` from
        // `lib/coder-agent-bindings.ts`; without an inline check here,
        // Coder-issued git mutations would slip through. Evaluating
        // the same lib hook factory keeps the rule source-of-truth
        // single while covering both call paths.
        const gitGuardDeny = await evaluateGitGuardForSandboxExec(
          call.args,
          options?.isMainProtected,
        );
        if (gitGuardDeny) {
          return gitGuardDeny;
        }
        // Hard boundary: the native (APK) shell has no POSIX shell / coreutils,
        // so arbitrary `sandbox_exec` can't run on-device. Git work goes through
        // the typed branch/commit tools (not shell), so a session on the local
        // clone refuses exec with a typed, non-retryable error rather than
        // pretending success or falling through to a sandbox it doesn't have.
        if (nativeFs) {
          const err: StructuredToolError = {
            type: 'NATIVE_TOOL_UNSUPPORTED',
            retryable: false,
            message: 'sandbox_exec is unavailable on the on-device working copy',
            detail:
              'The native shell has no command runtime. Use the typed file and git tools ' +
              '(read/write/list, create_branch, commit) instead of shell commands.',
          };
          return {
            text: formatStructuredError(
              err,
              `[Tool Error — sandbox_exec]\nsandbox_exec is not supported on the on-device working copy — there is no shell on the native shell. Use the typed file/git tools instead.`,
            ),
            structuredError: err,
          };
        }
        const start = Date.now();
        const markWorkspaceMutated = isLikelyMutatingSandboxExec(call.args.command);
        const normalizedWorkdir = normalizeSandboxWorkdir(call.args.workdir);

        // PR 3c.1: when the active session has a daemon binding, route
        // sandbox_exec through pushd's WS instead of the cloud sandbox
        // endpoint. Same `ExecResult` shape — every
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
          branch?: string;
          /** Detached-path provenance; absent on daemon and buffered-fallback results. */
          terminalReason?: import('@push/lib/detached-exec-runner').DetachedTerminalReason;
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
                  `[Tool Error — sandbox_exec]\nDaemon is unreachable: ${caught.reason}\nThe daemon may have stopped or the bearer token may have been revoked. Re-pair to continue.`,
                ),
                card: { type: 'sandbox', data: cardData },
                structuredError: unreachableErr,
              };
            }
            throw caught;
          }
        } else {
          // Cloud path: detached background exec — no buffered ~165s ceiling,
          // so long test/build runs can actually complete. Falls back to
          // buffered exec inside execLongRunningInSandbox when the backend
          // lacks the routes (Modal 404s the start; `background_exec_fallback`
          // is logged there). Every status/log poll stamps idle accounting,
          // so a long run can never look idle to the hibernation reaper.
          console.log(
            JSON.stringify({ level: 'info', event: 'sandbox_exec_detached_dispatch', sandboxId }),
          );
          result = await execLongRunningInSandbox(sandboxId, call.args.command, {
            workdir: normalizedWorkdir,
            markWorkspaceMutated,
            abortSignal: options?.abortSignal,
            onProgress: options?.onExecProgress,
          });

          // User cancel (Stop) — the runner interrupted the detached process
          // and resolved with cancel provenance. Synthesize the same envelope
          // as the daemon path: cancel is a user-initiated state, not an
          // error class. Gate on terminalReason, NOT the live signal — a
          // command that exits 124 on its own while Stop happens to be
          // pressed reports 'completed' and must keep its real result.
          if (result.terminalReason === 'cancelled') {
            // A mid-run cancel means the process RAN until it was interrupted
            // — a mutating command may already have changed files. Invalidate
            // the same way a completed run does (the pre-start cancel case is
            // a conservative false positive, which is acceptable).
            if (markWorkspaceMutated) {
              clearFileVersionCache(sandboxId);
              clearPrefetchedEditFileCache(sandboxId);
              fileLedger.markAllStale();
            }
            const durationMs = Date.now() - start;
            const cardData: SandboxCardData = {
              command: call.args.command,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 124,
              truncated: result.truncated,
              durationMs,
            };
            return {
              text: `[Tool Result — sandbox_exec]\nCommand: ${call.args.command}\nExit code: 124\nCancelled by user.`,
              card: { type: 'sandbox', data: cardData },
              ...(result.branch ? { branch: result.branch } : {}),
            };
          }
        }
        const durationMs = Date.now() - start;

        // Exit code -1 historically meant "the command was never dispatched"
        // (buffered path, container unreachable). The detached path adds two
        // post-start -1 cases that must NOT make that claim: 'lost-contact'
        // (started, outcome unknown) and 'start-unconfirmed' (may or may not
        // have launched; deliberately not retried to avoid double execution).
        if (result.exitCode === -1) {
          const reason = result.error || 'Sandbox unavailable';
          const mayHaveRun =
            result.terminalReason === 'lost-contact' ||
            result.terminalReason === 'start-unconfirmed';
          // A mutating command that MAY have run must invalidate caches the
          // same way a confirmed run does — the workspace state is unknown.
          if (mayHaveRun && markWorkspaceMutated) {
            clearFileVersionCache(sandboxId);
            clearPrefetchedEditFileCache(sandboxId);
            fileLedger.markAllStale();
          }
          const err = classifyError(reason, call.args.command);
          err.type = 'SANDBOX_UNREACHABLE';
          err.retryable = false;
          const cardData: SandboxCardData = {
            command: call.args.command,
            stdout: result.stdout,
            stderr: result.stderr || reason,
            exitCode: -1,
            truncated: result.truncated,
            durationMs,
          };
          const detail =
            result.terminalReason === 'lost-contact'
              ? `Lost contact with the command AFTER it started — its outcome is unknown and it may have completed or mutated the workspace. ${reason}\nRe-read any files you depend on before editing; do not assume the command did not run.`
              : result.terminalReason === 'start-unconfirmed'
                ? `The command's background start failed without confirmation — it may or may not have run. ${reason}\nIt was deliberately NOT retried (a retry could execute it twice). Verify the workspace state before re-running.`
                : `Command was not executed. ${reason}\nThe sandbox container is no longer reachable. Please restart the sandbox to continue.`;
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_exec]\n${detail}`),
            card: { type: 'sandbox', data: cardData },
            structuredError: err,
            ...(result.branch ? { branch: result.branch } : {}),
          };
        }

        // Command-aware reduction of the MODEL-FACING text only. The raw
        // stdout/stderr below (cardData) is left untouched so the UI stays
        // lossless. Exit code is printed verbatim regardless of reduction.
        const reduced = reduceToolOutput({
          command: call.args.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });

        const lines: string[] = [
          `[Tool Result — sandbox_exec]`,
          `Command: ${call.args.command}`,
          `Exit code: ${result.exitCode}`,
        ];
        // stdout/stderr is fully attacker-controlled (any program output, file
        // contents via `cat`, etc.). Sanitize: escape envelope markers, spoof
        // infrastructure tags, AND defang embedded JSON tool-call shapes that
        // the model could echo back next turn.
        if (reduced.stdout) lines.push(`\nStdout:\n${sanitizeUntrustedSource(reduced.stdout)}`);
        if (reduced.stderr) lines.push(`\nStderr:\n${sanitizeUntrustedSource(reduced.stderr)}`);
        if (result.truncated) lines.push(`\n[Output truncated]`);
        // Runner-level terminal note — exit 124 with an error message is the
        // detached runner's overall-deadline interrupt (user cancel returned
        // its own envelope above; -1 unreachable is handled earlier). Without
        // this line the model sees a bare 124 and can't tell deadline from a
        // command that exited 124 on its own.
        if (result.exitCode === 124 && result.error) {
          lines.push(`\n[Note] ${sanitizeUntrustedSource(result.error)}`);
        }

        // Exit 137 = SIGKILL. Inside the sandbox that is almost always the
        // container's out-of-memory killer, not a user signal — and the model
        // retrying the identical command is what escalates a killed child
        // process into a dead container (and a lost session). Name the cause
        // and the fix instead of letting it read as a generic test failure.
        if (result.exitCode === 137) {
          lines.push(
            `\n[Note] Exit 137 — the process was killed (SIGKILL), most likely by the sandbox's out-of-memory killer. ` +
              `Do NOT re-run the same command unchanged; repeated OOM kills can take down the whole sandbox. ` +
              `Reduce memory pressure instead: run a narrower test subset, or cap parallelism ` +
              `(e.g. \`--test-concurrency=1\` for node --test, \`--maxWorkers=1\` for vitest/jest).`,
          );
        }

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

        // LCM Phase 3 recall: when output was reduced, retain the full
        // model-facing (sanitized, unreduced) output in the verbatim log so the
        // model can `memory_expand` it back. Sanitized — not the raw cardData —
        // because recall re-enters the model, so it must carry the same
        // injection defanging the inline stdout/stderr got. Best-effort.
        const recall = await retainReducedOutput({
          reduced,
          rawText: [
            result.stdout ? `Stdout:\n${sanitizeUntrustedSource(result.stdout)}` : '',
            result.stderr ? `Stderr:\n${sanitizeUntrustedSource(result.stderr)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          command: call.args.command,
          scope: options?.memoryScope ?? { repoFullName: '' },
        });
        if (recall.marker) lines.push(recall.marker);

        return {
          text: lines.join('\n'),
          card: { type: 'sandbox', data: cardData },
          ...(result.branch ? { branch: result.branch } : {}),
        };
      }

      case 'sandbox_read_file': {
        if (nativeFs) {
          return runNativeFsTool('sandbox_read_file', () =>
            handleReadFile(buildReadOnlyInspectionContext(stateSandboxId, nativeFs), call.args),
          );
        }
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
        return handleSearch(buildReadOnlyInspectionContext(stateSandboxId, nativeFs), call.args);
      }

      case 'sandbox_list_dir': {
        if (nativeFs) {
          return runNativeFsTool('sandbox_list_dir', () =>
            handleListDir(buildReadOnlyInspectionContext(stateSandboxId, nativeFs), call.args),
          );
        }
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

      // Sensitive-path refusal for the edit/write family lives inside the
      // handlers (like the read/list/search family), so every surface —
      // cloud, daemon, native — inherits it without per-case copies here.
      case 'sandbox_edit_file': {
        return handleEditFile(buildEditContext(stateSandboxId, nativeFs), call.args);
      }

      case 'sandbox_edit_range': {
        return handleEditRange(buildEditContext(stateSandboxId, nativeFs), call.args);
      }

      case 'sandbox_search_replace': {
        return handleSearchReplace(buildEditContext(stateSandboxId, nativeFs), call.args);
      }

      case 'sandbox_write_file': {
        if (nativeFs) {
          return runNativeFsTool('sandbox_write_file', () =>
            handleWriteFile(buildWriteContext(stateSandboxId, nativeFs), call.args),
          );
        }
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
              const err = classifyError(local.error || 'Daemon write failed', call.args.path);
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
        if (nativeFs) {
          return runNativeFsTool('sandbox_diff', () =>
            handleSandboxDiff(buildGitReleaseContext(stateSandboxId, undefined, nativeFs)),
          );
        }
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

      case 'sandbox_show_commit': {
        if (nativeFs) {
          return nativeUnsupportedToolResult(
            'sandbox_show_commit',
            'Commit inspection is not routed on-device yet. Use sandbox_diff for working-copy changes.',
          );
        }
        return handleShowCommit(buildGitReleaseContext(sandboxId), call.args);
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

        // Sanctioned write: atomic `checkout -b` (only moves HEAD on success),
        // shell-escaped and marked workspace-mutating by the backend.
        const result = await createToolPushGit(sandboxId, nativeFs).createBranch(name, from);

        if (!result.ok) {
          const reason = result.stderr || result.stdout || 'git checkout -b failed';
          const err = classifyError(reason, 'git checkout -b');
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_create_branch]\n${reason}`),
            structuredError: err,
          };
        }

        // Branch switch changes the entire working tree — invalidate caches
        // and ledgers the same way sandbox_exec does for mutating commands,
        // otherwise subsequent edits use versions from the previous branch
        // and trip stale-write / workspace-changed errors.
        clearFileVersionCache(stateSandboxId);
        clearPrefetchedEditFileCache(stateSandboxId);
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

        const pushGit = createToolPushGit(sandboxId, nativeFs);

        // Capture the current branch before switching so the result can carry
        // `previous` (null when detached). Failures here are non-fatal: we
        // proceed without `previous` rather than blocking the switch. The
        // backend's exec can throw on transport / timeout / non-2xx — wrap in
        // try/catch so a probe failure can never abort the switch.
        let previous: string | undefined;
        try {
          const current = await pushGit.currentBranch();
          if (current) previous = current;
        } catch {
          // Probe failed; continue without `previous`.
        }

        // Sanctioned write. `switchBranch` is branch-only (a path collision
        // fails fast instead of a silent path-mode checkout) and falls back to
        // a depth-1 fetch for shallow clones — see SandboxPlumbingBackend.
        const result = await pushGit.switchBranch(branch);

        if (!result.ok) {
          const reason = result.stderr || result.stdout || 'git switch failed';
          const err = classifyError(reason, 'git switch');
          return {
            text: formatStructuredError(err, `[Tool Error — sandbox_switch_branch]\n${reason}`),
            structuredError: err,
          };
        }

        // Same cache/ledger invalidation as sandbox_create_branch — switching
        // changes the entire working tree.
        clearFileVersionCache(stateSandboxId);
        clearPrefetchedEditFileCache(stateSandboxId);
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
          branchSwitch: {
            name: branch,
            kind: 'switched',
            ...(previous ? { previous } : {}),
            source: 'sandbox_switch_branch',
          },
        };
      }

      case 'sandbox_commit': {
        return handleSandboxCommit(
          buildGitReleaseContext(
            stateSandboxId,
            {
              currentBranch: options?.currentBranch,
              defaultBranch: options?.defaultBranch,
              // Threaded so handleSandboxCommit's fail-closed Protect Main check
              // (for the auto-branch-disabled case) actually runs — see #4 of the
              // Codex review. Without it ctx.isMainProtected is undefined.
              isMainProtected: options?.isMainProtected,
            },
            nativeFs,
          ),
          call.args,
          {
            providerOverride: options?.auditorProviderOverride,
            modelOverride: options?.auditorModelOverride ?? undefined,
          },
        );
      }

      case 'prepare_push': {
        return handlePreparePush(
          buildGitReleaseContext(
            stateSandboxId,
            {
              currentBranch: options?.currentBranch,
              defaultBranch: options?.defaultBranch,
              isMainProtected: options?.isMainProtected,
            },
            nativeFs,
          ),
          {
            providerOverride: options?.auditorProviderOverride,
            modelOverride: options?.auditorModelOverride ?? undefined,
          },
        );
      }

      case 'sandbox_push': {
        return handleSandboxPush(
          buildGitReleaseContext(
            stateSandboxId,
            {
              currentBranch: options?.currentBranch,
              defaultBranch: options?.defaultBranch,
              isMainProtected: options?.isMainProtected,
            },
            nativeFs,
          ),
          {
            providerOverride: options?.auditorProviderOverride,
            modelOverride: options?.auditorModelOverride ?? undefined,
          },
        );
      }

      // Verification tools need a shell; a native session must refuse rather
      // than fall through to a cloud sandbox call (empty id, or a stale clone
      // the on-device edits never touched). Push the branch and let CI verify.
      case 'sandbox_run_tests': {
        if (nativeFs) {
          return nativeUnsupportedToolResult(
            'sandbox_run_tests',
            'There is no shell on the on-device working copy. Commit and push, then verify with CI.',
          );
        }
        return handleRunTests(buildVerificationContext(sandboxId, options), call.args);
      }

      case 'sandbox_check_types': {
        if (nativeFs) {
          return nativeUnsupportedToolResult(
            'sandbox_check_types',
            'There is no shell on the on-device working copy. Commit and push, then verify with CI.',
          );
        }
        return handleCheckTypes(buildVerificationContext(sandboxId, options));
      }

      case 'sandbox_verify_workspace': {
        if (nativeFs) {
          return nativeUnsupportedToolResult(
            'sandbox_verify_workspace',
            'There is no shell on the on-device working copy. Commit and push, then verify with CI.',
          );
        }
        return handleVerifyWorkspace(buildVerificationContext(sandboxId, options));
      }

      case 'sandbox_download': {
        if (nativeFs) {
          return nativeUnsupportedToolResult(
            'sandbox_download',
            'Workspace archives come from the cloud sandbox API, which a native session does not have.',
          );
        }
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
        return handleSaveDraft(
          buildGitReleaseContext(stateSandboxId, undefined, nativeFs),
          call.args,
        );
      }

      case 'promote_to_github': {
        return handlePromoteToGithub(buildGitReleaseContext(sandboxId), call.args);
      }

      case 'sandbox_read_symbols': {
        return handleReadSymbols(
          buildReadOnlyInspectionContext(stateSandboxId, nativeFs),
          call.args,
        );
      }

      case 'sandbox_find_references': {
        // Reference lookup runs a python analyzer via exec — there is no
        // native implementation, so refuse with the same typed error as
        // `sandbox_exec` instead of dead-ending on an unreachable sandbox.
        if (nativeFs) {
          return nativeUnsupportedToolResult(
            'sandbox_find_references',
            'Reference lookup needs the sandbox analyzer runtime, which the native shell ' +
              'does not have. Use sandbox_search to find usages instead.',
          );
        }
        return handleFindReferences(buildReadOnlyInspectionContext(sandboxId), call.args);
      }

      case 'sandbox_apply_patchset': {
        return handleApplyPatchset(buildWriteContext(stateSandboxId, nativeFs), call.args);
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
