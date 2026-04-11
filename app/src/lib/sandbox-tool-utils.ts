import type { StructuredToolError } from '@/types';
import { getActiveGitHubToken } from './github-auth';

export function normalizeSandboxPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '/workspace';
  if (trimmed === '/workspace' || trimmed === 'workspace') return '/workspace';
  if (trimmed.startsWith('/workspace/')) return trimmed.replace(/\/+/g, '/');
  if (trimmed.startsWith('workspace/')) return `/${trimmed}`.replace(/\/+/g, '/');
  if (trimmed.startsWith('/')) return trimmed.replace(/\/+/g, '/');
  return `/workspace/${trimmed}`.replace(/\/+/g, '/');
}

export function normalizeSandboxWorkdir(workdir?: string): string | undefined {
  if (typeof workdir !== 'string') return undefined;
  return normalizeSandboxPath(workdir);
}

export function formatSandboxDisplayPath(path: string): string {
  if (path === '/workspace') return '/workspace';
  return path.replace(/^\/workspace\//, '').replace(/^\.\//, '');
}

export function formatSandboxDisplayScope(path: string): string {
  if (path === '/workspace') return '/workspace/';
  const formatted = formatSandboxDisplayPath(path);
  return formatted.endsWith('/') ? formatted : `${formatted}/`;
}

/**
 * Normalize Unicode for fuzzy comparison — collapses smart quotes, em-dashes,
 * ellipses, mojibake sequences, and other typographic variants into their
 * ASCII equivalents. Used to detect encoding mismatches in search strings.
 *
 * Mojibake occurs when UTF-8 bytes are decoded as Windows-1252 (CP1252).
 * The middle byte 0x80 maps to U+20AC (€) in CP1252, or stays as U+0080
 * in ISO-8859-1. We match both variants with a character class.
 */
export function normalizeUnicode(s: string): string {
  return (
    s
      // Mojibake: UTF-8 bytes decoded as CP1252 (common) or ISO-8859-1 (rare)
      // â + €/\x80 + CP1252(byte3)  →  original character
      .replace(/\u00e2[\u20ac\u0080]\u201c/g, '-') // â€" (en-dash U+2013)
      .replace(/\u00e2[\u20ac\u0080]\u201d/g, '-') // â€" (em-dash U+2014)
      .replace(/\u00e2[\u20ac\u0080]\u2122/g, "'") // â€™ (right single quote U+2019)
      .replace(/\u00e2[\u20ac\u0080]\u02dc/g, "'") // â€˜ (left single quote U+2018)
      .replace(/\u00e2[\u20ac\u0080]\u0153/g, '"') // â€œ (left double quote U+201C)
      .replace(/\u00e2[\u20ac\u0080][\u009d\u201d]/g, '"') // â€\x9d (right double quote U+201D)
      .replace(/\u00e2[\u20ac\u0080]\u00a6/g, '...') // â€¦ (ellipsis U+2026)
      .replace(/\u00e2[\u2020\u0086][\u2019\u0092]/g, '->') // â†' (right arrow U+2192)
      // Actual Unicode typographic characters
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // smart single quotes → '
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"') // smart double quotes → "
      .replace(/[\u2013\u2014]/g, '-') // en-dash, em-dash → -
      .replace(/\u2026/g, '...') // ellipsis → ...
      .replace(/\u2192/g, '->') // right arrow → ->
      .replace(/\u00A0/g, ' ') // non-breaking space → space
      // NFC normalization for accented characters
      .normalize('NFC')
  );
}

export function extractSandboxSearchResultPath(line: string): string | null {
  const match = line.match(/^(.*?):\d+(?::|$)/);
  if (!match?.[1]) return null;
  return normalizeSandboxPath(match[1]);
}

export function formatSandboxError(error: string, context?: string): string {
  const lowerError = error.toLowerCase();
  const lowerContext = context?.toLowerCase() ?? '';
  const isEnoent = lowerError.includes('enoent') || error.includes('ENOENT');
  const looksLikeCommandEnoent =
    isEnoent && (lowerError.includes('spawn ') || lowerContext.startsWith('sandbox_exec'));

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

/**
 * Diagnose a sandbox_exec failure from stderr and suggest a corrective action.
 * Returns a hint string, or null if the failure is not a recognizable precondition issue.
 */
export function diagnoseExecFailure(stderr: string): string | null {
  const lower = stderr.toLowerCase();

  // Command/binary not found — suggest install
  if (
    lower.includes('command not found') ||
    (lower.includes('not found') && lower.includes(': '))
  ) {
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
    const moduleMatch =
      stderr.match(/cannot find module ['"]([^'"]+)['"]/i) ||
      stderr.match(/module not found.*['"]([^'"]+)['"]/i);
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
  if (
    (lower.includes('no such file or directory') || lower.includes('enoent')) &&
    !lower.includes('command not found')
  ) {
    return `A file or directory in the command path does not exist. Use sandbox_list_dir to verify paths.`;
  }

  return null;
}

/**
 * Build actionable hints when sandbox_search returns no results.
 * Helps the model pivot quickly instead of guessing blindly.
 */
export function buildSearchNoResultsHints(query: string, searchPath: string): string[] {
  const hints: string[] = [];

  // Detect naming convention and suggest alternatives
  const isCamelOrPascal = /[a-z][A-Z]/.test(query) || /^[A-Z][a-z]/.test(query);
  const isSnakeCase = /_[a-z]/.test(query);
  const isScreamingSnake = /^[A-Z_]+$/.test(query) && query.includes('_');

  if (isCamelOrPascal || isSnakeCase || isScreamingSnake) {
    hints.push(
      `Search is case-sensitive. Try a partial/lowercase substring (e.g., "${extractKeyword(query)}") to catch different naming conventions.`,
    );
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
    hints.push(
      `Path is scoped to ${searchPath}. Try without a path filter to search the full workspace, or use sandbox_list_dir("${searchPath}") to verify the path exists.`,
    );
  }

  // General fallback suggestions
  if (hints.length === 0) {
    hints.push(
      'Try a shorter or more generic substring — partial matches work (e.g., "buildPrompt" instead of "buildOrchestratorPrompt").',
    );
  }

  hints.push(
    'Use sandbox_list_dir to browse the project structure, or sandbox_read_symbols(path) to extract function/class names from a specific file.',
  );

  return hints;
}

/**
 * Extract the most distinctive keyword from a query for suggestion purposes.
 * Splits camelCase/PascalCase/snake_case and picks the most meaningful word.
 */
export function extractKeyword(query: string): string {
  // Split on camelCase boundaries, underscores, spaces
  const parts = query
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 2);

  // Skip common prefixes like "build", "get", "set", "is", "has"
  const skipPrefixes = new Set([
    'build',
    'get',
    'set',
    'is',
    'has',
    'create',
    'make',
    'init',
    'the',
  ]);
  const meaningful = parts.filter((p) => !skipPrefixes.has(p));

  return (meaningful[0] || parts[0] || query).toLowerCase();
}

/**
 * Build actionable hints when sandbox_search fails due to a path error.
 */
export function buildSearchPathErrorHints(stderr: string, searchPath: string): string {
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

  if (
    lower.includes('no such file') ||
    lower.includes('enoent') ||
    lower.includes('not found') ||
    lower.includes('does not exist')
  ) {
    return { type: 'FILE_NOT_FOUND', retryable: false, message: error, detail: context };
  }
  // Health-check failures must be matched before the generic timeout check so
  // "health check timed out" is classified as SANDBOX_UNREACHABLE, not EXEC_TIMEOUT.
  if (
    lower.includes('sandbox_unreachable') ||
    lower.includes('modal_network_error') ||
    lower.includes('cannot connect') ||
    lower.includes('modal_error') ||
    lower.includes('sandbox unavailable') ||
    lower.includes('container error') ||
    lower.includes('container_error') ||
    lower.includes('no longer reachable') ||
    lower.includes('internal server error') ||
    lower.includes('health check failed') ||
    lower.includes('health check timed out')
  ) {
    // Transient container health issues are retryable; permanent config issues are not
    const transient =
      lower.includes('internal server error') ||
      lower.includes('container error') ||
      lower.includes('container_error') ||
      lower.includes('modal_network_error') ||
      lower.includes('modal_error') ||
      lower.includes('health check');
    return { type: 'SANDBOX_UNREACHABLE', retryable: transient, message: error, detail: context };
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('modal_timeout')) {
    return { type: 'EXEC_TIMEOUT', retryable: true, message: error, detail: context };
  }
  if (lower.includes('workspace changed') || lower.includes('workspace_changed')) {
    return { type: 'WORKSPACE_CHANGED', retryable: false, message: error, detail: context };
  }
  if (lower.includes('stale') || lower.includes('stale_file') || lower.includes('stale write')) {
    return { type: 'STALE_FILE', retryable: false, message: error, detail: context };
  }
  if (lower.includes('edit guard') || lower.includes('edit_guard_blocked')) {
    return { type: 'EDIT_GUARD_BLOCKED', retryable: false, message: error, detail: context };
  }
  if (lower.includes('git guard') || lower.includes('git_guard_blocked')) {
    return { type: 'GIT_GUARD_BLOCKED', retryable: false, message: error, detail: context };
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
export function formatStructuredError(err: StructuredToolError, baseText: string): string {
  return [baseText, `error_type: ${err.type}`, `retryable: ${err.retryable}`].join('\n');
}

/**
 * Retry a sandbox write operation once after a 2s backoff when the result
 * indicates a CONTAINER_ERROR.  HTTP-level retries in sandboxFetch only fire on
 * non-200 responses; container errors come back as 200 with ok:false, so this
 * application-level retry is needed to catch transient health blips.
 */
export async function retryOnContainerError<T extends { ok: boolean; code?: string }>(
  label: string,
  writeFn: () => Promise<T>,
): Promise<T> {
  let result = await writeFn();
  if (!result.ok && result.code === 'CONTAINER_ERROR') {
    console.log(`[${label}] Container error, retrying in 2s...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await writeFn();
  }
  return result;
}

export function getGitHubHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    Authorization: `token ${token}`,
  };
}

export function sanitizeGitOutput(value: string, token: string): string {
  if (!value) return value;
  return value.replaceAll(token, '***').replace(/x-access-token:[^@]+@/gi, 'x-access-token:***@');
}

export interface CreatedRepoResponse {
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

export async function createGitHubRepo(
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
      const text = await response.text().catch(() => '');
      try {
        const body = JSON.parse(text) as { message?: string; errors?: Array<{ message?: string }> };
        details = body.message || body.errors?.[0]?.message || '';
      } catch {
        details = text;
      }
    } catch {
      details = 'Failed to read response body';
    }
    if (response.status === 422) {
      throw new Error(
        `Repository creation failed: name likely already exists (${details || 'validation error'}).`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Repository creation failed: GitHub auth error (${details || response.status}).`,
      );
    }
    throw new Error(
      `Repository creation failed (${response.status}): ${details || 'unknown error'}`,
    );
  }

  return response.json() as Promise<CreatedRepoResponse>;
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function isLikelyMutatingSandboxExec(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;

  if (
    /^(cd\s+\S+\s*&&\s*)?(pwd|ls|find|cat|head|tail|wc|stat|file|rg|grep|sed -n|awk|git status|git diff|git show|git branch --show-current)\b/.test(
      normalized,
    )
  ) {
    return false;
  }

  if (/(^|[^0-9])>>?/.test(normalized)) {
    return true;
  }

  return (
    /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|tee|patch)\b/.test(normalized) ||
    /\bgit\s+(add|commit|checkout|switch|merge|rebase|reset|restore|clean|stash|cherry-pick|apply|am|push)\b/.test(
      normalized,
    ) ||
    /\b(npm|pnpm|yarn)\s+(install|add|remove|uninstall|update|up|ci)\b/.test(normalized) ||
    /\b(pip|pip3)\s+install\b/.test(normalized) ||
    /\bgo\s+mod\b/.test(normalized) ||
    /\bcargo\s+(add|remove)\b/.test(normalized) ||
    /\bsed\s+-i\b/.test(normalized) ||
    /\bperl\s+-pi\b/.test(normalized)
  );
}

// ---------------------------------------------------------------------------
// Git guard — block direct git mutations in sandbox_exec
// ---------------------------------------------------------------------------

const GIT_MUTATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+commit\b/i, label: 'git commit' },
  { pattern: /\bgit\s+push\b/i, label: 'git push' },
  { pattern: /\bgit\s+merge\b/i, label: 'git merge' },
  { pattern: /\bgit\s+rebase\b/i, label: 'git rebase' },
];

/**
 * Detect git mutation commands that should go through the audited flow.
 * Returns the matched command label, or null if the command is safe.
 */
export function detectBlockedGitCommand(command: string): string | null {
  for (const { pattern, label } of GIT_MUTATION_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return null;
}
