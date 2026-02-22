import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { applyHashlineEdits, calculateContentVersion, renderAnchoredRange } from './hashline.mjs';

const execFileAsync = promisify(execFile);

export const MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_SEARCH_RESULTS = 120;
const DEFAULT_WEB_SEARCH_RESULTS = 5;
const MAX_WEB_SEARCH_RESULTS = 10;
const WEB_SEARCH_TIMEOUT_MS = 15_000;
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const OLLAMA_SEARCH_URL = 'https://ollama.com/api/web_search';
const TAVILY_API_KEY_ENV_VARS = ['PUSH_TAVILY_API_KEY', 'TAVILY_API_KEY', 'VITE_TAVILY_API_KEY'];
const OLLAMA_API_KEY_ENV_VARS = ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'];
const WEB_SEARCH_BACKENDS = new Set(['auto', 'tavily', 'ollama', 'duckduckgo']);

const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_files', 'web_search', 'read_symbols', 'git_status', 'git_diff']);

// Patterns that indicate high-risk shell commands requiring user approval
const HIGH_RISK_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rRf]|--recursive|--force)/,
  /\brm\s+-[a-zA-Z]*\s/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+checkout\s+\.\s*$/,
  /\bgit\s+restore\s+\.\s*$/,
  /\bchmod\s+.*[0-7]{3,4}/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(curl|wget)\s+.*\|\s*(ba)?sh/,
  />\s*\/dev\/sd[a-z]/,
  /\bsudo\b/,
  /\bnpm\s+publish\b/,
  /\bdropdb\b/,
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
];

export function isHighRiskCommand(command) {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Returns the index of the first matching HIGH_RISK_PATTERNS entry, or -1.
 * Used by session-trust to track which risk *category* was approved.
 */
export function matchingRiskPatternIndex(command) {
  for (let i = 0; i < HIGH_RISK_PATTERNS.length; i++) {
    if (HIGH_RISK_PATTERNS[i].test(command)) return i;
  }
  return -1;
}

// ── Safe-command allowlist ────────────────────────────────────────
// Conservative built-in patterns for common dev operations.
// Anchored to $ to prevent bypass via chained commands.
const BUILTIN_SAFE_PATTERNS = [
  // rm -rf of known build/cache dirs (must be the last argument)
  /\brm\s+(-[a-zA-Z]*\s+)*-*(rf|fr)\s+(node_modules|dist|build|\.next|coverage|__pycache__|\.cache|tmp)\s*$/,
  // chmod with common safe permission modes
  /\bchmod\s+(644|755|600|700|775)\s+\S+\s*$/,
  // git checkout restoring a specific file (not bare "git checkout .")
  /\bgit\s+checkout\s+\.\s+--\s+\S+/,
  /\bgit\s+checkout\s+--\s+\S+/,
];

/**
 * Parse a user-configured safe pattern string into a test function.
 * - Strings wrapped in /slashes/ are treated as regex.
 * - Other strings are treated as prefix matches.
 * Returns null if the pattern is invalid.
 */
function parseUserSafePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) return null;
  const trimmed = pattern.trim();

  // Regex form: /pattern/
  if (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) {
    try {
      const re = new RegExp(trimmed.slice(1, -1));
      return (cmd) => re.test(cmd);
    } catch {
      return null; // invalid regex — silently skip
    }
  }

  // Prefix match
  return (cmd) => cmd.startsWith(trimmed);
}

/**
 * Check if a command matches the safe-command allowlist.
 * Checks built-in patterns first, then user-configured patterns.
 */
export function isSafeCommand(command, userPatterns = []) {
  if (BUILTIN_SAFE_PATTERNS.some((p) => p.test(command))) return true;

  for (const raw of userPatterns) {
    const matcher = parseUserSafePattern(raw);
    if (matcher && matcher(command)) return true;
  }

  return false;
}

export function isReadOnlyToolCall(call) {
  return Boolean(call && READ_ONLY_TOOLS.has(call.tool));
}

