/**
 * Sandbox tool definitions, detection, and execution.
 *
 * Mirrors the github-tools.ts pattern exactly:
 * - LLM outputs a JSON block with { tool, args }
 * - We detect, validate, execute, and return text + optional card
 *
 * Sandbox tools operate on a running Modal sandbox (persistent container).
 */

import type {
  ToolExecutionResult,
  StructuredToolError,
  ActiveRepo,
  SandboxCardData,
  DiffPreviewCardData,
  CommitReviewCardData,
  FileListCardData,
  TestResultsCardData,
  TypeCheckCardData,
} from '@/types';
import { detectToolFromText, asRecord } from './utils';
import {
  execInSandbox,
  readFromSandbox,
  writeToSandbox,
  batchWriteToSandbox,
  getSandboxDiff,
  listDirectory,
  downloadFromSandbox,
  type FileReadResult,
  type BatchWriteEntry,
} from './sandbox-client';
import { runAuditor } from './auditor-agent';
import { parseDiffStats } from './diff-utils';
import { recordReadFileMetric, recordWriteFileMetric } from './edit-metrics';
import { fileLedger, extractSignatures, extractSignaturesWithLines } from './file-awareness-ledger';
import { applyHashlineEdits, calculateLineHash, type HashlineOp } from "./hashline";
import { getActiveGitHubToken } from './github-auth';
import {
  fileVersionKey,
  getByKey as versionCacheGet,
  setByKey as versionCacheSet,
  deleteByKey as versionCacheDelete,
  deleteFileVersion as versionCacheDeletePath,
  clearFileVersionCache,
} from './sandbox-file-version-cache';

// Re-export so existing consumers don't break
export { clearFileVersionCache } from './sandbox-file-version-cache';


function normalizeSandboxPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/workspace';
  if (trimmed === '/workspace' || trimmed === 'workspace') return '/workspace';
  if (trimmed.startsWith('/workspace/')) return trimmed.replace(/\/+/g, '/');
  if (trimmed.startsWith('workspace/')) return `/${trimmed}`.replace(/\/+/g, '/');
  if (trimmed.startsWith('/')) return trimmed.replace(/\/+/g, '/');
  return `/workspace/${trimmed}`.replace(/\/+/g, '/');
}

function normalizeSandboxWorkdir(workdir?: string): string | undefined {
  if (typeof workdir !== 'string') return undefined;
  return normalizeSandboxPath(workdir);
}

// --- Enhanced error messages ---

function formatSandboxError(error: string, context?: string): string {
  const lowerError = error.toLowerCase();
  const lowerContext = context?.toLowerCase() ?? '';
  const isEnoent = lowerError.includes('enoent') || error.includes('ENOENT');
  const looksLikeCommandEnoent = isEnoent
    && (lowerError.includes('spawn ') || lowerContext.startsWith('sandbox_exec'));

  // Common error patterns with suggestions
  if (lowerError.includes('permission denied') || error.includes('EACCES')) {
    return `[Tool Error] Permission denied${context ? ` for ${context}` : ''}. The file or directory may be protected. Try a different path or use sudo if appropriate.`;
  }
  if (lowerError.includes('command not found') || looksLikeCommandEnoent) {
    return `[Tool Error] Command not found${context ? `: ${context}` : ''}. The tool may not be installed in the sandbox. Try installing it first, or use a different command.`;
  }
  if (lowerError.includes('no such file') || isEnoent) {
    return `[Tool Error] File not found${context ? `: ${context}` : ''}. Use sandbox_list_dir to see available files, or check the path.`;
  }
  if (lowerError.includes('is a directory')) {
    return `[Tool Error] ${context || 'Path'} is a directory, not a file. Use sandbox_list_dir to browse directories, then sandbox_read_file on a specific file.`;
  }
  if (lowerError.includes('connection refused') || error.includes('ECONNREFUSED')) {
    return `[Tool Error] Connection refused${context ? ` for ${context}` : ''}. The service may not be running or the port may be incorrect.`;
  }
  return `[Tool Error] ${error}`;
}

// --- Exec failure diagnosis ---

/**
 * Diagnose a sandbox_exec failure from stderr and suggest a corrective action.
 * Returns a hint string, or null if the failure is not a recognizable precondition issue.
 */
function diagnoseExecFailure(stderr: string): string | null {
  const lower = stderr.toLowerCase();

  // Command/binary not found — suggest install
  if (lower.includes('command not found') || lower.includes('not found') && lower.includes(': ')) {
    // Try to extract the missing command name
    const match = stderr.match(/(?:bash: |sh: |zsh: )?(\S+):\s*(?:command\s+)?not found/i);
    const missing = match?.[1];
    if (missing) {
      // Suggest package manager install based on common tool patterns
      if (['node', 'npm', 'npx'].includes(missing)) {
        return `"${missing}" is not installed. Try: apt-get update && apt-get install -y nodejs npm`;
      }
      if (['python', 'python3'].includes(missing)) {
        return `"${missing}" is not installed. Try: apt-get update && apt-get install -y python3`;
      }
      if (missing === 'pip' || missing === 'pip3') {
        return `"${missing}" is not installed. Try: apt-get update && apt-get install -y python3-pip`;
      }
      if (missing === 'git') {
        return `"${missing}" is not installed. Try: apt-get update && apt-get install -y git`;
      }
      return `"${missing}" is not available in the sandbox. Try installing it with: apt-get update && apt-get install -y ${missing}`;
    }
    return `A required command is not installed. Try installing the missing tool with apt-get, npm, or pip.`;
  }

  // Module/package not found — suggest install
  if (lower.includes('cannot find module') || lower.includes('module not found')) {
    const moduleMatch = stderr.match(/cannot find module ['"]([^'"]+)['"]/i)
      || stderr.match(/module not found.*['"]([^'"]+)['"]/i);
    if (moduleMatch?.[1]) {
      return `Module "${moduleMatch[1]}" is missing. Try: npm install ${moduleMatch[1]}`;
    }
    return `A required module is missing. Run npm install to install dependencies.`;
  }
  if (lower.includes('no module named')) {
    const pyMatch = stderr.match(/no module named ['"]?(\S+?)['"]?$/im);
    if (pyMatch?.[1]) {
      return `Python module "${pyMatch[1]}" is missing. Try: pip install ${pyMatch[1]}`;
    }
    return `A required Python module is missing. Install it with pip.`;
  }

  // Permission denied
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return `Permission denied. Try prefixing the command with sudo, or check file permissions with ls -la.`;
  }

  // No such file or directory (not a "command not found" — more like a bad path arg)
  if ((lower.includes('no such file or directory') || lower.includes('enoent'))
    && !lower.includes('command not found')) {
    return `A file or directory in the command path does not exist. Use sandbox_list_dir to verify paths.`;
  }

  return null;
}

// --- Search hint builder ---

/**
 * Build actionable hints when sandbox_search returns no results.
 * Helps the model pivot quickly instead of guessing blindly.
 */
function buildSearchNoResultsHints(query: string, searchPath: string): string[] {
  const hints: string[] = [];

  // Detect naming convention and suggest alternatives
  const isCamelOrPascal = /[a-z][A-Z]/.test(query) || /^[A-Z][a-z]/.test(query);
  const isSnakeCase = /_[a-z]/.test(query);
  const isScreamingSnake = /^[A-Z_]+$/.test(query) && query.includes('_');

  if (isCamelOrPascal || isSnakeCase || isScreamingSnake) {
    hints.push(`Search is case-sensitive. Try a partial/lowercase substring (e.g., "${extractKeyword(query)}") to catch different naming conventions.`);
  }

  // Multi-word queries — suggest shorter terms
  if (query.includes(' ') || query.length > 25) {
    const shorter = query.split(/[\s_]+/)[0];
    if (shorter && shorter !== query) {
      hints.push(`Query may be too specific. Try a shorter term like "${shorter}".`);
    }
  }

  // Path filter is narrowing results
  if (searchPath !== '/workspace') {
    hints.push(`Path is scoped to ${searchPath}. Try without a path filter to search the full workspace, or use sandbox_list_dir("${searchPath}") to verify the path exists.`);
  }

  // General fallback suggestions
  if (hints.length === 0) {
    hints.push('Try a shorter or more generic substring — partial matches work (e.g., "buildPrompt" instead of "buildOrchestratorPrompt").');
  }

  hints.push('Use sandbox_list_dir to browse the project structure, or sandbox_read_symbols(path) to extract function/class names from a specific file.');

  return hints;
}

/**
 * Extract the most distinctive keyword from a query for suggestion purposes.
 * Splits camelCase/PascalCase/snake_case and picks the most meaningful word.
 */
function extractKeyword(query: string): string {
  // Split on camelCase boundaries, underscores, spaces
  const parts = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map(p => p.toLowerCase())
    .filter(p => p.length > 2);

  // Skip common prefixes like "build", "get", "set", "is", "has"
  const skipPrefixes = new Set(['build', 'get', 'set', 'is', 'has', 'create', 'make', 'init', 'the']);
  const meaningful = parts.filter(p => !skipPrefixes.has(p));

  return (meaningful[0] || parts[0] || query).toLowerCase();
}

/**
 * Build actionable hints when sandbox_search fails due to a path error.
 */
function buildSearchPathErrorHints(stderr: string, searchPath: string): string {
  const lower = stderr.toLowerCase();

  if (lower.includes('no such file or directory') || lower.includes('enoent')) {
    // Extract parent dir for suggestion
    const parent = searchPath.replace(/\/[^/]+\/?$/, '') || '/workspace';
    return [
      `[Tool Error] Search path "${searchPath}" does not exist.`,
      `Hint: Use sandbox_list_dir("${parent}") to see what directories are available.`,
      `error_type: FILE_NOT_FOUND`,
      `retryable: false`,
    ].join('\n');
  }

  if (lower.includes('is a directory') === false && lower.includes('permission denied')) {
    return [
      `[Tool Error] Permission denied searching "${searchPath}".`,
      `Hint: Check path permissions with sandbox_exec("ls -la ${searchPath}").`,
      `error_type: AUTH_FAILURE`,
      `retryable: false`,
    ].join('\n');
  }

  // Fallback — still provide some guidance
  return '';
}

// --- Structured error classification ---

/**
 * Classify an error message into a structured ToolErrorType.
 * Pattern-matches common error text from sandbox operations.
 */
export function classifyError(error: string, context?: string): StructuredToolError {
  const lower = error.toLowerCase();

  if (lower.includes('no such file') || lower.includes('enoent') || lower.includes('not found') || lower.includes('does not exist')) {
    return { type: 'FILE_NOT_FOUND', retryable: false, message: error, detail: context };
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('modal_timeout')) {
    return { type: 'EXEC_TIMEOUT', retryable: true, message: error, detail: context };
  }
  if (lower.includes('sandbox_unreachable') || lower.includes('modal_network_error') || lower.includes('cannot connect') || lower.includes('modal_error') || lower.includes('sandbox unavailable') || lower.includes('container error') || lower.includes('no longer reachable') || lower.includes('internal server error')) {
    // Transient container health issues are retryable; permanent config issues are not
    const transient = lower.includes('internal server error') || lower.includes('container error') || lower.includes('modal_network_error') || lower.includes('modal_error');
    return { type: 'SANDBOX_UNREACHABLE', retryable: transient, message: error, detail: context };
  }
  if (lower.includes('stale') || lower.includes('stale_file') || lower.includes('stale write')) {
    return { type: 'STALE_FILE', retryable: false, message: error, detail: context };
  }
  if (lower.includes('edit guard') || lower.includes('edit_guard_blocked')) {
    return { type: 'EDIT_GUARD_BLOCKED', retryable: false, message: error, detail: context };
  }
  if (lower.includes('hash mismatch') || lower.includes('hash_mismatch')) {
    return { type: 'EDIT_HASH_MISMATCH', retryable: false, message: error, detail: context };
  }
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return { type: 'AUTH_FAILURE', retryable: false, message: error, detail: context };
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('rate_limited')) {
    return { type: 'RATE_LIMITED', retryable: true, message: error, detail: context };
  }
  if (lower.includes('write failed') || lower.includes('write_failed')) {
    return { type: 'WRITE_FAILED', retryable: true, message: error, detail: context };
  }

  return { type: 'UNKNOWN', retryable: false, message: error, detail: context };
}