export const TOOL_PROTOCOL = `TOOL PROTOCOL

When you need tools, output one or more fenced JSON blocks:
\`\`\`json
{"tool":"tool_name","args":{"key":"value"}}
\`\`\`

Available tools:
- read_file(path, start_line?, end_line?) — read file content with stable line hash anchors
- list_dir(path?) — list files/directories
- search_files(pattern, path?, max_results?) — text search in workspace
- web_search(query, max_results?) — search the public web (backend: auto|tavily|ollama|duckduckgo via PUSH_WEB_SEARCH_BACKEND)
- exec(command, timeout_ms?) — run a shell command
- write_file(path, content) — write full file content
- edit_file(path, edits, expected_version?) — surgical hashline edits. edits[] ops: replace_line | insert_after | insert_before | delete_line, each with ref and optional content
- read_symbols(path) — extract function/class/type declarations from a file
- git_status() — workspace git status (branch, dirty files)
- git_diff(path?, staged?) — show git diff (optionally for a specific file, optionally staged)
- git_commit(message, paths?) — stage and commit files (all files if paths not specified)
- undo_edit(path) — restore a file from its most recent backup (created before each write/edit)
- save_memory(content) — persist learnings across sessions (stored in .push/memory.md). Save project patterns, build commands, conventions. Keep concise — this is loaded into every future session.
- coder_update_state(plan?, openTasks?, filesTouched?, assumptions?, errorsEncountered?) — update working memory (no filesystem action)
- ask_user(question, choices?) — pause and ask the operator a clarifying question; choices is an optional string[] of suggested answers. Use only when a critical ambiguity would cause significant wasted work — avoid for questions you can reasonably assume.

Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- You may emit multiple tool calls in one assistant reply.
- Emit at most one mutating filesystem/exec tool call per reply; read-only calls can be batched.
- Prefer edit_file over full-file rewrites when possible.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe tool calls in prose. Emit only JSON blocks for tool calls.`;

export function truncateText(text, max = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const totalLines = text.split('\n').length;
  const kept = text.slice(0, max);
  const keptLines = kept.split('\n').length;
  const extra = text.length - max;
  return `${kept}\n\n[truncated ${extra} chars, showing ${keptLines}/${totalLines} lines — use start_line/end_line to read specific ranges]`;
}

function asString(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function asOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseToolCallCandidate(candidate) {
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'json_parse_error' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape' };
  }

  if (typeof parsed.tool !== 'string') {
    return { ok: false, reason: 'missing_tool' };
  }

  if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) {
    return { ok: false, reason: 'missing_args_object' };
  }

  return {
    ok: true,
    call: {
      tool: parsed.tool,
      args: parsed.args,
    },
  };
}

function isLikelyToolCallCandidate(candidate) {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  return /"tool"\s*:/.test(trimmed);
}

export function detectAllToolCalls(text) {
  const calls = [];
  const malformed = [];

  const fenceRegex = /```(?:\s*(\w+))?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const candidate = (match[2] || '').trim();
    if (!candidate) continue;
    if (lang && lang !== 'json') continue;
    if (!isLikelyToolCallCandidate(candidate)) continue;
    const parsed = parseToolCallCandidate(candidate);
    if (parsed.ok) {
      calls.push(parsed.call);
    } else {
      malformed.push({ reason: parsed.reason, sample: candidate.slice(0, 120) });
    }
  }

  if (calls.length === 0) {
    const trimmed = text.trim();
    if (isLikelyToolCallCandidate(trimmed)) {
      const parsed = parseToolCallCandidate(trimmed);
      if (parsed.ok) {
        calls.push(parsed.call);
      } else {
        malformed.push({ reason: parsed.reason, sample: trimmed.slice(0, 120) });
      }
    }
  }

  return { calls, malformed };
}

export function detectToolCall(text) {
  const detected = detectAllToolCalls(text);
  return detected.calls[0] || null;
}

export async function ensureInsideWorkspace(workspaceRoot, rawPath) {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('path is required');
  const resolved = path.resolve(workspaceRoot, trimmed);
  const root = path.resolve(workspaceRoot);

  // 1. Logical check — catches obvious traversal without touching fs
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('path escapes workspace root');
  }

  // 2. Realpath check — catches symlink escapes
  try {
    const realRoot = await fs.realpath(root);
    let realTarget;
    try {
      realTarget = await fs.realpath(resolved);
    } catch (targetErr) {
      if (targetErr.code === 'ENOENT') {
        // New file: check parent dir instead
        const parent = path.dirname(resolved);
        try {
          const realParent = await fs.realpath(parent);
          if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
            throw new Error('path escapes workspace root');
          }
        } catch (parentErr) {
          if (parentErr.code === 'ENOENT') {
            // Parent doesn't exist either — fall back to logical check (already passed)
          } else if (parentErr.message === 'path escapes workspace root') {
            throw parentErr;
          }
          // Other errors: fall back to logical check
        }
        return resolved;
      }
      // Non-ENOENT errors: fall back to logical check
      return resolved;
    }
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('path escapes workspace root');
    }
  } catch (rootErr) {
    if (rootErr.message === 'path escapes workspace root') throw rootErr;
    // Workspace root doesn't exist on disk (e.g. test with fake paths) — logical check only
  }

  return resolved;
}

function formatExecOutput(stdout, stderr, exitCode, timedOut = false) {
  const parts = [`exit_code: ${exitCode}`];
  if (timedOut) parts.push('timed_out: true');
  if (stdout.trim()) parts.push(`stdout:\n${stdout}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr}`);
  if (!stdout.trim() && !stderr.trim()) parts.push('stdout:\n<empty>');
  return parts.join('\n\n');
}

function classifyToolError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('path escapes workspace root')) {
    return { code: 'PATH_ESCAPE', message, retryable: false };
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return { code: 'NOT_FOUND', message, retryable: true };
  }
  if (lower.includes('stale ref') || lower.includes('stale expected_version')) {
    return { code: 'STALE_WRITE', message, retryable: true };
  }
  if (lower.includes('ambiguous ref')) {
    return { code: 'AMBIGUOUS_REF', message, retryable: true };
  }
  if (lower.includes('must be') || lower.includes('required') || lower.includes('invalid')) {
    return { code: 'INVALID_ARGS', message, retryable: false };
  }
  return { code: 'TOOL_ERROR', message, retryable: false };
}

async function executeSearch(pattern, searchRoot, maxResults) {
  try {
    const { stdout } = await execFileAsync('rg', [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      String(maxResults),
      pattern,
      searchRoot,
    ], { maxBuffer: 2_000_000 });
    return stdout.trim() || 'No matches';
  } catch (err) {
    if (err.code === 1) return (err.stdout || '').trim() || 'No matches';
    if (err.code === 'ENOENT') {
      try {
        const { stdout } = await execFileAsync('grep', [
          '-RIn',
          '--binary-files=without-match',
          '--',
          pattern,
          searchRoot,
        ], { maxBuffer: 2_000_000 });
        return stdout.trim() || 'No matches';
      } catch (grepErr) {
        if (grepErr.code === 1) return (grepErr.stdout || '').trim() || 'No matches';
        throw new Error(`Search failed: ${grepErr.message}`);
      }
    }
    throw new Error(`Search failed: ${err.message}`);
  }
}

function resolveTavilyApiKey() {
  for (const envName of TAVILY_API_KEY_ENV_VARS) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeWebSearchBackend(rawValue) {
  if (typeof rawValue !== 'string') return '';
  const normalized = rawValue.trim().toLowerCase();
  return WEB_SEARCH_BACKENDS.has(normalized) ? normalized : '';
}

function resolveWebSearchBackend(options = {}) {
  const direct = normalizeWebSearchBackend(options.webSearchBackend);
  if (direct) return direct;

  const fromEnv = normalizeWebSearchBackend(process.env.PUSH_WEB_SEARCH_BACKEND);
  if (fromEnv) return fromEnv;

  return 'auto';
}

function resolveProviderId(options = {}) {
  if (typeof options.providerId !== 'string') return '';
  return options.providerId.toLowerCase();
}

function resolveOllamaApiKey(options = {}, { allowAnyProvider = false } = {}) {
  const providerId = resolveProviderId(options);
  if (!allowAnyProvider && providerId !== 'ollama') return '';

  if (providerId === 'ollama' && typeof options.providerApiKey === 'string' && options.providerApiKey.trim()) {
    return options.providerApiKey.trim();
  }

  for (const envName of OLLAMA_API_KEY_ENV_VARS) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'");
}

function decodeMaybe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function stripHtml(text) {
  return decodeHtmlEntities(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDuckDuckGoUrl(rawUrl) {
  if (!rawUrl) return '';
  let candidate = decodeMaybe(decodeHtmlEntities(rawUrl).trim());
  if (!candidate) return '';
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;

  if (candidate.startsWith('/')) {
    try {
      const redirectUrl = new URL(candidate, 'https://duckduckgo.com');
      const target = redirectUrl.searchParams.get('uddg');
      if (!target) return '';
      candidate = decodeMaybe(target);
    } catch {
      return '';
    }
  }

  return /^https?:\/\//i.test(candidate) ? candidate : '';
}

function parseDuckDuckGoHTML(html, maxResults) {
  const links = [];
  const snippets = [];

  const linkRegex = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const full = match[0];
    const hrefMatch = full.match(/href=["']([^"']*)["']/i);
    const titleMatch = full.match(/>([\s\S]*?)<\/a>/i);
    const url = normalizeDuckDuckGoUrl(hrefMatch?.[1] || '');
    const title = stripHtml(titleMatch?.[1] || '');
    if (!url || !title) continue;
    links.push({ title, url });
  }

  const snippetRegex = /<(?:a|div)[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]));
  }

  const results = [];
  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      content: snippets[i] || '',
    });
  }
  return results;
}

function parseJsonWebSearchResults(payload, maxResults) {
  const rawResults = Array.isArray(payload?.results) ? payload.results : [];
  const results = [];

  for (const entry of rawResults) {
    if (!entry || typeof entry !== 'object') continue;
    const title = typeof entry.title === 'string'
      ? entry.title.trim()
      : (typeof entry.name === 'string' ? entry.name.trim() : '');
    const url = typeof entry.url === 'string'
      ? entry.url.trim()
      : (typeof entry.link === 'string' ? entry.link.trim() : '');
    const content = typeof entry.content === 'string'
      ? entry.content.trim()
      : (
          typeof entry.snippet === 'string'
            ? entry.snippet.trim()
            : (typeof entry.description === 'string' ? entry.description.trim() : '')
        );
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, content });
    if (results.length >= maxResults) break;
  }

  return results;
}

async function executeDuckDuckGoWebSearch(query, maxResults, signal) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), WEB_SEARCH_TIMEOUT_MS);
  const signals = [timeoutController.signal];
  if (signal) signals.push(signal);

  try {
    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        headers: { 'User-Agent': 'PushCLI/1.0 (AI Coding Assistant)' },
        signal: AbortSignal.any(signals),
      },
    );

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned ${response.status}`);
    }

    const html = await response.text();
    return parseDuckDuckGoHTML(html, maxResults);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
      throw new Error(`Web search timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeTavilyWebSearch(query, maxResults, apiKey, signal) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), WEB_SEARCH_TIMEOUT_MS);
  const signals = [timeoutController.signal];
  if (signal) signals.push(signal);

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
      }),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Tavily returned ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
    }

    const payload = await response.json();
    return parseJsonWebSearchResults(payload, maxResults);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
      throw new Error(`Web search timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeOllamaWebSearch(query, maxResults, apiKey, signal) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), WEB_SEARCH_TIMEOUT_MS);
  const signals = [timeoutController.signal];
  if (signal) signals.push(signal);

  try {
    const response = await fetch(OLLAMA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Ollama search returned ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`);
    }

    const payload = await response.json();
    return parseJsonWebSearchResults(payload, maxResults);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
      throw new Error(`Web search timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function resolveWebSearchSourceHint(options = {}) {
  const backend = resolveWebSearchBackend(options);
  if (backend === 'tavily') return 'tavily';
  if (backend === 'ollama') return 'ollama_native';
  if (backend === 'duckduckgo') return 'duckduckgo_html';
  if (resolveTavilyApiKey()) return 'tavily';
  if (resolveOllamaApiKey(options)) return 'ollama_native';
  return 'duckduckgo_html';
}

async function executeWebSearch(query, maxResults, signal, options = {}) {
  const backend = resolveWebSearchBackend(options);

  if (backend === 'tavily') {
    const tavilyApiKey = resolveTavilyApiKey();
    if (!tavilyApiKey) {
      throw new Error('Tavily API key not configured (search backend=tavily)');
    }
    const results = await executeTavilyWebSearch(query, maxResults, tavilyApiKey, signal);
    return { backend, source: 'tavily', results };
  }

  if (backend === 'ollama') {
    const ollamaApiKey = resolveOllamaApiKey(options, { allowAnyProvider: true });
    if (!ollamaApiKey) {
      throw new Error('Ollama API key not configured (search backend=ollama)');
    }
    const results = await executeOllamaWebSearch(query, maxResults, ollamaApiKey, signal);
    return { backend, source: 'ollama_native', results };
  }

  if (backend === 'duckduckgo') {
    const results = await executeDuckDuckGoWebSearch(query, maxResults, signal);
    return { backend, source: 'duckduckgo_html', results };
  }

  const tavilyApiKey = resolveTavilyApiKey();
  if (tavilyApiKey) {
    const results = await executeTavilyWebSearch(query, maxResults, tavilyApiKey, signal);
    return { backend, source: 'tavily', results };
  }

  const ollamaApiKey = resolveOllamaApiKey(options);
  if (ollamaApiKey) {
    const results = await executeOllamaWebSearch(query, maxResults, ollamaApiKey, signal);
    return { backend, source: 'ollama_native', results };
  }

  const results = await executeDuckDuckGoWebSearch(query, maxResults, signal);
  return { backend, source: 'duckduckgo_html', results };
}

/**
 * Best-effort backup of a file before mutation.
 * Stored in .push/backups/ with a timestamped name.
 */
export async function backupFile(filePath, workspaceRoot) {
  try {
    await fs.access(filePath); // only backup if file exists
    const backupDir = path.join(workspaceRoot, '.push', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const relative = path.relative(workspaceRoot, filePath).replace(/\//g, '__');
    const backupPath = path.join(backupDir, `${relative}.${Date.now()}.bak`);
    await fs.copyFile(filePath, backupPath);
  } catch {
    // Best-effort — don't fail the write/edit if backup fails
  }
}

/**
 * Execute a tool call. Options:
 * - approvalFn(tool, detail): async fn that returns true to proceed, false to deny.
 *   If not provided, all calls proceed (headless default: deny high-risk).
 * - providerId: active provider id ('ollama' | 'mistral' | 'openrouter') for provider-aware tools.
 * - providerApiKey: resolved provider API key for provider-aware tools.
 */
export async function executeToolCall(call, workspaceRoot, options = {}) {
  try {
    switch (call.tool) {
      case 'read_file': {
        const filePath = await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const raw = await fs.readFile(filePath, 'utf8');
        const startLine = asOptionalNumber(call.args.start_line);
        const endLine = asOptionalNumber(call.args.end_line);

        const rendered = renderAnchoredRange(raw, startLine, endLine);
        return {
          ok: true,
          text: truncateText(rendered.text || '<empty file>'),
          meta: {
            path: filePath,
            start_line: rendered.startLine,
            end_line: rendered.endLine,
            total_lines: rendered.totalLines,
            lines: rendered.endLine - rendered.startLine + 1,
            version: calculateContentVersion(raw),
            anchored: true,
          },
        };
      }

      case 'list_dir': {
        const dirArg = typeof call.args.path === 'string' ? call.args.path : '.';
        const dirPath = await ensureInsideWorkspace(workspaceRoot, dirArg);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const mapped = entries
          .map((entry) => ({
            name: entry.name,
            type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          }))
          .sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            if (a.type === 'dir') return -1;
            if (b.type === 'dir') return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 300);
        const prefixMap = { dir: 'd', file: 'f', symlink: 'l', other: 'f' };
        const text = mapped.map((entry) => `${prefixMap[entry.type] || 'f'} ${entry.name}`).join('\n');
        return {
          ok: true,
          text: text || '<empty directory>',
          meta: { path: dirPath, count: mapped.length },
        };
      }

      case 'search_files': {
        const pattern = asString(call.args.pattern, 'pattern').trim();
        if (!pattern) throw new Error('pattern cannot be empty');
        const searchPath = typeof call.args.path === 'string' ? await ensureInsideWorkspace(workspaceRoot, call.args.path) : workspaceRoot;
        const maxResults = clamp(asOptionalNumber(call.args.max_results) ?? DEFAULT_SEARCH_RESULTS, 1, 1000);
        const output = await executeSearch(pattern, searchPath, maxResults);
        return {
          ok: true,
          text: truncateText(output),
          meta: { path: searchPath, max_results: maxResults },
        };
      }

      case 'web_search': {
        const query = asString(call.args.query, 'query').trim();
        if (!query) throw new Error('query must be a non-empty string');
        const maxResults = clamp(asOptionalNumber(call.args.max_results) ?? DEFAULT_WEB_SEARCH_RESULTS, 1, MAX_WEB_SEARCH_RESULTS);
        const backend = resolveWebSearchBackend(options);
        const sourceHint = resolveWebSearchSourceHint(options);

        try {
          const search = await executeWebSearch(query, maxResults, options.signal, options);
          const { source, results } = search;
          if (results.length === 0) {
            return {
              ok: true,
              text: `No web results found for "${query}".`,
              meta: { query, max_results: maxResults, results: 0, source, backend },
            };
          }

          const formatted = results
            .map(
              (result, index) =>
                `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.content || '(no snippet)'}`,
            )
            .join('\n\n');

          return {
            ok: true,
            text: truncateText(
              `Query: "${query}"\n${results.length} web result${results.length === 1 ? '' : 's'}:\n\n${formatted}`,
            ),
            meta: {
              query,
              max_results: maxResults,
              results: results.length,
              source,
              backend,
            },
          };
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            text: `Web search (${sourceHint}) failed: ${message}`,
            structuredError: {
              code: 'WEB_SEARCH_ERROR',
              message,
              retryable: true,
            },
            meta: { query, max_results: maxResults, source: sourceHint, backend },
          };
        }
      }

      case 'ask_user': {
        const question = asString(call.args.question, 'question');
        const choices = Array.isArray(call.args.choices) ? call.args.choices.map(String) : null;

        if (typeof options.askUserFn === 'function') {
          const answer = await options.askUserFn(question, choices);
          return {
            ok: true,
            text: `User answered: ${answer}`,
            meta: { question, choices },
          };
        }
        // Headless / non-interactive fallback
        return {
          ok: true,
          text: 'Non-interactive session — make a reasonable assumption and document it via coder_update_state.',
          meta: { question, choices, non_interactive: true },
        };
      }

      case 'exec': {
        const command = asString(call.args.command, 'command');
        const timeoutMs = clamp(asOptionalNumber(call.args.timeout_ms) ?? 90_000, 1_000, 180_000);
        const execMode = options.execMode ?? 'auto';

        // In headless mode (no approvalFn), block ALL exec unless --allow-exec or yolo
        if (!options.approvalFn && !options.allowExec && execMode !== 'yolo') {
          return {
            ok: false,
            text: `Blocked: exec is disabled in headless mode. Use --allow-exec to enable.`,
            structuredError: {
              code: 'EXEC_DISABLED',
              message: 'exec blocked in headless mode without --allow-exec',
              retryable: false,
            },
          };
        }

        // Tiered approval gate
        if (execMode === 'yolo') {
          // No prompts — fall through to execution
        } else if (execMode === 'strict') {
          // Prompt for ALL exec, even safe commands
          if (!options.approvalFn) {
            return {
              ok: false,
              text: `Blocked: exec requires approval in strict mode.`,
              structuredError: {
                code: 'APPROVAL_REQUIRED',
                message: 'exec blocked in strict mode without approval function',
                retryable: false,
              },
            };
          }
          const approved = await options.approvalFn('exec', command);
          if (!approved) {
            return {
              ok: false,
              text: `Denied by user: "${command}" was not approved for execution.`,
              structuredError: {
                code: 'APPROVAL_DENIED',
                message: 'User denied command in strict mode',
                retryable: false,
              },
            };
          }
        } else {
          // auto (default): safe patterns bypass, high-risk commands prompt
          if (!isSafeCommand(command, options.safeExecPatterns)) {
            if (isHighRiskCommand(command)) {
              const { approvalFn } = options;
              if (!approvalFn) {
                return {
                  ok: false,
                  text: `Blocked: "${command}" is a high-risk command. Not allowed in headless mode without approval.`,
                  structuredError: {
                    code: 'APPROVAL_REQUIRED',
                    message: 'High-risk command blocked in non-interactive mode',
                    retryable: false,
                  },
                };
              }
              const approved = await approvalFn('exec', command);
              if (!approved) {
                return {
                  ok: false,
                  text: `Denied by user: "${command}" was not approved for execution.`,
                  structuredError: {
                    code: 'APPROVAL_DENIED',
                    message: 'User denied high-risk command',
                    retryable: false,
                  },
                };
              }
            }
          }
        }

        try {
          const isLocalSandbox = process.env.PUSH_LOCAL_SANDBOX === 'true';
          const bin = isLocalSandbox ? 'docker' : '/bin/bash';
          const args = isLocalSandbox 
            ? ['run', '--rm', '-v', `${workspaceRoot}:/workspace`, '-w', '/workspace', 'push-sandbox', 'bash', '-lc', command]
            : ['-lc', command];
          const execOpts = {
            cwd: workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 4_000_000,
          };
          if (options.signal) execOpts.signal = options.signal;
          const { stdout, stderr } = await execFileAsync(bin, args, execOpts);
          return {
            ok: true,
            text: truncateText(formatExecOutput(stdout, stderr, 0)),
            meta: { command, timeout_ms: timeoutMs },
          };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          return {
            ok: false,
            text: truncateText(formatExecOutput(err.stdout || '', err.stderr || err.message, exitCode, Boolean(err.killed))),
            structuredError: {
              code: err.killed ? 'EXEC_TIMEOUT' : 'EXEC_FAILED',
              message: err.killed ? 'Command timed out' : `Command exited with code ${exitCode}`,
              retryable: true,
            },
            meta: { command, timeout_ms: timeoutMs, exit_code: exitCode, timed_out: Boolean(err.killed) },
          };
        }
      }

      case 'write_file': {
        const filePath = await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const content = asString(call.args.content, 'content');
        await backupFile(filePath, workspaceRoot);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return {
          ok: true,
          text: `Wrote ${content.length} bytes to ${path.relative(workspaceRoot, filePath) || '.'}`,
          meta: { path: filePath, bytes: content.length, version: calculateContentVersion(content) },
        };
      }

      case 'edit_file': {
        const filePath = await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const edits = Array.isArray(call.args.edits) ? call.args.edits : null;
        if (!edits) throw new Error('edits must be an array');

        await backupFile(filePath, workspaceRoot);
        const before = await fs.readFile(filePath, 'utf8');
        const versionBefore = calculateContentVersion(before);

        if (typeof call.args.expected_version === 'string' && call.args.expected_version.trim()) {
          const expected = call.args.expected_version.trim();
          if (expected !== versionBefore) {
            return {
              ok: false,
              text: `Stale expected_version: expected ${expected}, found ${versionBefore}. Re-read file and retry.`,
              structuredError: {
                code: 'STALE_WRITE',
                message: `expected_version mismatch: expected ${expected}, found ${versionBefore}`,
                retryable: true,
              },
              meta: { path: filePath, version_before: versionBefore },
            };
          }
        }

        const applied = applyHashlineEdits(before, edits);
        await fs.writeFile(filePath, applied.content, 'utf8');
        const versionAfter = calculateContentVersion(applied.content);

        // Build context preview around each edit site
        const afterLines = applied.content.split('\n');
        const previews = applied.applied.map(({ op, line }) => {
          const center = line - 1; // 0-indexed
          const start = Math.max(0, center - 3);
          const end = Math.min(afterLines.length, center + 4);
          return afterLines.slice(start, end).map((l, i) => `${start + i + 1}| ${l}`).join('\n');
        });
        const previewText = previews.length > 0 ? `\n\nContext after edits:\n${previews.join('\n---\n')}` : '';

        return {
          ok: true,
          text: `Applied ${applied.applied.length} hashline edits to ${path.relative(workspaceRoot, filePath) || '.'}${previewText}`,
          meta: {
            path: filePath,
            edits: applied.applied.length,
            version_before: versionBefore,
            version_after: versionAfter,
          },
        };
      }

      case 'read_symbols': {
        const filePath = await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const symbols = [];
        const patterns = [
          { pat: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/, kind: 'function' },
          { pat: /^\s*(export\s+)?(default\s+)?class\s+(\w+)/, kind: 'class' },
          { pat: /^\s*(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, kind: 'function' },
          { pat: /^\s*(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: 'function' },
          { pat: /^\s*def\s+(\w+)/, kind: 'function' },
          { pat: /^\s*(async\s+)?fn\s+(\w+)/, kind: 'function' },
          { pat: /^\s*func\s+(\w+)/, kind: 'function' },
          { pat: /^\s*type\s+(\w+)/, kind: 'type' },
          { pat: /^\s*(export\s+)?interface\s+(\w+)/, kind: 'interface' },
        ];
        lines.forEach((line, i) => {
          for (const { pat, kind } of patterns) {
            if (pat.test(line)) {
              symbols.push({ line: i + 1, kind, text: line.trim() });
              break;
            }
          }
        });
        const text = symbols.length > 0
          ? symbols.map(s => `${s.line}| [${s.kind}] ${s.text}`).join('\n')
          : 'No symbols found';
        return {
          ok: true,
          text: truncateText(text),
          meta: { path: filePath, symbolCount: symbols.length },
        };
      }

      case 'git_status': {
        try {
          const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], { cwd: workspaceRoot });
          const lines = stdout.trim().split('\n');
          const branchLine = lines[0] || '';
          const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$/);
          const branch = branchMatch ? branchMatch[1] : 'unknown';
          const tracking = branchMatch ? (branchMatch[2] || null) : null;
          const aheadBehind = branchMatch?.[3] || null;
          const changes = lines.slice(1).filter(l => l.trim()).map(l => {
            const xy = l.slice(0, 2);
            return {
              status: xy.trim(),
              path: l.slice(3),
              staged: xy[0] !== ' ' && xy[0] !== '?',
              unstaged: xy[1] !== ' ' && xy[1] !== '?',
            };
          });
          const staged = changes.filter(c => c.staged);
          const unstaged = changes.filter(c => c.unstaged);
          const untracked = changes.filter(c => c.status === '??');

          // Build structured text for clearer agent reasoning
          const sections = [`Branch: ${branch}${tracking ? ` → ${tracking}` : ''}${aheadBehind ? ` [${aheadBehind}]` : ''}`];
          if (staged.length) sections.push(`Staged (${staged.length}): ${staged.map(c => c.path).join(', ')}`);
          if (unstaged.length) sections.push(`Unstaged (${unstaged.length}): ${unstaged.map(c => c.path).join(', ')}`);
          if (untracked.length) sections.push(`Untracked (${untracked.length}): ${untracked.map(c => c.path).join(', ')}`);
          if (!changes.length) sections.push('Clean working tree');

          return {
            ok: true,
            text: sections.join('\n'),
            meta: { branch, tracking, aheadBehind, changedFiles: changes.length, staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
          };
        } catch (err) {
          return { ok: false, text: `git status failed: ${err.message}`, structuredError: { code: 'GIT_ERROR', message: err.message, retryable: false } };
        }
      }

      case 'git_diff': {
        const diffPath = call.args.path ? await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path')) : null;
        const staged = call.args.staged === true;
        const gitArgs = ['diff', '--stat'];
        if (staged) gitArgs.push('--staged');
        if (diffPath) gitArgs.push('--', diffPath);
        try {
          // Get stat summary
          const { stdout: statOut } = await execFileAsync('git', gitArgs, { cwd: workspaceRoot, maxBuffer: 2_000_000 });
          // Get full diff
          const fullArgs = ['diff'];
          if (staged) fullArgs.push('--staged');
          if (diffPath) fullArgs.push('--', diffPath);
          const { stdout: diffOut } = await execFileAsync('git', fullArgs, { cwd: workspaceRoot, maxBuffer: 2_000_000 });

          // Parse stat lines to extract file-level summary
          const statLines = statOut.trim().split('\n');
          const summaryLine = statLines[statLines.length - 1] || '';
          const filesChanged = [];
          for (const line of statLines.slice(0, -1)) {
            const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s*([+-]*)\s*$/);
            if (m) filesChanged.push({ file: m[1].trim(), changes: parseInt(m[2], 10) });
          }

          const insertions = (summaryLine.match(/(\d+) insertion/) || [])[1];
          const deletions = (summaryLine.match(/(\d+) deletion/) || [])[1];

          return {
            ok: true,
            text: truncateText(diffOut.trim() || 'No changes'),
            meta: {
              staged,
              path: diffPath,
              filesChanged: filesChanged.length,
              insertions: insertions ? parseInt(insertions, 10) : 0,
              deletions: deletions ? parseInt(deletions, 10) : 0,
              files: filesChanged,
            },
          };
        } catch (err) {
          return { ok: false, text: `git diff failed: ${err.message}`, structuredError: { code: 'GIT_ERROR', message: err.message, retryable: false } };
        }
      }

      case 'git_commit': {
        const message = asString(call.args.message, 'message');
        const paths = Array.isArray(call.args.paths) ? call.args.paths : [];

        // This is a mutating operation — validate paths are inside workspace
        const resolvedPaths = await Promise.all(paths.map(p => ensureInsideWorkspace(workspaceRoot, p)));

        try {
          // Stage specified files, or all if none specified
          if (resolvedPaths.length > 0) {
            await execFileAsync('git', ['add', '--', ...resolvedPaths], { cwd: workspaceRoot });
          } else {
            // Exclude .push/ (sessions, backups, internal state) from "all" staging
            await execFileAsync('git', ['add', '-A', '--', '.', ':!.push'], { cwd: workspaceRoot });
          }

          const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd: workspaceRoot });

          // Get the commit SHA
          const { stdout: sha } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: workspaceRoot });

          return {
            ok: true,
            text: stdout.trim(),
            meta: { sha: sha.trim(), message, filesStaged: resolvedPaths.length || 'all' },
          };
        } catch (err) {
          return { ok: false, text: `git commit failed: ${err.message}`, structuredError: { code: 'GIT_ERROR', message: err.message, retryable: true } };
        }
      }

      case 'undo_edit': {
        const filePath = await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const backupDir = path.join(workspaceRoot, '.push', 'backups');
        const relative = path.relative(workspaceRoot, filePath).replace(/\//g, '__');
        const prefix = `${relative}.`;

        let entries;
        try {
          entries = await fs.readdir(backupDir);
        } catch {
          return { ok: false, text: `No backups found for ${call.args.path}`, structuredError: { code: 'NO_BACKUP', message: 'Backup directory does not exist', retryable: false } };
        }

        const matches = entries
          .filter(e => e.startsWith(prefix) && e.endsWith('.bak'))
          .sort()
          .reverse();

        if (matches.length === 0) {
          return { ok: false, text: `No backups found for ${call.args.path}`, structuredError: { code: 'NO_BACKUP', message: 'No matching backup files', retryable: false } };
        }

        const backupPath = path.join(backupDir, matches[0]);
        await fs.copyFile(backupPath, filePath);
        return {
          ok: true,
          text: `Restored ${call.args.path} from backup ${matches[0]}`,
          meta: { path: filePath, backup: matches[0], availableBackups: matches.length },
        };
      }

      case 'save_memory': {
        const content = asString(call.args.content, 'content');
        const memoryDir = path.join(workspaceRoot, '.push');
        const memoryPath = path.join(memoryDir, 'memory.md');
        await fs.mkdir(memoryDir, { recursive: true });
        await fs.writeFile(memoryPath, content, 'utf8');
        return {
          ok: true,
          text: `Memory saved (${content.length} chars). Will be loaded into system prompt on next session.`,
          meta: { path: memoryPath, chars: content.length },
        };
      }

      default:
        return {
          ok: false,
          text: `Unknown tool: ${call.tool}. Available: read_file, list_dir, search_files, web_search, exec, write_file, edit_file, undo_edit, read_symbols, git_status, git_diff, git_commit, save_memory`,
          structuredError: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${call.tool}`,
            retryable: false,
          },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      text: `Tool error: ${message}`,
      structuredError: classifyToolError(err),
    };
  }
}