/**
 * Format a structured error into the text block injected into tool results.
 */
function formatStructuredError(err: StructuredToolError, baseText: string): string {
  return [
    baseText,
    `error_type: ${err.type}`,
    `retryable: ${err.retryable}`,
  ].join('\n');
}

function getGitHubHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    Authorization: `token ${token}`,
  };
}

function sanitizeGitOutput(value: string, token: string): string {
  if (!value) return value;
  return value
    .replaceAll(token, '***')
    .replace(/x-access-token:[^@]+@/gi, 'x-access-token:***@');
}

interface CreatedRepoResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url?: string;
  clone_url?: string;
  owner?: {
    login?: string;
  };
}

async function createGitHubRepo(
  repoName: string,
  description: string | undefined,
  isPrivate: boolean,
): Promise<CreatedRepoResponse> {
  const token = getActiveGitHubToken();
  if (!token) {
    throw new Error('GitHub auth required to promote. Connect a GitHub account in Settings.');
  }

  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: getGitHubHeaders(token),
    body: JSON.stringify({
      name: repoName,
      description: description || '',
      private: isPrivate,
      auto_init: false,
    }),
  });

  if (!response.ok) {
    let details = '';
    try {
      const body = await response.json() as { message?: string; errors?: Array<{ message?: string }> };
      details = body.message || body.errors?.[0]?.message || '';
    } catch {
      details = await response.text().catch(() => '');
    }
    if (response.status === 422) {
      throw new Error(`Repository creation failed: name likely already exists (${details || 'validation error'}).`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Repository creation failed: GitHub auth error (${details || response.status}).`);
    }
    throw new Error(`Repository creation failed (${response.status}): ${details || 'unknown error'}`);
  }

  return response.json() as Promise<CreatedRepoResponse>;
}



// --- Tool types ---

export type SandboxToolCall =
  | { tool: 'sandbox_exec'; args: { command: string; workdir?: string } }
  | { tool: 'sandbox_read_file'; args: { path: string; start_line?: number; end_line?: number } }
  | { tool: 'sandbox_search'; args: { query: string; path?: string } }
  | { tool: 'sandbox_edit_file'; args: { path: string; edits: HashlineOp[]; expected_version?: string } }
  | { tool: 'sandbox_write_file'; args: { path: string; content: string; expected_version?: string } }
  | { tool: 'sandbox_list_dir'; args: { path?: string } }
  | { tool: 'sandbox_diff'; args: Record<string, never> }
  | { tool: 'sandbox_prepare_commit'; args: { message: string } }
  | { tool: 'sandbox_push'; args: Record<string, never> }
  | { tool: 'sandbox_run_tests'; args: { framework?: string } }
  | { tool: 'sandbox_check_types'; args: Record<string, never> }
  | { tool: 'sandbox_download'; args: { path?: string } }
  | { tool: 'sandbox_save_draft'; args: { message?: string; branch_name?: string } }
  | { tool: 'promote_to_github'; args: { repo_name: string; description?: string; private?: boolean } }
  | { tool: 'sandbox_read_symbols'; args: { path: string } }
  | { tool: 'sandbox_apply_patchset'; args: { dryRun?: boolean; edits: Array<{ path: string; ops: HashlineOp[] }> } }

// --- Validation ---

function getToolName(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parsePositiveIntegerArg(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;

  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return numeric;
}

export function validateSandboxToolCall(parsed: unknown): SandboxToolCall | null {
  const parsedObj = asRecord(parsed);
  if (!parsedObj) return null;
  const tool = getToolName(parsedObj.tool);
  const args = asRecord(parsedObj.args) || {};

  if (tool === 'sandbox_exec' && typeof args.command === 'string') {
    return { tool: 'sandbox_exec', args: { command: args.command, workdir: normalizeSandboxWorkdir(typeof args.workdir === 'string' ? args.workdir : undefined) } };
  }
  if ((tool === 'sandbox_read_file' || tool === 'read_sandbox_file') && typeof args.path === 'string') {
    const startLine = parsePositiveIntegerArg(args.start_line);
    const endLine = parsePositiveIntegerArg(args.end_line);
    if (startLine === null || endLine === null) return null;
    if (startLine !== undefined && endLine !== undefined && startLine > endLine) return null;
    return { tool: 'sandbox_read_file', args: { path: normalizeSandboxPath(args.path), start_line: startLine, end_line: endLine } };
  }
  if ((tool === 'sandbox_search' || tool === 'search_sandbox') && typeof args.query === 'string') {
    return { tool: 'sandbox_search', args: { query: args.query, path: typeof args.path === 'string' ? normalizeSandboxPath(args.path) : undefined } };
  }
  if (tool === 'sandbox_write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
    return {
      tool: 'sandbox_write_file',
      args: {
        path: normalizeSandboxPath(args.path),
        content: args.content,
        expected_version: typeof args.expected_version === 'string' ? args.expected_version : undefined,
      },
    };
  }
  if (tool === "sandbox_edit_file" && typeof args.path === "string" && Array.isArray(args.edits)) {
    return {
      tool: "sandbox_edit_file",
      args: {
        path: normalizeSandboxPath(args.path),
        edits: args.edits as HashlineOp[],
        expected_version: typeof args.expected_version === "string" ? args.expected_version : undefined,
      },
    };
  }
  if (tool === 'sandbox_list_dir' || tool === 'list_sandbox_dir') {
    return { tool: 'sandbox_list_dir', args: { path: typeof args.path === 'string' ? normalizeSandboxPath(args.path) : undefined } };
  }
  if (tool === 'sandbox_diff') {
    return { tool: 'sandbox_diff', args: {} };
  }
  if ((tool === 'sandbox_prepare_commit' || tool === 'sandbox_commit') && typeof args.message === 'string') {
    return { tool: 'sandbox_prepare_commit', args: { message: args.message } };
  }
  if (tool === 'sandbox_push') {
    return { tool: 'sandbox_push', args: {} };
  }
  if (tool === 'sandbox_run_tests') {
    return { tool: 'sandbox_run_tests', args: { framework: typeof args.framework === 'string' ? args.framework : undefined } };
  }
  if (tool === 'sandbox_check_types') {
    return { tool: 'sandbox_check_types', args: {} };
  }
  if (tool === 'sandbox_download') {
    return { tool: 'sandbox_download', args: { path: typeof args.path === 'string' ? normalizeSandboxPath(args.path) : undefined } };
  }
  if (tool === 'sandbox_save_draft') {
    return {
      tool: 'sandbox_save_draft',
      args: {
        message: typeof args.message === 'string' ? args.message : undefined,
        branch_name: typeof args.branch_name === 'string' ? args.branch_name : undefined,
      },
    };
  }
  if (tool === 'sandbox_read_symbols' && typeof args.path === 'string') {
    return { tool: 'sandbox_read_symbols', args: { path: normalizeSandboxPath(args.path) } };
  }
  if (tool === 'sandbox_apply_patchset' && Array.isArray(args.edits)) {
    const validEdits = (args.edits as unknown[])
      .filter((edit): edit is { path: string; ops: HashlineOp[] } => {
        const rec = asRecord(edit);
        return rec !== null && typeof rec.path === 'string' && Array.isArray(rec.ops);
      })
      .map(edit => ({
        ...edit,
        path: normalizeSandboxPath(edit.path),
      }));
    if (validEdits.length === 0) return null;
    return {
      tool: 'sandbox_apply_patchset',
      args: {
        dryRun: typeof args.dryRun === 'boolean' ? args.dryRun : (args.dry_run === true ? true : undefined),
        edits: validEdits,
      },
    };
  }
  if (tool === 'promote_to_github' && typeof args.repo_name === 'string') {
    const repoName = args.repo_name.trim();
    if (!repoName) return null;
    return {
      tool: 'promote_to_github',
      args: {
        repo_name: repoName,
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      },
    };
  }
  return null;
}

// --- Detection ---

/** The set of tool names that are actually implemented and wired up. */
export const IMPLEMENTED_SANDBOX_TOOLS = new Set([
  'sandbox_exec', 'sandbox_read_file', 'sandbox_search', 'sandbox_write_file',
  "sandbox_edit_file",
  'sandbox_list_dir', 'sandbox_diff', 'sandbox_prepare_commit', 'sandbox_push',
  'sandbox_run_tests', 'sandbox_check_types', 'sandbox_download', 'sandbox_save_draft',
  'promote_to_github', 'sandbox_read_symbols', 'sandbox_apply_patchset',
  // Compatibility aliases
  'read_sandbox_file', 'search_sandbox', 'list_sandbox_dir', 'sandbox_commit',
]);

/**
 * Check if a tool name looks like a sandbox tool but is not implemented.
 * Returns the unrecognized name, or null if the tool is known.
 */
export function getUnrecognizedSandboxToolName(text: string): string | null {
  return detectToolFromText<string>(text, (parsed) => {
    const toolName = getToolName(asRecord(parsed)?.tool);
    if (toolName.startsWith('sandbox_') && !IMPLEMENTED_SANDBOX_TOOLS.has(toolName)) {
      return toolName;
    }
    return null;
  });
}

export function detectSandboxToolCall(text: string): SandboxToolCall | null {
  return detectToolFromText<SandboxToolCall>(text, (parsed) => {
    const toolName = getToolName(asRecord(parsed)?.tool);
    if (toolName.startsWith('sandbox_') || ['read_sandbox_file', 'search_sandbox', 'list_sandbox_dir', 'promote_to_github'].includes(toolName)) {
      return validateSandboxToolCall(parsed);
    }
    return null;
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}


async function readFullFileByChunks(
  sandboxId: string,
  path: string,
  versionHint?: string | null,
): Promise<{ content: string; version?: string | null; truncated: boolean }> {
  const chunkSize = 400;
  const maxChunks = 200;
  let version = versionHint;

  // Phase 1: Fetch the first chunk to establish version and determine if we
  // can use parallel fetching for the rest.
  const firstRange = await readFromSandbox(sandboxId, path, 1, chunkSize) as FileReadResult & { error?: string };
  if (firstRange.error) throw new Error(firstRange.error);
  if (!version && typeof firstRange.version === 'string' && firstRange.version) {
    version = firstRange.version;
  }
  if (!firstRange.content) {
    return { content: '', version, truncated: false };
  }

  // If the first chunk was itself truncated by payload size, we can't parallelize safely.
  if (firstRange.truncated) {
    return { content: firstRange.content, version, truncated: true };
  }

  const firstLines = firstRange.content.split('\n');
  const firstHadTrailing = firstRange.content.endsWith('\n');
  const firstNormalized = firstHadTrailing ? firstLines.slice(0, -1) : firstLines;

  // If first chunk is not full, the file fits in one chunk — done.
  if (firstNormalized.length < chunkSize) {
    return { content: firstRange.content, version, truncated: false };
  }

  // Phase 2: Get total line count so we can issue parallel chunk requests.
  // Use `sed -n '$='` instead of `wc -l` — wc undercounts files missing a trailing newline.
  let totalLines = 0;
  try {
    const lineCountResult = await execInSandbox(sandboxId, `sed -n '$=' ${shellEscape(path)}`);
    if (lineCountResult.exitCode === 0 && lineCountResult.stdout.trim()) {
      totalLines = parseInt(lineCountResult.stdout.trim(), 10);
    }
  } catch { /* fall through to sequential */ }

  // Phase 3: If we have a line count, fetch remaining chunks in parallel.
  if (totalLines > chunkSize) {
    const collected: string[] = [...firstNormalized];
    let truncated = false;
    let lastHadTrailingNewline = firstHadTrailing;

    const remainingChunks: Array<{ start: number; end: number }> = [];
    for (let start = chunkSize + 1; start <= totalLines; start += chunkSize) {
      remainingChunks.push({ start, end: Math.min(start + chunkSize - 1, totalLines) });
      if (remainingChunks.length >= maxChunks - 1) break;
    }

    // Fetch remaining chunks in parallel with concurrency limit to avoid
    // overwhelming the sandbox with too many simultaneous requests.
    const MAX_CONCURRENT_CHUNKS = 8;
    const chunkResults: Array<FileReadResult & { error?: string }> = [];
    for (let i = 0; i < remainingChunks.length; i += MAX_CONCURRENT_CHUNKS) {
      const batch = remainingChunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
      const batchResults = await Promise.all(
        batch.map(({ start, end }) =>
          readFromSandbox(sandboxId, path, start, end) as Promise<FileReadResult & { error?: string }>
        )
      );
      chunkResults.push(...batchResults);
      // Stop early if any chunk in this batch was truncated or empty
      if (batchResults.some(r => r.truncated || !r.content)) break;
    }

    for (const range of chunkResults) {
      if (range.error) throw new Error(range.error);
      if (!range.content) break;

      if (range.truncated) {
        truncated = true;
      }

      const lines = range.content.split('\n');
      const hadTrailing = range.content.endsWith('\n');
      lastHadTrailingNewline = hadTrailing;
      const normalized = hadTrailing ? lines.slice(0, -1) : lines;
      collected.push(...normalized);

      if (range.truncated) break;
    }

    let content = collected.join('\n');
    if (lastHadTrailingNewline) {
      content += '\n';
    }
    return { content, version, truncated };
  }

  // Fallback: sequential reads (if wc -l failed or file is small)
  const collected: string[] = [...firstNormalized];
  let startLine = chunkSize + 1;
  let truncated = false;
  let lastHadTrailingNewline = firstHadTrailing;

  for (let i = 1; i < maxChunks; i += 1) {
    const range = await readFromSandbox(sandboxId, path, startLine, startLine + chunkSize - 1) as FileReadResult & { error?: string };
    if (range.error) throw new Error(range.error);
    if (!version && typeof range.version === 'string' && range.version) {
      version = range.version;
    }
    if (!range.content) {
      // Preserve lastHadTrailingNewline from the previous chunk — an empty
      // response means EOF, so the trailing-newline state of the last real
      // chunk is what matters.
      break;
    }

    if (range.truncated) {
      truncated = true;
    }

    const lines = range.content.split('\n');
    const hadTrailingNewline = range.content.endsWith('\n');
    lastHadTrailingNewline = hadTrailingNewline;
    const normalized = hadTrailingNewline ? lines.slice(0, -1) : lines;

    collected.push(...normalized);
    if (range.truncated) break;
    if (normalized.length < chunkSize) break;
    startLine += normalized.length;

    if (i === maxChunks - 1 && normalized.length === chunkSize) {
      truncated = true;
    }
  }

  let content = collected.join('\n');
  if (lastHadTrailingNewline) {
    content += '\n';
  }

  return {
    content,
    version,
    truncated,
  };
}
// --- Diff parsing (shared via diff-utils) ---

// --- Execution ---

export async function executeSandboxToolCall(
  call: SandboxToolCall,
  sandboxId: string,
): Promise<ToolExecutionResult> {
  if (!sandboxId) {
    const err = classifyError('Sandbox unreachable — no active sandbox', 'executeSandboxToolCall');
    return { text: formatStructuredError(err, '[Tool Error] No active sandbox — start one first.'), structuredError: err };
  }

  try {
    switch (call.tool) {
      case 'sandbox_exec': {
        const start = Date.now();
        const result = await execInSandbox(sandboxId, call.args.command, normalizeSandboxWorkdir(call.args.workdir));
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
            text: formatStructuredError(err, `[Tool Error — sandbox_exec]\nCommand was not executed. ${reason}\nThe sandbox container is no longer reachable. Please restart the sandbox to continue.`),
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

        // Invalidate version cache after exec — commands like `npm install`,
        // `git checkout`, `sed -i`, etc. can modify files without going through
        // the write path, leaving the cache stale and causing spurious STALE_FILE
        // rejections on subsequent writes.
        // (exitCode === -1 already returned early above, so no guard needed here.)
        clearFileVersionCache(sandboxId);

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
        const isRangeRead = call.args.start_line !== undefined || call.args.end_line !== undefined;
        const result = await readFromSandbox(sandboxId, call.args.path, call.args.start_line, call.args.end_line) as FileReadResult & { error?: string };
        const cacheKey = fileVersionKey(sandboxId, call.args.path);

        // Handle directory or read errors (e.g. "cat: /path: Is a directory")
        if (result.error) {
          versionCacheDelete(cacheKey);
          recordReadFileMetric({
            outcome: 'error',
            payloadChars: 0,
            isRangeRead,
            errorCode: 'READ_ERROR',
          });
          const err = classifyError(result.error, call.args.path);
          return { text: formatStructuredError(err, formatSandboxError(result.error, call.args.path)), structuredError: err };
        }

        if (typeof result.version === 'string' && result.version) {
          versionCacheSet(cacheKey, result.version);
        } else {
          versionCacheDelete(cacheKey);
        }

        const rangeStart = typeof result.start_line === 'number'
          ? result.start_line
          : call.args.start_line ?? 1;
        const rangeEnd = typeof result.end_line === 'number'
          ? result.end_line
          : call.args.end_line;

        // For every read: add hashline anchors and line numbers to the tool result text
        let toolResultContent = '';
        const emptyRangeWarning = '';
        if (result.content) {
          const contentLines = result.content.split('\n');
          // If content ends with a trailing newline, the last split element is empty — don't number it
          const hasTrailingNewline = result.content.endsWith('\n') && contentLines.length > 1;
          const linesToNumber = hasTrailingNewline ? contentLines.slice(0, -1) : contentLines;
          const maxLineNum = Math.max(rangeStart, rangeStart + linesToNumber.length - 1);
          const padWidth = String(maxLineNum).length;

          const hashPromises = linesToNumber.map(line => calculateLineHash(line));
          const lineHashes = await Promise.all(hashPromises);

          toolResultContent = linesToNumber
            .map((line, idx) => `[${lineHashes[idx]}] ${String(rangeStart + idx).padStart(padWidth)}\t${line}`)
            .join('\n');
        }

        // --- File Awareness Ledger: record what the model has seen ---
        const contentLineCount = result.content ? result.content.split('\n').length : 0;
        // If start_line was provided without end_line and the result wasn't
        // truncated, the server returned the entire file from that offset —
        // treat it as a full read so the ledger doesn't false-positive as
        // partial_read.
        const effectivelyFullRead = isRangeRead && !rangeEnd && !result.truncated;
        // Extract symbols for ledger tracking
        const readStartLine = (isRangeRead && !effectivelyFullRead) ? rangeStart : 1;
        const symbols = result.content ? extractSignaturesWithLines(result.content, readStartLine) : [];
        if (!emptyRangeWarning) {
          fileLedger.recordRead(call.args.path, {
            startLine: (isRangeRead && !effectivelyFullRead) ? rangeStart : undefined,
            endLine: (isRangeRead && !effectivelyFullRead) ? (rangeEnd ?? rangeStart + contentLineCount - 1) : undefined,
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

        const fileLabel = isRangeRead
          ? `Lines ${rangeStart}-${rangeEnd ?? '∞'} of ${call.args.path}`
          : `File: ${call.args.path}`;

        const lines: string[] = [
          `[Tool Result — sandbox_read_file]`,
          fileLabel,
          `Version: ${result.version || 'unknown'}`,
          result.truncated ? `(truncated)` : '',
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
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
          md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
          css: 'css', html: 'html', sh: 'shell', bash: 'shell',
          toml: 'toml', sql: 'sql', c: 'c', cpp: 'cpp', h: 'c',
        };
        const language = sandboxLangMap[ext] || ext;

        return {
          text: lines.join('\n'),
          card: {
            type: 'editor',
            data: {
              path: call.args.path,
              content: result.content, // Card gets clean content — no line numbers
              language,
              truncated: result.truncated,
              version: typeof result.version === 'string' ? result.version : undefined,
              source: 'sandbox' as const,
              sandboxId,
            },
          },
        };
      }

      case 'sandbox_search': {
        const query = call.args.query.trim();
        const searchPath = normalizeSandboxPath((call.args.path || '/workspace').trim() || '/workspace');

        if (!query) {
          return { text: '[Tool Error] sandbox_search requires a non-empty query.' };
        }

        const escapedQuery = shellEscape(query);
        const escapedPath = shellEscape(searchPath);
        const command = [
          'if command -v rg >/dev/null 2>&1; then',
          `  rg -n --hidden --glob '!.git' --color never --max-count 200 -- ${escapedQuery} ${escapedPath};`,
          'else',
          `  grep -RIn --exclude-dir=.git -- ${escapedQuery} ${escapedPath} | head -n 200;`,
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
                ...hints.map(h => `- ${h}`),
              ].join('\n'),
            };
          }
          // Exit code 2+ usually means path or argument error — provide specific guidance
          const pathHint = buildSearchPathErrorHints(result.stderr || '', searchPath);
          if (pathHint) {
            return { text: pathHint };
          }
          return {
            text: formatSandboxError(result.stderr || 'Search failed', `sandbox_search (${searchPath})`),
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
              ...hints.map(h => `- ${h}`),
            ].join('\n'),
          };
        }

        const lines = output
          .split('\n')
          .slice(0, 120)
          .map((line) => line.length > 320 ? `${line.slice(0, 320)}...` : line);

        const matchCount = lines.length;
        const truncated = output.split('\n').length > lines.length || result.truncated;

        return {
          text: [
            '[Tool Result — sandbox_search]',
            `Query: ${query}`,
            `Path: ${searchPath}`,
            `Matches: ${matchCount}${truncated ? ' (truncated)' : ''}`,
            '',
            ...lines,
          ].join('\n'),
        };
      }

      case 'sandbox_list_dir': {
        const dirPath = normalizeSandboxPath(call.args.path || '/workspace');
        const entries = await listDirectory(sandboxId, dirPath);

        const dirs = entries.filter((e) => e.type === 'directory');
        const files = entries.filter((e) => e.type === 'file');

        const lines: string[] = [
          `[Tool Result — sandbox_list_dir]`,
          `Directory: ${dirPath}`,
          `${dirs.length} directories, ${files.length} files\n`,
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
            ...files.map((f) => ({ name: f.name, type: 'file' as const, size: f.size || undefined })),
          ],
        };

        return { text: lines.join('\n'), card: { type: 'file-list', data: cardData } };
      }

      case "sandbox_edit_file": {
        const { path, edits } = call.args;

        // 1. Read the current file content
        let readResult = await readFromSandbox(sandboxId, path) as FileReadResult & { error?: string };
        if (readResult.error) {
          const err = classifyError(readResult.error, path);
          return { text: formatStructuredError(err, formatSandboxError(readResult.error, path)), structuredError: err };
        }

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
              text: formatStructuredError(err, [
                `[Tool Error — sandbox_edit_file]`,
                `Edit guard: ${path} is too large to fully load safely.`,
                `Chunked hydration remained truncated (likely due to payload limits on a single line range).`,
                `Use sandbox_read_file with narrower start_line/end_line ranges and retry with targeted edits.`,
              ].join('\n')),
              structuredError: err,
            };
          }
          readResult = {
            ...readResult,
            content: expanded.content,
            truncated: expanded.truncated,
            version: expanded.version ?? readResult.version,
          };
        }
        // 2. Apply hashline edits
        const editResult = await applyHashlineEdits(readResult.content, edits);

        if (editResult.failed > 0) {
          const err: StructuredToolError = { type: 'EDIT_HASH_MISMATCH', retryable: false, message: `Failed to apply ${editResult.failed} of ${edits.length} edits.`, detail: editResult.errors.join('; ') };
          return {
            text: formatStructuredError(err, [
              `[Tool Error — sandbox_edit_file]`,
              `Failed to apply ${editResult.failed} of ${edits.length} edits.`,
              ...editResult.errors.map(e => `- ${e}`),
              `No changes were saved. Review the file content and references then retry.`,
            ].join("\n")),
            structuredError: err,
          };
        }

        // 3. Write the edited content directly (instead of delegating to sandbox_write_file)
        // Transient failures (5xx, timeout, network) are retried by sandbox-client withRetry().
        const beforeVersion = readResult.version || 'unknown';
        // Always prefer the version from the fresh read we just performed.
        // A caller-provided expected_version may be stale from a previous read, and
        // using it here would cause a spurious STALE_FILE rejection on the server.
        const editWriteVersion = readResult.version || undefined;
        const editWriteResult = await writeToSandbox(sandboxId, path, editResult.content, editWriteVersion);

        if (!editWriteResult.ok) {
          if (editWriteResult.code === 'STALE_FILE') {
            const staleErr: StructuredToolError = { type: 'STALE_FILE', retryable: false, message: `Stale write rejected for ${path}.` };
            return { text: formatStructuredError(staleErr, `[Tool Error — sandbox_edit_file]\nStale write rejected for ${path}. Re-read the file and retry.`), structuredError: staleErr };
          }
          const wErr = classifyError(editWriteResult.error || 'Write failed', path);
          return { text: formatStructuredError(wErr, `[Tool Error — sandbox_edit_file]\n${editWriteResult.error || 'Write failed'}`), structuredError: wErr };
        }

        // Update version cache
        const editCacheKey = fileVersionKey(sandboxId, path);
        if (typeof editWriteResult.new_version === 'string' && editWriteResult.new_version) {
          versionCacheSet(editCacheKey, editWriteResult.new_version);
        }
        fileLedger.recordCreation(path);

        // 4. Get the diff hunks for this file
        const escapedPath = path.replace(/'/g, "'\\''");
        const diffResult = await execInSandbox(sandboxId, `cd /workspace && git diff -- '${escapedPath}'`);
        const diffHunks = diffResult.exitCode === 0 ? diffResult.stdout.trim() : '';

        const editLines: string[] = [
          `[Tool Result — sandbox_edit_file]`,
          `Edited ${path}: ${editResult.applied} of ${edits.length} operations applied.`,
          `Before version: ${beforeVersion}`,
          `After version: ${editWriteResult.new_version || 'unknown'}`,
          `Bytes written: ${editWriteResult.bytes_written ?? editResult.content.length}`,
        ];
        if (diffHunks) {
          // Limit diff output to prevent context bloat
          const maxDiffLen = 3000;
          const truncatedDiff = diffHunks.length > maxDiffLen ? diffHunks.slice(0, maxDiffLen) + '\n[diff truncated]' : diffHunks;
          editLines.push('', 'Diff:', truncatedDiff);
        } else {
          editLines.push('', 'No diff hunks (file may be outside git or content identical).');
        }

        return { text: editLines.join('\n') };
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
            const autoReadResult = await readFromSandbox(sandboxId, call.args.path) as FileReadResult & { error?: string };
            if (!autoReadResult.error && autoReadResult.content !== undefined) {
              // Record the auto-read in the ledger
              let autoReadContent = autoReadResult.content;
              let autoReadVersion = autoReadResult.version;
              let autoReadTruncated = Boolean(autoReadResult.truncated);
              if (autoReadTruncated) {
                const expanded = await readFullFileByChunks(sandboxId, call.args.path, autoReadResult.version);
                autoReadContent = expanded.content;
                autoReadVersion = expanded.version ?? autoReadVersion;
                autoReadTruncated = expanded.truncated;
              }

              const autoLineCount = autoReadContent.split('\n').length;
              fileLedger.recordRead(call.args.path, {
                truncated: autoReadTruncated,
                totalLines: autoLineCount,
              });
              // Update version cache
              if (typeof autoReadVersion === 'string' && autoReadVersion) {
                versionCacheSet(cacheKey, autoReadVersion);
              }
              fileLedger.recordAutoExpandSuccess();
              console.debug(`[edit-guard] Auto-expanded "${call.args.path}" (${autoLineCount} lines) — proceeding with write.`);
              // Re-check guard after auto-expand (should pass now unless still partial)
              const retryVerdict = fileLedger.checkWriteAllowed(call.args.path);
              if (!retryVerdict.allowed) {
                // Still blocked after auto-expand (e.g. truncated partial read)
                recordWriteFileMetric({
                  durationMs: Date.now() - writeStart,
                  outcome: 'error',
                  errorCode: 'EDIT_GUARD_BLOCKED',
                });
                const guardErr: StructuredToolError = { type: 'EDIT_GUARD_BLOCKED', retryable: false, message: `Edit guard: ${retryVerdict.reason}`, detail: 'File too large for auto-expand' };
                return {
                  text: formatStructuredError(guardErr, [
                    `[Tool Error — sandbox_write_file]`,
                    `Edit guard: ${retryVerdict.reason}`,
                    `The file was auto-read but is too large to fully load. Use sandbox_read_file with start_line/end_line to read the sections you need to edit, then retry.`,
                  ].join('\n')),
                  structuredError: guardErr,
                };
              }
            } else {
              // Auto-read failed — the file may not exist (new file creation).
              // If the error looks like a missing file, allow the write.
              const errMsg = typeof autoReadResult.error === 'string' ? autoReadResult.error.toLowerCase() : '';
              if (errMsg.includes('no such file') || errMsg.includes('not found') || errMsg.includes('does not exist')) {
                fileLedger.recordCreation(call.args.path);
                fileLedger.recordAutoExpandSuccess();
                console.debug(`[edit-guard] File "${call.args.path}" does not exist — allowing new file creation.`);
              } else {
                recordWriteFileMetric({
                  durationMs: Date.now() - writeStart,
                  outcome: 'error',
                  errorCode: 'EDIT_GUARD_BLOCKED',
                });
                const guardErr2: StructuredToolError = { type: 'EDIT_GUARD_BLOCKED', retryable: false, message: `Edit guard: ${guardVerdict.reason}` };
                return {
                  text: formatStructuredError(guardErr2, [
                    `[Tool Error — sandbox_write_file]`,
                    `Edit guard: ${guardVerdict.reason}`,
                  ].join('\n')),
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
            const guardErr3: StructuredToolError = { type: 'EDIT_GUARD_BLOCKED', retryable: false, message: `Edit guard: ${guardVerdict.reason}`, detail: 'Auto-read threw an exception' };
            return {
              text: formatStructuredError(guardErr3, [
                `[Tool Error — sandbox_write_file]`,
                `Edit guard: ${guardVerdict.reason}`,
              ].join('\n')),
              structuredError: guardErr3,
            };
          }
        }

        // After auto-expand, the version cache may have been updated — refresh.
        // Prefer the cache (most recently observed version) over the caller's
        // expected_version, which may be stale from an earlier read.
        const freshVersion = versionCacheGet(cacheKey) || call.args.expected_version;

        // Stale warning (soft — doesn't block, just informs)
        const staleWarning = fileLedger.getStaleWarning(call.args.path);

        try {
          const result = await writeToSandbox(sandboxId, call.args.path, call.args.content, freshVersion);

          if (!result.ok) {
            if (result.code === 'STALE_FILE') {
              if (typeof result.current_version === 'string' && result.current_version) {
                versionCacheSet(cacheKey, result.current_version);
              }
              recordWriteFileMetric({
                durationMs: Date.now() - writeStart,
                outcome: 'stale',
                errorCode: 'STALE_FILE',
              });
              const expected = result.expected_version || freshVersion || 'unknown';
              const current = result.current_version || 'missing';
              const err: StructuredToolError = { type: 'STALE_FILE', retryable: false, message: `Stale write rejected for ${call.args.path}.`, detail: `expected=${expected} current=${current}` };
              return {
                text: formatStructuredError(err, [
                  `[Tool Error — sandbox_write_file]`,
                  `Stale write rejected for ${call.args.path}.`,
                  `Expected version: ${expected}`,
                  `Current version: ${current}`,
                  `Re-read the file with sandbox_read_file, apply edits to the latest content, then retry.`,
                ].join('\n')),
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
            return { text: formatStructuredError(writeErr, formatSandboxError(detail, call.args.path)), structuredError: writeErr };
          }

          const previousVersion = versionCacheGet(cacheKey);
          if (typeof result.new_version === 'string' && result.new_version) {
            versionCacheSet(cacheKey, result.new_version);
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
            lines.push(`⚠ Note: Content is identical to the previous version — no effective change.`);
          } else if (!call.args.path.startsWith('/workspace')) {
            lines.push(`⚠ Note: File is outside /workspace — git will not track this file.`);
          }

          // Stale warning from edit guard (soft, non-blocking)
          if (staleWarning) {
            lines.push(`⚠ ${staleWarning}`);
          }

          // Record successful write — model now "owns" this file content
          fileLedger.recordCreation(call.args.path);

          recordWriteFileMetric({
            durationMs: Date.now() - writeStart,
            outcome: 'success',
          });
          return { text: lines.join('\n') };
        } catch (writeErr) {
          const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          const errCode = errMsg.match(/\(([A-Z_]+)\)/)?.[1] || 'WRITE_EXCEPTION';
          recordWriteFileMetric({
            durationMs: Date.now() - writeStart,
            outcome: 'error',
            errorCode: errCode,
          });
          const writeError = classifyError(errMsg, call.args.path);
          return { text: formatStructuredError(writeError, formatSandboxError(errMsg, call.args.path)), structuredError: writeError };
        }
      }

      case 'sandbox_diff': {
        const result = await getSandboxDiff(sandboxId);

        if (result.error) {
          const diffErr = classifyError(result.error, 'sandbox_diff');
          return { text: formatStructuredError(diffErr, `[Tool Error — sandbox_diff]\n${result.error}`), structuredError: diffErr };
        }

        if (!result.diff) {
          const diagnosticLines = [
            `[Tool Result — sandbox_diff]`,
            `No changes detected.`,
          ];
          if (result.git_status) {
            diagnosticLines.push(`\ngit status output:\n${result.git_status}`);
          } else {
            diagnosticLines.push(`\nThe working tree is clean. If you expected changes, verify that sandbox_write_file succeeded and the file is inside /workspace.`);
          }
          return { text: diagnosticLines.join('\n') };
        }

        const stats = parseDiffStats(result.diff);
        const lines: string[] = [
          `[Tool Result — sandbox_diff]`,
          `${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''} changed, +${stats.additions} -${stats.deletions}`,
          result.truncated ? `(truncated)\n` : '',
          result.diff,
        ];

        const cardData: DiffPreviewCardData = {
          diff: result.diff,
          filesChanged: stats.filesChanged,
          additions: stats.additions,
          deletions: stats.deletions,
          truncated: result.truncated,
        };

        return { text: lines.join('\n'), card: { type: 'diff-preview', data: cardData } };
      }

      case 'sandbox_prepare_commit': {
        // Step 1: Get the diff
        const diffResult = await getSandboxDiff(sandboxId);

        if (diffResult.error) {
          const commitDiffErr = classifyError(diffResult.error, 'sandbox_prepare_commit');
          return { text: formatStructuredError(commitDiffErr, `[Tool Error — sandbox_prepare_commit]\n${diffResult.error}`), structuredError: commitDiffErr };
        }

        if (!diffResult.diff) {
          const lines = [`[Tool Result — sandbox_prepare_commit]\nNo changes to commit.`];
          if (diffResult.git_status) {
            lines.push(`git status shows: ${diffResult.git_status}`);
          } else {
            lines.push(`Working tree is clean. Verify files were written inside /workspace and content differs from the original.`);
          }
          return { text: lines.join('\n') };
        }

        // Step 2: Run Auditor
        const auditResult = await runAuditor(
          diffResult.diff,
          (phase) => console.log(`[Push] Auditor: ${phase}`),
        );

        if (auditResult.verdict === 'unsafe') {
          // Blocked — return verdict card only, no review card
          return {
            text: `[Tool Result — sandbox_prepare_commit]\nCommit BLOCKED by Auditor: ${auditResult.card.summary}`,
            card: { type: 'audit-verdict', data: auditResult.card },
          };
        }

        // Step 3: SAFE — return a review card for user approval (do NOT commit)
        const stats = parseDiffStats(diffResult.diff);
        const reviewData: CommitReviewCardData = {
          diff: {
            diff: diffResult.diff,
            filesChanged: stats.filesChanged,
            additions: stats.additions,
            deletions: stats.deletions,
            truncated: diffResult.truncated,
          },
          auditVerdict: auditResult.card,
          commitMessage: call.args.message,
          status: 'pending',
        };

        return {
          text: `[Tool Result — sandbox_prepare_commit]\nReady for review: "${call.args.message}" (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions}). Waiting for user approval.`,
          card: { type: 'commit-review', data: reviewData },
        };
      }

      case 'sandbox_push': {
        const pushResult = await execInSandbox(sandboxId, 'cd /workspace && git push origin HEAD');

        if (pushResult.exitCode !== 0) {
          return { text: `[Tool Result — sandbox_push]\nPush failed: ${pushResult.stderr}` };
        }

        return { text: `[Tool Result — sandbox_push]\nPushed successfully.` };
      }

      case 'sandbox_run_tests': {
        const start = Date.now();

        // Auto-detect test framework if not specified
        let command = '';
        let framework: TestResultsCardData['framework'] = 'unknown';

        if (call.args.framework) {
          // User specified framework
          switch (call.args.framework.toLowerCase()) {
            case 'npm':
            case 'jest':
            case 'vitest':
            case 'mocha':
              command = 'npm test';
              framework = 'npm';
              break;
            case 'pytest':
            case 'python':
              command = 'pytest -v';
              framework = 'pytest';
              break;
            case 'cargo':
            case 'rust':
              command = 'cargo test';
              framework = 'cargo';
              break;
            case 'go':
              command = 'go test ./...';
              framework = 'go';
              break;
            default:
              command = call.args.framework;
              framework = 'unknown';
          }
        } else {
          // Auto-detect by checking for config files
          const detectResult = await execInSandbox(
            sandboxId,
            'cd /workspace && ls -1 package.json Cargo.toml go.mod pytest.ini pyproject.toml setup.py 2>/dev/null | head -1',
          );
          const detected = detectResult.stdout.trim();

          if (detected === 'package.json') {
            command = 'npm test';
            framework = 'npm';
          } else if (detected === 'Cargo.toml') {
            command = 'cargo test';
            framework = 'cargo';
          } else if (detected === 'go.mod') {
            command = 'go test ./...';
            framework = 'go';
          } else if (['pytest.ini', 'pyproject.toml', 'setup.py'].includes(detected)) {
            command = 'pytest -v';
            framework = 'pytest';
          } else {
            // Fallback: try npm test
            command = 'npm test';
            framework = 'npm';
          }
        }

        const result = await execInSandbox(sandboxId, `cd /workspace && ${command}`);
        const durationMs = Date.now() - start;
        // Tests can generate artifacts, coverage files, snapshots, etc.
        clearFileVersionCache(sandboxId);

        // Parse test results from output
        const output = result.stdout + '\n' + result.stderr;
        let passed = 0, failed = 0, skipped = 0, total = 0;

        // npm/jest/vitest patterns
        const jestMatch = output.match(/Tests:\s*(\d+)\s*passed.*?(\d+)\s*failed.*?(\d+)\s*total/i) ||
                          output.match(/(\d+)\s*passing.*?(\d+)\s*failing/i);
        // pytest patterns
        const pytestMatch = output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i) ||
                            output.match(/passed:\s*(\d+).*?failed:\s*(\d+)/i);
        // cargo patterns
        const cargoMatch = output.match(/test result:.*?(\d+)\s*passed.*?(\d+)\s*failed/i);
        // go patterns — count both passing and failing packages
        const goPassMatch = output.match(/ok\s+.*?\s+(\d+\.\d+)s/g);
        const goFailMatch = output.match(/FAIL\s+.*?\s+(\d+\.\d+)s/g);

        if (jestMatch) {
          passed = parseInt(jestMatch[1]) || 0;
          failed = parseInt(jestMatch[2]) || 0;
          total = jestMatch[3] ? (parseInt(jestMatch[3]) || 0) : (passed + failed);
        } else if (pytestMatch) {
          passed = parseInt(pytestMatch[1]) || 0;
          failed = parseInt(pytestMatch[2]) || 0;
          total = passed + failed;
        } else if (cargoMatch) {
          passed = parseInt(cargoMatch[1]) || 0;
          failed = parseInt(cargoMatch[2]) || 0;
          total = passed + failed;
        } else if (goPassMatch || goFailMatch) {
          passed = goPassMatch ? goPassMatch.length : 0;
          failed = goFailMatch ? goFailMatch.length : 0;
          total = passed + failed;
        }

        // Check for skipped tests
        const skipMatch = output.match(/(\d+)\s*skipped/i);
        if (skipMatch) {
          skipped = parseInt(skipMatch[1]) || 0;
          total += skipped;
        }

        const truncated = output.length > 8000;
        const truncatedOutput = truncated ? output.slice(0, 8000) + '\n\n[...output truncated]' : output;

        const statusIcon = result.exitCode === 0 ? '✓' : '✗';
        const lines: string[] = [
          `[Tool Result — sandbox_run_tests]`,
          `${statusIcon} Tests ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} (${framework})`,
          `Command: ${command}`,
          `Duration: ${(durationMs / 1000).toFixed(1)}s`,
          total > 0 ? `Results: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}` : '',
          `\nOutput:\n${truncatedOutput}`,
        ].filter(Boolean);

        const cardData: TestResultsCardData = {
          framework,
          passed,
          failed,
          skipped,
          total,
          durationMs,
          exitCode: result.exitCode,
          output: truncatedOutput,
          truncated,
        };

        return { text: lines.join('\n'), card: { type: 'test-results', data: cardData } };
      }

      case 'sandbox_check_types': {
        const start = Date.now();

        // Auto-detect type checker
        let command = '';
        let tool: TypeCheckCardData['tool'] = 'unknown';

        // Check for TypeScript first (most common)
        const detectResult = await execInSandbox(
          sandboxId,
          'cd /workspace && ls -1 tsconfig.json pyrightconfig.json mypy.ini 2>/dev/null | head -1',
        );
        const detected = detectResult.stdout.trim();

        if (detected === 'tsconfig.json' || detected === 'tsconfig.app.json' || detected === 'tsconfig.node.json') {
          // Check if node_modules exists, install if missing
          const nodeModulesCheck = await execInSandbox(sandboxId, 'cd /workspace && ls -d node_modules 2>/dev/null');
          if (nodeModulesCheck.exitCode !== 0) {
            const installResult = await execInSandbox(sandboxId, 'cd /workspace && npm install');
            if (installResult.exitCode !== 0) {
              return { text: `[Tool Result — sandbox_check_types]\nFailed to install dependencies:\n${installResult.stderr}` };
            }
            // npm install modifies node_modules, package-lock.json, etc.
            clearFileVersionCache(sandboxId);
          }

          // Check if tsc is available and run type check
          const tscCheck = await execInSandbox(sandboxId, 'cd /workspace && npx tsc --version 2>/dev/null');
          if (tscCheck.exitCode === 0) {
            command = 'npx tsc --noEmit';
            tool = 'tsc';
          }
        } else if (detected === 'pyrightconfig.json') {
          // Check if pyright is available
          const pyrightCheck = await execInSandbox(sandboxId, 'cd /workspace && pyright --version 2>/dev/null');
          if (pyrightCheck.exitCode === 0) {
            command = 'pyright';
            tool = 'pyright';
          }
        } else if (detected === 'mypy.ini') {
          // Check if mypy is available
          const mypyCheck = await execInSandbox(sandboxId, 'cd /workspace && mypy --version 2>/dev/null');
          if (mypyCheck.exitCode === 0) {
            // Use 'mypy' without args to respect mypy.ini config paths
            command = 'mypy';
            tool = 'mypy';
          }
        }

        if (!command) {
          // Fallback: try tsc if package.json exists
          const pkgCheck = await execInSandbox(sandboxId, 'cd /workspace && cat package.json 2>/dev/null');
          if (pkgCheck.stdout.includes('typescript')) {
            command = 'npx tsc --noEmit';
            tool = 'tsc';
          } else {
            return { text: '[Tool Result — sandbox_check_types]\nNo type checker detected. Supported: TypeScript (tsc), Pyright, mypy.' };
          }
        }

        const result = await execInSandbox(sandboxId, `cd /workspace && ${command}`);
        const durationMs = Date.now() - start;

        const output = result.stdout + '\n' + result.stderr;
        const errors: TypeCheckCardData['errors'] = [];
        let errorCount = 0;
        let warningCount = 0;

        // Parse TypeScript errors: file.ts(line,col): error TS1234: message
        if (tool === 'tsc') {
          const tsErrorRegex = /(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+):\s*(.+)/g;
          let match;
          while ((match = tsErrorRegex.exec(output)) !== null && errors.length < 50) {
            const isError = match[4] === 'error';
            if (isError) errorCount++;
            else warningCount++;
            errors.push({
              file: match[1],
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              message: match[6],
              code: match[5],
            });
          }
          // Also check for "Found N errors" summary
          const summaryMatch = output.match(/Found (\d+) errors?/);
          if (summaryMatch) {
            errorCount = Math.max(errorCount, parseInt(summaryMatch[1]));
          }
        }

        // Parse Pyright errors: file.py:line:col - error: message
        if (tool === 'pyright') {
          const pyrightRegex = /(.+?):(\d+):(\d+)\s*-\s*(error|warning):\s*(.+)/g;
          let match;
          while ((match = pyrightRegex.exec(output)) !== null && errors.length < 50) {
            const isError = match[4] === 'error';
            if (isError) errorCount++;
            else warningCount++;
            errors.push({
              file: match[1],
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              message: match[5],
            });
          }
        }

        // Parse mypy errors: file.py:line: error: message
        if (tool === 'mypy') {
          const mypyRegex = /(.+?):(\d+):\s*(error|warning):\s*(.+)/g;
          let match;
          while ((match = mypyRegex.exec(output)) !== null && errors.length < 50) {
            const isError = match[3] === 'error';
            if (isError) errorCount++;
            else warningCount++;
            errors.push({
              file: match[1],
              line: parseInt(match[2]),
              column: 0,
              message: match[4],
            });
          }
        }

        const truncated = output.length > 8000;
        const statusIcon = result.exitCode === 0 ? '✓' : '✗';
        const lines: string[] = [
          `[Tool Result — sandbox_check_types]`,
          `${statusIcon} Type check ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} (${tool})`,
          `Command: ${command}`,
          `Duration: ${(durationMs / 1000).toFixed(1)}s`,
          errorCount > 0 || warningCount > 0 ? `Found: ${errorCount} error${errorCount !== 1 ? 's' : ''}${warningCount > 0 ? `, ${warningCount} warning${warningCount !== 1 ? 's' : ''}` : ''}` : '',
        ].filter(Boolean);

        if (errors.length > 0) {
          lines.push('\nErrors:');
          for (const err of errors.slice(0, 10)) {
            lines.push(`  ${err.file}:${err.line}${err.column ? `:${err.column}` : ''} — ${err.message}`);
          }
          if (errors.length > 10) {
            lines.push(`  ...and ${errors.length - 10} more`);
          }
        }

        const cardData: TypeCheckCardData = {
          tool,
          errors,
          errorCount,
          warningCount,
          exitCode: result.exitCode,
          truncated,
        };

        return { text: lines.join('\n'), card: { type: 'type-check', data: cardData } };
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
          return { text: '[Tool Result — sandbox_save_draft]\nNo changes to save. Working tree is clean.' };
        }

        // Step 2: Get current branch
        const currentBranchResult = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
        const currentBranch = currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

        // Step 3: Determine draft branch name — must start with draft/ (unaudited path)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        if (call.args.branch_name && !call.args.branch_name.startsWith('draft/')) {
          return { text: '[Tool Error — sandbox_save_draft]\nbranch_name must start with "draft/". This tool skips Auditor review and is restricted to draft branches. Use sandbox_prepare_commit for non-draft branches.' };
        }
        const draftBranchName = call.args.branch_name || `draft/${currentBranch || 'main'}-${timestamp}`;

        // Step 4: Create draft branch if not already on one
        const needsNewBranch = !currentBranch.startsWith('draft/');
        if (needsNewBranch) {
          const checkoutResult = await execInSandbox(
            sandboxId,
            `cd /workspace && git checkout -b ${shellEscape(draftBranchName)}`,
          );
          if (checkoutResult.exitCode !== 0) {
            return { text: `[Tool Error — sandbox_save_draft]\nFailed to create draft branch: ${checkoutResult.stderr}` };
          }
        }

        const activeDraftBranch = needsNewBranch ? draftBranchName : currentBranch;

        // Step 5: Stage all changes and commit (no Auditor — drafts are WIP)
        const draftMessage = call.args.message || 'WIP: draft save';
        const stageResult = await execInSandbox(sandboxId, 'cd /workspace && git add -A');
        if (stageResult.exitCode !== 0) {
          return { text: `[Tool Error — sandbox_save_draft]\nFailed to stage changes: ${stageResult.stderr}` };
        }

        const commitResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git commit -m ${shellEscape(draftMessage)}`,
        );
        if (commitResult.exitCode !== 0) {
          return { text: `[Tool Error — sandbox_save_draft]\nFailed to commit draft: ${commitResult.stderr}` };
        }
        // git add + commit changes file hashes tracked by git
        clearFileVersionCache(sandboxId);

        // Step 6: Push to remote
        const pushResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git push -u origin ${shellEscape(activeDraftBranch)}`,
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
          pushOk ? 'Pushed to remote.' : `Push failed: ${pushResult.stderr}. Use sandbox_push() to retry.`,
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
        const requestedName = call.args.repo_name.trim();
        const repoName = requestedName.includes('/') ? requestedName.split('/').pop()!.trim() : requestedName;
        if (!repoName) {
          return { text: '[Tool Error] promote_to_github requires a valid repo_name.' };
        }

        const createdRepo = await createGitHubRepo(
          repoName,
          call.args.description,
          call.args.private !== undefined ? call.args.private : true,
        );

        const authToken = getActiveGitHubToken();
        if (!authToken) {
          return { text: '[Tool Error] GitHub auth token missing after repo creation.' };
        }
        const remoteUrl = `https://x-access-token:${authToken}@github.com/${createdRepo.full_name}.git`;

        const branchResult = await execInSandbox(
          sandboxId,
          'cd /workspace && git rev-parse --abbrev-ref HEAD',
        );
        const branchName = branchResult.exitCode === 0
          ? (branchResult.stdout.trim() || createdRepo.default_branch || 'main')
          : (createdRepo.default_branch || 'main');

        const remoteResult = await execInSandbox(
          sandboxId,
          `cd /workspace && if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin ${shellEscape(remoteUrl)}; else git remote add origin ${shellEscape(remoteUrl)}; fi`,
        );
        if (remoteResult.exitCode !== 0) {
          const remoteError = sanitizeGitOutput(remoteResult.stderr || remoteResult.stdout || 'unknown error', authToken);
          return { text: `[Tool Error] Created repo ${createdRepo.full_name}, but failed to configure git remote: ${remoteError}` };
        }

        const pushResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git push -u origin ${shellEscape(branchName)}`,
        );

        const rawPushError = `${pushResult.stderr}\n${pushResult.stdout}`.toLowerCase();
        const noCommitsYet = rawPushError.includes('src refspec')
          || rawPushError.includes('does not match any')
          || rawPushError.includes('no commits yet');

        const repoObject: ActiveRepo = {
          id: createdRepo.id,
          name: createdRepo.name,
          full_name: createdRepo.full_name,
          owner: createdRepo.owner?.login || createdRepo.full_name.split('/')[0],
          default_branch: createdRepo.default_branch || branchName || 'main',
          private: createdRepo.private,
        };

        if (pushResult.exitCode !== 0 && !noCommitsYet) {
          const pushError = sanitizeGitOutput(pushResult.stderr || pushResult.stdout || 'unknown error', authToken);
          return {
            text: `[Tool Error] Repo ${createdRepo.full_name} was created, but push failed: ${pushError}. You can retry after fixing git/auth state.`,
          };
        }

        const warning = pushResult.exitCode !== 0 && noCommitsYet
          ? 'Repo created and remote configured, but there were no local commits to push yet.'
          : undefined;

        const lines = [
          '[Tool Result — promote_to_github]',
          `Repository created: ${createdRepo.full_name}`,
          `Visibility: ${createdRepo.private ? 'private' : 'public'}`,
          `Default branch: ${createdRepo.default_branch || branchName || 'main'}`,
          warning ? `Warning: ${warning}` : `Push: successful on branch ${branchName}`,
        ];

        return {
          text: lines.join('\n'),
          promotion: {
            repo: repoObject,
            pushed: !warning,
            warning,
            htmlUrl: createdRepo.html_url,
          },
        };
      }

      case 'sandbox_read_symbols': {
        const filePath = call.args.path;
        const ext = filePath.split('.').pop()?.toLowerCase() || '';

        // Inline Python script that handles both Python (ast) and TS/JS (regex)
        const pythonScript = `
import sys, json, os

path = sys.argv[1]
ext = os.path.splitext(path)[1].lower()
symbols = []

try:
    with open(path, 'r', errors='replace') as f:
        content = f.read()
        lines = content.split('\\n')
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)

if ext == '.py':
    import ast
    try:
        tree = ast.parse(content, filename=path)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) or isinstance(node, ast.AsyncFunctionDef):
                args = ', '.join(a.arg for a in node.args.args)
                prefix = 'async ' if isinstance(node, ast.AsyncFunctionDef) else ''
                symbols.append({"name": node.name, "kind": "function", "line": node.lineno, "signature": f"{prefix}def {node.name}({args})"})
            elif isinstance(node, ast.ClassDef):
                bases = ', '.join(getattr(b, 'id', '?') if hasattr(b, 'id') else '?' for b in node.bases)
                symbols.append({"name": node.name, "kind": "class", "line": node.lineno, "signature": f"class {node.name}({bases})" if bases else f"class {node.name}"})
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                if isinstance(node, ast.ImportFrom):
                    names = ', '.join(a.name for a in node.names)
                    symbols.append({"name": node.module or '', "kind": "import", "line": node.lineno, "signature": f"from {node.module} import {names}"})
                else:
                    for alias in node.names:
                        symbols.append({"name": alias.name, "kind": "import", "line": node.lineno, "signature": f"import {alias.name}"})
    except SyntaxError as e:
        symbols.append({"name": "PARSE_ERROR", "kind": "error", "line": e.lineno or 0, "signature": str(e)})
else:
    import re
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        # export/function/class/interface/type/const patterns
        m = re.match(r'^export\\s+(default\\s+)?(async\\s+)?function\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(3), "kind": "function", "line": i, "signature": stripped.split('{')[0].strip().rstrip(':')})
            continue
        m = re.match(r'^(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "class", "line": i, "signature": stripped.split('{')[0].strip()})
            continue
        m = re.match(r'^(?:export\\s+)?interface\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "interface", "line": i, "signature": stripped.split('{')[0].strip()})
            continue
        m = re.match(r'^(?:export\\s+)?type\\s+(\\w+)\\s*[=<]', stripped)
        if m:
            symbols.append({"name": m.group(1), "kind": "type", "line": i, "signature": stripped.split('=')[0].strip()})
            continue
        m = re.match(r'^(?:export\\s+)?(const|let|var)\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(2), "kind": "variable", "line": i, "signature": stripped.split('=')[0].strip().rstrip(':')})
            continue
        # Standalone function (no export)
        m = re.match(r'^(async\\s+)?function\\s+(\\w+)', stripped)
        if m:
            symbols.append({"name": m.group(2), "kind": "function", "line": i, "signature": stripped.split('{')[0].strip().rstrip(':')})
            continue

print(json.dumps({"symbols": symbols, "total_lines": len(lines)}))
`.trim();

        const escapedFilePath = shellEscape(filePath);
        const result = await execInSandbox(
          sandboxId,
          `python3 -c ${shellEscape(pythonScript)} ${escapedFilePath}`,
        );

        if (result.exitCode !== 0) {
          const err = classifyError(result.stderr || 'Symbol extraction failed', filePath);
          return { text: formatStructuredError(err, `[Tool Error — sandbox_read_symbols]\n${result.stderr || 'Failed to extract symbols'}`), structuredError: err };
        }

        try {
          const parsed = JSON.parse(result.stdout.trim()) as {
            error?: string;
            symbols?: Array<{ name: string; kind: string; line: number; signature: string }>;
            total_lines?: number;
          };

          if (parsed.error) {
            const err = classifyError(parsed.error, filePath);
            return { text: formatStructuredError(err, `[Tool Error — sandbox_read_symbols]\n${parsed.error}`), structuredError: err };
          }

          const symbols = parsed.symbols || [];
          const totalLines = parsed.total_lines || 0;
          const lang = ['py'].includes(ext) ? 'Python' : ['ts', 'tsx', 'js', 'jsx'].includes(ext) ? 'TypeScript/JavaScript' : ext;

          const lines: string[] = [
            `[Tool Result — sandbox_read_symbols]`,
            `File: ${filePath} (${totalLines} lines, ${lang})`,
            `Symbols: ${symbols.length}`,
            '',
          ];

          for (const sym of symbols) {
            lines.push(`  ${sym.kind.padEnd(10)} L${String(sym.line).padStart(4)}  ${sym.signature}`);
          }

          if (symbols.length === 0) {
            lines.push('  (no symbols found)');
          }

          return { text: lines.join('\n') };
        } catch {
          return { text: `[Tool Error — sandbox_read_symbols]\nFailed to parse symbol output: ${result.stdout.slice(0, 500)}` };
        }
      }

      case 'sandbox_apply_patchset': {
        const { edits, dryRun } = call.args;

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

        // Phase 1: Read all files and validate all hashline ops
        const fileContents = new Map<string, { content: string; version?: string }>();
        const validationErrors: string[] = [];
        const editResults: Array<{ path: string; content: string; applied: number; version?: string }> = [];

        // Read all files in parallel
        const readPromises = edits.map(async (edit) => {
          try {
            const readResult = await readFromSandbox(sandboxId, edit.path) as FileReadResult & { error?: string };
            if (readResult.error) {
              validationErrors.push(`${edit.path}: ${readResult.error}`);
              return;
            }
            fileContents.set(edit.path, {
              content: readResult.content,
              version: typeof readResult.version === 'string' ? readResult.version : undefined,
            });
          } catch (e) {
            validationErrors.push(`${edit.path}: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
        await Promise.all(readPromises);

        if (validationErrors.length > 0) {
          const err: StructuredToolError = { type: 'FILE_NOT_FOUND', retryable: false, message: `Failed to read ${validationErrors.length} file(s)`, detail: validationErrors.join('; ') };
          return {
            text: formatStructuredError(err, [
              `[Tool Error — sandbox_apply_patchset]`,
              `Failed to read ${validationErrors.length} file(s):`,
              ...validationErrors.map(e => `  - ${e}`),
              `No changes were written.`,
            ].join('\n')),
            structuredError: err,
          };
        }

        // Validate all hashline ops against file contents
        for (const edit of edits) {
          const fileData = fileContents.get(edit.path);
          if (!fileData) continue; // shouldn't happen given the check above

          const editResult = await applyHashlineEdits(fileData.content, edit.ops);
          if (editResult.failed > 0) {
            validationErrors.push(`${edit.path}: ${editResult.errors.join('; ')}`);
          } else {
            editResults.push({
              path: edit.path,
              content: editResult.content,
              applied: editResult.applied,
              version: fileData.version,
            });
          }
        }

        if (validationErrors.length > 0) {
          const err: StructuredToolError = { type: 'EDIT_HASH_MISMATCH', retryable: false, message: `Hash mismatch in ${validationErrors.length} file(s)`, detail: validationErrors.join('; ') };
          return {
            text: formatStructuredError(err, [
              `[Tool Error — sandbox_apply_patchset]`,
              `Validation failed for ${validationErrors.length} file(s):`,
              ...validationErrors.map(e => `  - ${e}`),
              `No changes were written. Re-read the affected files and retry.`,
            ].join('\n')),
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
          return { text: lines.join('\n') };
        }

        // Phase 2: Batch write all files in a single HTTP request
        const writeResults: string[] = [];
        const writeFailures: string[] = [];

        // Build index for lookup by path
        const editResultsByPath = new Map(editResults.map(r => [r.path, r]));

        try {
          const batchEntries: BatchWriteEntry[] = editResults.map(r => ({
            path: r.path,
            content: r.content,
            expected_version: r.version,
          }));
          const batchResult = await batchWriteToSandbox(sandboxId, batchEntries);

          for (const entry of batchResult.results) {
            const editInfo = editResultsByPath.get(entry.path);
            if (entry.ok) {
              // Update version cache
              const cacheKey = fileVersionKey(sandboxId, entry.path);
              if (typeof entry.new_version === 'string' && entry.new_version) {
                versionCacheSet(cacheKey, entry.new_version);
              }
              fileLedger.recordCreation(entry.path);
              writeResults.push(`${entry.path}: ${editInfo?.applied ?? '?'} op(s) applied, ${entry.bytes_written ?? 0} bytes written`);
            } else {
              if (entry.code === 'STALE_FILE') {
                writeFailures.push(`${entry.path}: stale write rejected (version changed during patchset)`);
              } else {
                writeFailures.push(`${entry.path}: ${entry.error || 'write failed'}`);
              }
            }
          }
        } catch (batchErr) {
          // Fallback to sequential writes if batch endpoint is unavailable.
          // Invalidate version cache for ALL files first — sequential writes may
          // partially succeed, leaving the cache inconsistent with sandbox truth.
          console.warn('[sandbox-tools] batch write failed, falling back to sequential writes:', batchErr);
          for (const r of editResults) {
            versionCacheDeletePath(sandboxId, r.path);
          }
          for (const r of editResults) {
            try {
              const writeResult = await writeToSandbox(sandboxId, r.path, r.content, r.version);
              if (!writeResult.ok) {
                if (writeResult.code === 'STALE_FILE') {
                  writeFailures.push(`${r.path}: stale write rejected (version changed during patchset)`);
                } else {
                  writeFailures.push(`${r.path}: ${writeResult.error || 'write failed'}`);
                }
              } else {
                const cacheKey = fileVersionKey(sandboxId, r.path);
                if (typeof writeResult.new_version === 'string' && writeResult.new_version) {
                  versionCacheSet(cacheKey, writeResult.new_version);
                }
                fileLedger.recordCreation(r.path);
                writeResults.push(`${r.path}: ${r.applied} op(s) applied, ${writeResult.bytes_written ?? r.content.length} bytes written`);
              }
            } catch (e) {
              writeFailures.push(`${r.path}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }

        if (writeFailures.length > 0) {
          const lines: string[] = [
            `[Tool Result — sandbox_apply_patchset] (partial failure)`,
            `${writeResults.length} of ${editResults.length} file(s) written successfully:`,
          ];
          if (writeResults.length > 0) {
            lines.push(...writeResults.map(r => `  ✓ ${r}`));
          }
          lines.push(`${writeFailures.length} file(s) failed:`);
          lines.push(...writeFailures.map(f => `  ✗ ${f}`));
          return { text: lines.join('\n') };
        }

        const lines: string[] = [
          `[Tool Result — sandbox_apply_patchset]`,
          `All ${editResults.length} file(s) patched successfully:`,
          ...writeResults.map(r => `  ✓ ${r}`),
        ];
        return { text: lines.join('\n') };
      }

      default:
        return { text: `[Tool Error] Unknown sandbox tool: ${String((call as { tool?: unknown }).tool ?? 'unknown')}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Push] Sandbox tool error:', msg);
    const catchErr = classifyError(msg, String((call as { tool?: unknown }).tool ?? 'unknown'));
    return { text: formatStructuredError(catchErr, `[Tool Error] ${msg}`), structuredError: catchErr };
  }
}

// --- System prompt extension ---

export const SANDBOX_TOOL_PROTOCOL = `
SANDBOX TOOLS — You have access to a code sandbox (persistent container with the repo cloned).

Additional tools available when sandbox is active:
- sandbox_exec(command, workdir?) — Run a shell command in the sandbox (default workdir: /workspace)
- sandbox_read_file(path, start_line?, end_line?) — Read a file from the sandbox filesystem. Only works on files — fails on directories. Use start_line/end_line to read a specific line range (1-indexed). When a range is specified, output includes line numbers for reference.
- sandbox_search(query, path?) — Search file contents in the sandbox (uses rg/grep). Case-sensitive by default; supports regex patterns. Fast way to locate functions, symbols, and strings before editing. Tip: use short, distinctive substrings rather than full names to catch different naming conventions.
- sandbox_list_dir(path?) — List files and folders in a sandbox directory (default: /workspace). Use this to explore the project structure before reading specific files.
- sandbox_write_file(path, content, expected_version?) — Write or overwrite a file in the sandbox. If expected_version is provided, stale writes are rejected.
- sandbox_edit_file(path, edits, expected_version?) — Edit a file using content hashes as line references. edits is an array of HashlineOp: { op: "replace_line" | "insert_after" | "insert_before" | "delete_line", ref: string, content: string }. The ref can be a bare hash ("abc1234", 7-12 hex chars) or a line-qualified ref ("42:abc1234" — 1-indexed line number + colon + hash). Read results show "[hash] lineNo" per line; use those in refs. For unique lines, bare hashes work fine. When lines have duplicate content (same hash), use a line-qualified ref to target the exact line — this always resolves unambiguously. If an edit fails with an ambiguity error, the error shows matching line numbers — retry with a line-qualified ref.
- sandbox_diff() — Get the git diff of all uncommitted changes
- sandbox_prepare_commit(message) — Prepare a commit for review. Gets diff, runs Auditor. If SAFE, returns a review card for user approval. Does NOT commit — user must approve via the UI.
- sandbox_push() — Retry a failed push. Use this only if a push failed after approval. No Auditor needed (commit was already audited).
- sandbox_run_tests(framework?) — Run the test suite. Auto-detects npm/pytest/cargo/go if framework not specified. Returns pass/fail counts and output.
- sandbox_check_types() — Run type checker (tsc for TypeScript, pyright/mypy for Python). Auto-detects from config files. Returns errors with file:line locations.
- sandbox_save_draft(message?, branch_name?) — Quick-save all uncommitted changes to a draft branch. Stages everything, commits with the message (default: "WIP: draft save"), and pushes. Skips Auditor review (drafts are WIP). If not already on a draft/ branch, creates one automatically. Use this for checkpoints, WIP saves, or before sandbox expiry.
- sandbox_download(path?) — Download workspace files as a compressed archive (tar.gz). Path defaults to /workspace. Returns a download card the user can save.
- sandbox_read_symbols(path) — Extract a symbol index from a source file (functions, classes, interfaces, types, imports with line numbers). Works on .py (via ast), .ts/.tsx/.js/.jsx (via regex). Use this to understand file structure before editing — cheaper than reading the whole file.
- sandbox_apply_patchset(edits, dryRun?) — Apply hashline edits to multiple files with all-or-nothing validation. edits is an array of { path, ops: HashlineOp[] } (each path must appear once). Phase 1 reads all files and validates all ops — if any fail, nothing is written. Phase 2 writes sequentially (partial failure possible if a write fails mid-way). Use dryRun=true to validate without writing. Prefer this over multiple sandbox_edit_file calls when editing 2+ files together.
- promote_to_github(repo_name, description?, private?) — Create a new GitHub repo under the authenticated user, set the sandbox git remote, and push current branch. Defaults to private=true.

Compatibility aliases also work:
- read_sandbox_file(path, start_line?, end_line?) → sandbox_read_file
- search_sandbox(query, path?) → sandbox_search
- list_sandbox_dir(path?) → sandbox_list_dir

Usage: Output a fenced JSON block just like GitHub tools:
\`\`\`json
{"tool": "sandbox_exec", "args": {"command": "npm test"}}
\`\`\`

Commit message guidelines for sandbox_prepare_commit:
- Use conventional commit format (feat:, fix:, refactor:, docs:, etc.)
- Keep under 72 characters
- Describe what changed and why, not how

Sandbox rules:
- CRITICAL: To use a sandbox tool, you MUST output the fenced JSON block. Do NOT describe or narrate tool usage in prose. The system can ONLY detect and execute tool calls from JSON blocks.
- The repo is cloned to /workspace — use that as the working directory
- You can install packages, run tests, build, lint — anything you'd do in a terminal
- For multi-step tasks (edit + test), use multiple tool calls in sequence
- You may emit multiple tool calls in one message. Read-only calls (sandbox_read_file, sandbox_search, sandbox_list_dir, sandbox_diff) run in parallel. Place any mutating call (sandbox_exec, sandbox_write_file, sandbox_edit_file, sandbox_prepare_commit, sandbox_push, sandbox_apply_patchset, etc.) LAST — it runs after all reads complete. Maximum 6 parallel reads per turn.
- Prefer read → write flows for edits. Use expected_version from sandbox_read_file to avoid stale overwrites. For large files, use start_line/end_line to read only the relevant section before editing.
- sandbox_diff shows what you've changed — review before committing
- sandbox_prepare_commit triggers the Auditor for safety review, then presents a review card. The user approves or rejects via the UI.
- If the push fails after a successful commit, use sandbox_push() to retry
- Keep commands focused — avoid long-running servers or background processes
- IMPORTANT: sandbox_read_file only works on files, not directories. To explore the project structure, use sandbox_list_dir first, then read specific files.
- Before delegating code changes, prefer sandbox_search to quickly locate relevant files/functions and provide precise context.
- Search strategy: Start with short, distinctive substrings. If no results, broaden the term or drop the path filter. Use sandbox_list_dir to verify paths exist. Use sandbox_read_symbols(path) to discover function/class names in a specific file without reading the whole file.
- Use sandbox_run_tests BEFORE committing to catch regressions early. It's faster than sandbox_exec("npm test") and gives structured results.
- Use sandbox_check_types to validate TypeScript/Python code before committing. Catches type errors that tests might miss.`;
