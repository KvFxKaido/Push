// @ts-nocheck — gradual typing in progress for this large module
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { applyHashlineEdits, calculateContentVersion, renderAnchoredRange } from './hashline.js';
import { applySearchReplace } from './search-replace.js';
import { computeEditDiff, overEditDiffLineBudget, renderEditDiffText } from '../lib/edit-diff.ts';
import { MAX_SIDE_EFFECT_CHAIN } from '../lib/tool-call-grouping.ts';
import { runDiagnostics } from './diagnostics.js';
import { createLocalGitBackend, createLocalPushGit } from './git-backend.js';
import { spawnCommandInResolvedShell } from './shell.js';
import { scrubEnv } from './env-scrub.js';
import {
  resolveExecSandboxBackend,
  runCommandInExecSandbox,
  spawnCommandInExecSandbox,
} from './exec-sandbox.js';
import {
  buildArtifactRecord,
  summarizeArtifact,
  validateCreateArtifactArgs,
} from '../lib/artifacts/handler.ts';
import type { ArtifactAuthor, ArtifactScope } from '../lib/artifacts/types.ts';
import { CliFlatJsonArtifactStore } from './artifacts-store.ts';
import { resolveWorkspaceIdentity } from '../lib/workspace-identity.ts';
import {
  enforceRoleCapability,
  formatRoleCapabilityDenial,
  getEffectiveCapabilities,
  getToolCapabilities,
  roleCanUseTool,
  type ExecutionMode,
} from '../lib/capabilities.ts';
import type { AgentRole } from '../lib/runtime-contract.ts';
import {
  deriveProtocolVersion,
  getToolProtocolEntries,
  getToolPublicNames,
  resolveToolName,
} from '../lib/tool-registry.ts';
import { evaluatePreHooks } from '../lib/tool-hooks.ts';
import { runPostEditDiagnostics } from './post-edit-diagnostics.ts';
import { reduceToolOutput } from '../lib/tool-output-reducers.ts';
import { retainReducedOutput } from '../lib/verbatim-retain.ts';
import { runAuditor } from '../lib/auditor-agent.ts';
import { resolveAuditorGateEnabled, AUDITOR_GATE_ENV_VAR } from '../lib/auditor-policy.ts';
import { buildAuditorGateRuntimeContext } from './auditor-gate-memory.ts';
import { recordAuditGateVerdict } from './audit-eval-store.ts';
import { runMemoryGrep, runMemoryExpand } from '../lib/memory-tool-exec.ts';
import { getDefaultMemoryStore } from '../lib/context-memory-store.ts';
import { PROVIDER_CONFIGS, resolveApiKey, createProviderStream } from './provider.js';
import { executeGitHubCoreTool } from '../lib/github-tool-core.ts';
import { parseGitHubCoreToolCall } from '../lib/github-tool-parser.ts';
import { createCliGitHubRuntime, hasEnvGitHubToken, resolveGitHubToken } from './github-runtime.js';
import { commandRequiresApproval, isSinglePlainCommand } from '../lib/command-policy.ts';
import { startElapsedMs } from '../lib/monotonic-elapsed.ts';
import {
  buildCommandToolCard,
  buildCommitToolCard,
  buildDiffPreviewToolCard,
  buildEditDiffToolCard,
  buildGitStatusToolCard,
  buildTypeCheckToolCard,
} from '../lib/tool-card-producers.ts';

/**
 * CLI tool execution is the pushd daemon surface — the daemon IS the
 * workspace. The current product treats daemon-backed sessions as local
 * execution, not cloud sandbox; hardcoding here matches that truth. A future
 * cloud-backed CLI path would lift this to a per-call derivation at the
 * runtime edge (mirroring the web seam in `getExecutionMode`).
 */
const CLI_EXECUTION_MODE: ExecutionMode = 'local-daemon';

const KNOWN_AGENT_ROLES = new Set<AgentRole>([
  'orchestrator',
  'explorer',
  'coder',
  'reviewer',
  'auditor',
]);

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && KNOWN_AGENT_ROLES.has(value as AgentRole);
}

const execFileAsync = promisify(execFile);

export const MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_EXEC_TIMEOUT_MS = 90_000;
const MAX_EXEC_TIMEOUT_MS = 180_000;
const DEFAULT_EXEC_SESSION_TIMEOUT_MS = 600_000;
const MAX_EXEC_SESSION_TIMEOUT_MS = 1_800_000;
const DEFAULT_EXEC_POLL_MAX_CHARS = 8_000;
const MAX_EXEC_POLL_MAX_CHARS = 64_000;
// `exec_wait` blocks server-side until a session exits (or needs input / the
// wait budget elapses), moving the poll loop off the model — one tool call
// instead of one model round-trip per poll. Returns early the instant the
// command exits. The slice bounds abort/interactive-trap detection latency
// while blocking; the wait itself is abortable via `options.signal` (Stop).
const DEFAULT_EXEC_WAIT_MS = 120_000;
const MAX_EXEC_WAIT_MS = 600_000;
const EXEC_WAIT_SLICE_MS = 400;
const INTERACTIVE_TRAP_THRESHOLD_MS = 2_000;

// Interactive prompt heuristics. Each regex is tested against `text.trim()`
// for a single chunk. Design bias: prefer false negatives over false
// positives — a missed trap degrades to the existing timeout, but a false
// trap flips `interactive_trap: true` on healthy output and misleads agents.
// The patterns therefore anchor to end-of-chunk where possible and avoid
// bare keywords like "confirm" or a lone `?`.
const INTERACTIVE_PROMPT_PATTERNS = [
  // y/n confirmation brackets: [y/n], [Y/n], [yes/no], (y/n), (yes/no/[fingerprint])
  /\[(?:y|yes)(?:[/|](?:n|no))?\]/i,
  /\((?:y|yes)(?:[/|](?:n|no))?(?:[/|][^)]*)?\)/i,
  // Password / passphrase prompts that end the chunk with a colon
  /(?:^|\n)[^\n]*\bpassword[^\n:]*:\s*$/i,
  /(?:^|\n)[^\n]*\bpassphrase[^\n:]*:\s*$/i,
  // Git "Username for 'URL':"
  /(?:^|\n)\s*username\s+for\b[^\n]*:\s*$/i,
  // Question line that ends the chunk and contains a decision-style verb
  /(?:^|\n)[^\n]*\b(?:continue|proceed|overwrite|replace|abort|retry|install|uninstall|upgrade|remove|delete|trust|keep)\b[^.\n]*\?\s*$/i,
];

/**
 * Return true if a single PTY/stdio chunk looks like an interactive prompt
 * waiting for user input. Pure — no side effects. Exported for unit tests
 * so the regex list can be pinned without spinning up a subprocess.
 * `source` is the chunk provenance (`stdout` | `stderr` | `meta`); `meta`
 * chunks never flag as prompts because they're harness bookkeeping.
 */
export function detectPromptPattern(text, source = 'stdout') {
  if (source === 'meta') return false;
  if (typeof text !== 'string' || text.length === 0) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return INTERACTIVE_PROMPT_PATTERNS.some((re) => re.test(trimmed));
}

const MAX_EXEC_SESSION_OUTPUT_CHARS = 220_000;
const MAX_EXEC_SESSION_CHUNKS = 500;
const MAX_EXEC_SESSIONS = 24;
const DEFAULT_SEARCH_RESULTS = 120;
const DEFAULT_WEB_SEARCH_RESULTS = 5;
const MAX_WEB_SEARCH_RESULTS = 10;
const WEB_SEARCH_TIMEOUT_MS = 15_000;
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const OLLAMA_SEARCH_URL = 'https://ollama.com/api/web_search';
const TAVILY_API_KEY_ENV_VARS = ['PUSH_TAVILY_API_KEY', 'TAVILY_API_KEY', 'VITE_TAVILY_API_KEY'];
const OLLAMA_API_KEY_ENV_VARS = ['PUSH_OLLAMA_API_KEY', 'OLLAMA_API_KEY', 'VITE_OLLAMA_API_KEY'];
const WEB_SEARCH_BACKENDS = new Set(['auto', 'tavily', 'ollama', 'duckduckgo']);
const FETCH_URL_TIMEOUT_MS = 20_000;
// Refuse bodies the server declares larger than this before reading them;
// servers that lie (or stream chunked with no content-length) are cut off
// at the same cap by the bounded body reader instead of being buffered
// in full (see `readBodyBounded`).
const MAX_FETCH_URL_CONTENT_LENGTH = 5_000_000;
const MIN_FETCH_URL_CHARS = 1_000;

// Exported so daemon-side delegation handlers can reuse the same
// classification when bucketing detected tool calls into read-only
// vs mutating slots for the lib Coder kernel (which expects the
// `{ readOnly, mutating, extraMutations }` `DetectedToolCalls` shape
// from `lib/deep-reviewer-agent.ts`).
export const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'web_search',
  'fetch_url',
  'read_symbols',
  'read_symbol',
  'git_status',
  'git_diff',
  'lsp_diagnostics',
  'exec_poll',
  'exec_wait',
  'exec_list_sessions',
  'memory_grep',
  'memory_expand',
]);

// CLI-side classification of pure file-mutation tools (safe to batch in one
// turn). These are the *local CLI executor's* mutation tools — a distinct
// vocabulary from the sandbox tools in `FILE_MUTATION_CANONICAL_NAMES`
// (`lib/tool-registry.ts`). Membership intentionally differs: the local
// executor exposes `undo_edit` and does its editing through `write_file` /
// `edit_file` (hashline or exact search/replace), and never registers
// `sandbox_edit_range`/`_search_replace`/`_apply_patchset`. Do NOT try to
// "sync" the two sets — `sandbox_*` names never reach this classifier (those
// route through the registry path in `app/src/lib/tool-dispatch.ts`), so
// adding them here would be dead membership. Both the local engine
// (`cli/engine.ts`) and the daemon dispatch (`wrapCliDetectAllToolCalls`) use
// this to group contiguous file mutations into a single batch before any
// trailing side-effecting call (exec, git_commit, etc.).
export const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'undo_edit']);

// Read-only tools whose correct usage includes re-calling with identical args,
// so the lead exact-repeat loop breaker (`lib/coder-agent.ts`) must exempt
// them. `exec_poll` is the canonical case: polling a quiet long-running command
// returns `<no new output>` with an unchanged `next_seq`, so the right next
// call is the same `{session_id, from_seq}` — repeating it is waiting, not a
// loop. Without the exemption a slow command that doesn't emit output every
// round would trip the breaker on its 4th poll and abort the lead turn.
// `exec_wait` is exempt for the same reason: a command outliving one wait
// budget is resumed by re-calling with identical args — still waiting, not a
// loop. (In practice exec_wait collapses the poll storm to a handful of calls,
// but the exemption keeps a legitimately long wait from tripping the breaker.)
export const REPEAT_EXEMPT_TOOLS = new Set(['exec_poll', 'exec_wait']);

export function isFileMutationToolCall(call) {
  return Boolean(call && FILE_MUTATION_TOOLS.has(canonicalizeCliToolName(call.tool)));
}

// Shared symbol-detection patterns used by read_symbols and read_symbol
const SYMBOL_PATTERNS = [
  {
    pat: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/,
    kind: 'function',
    nameGroup: 4,
  },
  { pat: /^\s*(export\s+)?(default\s+)?class\s+(\w+)/, kind: 'class', nameGroup: 3 },
  {
    pat: /^\s*(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    kind: 'function',
    nameGroup: 2,
  },
  {
    pat: /^\s*(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
    kind: 'function',
    nameGroup: 2,
  },
  { pat: /^\s*def\s+(\w+)/, kind: 'function', nameGroup: 1 },
  { pat: /^\s*(async\s+)?fn\s+(\w+)/, kind: 'function', nameGroup: 2 },
  { pat: /^\s*func\s+(\w+)/, kind: 'function', nameGroup: 1 },
  { pat: /^\s*type\s+(\w+)/, kind: 'type', nameGroup: 1 },
  { pat: /^\s*(export\s+)?interface\s+(\w+)/, kind: 'interface', nameGroup: 2 },
];

const EXEC_SESSIONS = new Map();
let EXEC_SESSION_COUNTER = 0;
let cleanupHooksRegistered = false;
let hasScriptBinaryCache = null;

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
  /\bdoas\b/,
  /\bnpm\s+publish\b/,
  /\bdropdb\b/,
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
];

export function isHighRiskCommand(command) {
  return (
    HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command)) || commandRequiresApproval(command)
  );
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
  if (!isSinglePlainCommand(command)) return false;

  for (const raw of userPatterns) {
    const matcher = parseUserSafePattern(raw);
    if (matcher && matcher(command)) return true;
  }

  return false;
}

function splitCommandSegment(command) {
  // Best-effort extraction of the first shell segment.
  // This intentionally favors conservative prefixes and avoids deep shell parsing.
  return String(command || '')
    .split(/(?:&&|\|\||[|;\n])/)[0]
    .trim();
}

function tokenizeCommandSegment(segment) {
  if (!segment) return [];
  const tokens = segment.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) || [];
  return tokens.map((token) => token.replace(/^['"`]|['"`]$/g, ''));
}

/**
 * Suggest a reusable prefix allow-rule for a shell command.
 * Output is intentionally conservative to avoid broad accidental trust.
 */
export function suggestApprovalPrefix(command) {
  const segment = splitCommandSegment(command);
  const tokens = tokenizeCommandSegment(segment);
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0];

  const [first, second, third, fourth] = tokens;

  if ((first === 'sudo' || first === 'doas') && second && third) {
    return [first, second, third].join(' ');
  }

  if (first === 'git' && second && third) {
    const needsTarget = new Set(['push', 'fetch', 'pull', 'checkout', 'restore', 'reset', 'clean']);
    if (needsTarget.has(second)) return [first, second, third].join(' ');
    return [first, second].join(' ');
  }

  if ((first === 'npm' || first === 'pnpm' || first === 'yarn' || first === 'bun') && second) {
    return [first, second].join(' ');
  }

  if (first === 'docker' && second && third) {
    return [first, second, third].join(' ');
  }

  if (second?.startsWith('-') && third) {
    return [first, second, third].join(' ');
  }

  if (second && third && third.startsWith('-') && fourth) {
    return [first, second, third, fourth].join(' ');
  }

  return [first, second].join(' ');
}

function nextExecSessionId() {
  EXEC_SESSION_COUNTER += 1;
  return `exec_${Date.now().toString(36)}_${EXEC_SESSION_COUNTER.toString(36)}`;
}

function clearSessionTimer(session) {
  if (session?.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
}

function notifySessionExit(session) {
  if (!session || !Array.isArray(session.exitWaiters)) return;
  for (const waiter of session.exitWaiters.splice(0)) {
    try {
      waiter();
    } catch {
      // no-op
    }
  }
}

function markSessionClosed(session, exitCode, signal, { timedOut = false } = {}) {
  if (!session || session.closed) return;
  if (session.trapTimer) {
    clearTimeout(session.trapTimer);
    session.trapTimer = null;
  }
  session.interactiveTrap = false;
  session.closed = true;
  session.running = false;
  session.exitCode = typeof exitCode === 'number' ? exitCode : 1;
  session.exitSignal = signal || null;
  session.timedOut = Boolean(timedOut || session.timedOut);
  session.updatedAt = Date.now();
  clearSessionTimer(session);
  notifySessionExit(session);
}

function appendSessionChunk(session, text, source = 'stdout') {
  if (!session || typeof text !== 'string' || text.length === 0) return;
  // Clear trap state on new output
  if (session.trapTimer) {
    clearTimeout(session.trapTimer);
    session.trapTimer = null;
  }
  session.interactiveTrap = false;

  // Check for potential interactive trap
  const isPrompt = detectPromptPattern(text, source);
  if (isPrompt && session.running) {
    session.trapTimer = setTimeout(() => {
      session.interactiveTrap = true;
    }, INTERACTIVE_TRAP_THRESHOLD_MS);
  }

  const chunk = {
    seq: ++session.nextSeq,
    source,
    text,
    ts: Date.now(),
  };
  session.chunks.push(chunk);
  session.totalChars += text.length;
  session.updatedAt = Date.now();

  while (
    session.chunks.length > MAX_EXEC_SESSION_CHUNKS ||
    session.totalChars > MAX_EXEC_SESSION_OUTPUT_CHARS
  ) {
    const removed = session.chunks.shift();
    if (!removed) break;
    session.totalChars -= removed.text.length;
    session.firstAvailableSeq = removed.seq + 1;
  }

  if (session.chunks.length === 0) {
    session.firstAvailableSeq = session.nextSeq + 1;
  } else if (session.firstAvailableSeq < session.chunks[0].seq) {
    session.firstAvailableSeq = session.chunks[0].seq;
  }
}

function collectSessionOutput(session, fromSeq, maxChars) {
  const selected = session.chunks.filter((chunk) => chunk.seq > fromSeq);
  let used = 0;
  let truncated = false;
  let returnedChunks = 0;
  const out = [];

  for (const chunk of selected) {
    if (used >= maxChars) {
      truncated = true;
      break;
    }
    const remaining = maxChars - used;
    if (chunk.text.length <= remaining) {
      out.push(chunk.text);
      used += chunk.text.length;
      returnedChunks += 1;
      continue;
    }
    out.push(chunk.text.slice(0, remaining));
    used += remaining;
    returnedChunks += 1;
    truncated = true;
    break;
  }

  return {
    text: out.join(''),
    returnedChunks,
    truncated,
  };
}

// Resolve when the session exits, after `timeoutMs`, or when `signal` aborts —
// whichever comes first — and always remove this waiter from
// `session.exitWaiters` on the way out. Self-cleaning is load-bearing for
// `exec_wait`, which calls this once per slice while blocking: without removing
// the timed-out waiter, a long wait would pile up `waitMs / slice` dead closures
// per call (and more across resumes) that only flush when the process finally
// exits. Passing `signal` lets a blocking wait abort instantly instead of at the
// next slice boundary. Exported for unit tests.
export function waitForSessionExit(session, timeoutMs = 2_500, signal) {
  if (!session || !session.running) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const waiter = () => settle();
    const onAbort = () => settle();
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const idx = session.exitWaiters.indexOf(waiter);
      if (idx !== -1) session.exitWaiters.splice(idx, 1);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    timer = setTimeout(settle, timeoutMs);
    session.exitWaiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function stopSessionProcess(session, signal = 'SIGTERM') {
  if (!session || !session.child || !session.running) return false;
  try {
    return session.child.kill(signal);
  } catch {
    return false;
  }
}

function removeExecSession(sessionId, { stop = false, signal = 'SIGTERM' } = {}) {
  const session = EXEC_SESSIONS.get(sessionId);
  if (!session) return null;
  if (stop) {
    stopSessionProcess(session, signal);
  }
  clearSessionTimer(session);
  EXEC_SESSIONS.delete(sessionId);
  return session;
}

function cleanupExecSessions() {
  for (const session of EXEC_SESSIONS.values()) {
    if (session.running) {
      stopSessionProcess(session, 'SIGTERM');
      stopSessionProcess(session, 'SIGKILL');
    }
    clearSessionTimer(session);
  }
  EXEC_SESSIONS.clear();
}

function ensureCleanupHooks() {
  if (cleanupHooksRegistered) return;
  cleanupHooksRegistered = true;
  process.once('exit', cleanupExecSessions);
}

async function hasScriptBinary() {
  if (hasScriptBinaryCache !== null) return hasScriptBinaryCache;
  try {
    await execFileAsync('script', ['-V'], { timeout: 2_000, maxBuffer: 128_000 });
    hasScriptBinaryCache = true;
  } catch (err) {
    // Some script variants return non-zero for -V but still exist.
    if (err && err.code !== 'ENOENT') {
      hasScriptBinaryCache = true;
    } else {
      hasScriptBinaryCache = false;
    }
  }
  return hasScriptBinaryCache;
}

function formatSessionStatus(session) {
  if (!session) return 'unknown';
  if (session.running) return 'running';
  if (session.timedOut) return 'timed_out';
  if (typeof session.exitCode === 'number') return session.exitCode === 0 ? 'completed' : 'failed';
  return 'stopped';
}

function normalizeSignal(rawSignal) {
  const value = typeof rawSignal === 'string' ? rawSignal.trim().toUpperCase() : '';
  if (!value) return 'SIGTERM';
  const normalized = value.startsWith('SIG') ? value : `SIG${value}`;
  if (normalized === 'SIGTERM' || normalized === 'SIGINT' || normalized === 'SIGKILL')
    return normalized;
  throw new Error('signal must be SIGTERM, SIGINT, or SIGKILL');
}

function pruneExecSessions() {
  if (EXEC_SESSIONS.size <= MAX_EXEC_SESSIONS) return;
  const sessions = [...EXEC_SESSIONS.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const session of sessions) {
    if (EXEC_SESSIONS.size <= MAX_EXEC_SESSIONS) break;
    removeExecSession(session.id, { stop: session.running, signal: 'SIGKILL' });
  }
}

// CLI-side aliases: tool names that resolve to the same case in
// `executeToolCall`'s switch. Normalizing both the user's policy lists and
// the inbound `call.tool` through this map keeps `disabledTools` /
// `alwaysAllow` enforcement consistent regardless of which name the model
// emits. The web/lib registry has its own aliasing (`lib/tool-registry.ts`)
// but uses different canonical names; this map is intentionally CLI-local.
const CLI_TOOL_ALIASES = new Map([
  ['artifact', 'create_artifact'],
  // Kimi K3's native harness exposes the exact search/replace primitive as
  // `Edit`. Provider-family schema naming advertises that form; dispatch stays
  // on the CLI-native edit_file implementation.
  ['Edit', 'edit_file'],
  // Accept the registry/web public names (and long-form sandbox aliases) as
  // synonyms for the CLI-native branch tools, so models trained on the web
  // vocabulary resolve to the CLI tool regardless of which name they emit.
  ['switch_branch', 'git_switch_branch'],
  ['sandbox_switch_branch', 'git_switch_branch'],
  ['create_branch', 'git_create_branch'],
  ['sandbox_create_branch', 'git_create_branch'],
  // Likely model guesses for the CLI-native fetch_url (fetch_url is not in
  // the lib registry — CLI alias tolerance lives here, not there).
  ['fetch', 'fetch_url'],
  ['web_fetch', 'fetch_url'],
  ['get_url', 'fetch_url'],
  ['fetch_page', 'fetch_url'],
]);

function canonicalizeCliToolName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  return CLI_TOOL_ALIASES.get(trimmed) ?? trimmed;
}

/**
 * True when `disabledTools` policy (explicit list, falling back to
 * `PUSH_DISABLED_TOOLS`) blocks the named tool. `executeToolCall` enforces
 * this at dispatch; exported for callers that route a tool AROUND the
 * dispatcher and must keep honoring the same policy — the lead lane's
 * `delegate_explorer` interception (`cli/lead-turn.ts`) checks it to decide
 * whether to advertise/execute the fan-out arc or fall through to the
 * dispatcher's canonical TOOL_DISABLED denial (Codex P2 on #1370).
 */
export function isCliToolDisabled(toolName, disabledTools) {
  return resolveToolPolicyList(disabledTools, 'PUSH_DISABLED_TOOLS').has(
    canonicalizeCliToolName(toolName),
  );
}

// Resolve a comma-separated env var into a Set of canonicalized tool names,
// with an optional explicit list winning over the env. `undefined` array
// means "fall back to env"; an empty array means "no entries" and
// short-circuits the env read so callers can opt out.
function resolveToolPolicyList(explicit, envVar) {
  const normalize = (entries) =>
    new Set(entries.map((name) => canonicalizeCliToolName(name)).filter(Boolean));
  if (Array.isArray(explicit)) {
    return normalize(explicit);
  }
  const raw = process.env[envVar];
  if (!raw) return new Set();
  return normalize(raw.split(','));
}

async function guardExecCommand(command, options = {}, mode = 'exec') {
  const execMode = options.execMode ?? 'auto';
  const operationLabel = mode === 'exec_start' ? 'exec_start' : 'exec';
  // `alwaysAllow` waives approval for the named tool but does NOT bypass the
  // headless `--allow-exec` requirement below — that's a separate safety
  // gate for non-interactive runs. Resolved once in the dispatcher and
  // passed in via options.
  const alwaysAllowExec =
    Array.isArray(options.alwaysAllow) && options.alwaysAllow.includes(operationLabel);
  const blockedMessage =
    mode === 'exec_start'
      ? 'Blocked: exec_start is disabled in headless mode. Use --allow-exec to enable.'
      : 'Blocked: exec is disabled in headless mode. Use --allow-exec to enable.';

  // In headless mode (no approvalFn), block command execution unless --allow-exec or yolo
  if (!options.approvalFn && !options.allowExec && execMode !== 'yolo') {
    return {
      ok: false,
      result: {
        ok: false,
        text: blockedMessage,
        structuredError: {
          code: 'EXEC_DISABLED',
          message: `${operationLabel} blocked in headless mode without --allow-exec`,
          retryable: false,
        },
      },
    };
  }

  if (execMode === 'yolo') {
    return { ok: true };
  }

  // `alwaysAllow` skips approval prompts for the listed tool name even when
  // execMode would otherwise prompt. It's evaluated after the headless gate
  // so non-interactive runs still need `--allow-exec` to execute commands.
  if (alwaysAllowExec) {
    return { ok: true };
  }

  if (execMode === 'strict') {
    if (!options.approvalFn) {
      return {
        ok: false,
        result: {
          ok: false,
          text: `Blocked: ${operationLabel} requires approval in strict mode.`,
          structuredError: {
            code: 'APPROVAL_REQUIRED',
            message: `${operationLabel} blocked in strict mode without approval function`,
            retryable: false,
          },
        },
      };
    }
    const approved = await options.approvalFn('exec', command);
    if (!approved) {
      return {
        ok: false,
        result: {
          ok: false,
          text: `Denied by user: "${command}" was not approved for execution.`,
          structuredError: {
            code: 'APPROVAL_DENIED',
            message: 'User denied command in strict mode',
            retryable: false,
          },
        },
      };
    }
    return { ok: true };
  }

  // auto (default): safe patterns bypass, high-risk commands prompt
  if (!isSafeCommand(command, options.safeExecPatterns) && isHighRiskCommand(command)) {
    const { approvalFn } = options;
    if (!approvalFn) {
      return {
        ok: false,
        result: {
          ok: false,
          text: `Blocked: "${command}" is a high-risk command. Not allowed in headless mode without approval.`,
          structuredError: {
            code: 'APPROVAL_REQUIRED',
            message: 'High-risk command blocked in non-interactive mode',
            retryable: false,
          },
        },
      };
    }
    const approved = await approvalFn('exec', command);
    if (!approved) {
      return {
        ok: false,
        result: {
          ok: false,
          text: `Denied by user: "${command}" was not approved for execution.`,
          structuredError: {
            code: 'APPROVAL_DENIED',
            message: 'User denied high-risk command',
            retryable: false,
          },
        },
      };
    }
  }

  return { ok: true };
}

async function startExecSession(command, workspaceRoot, timeoutMs, ttyRequested = false) {
  ensureCleanupHooks();

  const sandboxBackend = resolveExecSandboxBackend();
  const canUseScriptTty = ttyRequested && sandboxBackend === 'host' && (await hasScriptBinary());

  const subprocessEnv = scrubEnv();
  const { child } = canUseScriptTty
    ? {
        child: spawn('script', ['-q', '-f', '-c', command, '/dev/null'], {
          cwd: workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: subprocessEnv,
        }),
      }
    : sandboxBackend === 'host'
      ? await spawnCommandInResolvedShell(command, {
          cwd: workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: subprocessEnv,
        })
      : await spawnCommandInExecSandbox(command, workspaceRoot, {
          cwd: workspaceRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: subprocessEnv,
        });

  const sessionId = nextExecSessionId();
  const session = {
    id: sessionId,
    command,
    cwd: workspaceRoot,
    ttyRequested: Boolean(ttyRequested),
    ttyMode: canUseScriptTty ? 'script' : ttyRequested ? 'pipe_fallback' : 'pipe',
    running: true,
    closed: false,
    timedOut: false,
    exitCode: null,
    exitSignal: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextSeq: 0,
    firstAvailableSeq: 1,
    totalChars: 0,
    chunks: [],
    child,
    timer: null,
    exitWaiters: [],
    interactiveTrap: false,
    trapTimer: null,
  };

  const timeoutTimer = setTimeout(() => {
    if (!session.running) return;
    session.timedOut = true;
    appendSessionChunk(
      session,
      `\n[push] session timed out after ${timeoutMs}ms, terminating...\n`,
      'meta',
    );
    stopSessionProcess(session, 'SIGTERM');
    setTimeout(() => {
      if (session.running) stopSessionProcess(session, 'SIGKILL');
    }, 1_500);
  }, timeoutMs);
  if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
  session.timer = timeoutTimer;

  child.stdout?.on('data', (chunk) => {
    appendSessionChunk(session, String(chunk), 'stdout');
  });

  child.stderr?.on('data', (chunk) => {
    appendSessionChunk(session, String(chunk), 'stderr');
  });

  child.on('error', (err) => {
    appendSessionChunk(session, `[push] failed to start command: ${err.message}\n`, 'stderr');
    markSessionClosed(session, 1, null, { timedOut: session.timedOut });
  });

  child.on('close', (code, signal) => {
    markSessionClosed(session, typeof code === 'number' ? code : 1, signal, {
      timedOut: session.timedOut,
    });
  });

  EXEC_SESSIONS.set(sessionId, session);
  pruneExecSessions();
  return session;
}

export function isReadOnlyToolCall(call) {
  if (!call) return false;
  // Read-only GitHub tools (public names) parallelize alongside CLI read-only
  // tools. Write GitHub tools fall through as side-effecting.
  if (GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES.has(call.tool)) return true;
  // Canonicalize so alias-emitted calls (e.g. `web_fetch` → `fetch_url`)
  // classify like their canonical tool instead of falling through to the
  // single-trailing-side-effect lane.
  return READ_ONLY_TOOLS.has(call.tool) || READ_ONLY_TOOLS.has(canonicalizeCliToolName(call.tool));
}

/**
 * Read-only subset of `TOOL_PROTOCOL`, used by daemon-side Explorer
 * delegation. The Explorer kernel is contractually read-only, so its
 * system prompt must only advertise tools in `READ_ONLY_TOOLS` — giving
 * it the full `TOOL_PROTOCOL` would repeatedly prompt the model to call
 * `write_file` / `exec` / etc., which the daemon executor then refuses,
 * wasting rounds on dead-end attempts.
 *
 * Kept deliberately in sync with the `READ_ONLY_TOOLS` set above: every
 * bullet below must name a tool that `READ_ONLY_TOOLS.has(name) === true`,
 * and every entry in that set should have a corresponding bullet (web_search
 * uses the same wording as the main protocol).
 *
 * Passed as `sandboxToolProtocol: READ_ONLY_TOOL_PROTOCOL` in the
 * `runExplorerAgent` options bag inside `cli/pushd.ts` — specifically
 * `handleDelegateExplorer` (direct-RPC path) and
 * `runExplorerForTaskGraph` (task-graph node path). Note that
 * `makeDaemonExplorerToolExec` only builds the tool executor closure;
 * it does not participate in prompt construction, so the override
 * must be passed alongside `toolExec` in the kernel options. So the
 * model sees CLI tool names (`read_file`, `list_dir`) that match the
 * daemon's detector + executor + `READ_ONLY_TOOLS` namespace. Without
 * this override the lib kernel falls back to `EXPLORER_TOOL_PROTOCOL`
 * from `lib/explorer-agent.ts`, which advertises the web-side public
 * names (`read`, `repo_read`, `search`) that the daemon's detector
 * does not recognize — so every Explorer tool call silently fails
 * detection, the model never gets a tool result, and the delegation
 * spins rounds without investigating anything (codex + Copilot P1 on
 * PR #284).
 *
 * **Divergence from READ_ONLY_TOOLS (post-Gap 2, 2026-04-18):** This
 * protocol advertises a SUBSET of `READ_ONLY_TOOLS`. Specifically,
 * `exec_poll` and `exec_list_sessions` sit in `READ_ONLY_TOOLS` (for
 * the deep-reviewer-agent's read/mutate bucketing of detected tool
 * calls — they're semantically read-verbs over exec sessions) but are
 * NOT advertised to Explorer, because the shared capability table
 * (`lib/capabilities.ts`) requires `sandbox:exec` for the exec family
 * and Explorer's grant does not include it. Advertising tools that
 * `roleCanUseTool('explorer', ...)` would deny would just waste
 * rounds — the model would follow the prompt, emit the call, and hit
 * the denial at `makeDaemonExplorerToolExec`. The
 * `daemon-integration.test.mjs` sync test enforces that every
 * advertised tool IS Explorer-callable per the capability grant.
 */
// CLI-native protocol body: the marker is derived from this string so
// any change to the inline tool list bumps the version, even when the
// lib `TOOL_SPECS` registry is unchanged (which it would be — these
// names are CLI-only). Codex P2 on PR #544.
const READ_ONLY_TOOL_PROTOCOL_BODY = `TOOL PROTOCOL (read-only)

When you need tools, output one or more fenced JSON blocks:
\`\`\`json
{"tool":"tool_name","args":{"key":"value"}}
\`\`\`

Available tools (all read-only — Explorer has no filesystem or exec mutation surface):
- read_file(path, start_line?, end_line?) — read file content; ranged reads supported for large files
- list_dir(path?) — list files/directories
- search_files(pattern, path?, max_results?) — text search in workspace
- read_symbols(path) — extract function/class/type declarations from a file
- read_symbol(path, symbol) — read a specific symbol's full body (function, class, type, interface) by name; more efficient than reading a whole file when you know which symbol you need
- git_status() — workspace git status (branch, dirty files)
- git_diff(path?, staged?) — show git diff (optionally for a specific file, optionally staged)
- lsp_diagnostics(path?) — run type-checker for the workspace; optional path filters results to a specific file. Supported: TypeScript (tsc), Python (pyright/ruff), Rust (cargo check), Go (go vet).
- web_search(query, max_results?) — search the public web (backend: auto|tavily|ollama|duckduckgo via PUSH_WEB_SEARCH_BACKEND)
- fetch_url(url, max_chars?) — fetch a public http(s) URL and return its readable text (HTML is converted to plain text). Use for docs pages, changelogs, and READMEs — including URLs surfaced by web_search
- memory_grep(pattern, kinds?, limit?) — search persisted memory records (prior decisions/findings/verification) by case-insensitive substring; returns matches with their [mem_…] id and a text snippet (use memory_expand for the full record)
- memory_expand(ids?, refs?) — recall full verbatim text: ids for memory records (from memory_grep results or [mem_…] tags; surrounding brackets are display-only) and/or refs for verbatim vb_… handles (shown in a reduced tool result's recall marker). At least one is required

Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- You may emit multiple read-only tool calls in one reply; they run in parallel.
- Do NOT emit any mutating tool (\`write_file\`, \`edit_file\`, \`exec\`, \`git_commit\`, etc.). Explorer is read-only; if mutation is needed, the orchestrator will request a Coder delegation after you report.
- Prefer read_symbol over read_file when you know which function/class you need.
- Prefer search_files before large file reads to locate evidence.
- Do not describe tool calls in prose. Emit only JSON blocks for tool calls.`;

export const READ_ONLY_TOOL_PROTOCOL = `[Tool schema version: ${deriveProtocolVersion(READ_ONLY_TOOL_PROTOCOL_BODY)}]

${READ_ONLY_TOOL_PROTOCOL_BODY}`;

// CLI full-protocol body: lists CLI-native tools that are NOT in the
// lib `TOOL_SPECS` registry (`exec_start`, `exec_poll`, `edit_file`,
// `git_create_branch`, `undo_edit`, `save_memory`, etc.), so its
// marker is derived from this body — not from the registry hash.
// Codex P2 on PR #544.
const TOOL_PROTOCOL_BODY = `TOOL PROTOCOL

When you need tools, output one or more fenced JSON blocks:
\`\`\`json
{"tool":"tool_name","args":{"key":"value"}}
\`\`\`

Available tools:
- read_file(path, start_line?, end_line?) — read file content with stable line hash anchors; truncated reads include truncated_at_line and remaining_bytes
- list_dir(path?) — list files/directories
- search_files(pattern, path?, max_results?) — text search in workspace
- web_search(query, max_results?) — search the public web (backend: auto|tavily|ollama|duckduckgo via PUSH_WEB_SEARCH_BACKEND)
- fetch_url(url, max_chars?) — fetch a public http(s) URL and return its readable text (HTML is converted to plain text). Use for docs pages, changelogs, and READMEs — including URLs surfaced by web_search
- memory_grep(pattern, kinds?, limit?) — search persisted memory records (prior decisions/findings/verification) by case-insensitive substring; returns matches with their [mem_…] id and a text snippet (use memory_expand for the full record)
- memory_expand(ids?, refs?) — recall full verbatim text: ids for memory records (from memory_grep results or [mem_…] tags; surrounding brackets are display-only) and/or refs for verbatim vb_… handles (shown in a reduced tool result's recall marker). At least one is required
- exec(command, timeout_ms?) — run a shell command
- exec_start(command, timeout_ms?, tty?) — start a long-running command session
- exec_poll(session_id, from_seq?, max_chars?) — read incremental output from a running command session
- exec_wait(session_id, timeout_ms?, from_seq?, max_chars?) — block until the command exits, needs input, or timeout_ms elapses, then return new output and final status; prefer this over repeated exec_poll for long commands
- exec_write(session_id, input, append_newline?) — send stdin to a running command session
- exec_stop(session_id, signal?) — stop a running command session and release it
- exec_list_sessions() — list active/finished command sessions
- write_file(path, content) — write full file content
- edit_file(path, edits?, search?, replace?, old_string?, new_string?, replace_all?, expected_version?) — two shapes: (a) surgical hashline edits via edits[] (ops: replace_line | insert_after | insert_before | delete_line, each with ref and optional content); (b) exact search/replace via search+replace (aliases old_string+new_string), optional replace_all — search must match exactly once unless replace_all
- read_symbols(path) — extract function/class/type declarations from a file
- read_symbol(path, symbol) — read a specific symbol's full body (function, class, type, interface) by name. More efficient than reading the whole file when you know which symbol you need.
- git_status() — workspace git status (branch, dirty files)
- git_diff(path?, staged?) — show git diff (optionally for a specific file, optionally staged)
- git_commit(message, paths?) — stage and commit files (all files if paths not specified)
- git_create_branch(name, from?) — create a new git branch and switch to it. Optional 'from' branches off a specific ref instead of HEAD.
- git_switch_branch(branch) — switch to an existing branch (fetches it for shallow clones if not present locally). Use git_create_branch for new branches.
- undo_edit(path) — restore a file from its most recent backup (created before each write/edit)
- lsp_diagnostics(path?) — run type-checker for the workspace; optional path filters results to a specific file. Supported: TypeScript (tsc), Python (pyright/ruff), Rust (cargo check), Go (go vet).
- save_memory(content) — persist learnings across sessions (stored in .push/memory.md). Save project patterns, build commands, conventions. Keep concise — this is loaded into every future session. Structured form: save_memory(type, content, tags?, files?) where type is decision|task|next|fact|blocker — stored in .push/memory.json as typed entries.
- create_artifact(kind, title, files?, source?, entry?, dependencies?) — create a renderable artifact for the chat panel. kind is one of: static-html | static-react | mermaid | file-tree. Use mermaid for diagrams; static-html for self-contained pages; static-react for component demos; file-tree for grouped file snapshots. (Live previews of running dev servers are not yet supported.)
- coder_update_state(plan?, openTasks?, filesTouched?, assumptions?, errorsEncountered?, currentPhase?, completedPhases?) — update working memory (no filesystem action). currentPhase is the current task phase; completedPhases is a list of completed phases (retroactive tracking supported).
- ask_user(question, choices?) — pause and ask the operator a clarifying question; choices is an optional string[] of suggested answers. Use only when a critical ambiguity would cause significant wasted work — avoid for questions you can reasonably assume.

Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- You may emit multiple tool calls in one assistant reply.
- Per-turn tool budget: read-only calls first (they run in parallel), then any number of file mutations (write_file / edit_file / undo_edit — run sequentially as one batch), then a trailing chain of up to ${MAX_SIDE_EFFECT_CHAIN} side-effecting calls (exec / git_commit / save_memory) that run sequentially and stop on the first failure. Side-effects beyond the cap are rejected with MULTI_MUTATION_NOT_ALLOWED. Only chain side-effects whose later steps remain valid regardless of the earlier steps' output; otherwise stop after the step you need to see.
- write_file / edit_file results append file-scoped type-checker diagnostics when a project checker is available. Treat reported errors as introduced by your change and fix them before moving on; "Diagnostics: clean" means the checker ran and found nothing for that file. Each check runs immediately after its edit — in a multi-file batch, a finding can be resolved by a later edit in the same reply (e.g. step 1 references a symbol step 2 adds), so before fixing a reported error, check whether a sibling edit already addressed it; when unsure, re-run lsp_diagnostics instead of re-editing.
- Prefer edit_file over full-file rewrites when possible.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe tool calls in prose. Emit only JSON blocks for tool calls.
- Prefer read_symbol over read_file when you know which function/class you need — it returns only that symbol's body.
- Check the ledger in [meta] for files with high relevance scores — those appeared most in search results and are likely the best read targets.
- The readBudget in [meta] shows chars read this turn. Use it to pace reads — prefer targeted reads (read_symbol, ranged read_file) over full-file reads when budget is high.`;

export const TOOL_PROTOCOL = `[Tool schema version: ${deriveProtocolVersion(TOOL_PROTOCOL_BODY)}]

${TOOL_PROTOCOL_BODY}`;

// ── GitHub tools ────────────────────────────────────────────────────
//
// GitHub tools reuse the shared, runtime-agnostic core (lib/github-tool-core)
// exactly like the web Worker and the MCP server. The CLI injects its own
// runtime (cli/github-runtime.ts) backed by a GITHUB_TOKEN (env or `gh auth
// token`) hitting api.github.com directly.
//
// They are advertised to models under their **public** registry names
// (`pr`, `prs`, `repo_read`, `pr_create`, …) — NOT their canonical names —
// because several canonical GitHub names (`read_file`, `list_directory`,
// `search_files`) collide with CLI-native tools. The public names are the
// same ones the web orchestrator prompt uses, so model behavior is
// consistent across surfaces. `resolveToolName` maps the public name back to
// the canonical the parser/dispatcher expect.
//
// Derived from the shared registry (`getToolProtocolEntries('github')`) so the
// advertised surface can't drift from the canonical tool specs.
const GITHUB_PROTOCOL_ENTRIES = getToolProtocolEntries('github');

// Public-name set the dispatcher recognizes as GitHub tools. Sourced from the
// shared registry helper (same single source of truth as the read-only set
// below) so it stays in lockstep with what's advertised.
export const GITHUB_PUBLIC_TOOL_NAMES: ReadonlySet<string> = new Set(
  getToolPublicNames({ source: 'github' }),
);

// Public names of the read-only GitHub tools — folded into the CLI's
// READ_ONLY_TOOLS-style parallelization bucket at dispatch time. Sourced from
// the shared registry helper (the single source of truth, also consumed by the
// web surface via `isReadOnlyToolName`) so the CLI's parallelization decision
// can't drift from the canonical `readOnly` flags. `readonly-classification-
// drift.test.mjs` pins this equivalence across surfaces.
export const GITHUB_READ_ONLY_PUBLIC_TOOL_NAMES: ReadonlySet<string> = new Set(
  getToolPublicNames({ source: 'github', readOnly: true }),
);

export function isGitHubToolName(name: unknown): boolean {
  return typeof name === 'string' && GITHUB_PUBLIC_TOOL_NAMES.has(name);
}

const GITHUB_TOOL_PROTOCOL_BODY = `GITHUB TOOLS

These operate on GitHub repositories over the GitHub API (not the local
workspace). \`repo\` is always "owner/name". Available when a GitHub token is
configured (PUSH_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN, or \`gh auth token\`);
otherwise they return GITHUB_NO_TOKEN.

Available tools:
${GITHUB_PROTOCOL_ENTRIES.map((spec) => `- ${spec.protocolSignature} — ${spec.protocolDescription}`).join('\n')}

Rules:
- Read-only GitHub tools (${getToolPublicNames({ source: 'github', readOnly: true }).join(', ')}) may run in parallel with other read-only calls.
- Write GitHub tools (${getToolPublicNames({ source: 'github', readOnly: false }).join(', ')}) are side-effecting — at most one trailing side-effect per turn, same budget as exec/git_commit.
- Merges happen through the PR flow: open a PR (pr_create) and merge it (pr_merge); never merge locally.
- Do not describe tool calls in prose. Emit only JSON blocks for tool calls.`;

/**
 * GitHub tool protocol block, appended to the system prompt only when a GitHub
 * token is configured. Schema-versioned off its own body so changes to the
 * GitHub surface bump the marker independently of the core protocol.
 */
export const GITHUB_TOOL_PROTOCOL = `[GitHub tool schema version: ${deriveProtocolVersion(GITHUB_TOOL_PROTOCOL_BODY)}]

${GITHUB_TOOL_PROTOCOL_BODY}`;

/**
 * Synchronous GitHub protocol block — env tokens only. Used for the instant
 * (pre-enrichment) base prompt so we don't spawn `gh` on the fast path.
 * Returns '' when no env token is set. The async enrichment step
 * (`getGitHubToolProtocolAsync`) is the authoritative advertise-time check and
 * additionally honors the `gh auth token` fallback.
 */
export function getGitHubToolProtocol(): string {
  return hasEnvGitHubToken() ? GITHUB_TOOL_PROTOCOL : '';
}

/**
 * Authoritative advertise-time GitHub protocol block. Consults the FULL token
 * resolution chain (env → `gh auth token`), so a user authenticated only via
 * `gh auth login` still sees the GitHub tools in the enriched system prompt
 * that actually reaches the model — matching what dispatch will accept at
 * execution time. Returns '' when no token resolves. Async because the `gh`
 * fallback spawns a subprocess (memoized in cli/github-runtime.ts).
 */
export async function getGitHubToolProtocolAsync(): Promise<string> {
  const token = await resolveGitHubToken();
  return token ? GITHUB_TOOL_PROTOCOL : '';
}

export function truncateText(text, max = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const totalLines = text.split('\n').length;
  const kept = text.slice(0, max);
  const keptLines = kept.split('\n').length;
  const extra = text.length - max;
  return `${kept}\n\n[truncated ${extra} chars, showing ${keptLines}/${totalLines} lines — use start_line/end_line to read specific ranges]`;
}

function truncateReadFileOutput(renderedText, rawContent, startLine, max = MAX_TOOL_OUTPUT_CHARS) {
  if (renderedText.length <= max) {
    return {
      text: renderedText,
      truncated: false,
      truncatedAtLine: undefined,
      remainingBytes: undefined,
    };
  }

  const renderedLines = renderedText.split('\n');
  const rawLines = String(rawContent).split(/\r?\n/);
  let keptCount = 0;
  let usedChars = 0;

  for (let i = 0; i < renderedLines.length; i++) {
    const lineChars = renderedLines[i].length + (i > 0 ? 1 : 0);
    if (usedChars + lineChars > max) {
      if (keptCount === 0) keptCount = 1;
      break;
    }
    usedChars += lineChars;
    keptCount += 1;
  }

  if (keptCount >= renderedLines.length) {
    return {
      text: renderedText,
      truncated: false,
      truncatedAtLine: undefined,
      remainingBytes: undefined,
    };
  }

  const truncatedAtLine = startLine + keptCount;
  const remainingBytes = Buffer.byteLength(rawLines.slice(keptCount).join('\n'));
  const preview = renderedLines.slice(0, keptCount).join('\n');
  return {
    text:
      `${preview}\n\n[truncated]\n` +
      `truncated_at_line: ${truncatedAtLine}\n` +
      `remaining_bytes: ${remainingBytes}\n` +
      `showing ${keptCount}/${renderedLines.length} lines — continue with start_line=${truncatedAtLine}`,
    truncated: true,
    truncatedAtLine,
    remainingBytes,
  };
}

function asString(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

// Shared git-ref validation for the branch tools (git_create_branch /
// git_switch_branch). execFileAsync passes argv without a shell so there's no
// injection surface, but a leading '-' would still be parsed by git as a flag,
// and the other shapes reject refs git itself would refuse. Centralized so
// create + switch validate identically and can be hardened in one place.
export function isInvalidGitRef(ref) {
  return (
    typeof ref !== 'string' ||
    !/^[A-Za-z0-9._/-]+$/.test(ref) ||
    ref.startsWith('-') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.includes('..')
  );
}

/** Human-facing description of the valid-ref rules, reused in error messages. */
const GIT_REF_DETAIL =
  'Branch refs may contain letters, digits, ".", "_", "/", "-"; no leading "-" or "/", no trailing "/", and no ".." allowed.';

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

// CLI tool-call detection now routes through the shared kernel at
// `lib/tool-dispatch.ts`. The kernel owns fenced-block extraction,
// JSON.parse + repair, bare-object fallback (missing-fence tolerance),
// dedup, and malformed-call reporting. The CLI registers a single
// pass-through source — tool-name validation happens downstream in
// `executeToolCall`, not at parse time.
//
// Before this wiring landed the CLI had its own fence-only implementation
// that silently dropped tool-call JSON emitted without opening fences.
// That bug surfaced as an empty TUI transcript when Gemini-3-flash on
// Ollama Cloud emitted `json\n{...}` without the leading triple-backtick.
// See docs/decisions/Tool-Call Parser Convergence Gap.md for the full
// four-layer analysis.
import { createToolDispatcher, PASS_THROUGH_CLI_SOURCE } from '../lib/tool-dispatch.js';
import type { NativeToolCall } from '../lib/provider-contract.js';

const cliToolDispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

export function detectAllToolCalls(text: string): {
  calls: { tool: string; args: Record<string, unknown> }[];
  malformed: { reason: string; sample: string; rawToolName?: string }[];
} {
  return cliToolDispatcher.detectAllToolCalls(text);
}

export function detectNativeToolCalls(calls: readonly NativeToolCall[]): {
  calls: { tool: string; args: Record<string, unknown> }[];
  malformed: { reason: string; sample: string; rawToolName?: string }[];
} {
  return cliToolDispatcher.detectNativeToolCalls(calls);
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

// Surfaces reducer telemetry in tool `meta` (freeform) only when a reduction
// actually fired — keeps the common case clean.
/** @param {import('../lib/tool-output-reducers.ts').ReducedOutput} reduced */
function reductionMeta(reduced) {
  if (!reduced.reduced) return {};
  return {
    output_reduced: true,
    reducer: reduced.reducerId,
    original_chars: reduced.originalChars,
    reduced_chars: reduced.reducedChars,
    saved_chars: reduced.savedChars,
  };
}

/**
 * When exec output was reduced, retain the full raw output in the verbatim log
 * and return a model-facing marker pointing at the ref (LCM Phase 3 recall).
 * Best-effort: scope is resolved lazily only on reduction, and any failure
 * yields an empty marker — retention never breaks the exec path.
 * @param {import('../lib/tool-output-reducers.ts').ReducedOutput} reduced
 */
async function reductionRecallMarker(reduced, rawText, command, workspaceRoot) {
  if (!reduced.reduced) return '';
  try {
    const identity = await resolveWorkspaceIdentity(workspaceRoot);
    if (!identity.repoFullName) return '';
    const { marker } = await retainReducedOutput({
      reduced,
      rawText,
      command,
      scope: { repoFullName: identity.repoFullName, branch: identity.branch ?? undefined },
    });
    return marker ?? '';
  } catch (err) {
    // Best-effort: identity resolution (or the retain call) failing must not
    // break exec — but log it so a consistently-failing retain is observable,
    // matching the web path's verbatim_retain_failed. stderr, per the CLI
    // stdout-is-the-output-channel rule.
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'verbatim_retain_marker_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return '';
  }
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
    const { stdout } = await execFileAsync(
      'rg',
      [
        '--line-number',
        '--no-heading',
        '--color',
        'never',
        '--max-count',
        String(maxResults),
        pattern,
        searchRoot,
      ],
      { maxBuffer: 2_000_000 },
    );
    return stdout.trim() || 'No matches';
  } catch (err) {
    if (err.code === 1) return (err.stdout || '').trim() || 'No matches';
    if (err.code === 'ENOENT') {
      try {
        const { stdout } = await execFileAsync(
          'grep',
          ['-RIn', '--binary-files=without-match', '--', pattern, searchRoot],
          { maxBuffer: 2_000_000 },
        );
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

  if (
    providerId === 'ollama' &&
    typeof options.providerApiKey === 'string' &&
    options.providerApiKey.trim()
  ) {
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

  const snippetRegex =
    /<(?:a|div)[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
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
    const title =
      typeof entry.title === 'string'
        ? entry.title.trim()
        : typeof entry.name === 'string'
          ? entry.name.trim()
          : '';
    const url =
      typeof entry.url === 'string'
        ? entry.url.trim()
        : typeof entry.link === 'string'
          ? entry.link.trim()
          : '';
    const content =
      typeof entry.content === 'string'
        ? entry.content.trim()
        : typeof entry.snippet === 'string'
          ? entry.snippet.trim()
          : typeof entry.description === 'string'
            ? entry.description.trim()
            : '';
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
      throw new Error(
        `Tavily returned ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
      );
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
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(
        `Ollama search returned ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
      );
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

/**
 * True when a Content-Type header names something we can meaningfully hand
 * to the model as text. An absent header passes — plenty of raw-file hosts
 * (gists, plain-text mirrors) omit it, and a garbled decode is self-evident
 * to the model in a way a refusal is not.
 */
function isTextLikeContentType(contentType) {
  const ct = String(contentType || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!ct) return true;
  if (ct.startsWith('text/')) return true;
  if (ct.endsWith('+json') || ct.endsWith('+xml')) return true;
  return new Set([
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/x-ndjson',
    'application/yaml',
    'application/x-yaml',
    'application/toml',
    'application/x-sh',
  ]).has(ct);
}

function extractHtmlTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

/**
 * Convert an HTML page to readable plain text. Unlike `stripHtml` (which
 * flattens snippets onto one line for search results), this preserves the
 * block structure — paragraphs, headings, list items — so a fetched docs
 * page stays scannable for the model.
 */
function htmlToReadableText(html) {
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  text = text
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt|header|footer|main|nav|figcaption)>/gi,
      '\n',
    )
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
  text = decodeHtmlEntities(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Read at most ~`maxBytes` from a fetch Response body and decode as UTF-8.
 * Bounds memory against servers that lie about (or omit) content-length —
 * `response.text()` would buffer the whole stream first. May overshoot by
 * up to one chunk; callers slice to their real cap after decode. Returns
 * `{ text, cut }` where `cut` means the cap stopped the read (the stream
 * may have held more). Falls back to a sliced `response.text()` when the
 * body isn't a web stream (some test mocks; undici always provides one).
 */
async function readBodyBounded(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), cut: text.length > maxBytes };
  }

  const reader = body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    // Release the connection if we stopped mid-stream; best-effort.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Conservative: a body ending exactly at the cap reads as cut. Callers
  // only use `cut` to annotate truncation, so the false positive is benign.
  return { text: new TextDecoder().decode(merged), cut: received >= maxBytes };
}

// Bound on the error-body read used only to build a short diagnostic
// snippet — a multi-MB 404 page must not be buffered for 200 chars.
const MAX_FETCH_URL_ERROR_BODY_BYTES = 8_192;

/**
 * GET a public http(s) URL and return `{ finalUrl, status, contentType,
 * body, bodyCut }`. Throws named errors so the `fetch_url` case can classify
 * retryability without string-matching messages:
 *   - `FetchUrlHttpError` (with `.status`) on a non-2xx response
 *   - `FetchUrlContentTypeError` on a non-text body
 *   - `FetchUrlTooLargeError` on a declared oversized body
 * Scheme validation happens in the caller; no private-address blocking is
 * attempted here — the CLI is a sole-user local surface where `exec curl`
 * already reaches anything this can (same trust posture as `exec`).
 */
async function executeFetchUrl(targetUrl, signal) {
  if (typeof fetch !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_URL_TIMEOUT_MS);
  const signals = [timeoutController.signal];
  if (signal) signals.push(signal);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'PushCLI/1.0 (AI Coding Assistant)',
        Accept:
          'text/html,application/xhtml+xml,application/json,text/plain,text/*;q=0.9,*/*;q=0.5',
      },
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) {
      // Bounded read: the body only feeds a 200-char diagnostic snippet, so
      // a multi-MB error page must not be buffered whole (Codex P2 on #1291).
      const rawBody = await readBodyBounded(response, MAX_FETCH_URL_ERROR_BODY_BYTES)
        .then((r) => r.text)
        .catch(() => '');
      const snippet = stripHtml(rawBody).slice(0, 200);
      const err = new Error(`URL returned ${response.status}${snippet ? `: ${snippet}` : ''}`);
      err.name = 'FetchUrlHttpError';
      err.status = response.status;
      throw err;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!isTextLikeContentType(contentType)) {
      const err = new Error(
        `unsupported content type "${contentType.split(';')[0].trim()}" — fetch_url only reads text-like content (HTML, JSON, plain text, XML)`,
      );
      err.name = 'FetchUrlContentTypeError';
      throw err;
    }

    const declaredLength = Number(response.headers.get('content-length') || '');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_URL_CONTENT_LENGTH) {
      const err = new Error(
        `response too large (${declaredLength} bytes declared, limit ${MAX_FETCH_URL_CONTENT_LENGTH})`,
      );
      err.name = 'FetchUrlTooLargeError';
      throw err;
    }

    // Bounded read regardless of what the header declared — chunked/lying
    // servers hit the same byte cap instead of being buffered in full.
    const { text: body, cut: bodyCut } = await readBodyBounded(
      response,
      MAX_FETCH_URL_CONTENT_LENGTH,
    );
    return {
      finalUrl: response.url || targetUrl,
      status: response.status,
      contentType,
      body,
      bodyCut,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
      throw new Error(`Fetch timed out after ${FETCH_URL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Transient statuses worth a retry; everything else 4xx is permanent for this URL. */
function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function resolveWebSearchSourceHint(options = {}) {
  const backend = resolveWebSearchBackend(options);
  if (backend === 'tavily') return 'tavily';
  if (backend === 'ollama') return 'ollama_native';
  if (backend === 'duckduckgo') return 'duckduckgo_html';
  if (resolveTavilyApiKey()) return 'tavily';
  if (resolveOllamaApiKey(options)) return 'ollama_native';
  // No key + no explicit DDG opt-in. The hint feeds the structured tool-error
  // path, not the success path — auto-mode without a configured backend now
  // throws instead of scraping DDG (see `executeWebSearch`).
  return 'none';
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

  // DuckDuckGo is intentionally NOT a silent auto-mode fallback — the HTML
  // scrape is unofficial and fragile. Surface a structured error so the
  // caller's catch arm can tell the model what to do. To use DDG, the user
  // sets `PUSH_WEB_SEARCH_BACKEND=duckduckgo` explicitly.
  //
  // Marked via `name` (rather than a one-off subclass) so the caller can
  // distinguish this permanent-config failure from a transient one — the
  // same convention `AbortError` rides — and set `retryable: false` on
  // the structured error.
  const err = new Error(
    'No web search backend is configured. Set TAVILY_API_KEY (recommended), ' +
      'configure an Ollama key, or set PUSH_WEB_SEARCH_BACKEND=duckduckgo to ' +
      'use the unofficial DuckDuckGo HTML scrape.',
  );
  err.name = 'WebSearchConfigError';
  throw err;
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
    // Flatten both separators — path.relative emits OS-native ones (backslash
    // on Windows), so matching only `/` would leave the separator in the name
    // and scatter backups into nested dirs instead of one flat backups/ folder.
    const relative = path.relative(workspaceRoot, filePath).replace(/[/\\]/g, '__');
    const backupPath = path.join(backupDir, `${relative}.${Date.now()}.bak`);
    await fs.copyFile(filePath, backupPath);
  } catch {
    // Best-effort — don't fail the write/edit if backup fails
  }
}

/**
 * Best-effort structured diff for a file mutation, attached to the tool
 * result as `meta.editDiff` and rendered by the TUI as an edit card. Never
 * fails the already-succeeded mutation. Symmetric logs (console.error —
 * CLI stdout is reserved for user output / --json): `edit_diff_skipped`
 * when the file is too large to diff within budget, `edit_diff_failed` on
 * an unexpected computation error; identical content returns null silently
 * (no-op edits are not a degradation worth a log line).
 */
function buildEditDiffMeta(relPath, before, after) {
  try {
    const beforeText = String(before ?? '');
    const afterText = String(after ?? '');
    const diff = computeEditDiff(relPath, beforeText, afterText);
    if (!diff && overEditDiffLineBudget(beforeText, afterText)) {
      console.error(
        JSON.stringify({
          level: 'info',
          event: 'edit_diff_skipped',
          reason: 'file_too_large',
          path: relPath,
        }),
      );
    }
    return diff;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'edit_diff_failed',
        path: relPath,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Build a `PreCommitGate` (the `lib/git/push-git.ts` seam) that runs the
 * Auditor SAFE/UNSAFE review over the staged diff before a commit lands.
 *
 * The gate is the CLI half of the cross-surface Auditor commit gate. It runs
 * the shared `runAuditor` kernel through the CLI's existing provider
 * `PushStream` (`createProviderStream`) — no provider adapter needed.
 *
 * Fail-closed (mirrors the Auditor's own default-to-UNSAFE stance):
 * - When the gate is enabled but no provider/model/key is resolvable, deny —
 *   the operator must fix provider config or disable the gate to commit.
 * - `runAuditor` itself returns UNSAFE on any stream/parse error.
 *
 * UNSAFE → an interactive `approvalFn` (when present) may override; headless
 * runs (no approvalFn) stay blocked. Every branch emits a structured log line
 * (symmetric safe ↔ unsafe ↔ overridden ↔ unavailable) so an operator can see
 * why a commit was gated, allowed, or refused.
 *
 * `getStagedDiff` lets the caller read the staged diff after `PushGit` has run
 * `git add` — the gate is invoked by `PushGit.commit` *after* staging, so the
 * diff reflects exactly what will be committed.
 */
function makeAuditorPreCommitGate({
  providerId,
  model,
  getStagedDiff,
  approvalFn,
  signal,
  workspaceRoot,
}) {
  return async () => {
    const cliProvider = providerId ? PROVIDER_CONFIGS[providerId] : null;
    let apiKey = '';
    if (cliProvider) {
      try {
        apiKey = resolveApiKey(cliProvider);
      } catch {
        apiKey = '';
      }
    }
    if (!cliProvider || !model || !apiKey) {
      const reason = !cliProvider
        ? `unknown provider "${providerId}"`
        : !model
          ? 'no model available'
          : 'no API key available';
      console.log(JSON.stringify({ level: 'error', event: 'auditor_gate_unavailable', reason }));
      return {
        ok: false,
        reason: `Auditor commit gate is enabled but could not run (${reason}). Disable it (config auditorGate / ${AUDITOR_GATE_ENV_VAR}) or fix provider config to commit.`,
      };
    }

    const stagedDiff = await getStagedDiff();
    // Empty diff → nothing to audit; let the commit proceed (it will no-op /
    // fail on its own if there's truly nothing staged).
    if (!stagedDiff || !stagedDiff.trim()) {
      console.log(JSON.stringify({ level: 'info', event: 'auditor_gate_empty_diff' }));
      return { ok: true };
    }

    const stream = createProviderStream(cliProvider, apiKey);
    let auditResult;
    try {
      auditResult = await runAuditor(
        stagedDiff,
        {
          provider: providerId,
          stream: (req) => stream(signal ? { ...req, signal: req.signal ?? signal } : req),
          modelId: model,
          // Retrieve Auditor-scoped typed memory (with verbatim top-record detail)
          // so the CLI gate sees the same context the web Auditor does. Best-effort:
          // resolve the durable scope via git, then build the memory block. Any
          // failure degrades to '' — memory is advisory, never a commit blocker.
          resolveRuntimeContext: async (diff) => {
            try {
              const identity = await resolveWorkspaceIdentity(workspaceRoot);
              return await buildAuditorGateRuntimeContext({
                scope: { repoFullName: identity.repoFullName, branch: identity.branch },
                diff,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.log(
                JSON.stringify({
                  level: 'warn',
                  event: 'auditor_gate_scope_failed',
                  error: message,
                }),
              );
              return '';
            }
          },
        },
        () => {},
      );
    } catch (err) {
      // runAuditor is itself fail-safe, but guard the call site too.
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ level: 'error', event: 'auditor_gate_error', message }));
      return { ok: false, reason: `Auditor errored: ${message} (defaulting to blocked)` };
    }

    // Capture this verdict for the audit eval-pair trainset. A later SAFE
    // verdict on the same branch+files completes a rejection→correction pair
    // (see lib/audit-eval-pairs.ts). Awaited (not fire-and-forget) so a one-shot
    // CLI process can't exit before the append flushes; it's a fast file append
    // and `recordAuditGateVerdict` is internally best-effort, so this never
    // affects the commit outcome. The UNSAFE observation is recorded here
    // regardless of a later interactive override: the Auditor's verdict trains
    // the corpus, not whether a human waved it through.
    try {
      const identity = await resolveWorkspaceIdentity(workspaceRoot);
      if (identity.repoFullName) {
        await recordAuditGateVerdict(workspaceRoot, {
          scope: { repoFullName: identity.repoFullName, branch: identity.branch },
          diff: stagedDiff,
          verdict: auditResult.verdict,
          summary: auditResult.card?.summary ?? '',
          risks: Array.isArray(auditResult.card?.risks) ? auditResult.card.risks : [],
          at: Date.now(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify({ level: 'warn', event: 'auditor_gate_eval_record_failed', message }),
      );
    }

    if (auditResult.verdict === 'safe') {
      console.log(JSON.stringify({ level: 'info', event: 'auditor_gate_safe' }));
      return { ok: true };
    }

    // UNSAFE — allow an interactive approval override; headless stays blocked.
    const summary = auditResult.card?.summary || 'auditor returned unsafe';
    const risks = Array.isArray(auditResult.card?.risks) ? auditResult.card.risks : [];
    if (typeof approvalFn === 'function') {
      const riskLines = risks.map((r) => `- [${r.level}] ${r.description}`).join('\n');
      const detail = `Auditor flagged this commit UNSAFE:\n${summary}${riskLines ? `\n${riskLines}` : ''}\nCommit anyway?`;
      let overridden = false;
      try {
        overridden = await approvalFn('auditor', detail);
      } catch {
        overridden = false;
      }
      if (overridden) {
        console.log(
          JSON.stringify({ level: 'warn', event: 'auditor_gate_unsafe_overridden', summary }),
        );
        return { ok: true };
      }
    }
    console.log(JSON.stringify({ level: 'warn', event: 'auditor_gate_unsafe_blocked', summary }));
    return { ok: false, reason: `Auditor blocked commit (UNSAFE): ${summary}` };
  };
}

/**
 * Execute a tool call. Options:
 * - approvalFn(tool, detail): async fn that returns true to proceed, false to deny.
 *   If not provided, all calls proceed (headless default: deny high-risk).
 * - providerId: active provider id ('ollama' | 'openrouter' | 'zen') for provider-aware tools.
 * - providerApiKey: resolved provider API key for provider-aware tools.
 * - model: active model id — used by the Auditor commit gate's verdict call.
 * - auditorGate: opt-out/in for the Auditor commit gate (resolved against
 *   PUSH_AUDITOR_GATE via `lib/auditor-policy.ts`; default on).
 * - disabledTools: CLI tool names blocked at dispatch (config: `disabledTools`).
 * - alwaysAllow: CLI tool names that bypass approval (config: `alwaysAllow`).
 *   Both fall back to `PUSH_DISABLED_TOOLS` / `PUSH_ALWAYS_ALLOW` env (comma-
 *   separated) when the option is omitted, so the daemon's delegated tool
 *   executors inherit the user's policy without re-loading config.
 */
export async function executeToolCall(call, workspaceRoot, options = {}) {
  const disabledList = resolveToolPolicyList(options.disabledTools, 'PUSH_DISABLED_TOOLS');
  const callCanonical = canonicalizeCliToolName(call?.tool);
  if (disabledList.has(callCanonical)) {
    return {
      ok: false,
      text: `Blocked: tool "${call.tool}" is disabled by user config (disabledTools). Do not retry — pick a different approach.`,
      structuredError: {
        code: 'TOOL_DISABLED',
        message: `Tool "${call.tool}" disabled by config`,
        retryable: false,
      },
    };
  }

  // Kernel-level role capability check. Mirrors the web runtime's
  // `WebToolExecutionRuntime.execute` gate so capability enforcement
  // is binding-independent on both surfaces. The previous arrangement
  // had the Explorer-side check in
  // `cli/pushd/delegation-execution.ts:makeDaemonExplorerToolExec`
  // (binding-side); the engine's main loop had no kernel role check at
  // all, which meant a future binding could silently skip enforcement.
  // Closes audit item #3 from the OpenCode silent-failure inventory.
  //
  // Three fail-closed branches surface from `enforceRoleCapability`:
  //   - ROLE_REQUIRED when options.role is missing entirely.
  //   - ROLE_INVALID when options.role is supplied but isn't a
  //     recognized AgentRole (e.g. typo from a JS caller).
  //   - ROLE_CAPABILITY_DENIED when the role's grant doesn't cover the
  //     tool. Fail-open for unmapped tool names is preserved.
  // The Explorer-side `makeDaemonExplorerToolExec` 3-layer gate stays
  // as defense-in-depth. Raw `options.role` is passed through (not
  // coerced to undefined) so the helper can distinguish missing from
  // invalid and surface the right diagnostic.
  // GitHub tools are advertised under public names (`pr`, `repo_read`, …);
  // the capability table + parser/dispatcher are keyed by canonical names.
  const callIsGitHubTool = isGitHubToolName(call?.tool);
  // Resolve a GitHub token once for GitHub tool calls (env, then `gh auth
  // token`; memoized). Presence both lifts the local-daemon remote-only
  // capability strip (write tools become grantable) and is reused by the
  // GitHub dispatch below — so the gate and execution agree on "is there a
  // remote." Non-GitHub calls never pay the resolution cost.
  let resolvedGitHubToken = '';
  if (callIsGitHubTool) {
    resolvedGitHubToken = await resolveGitHubToken();
  }
  {
    const canonicalForCheck = callIsGitHubTool
      ? (resolveToolName(call.tool) ?? call.tool)
      : callCanonical || (typeof call?.tool === 'string' ? call.tool : '');
    const check = enforceRoleCapability(options.role, canonicalForCheck, CLI_EXECUTION_MODE, {
      remoteGitHubAvailable: resolvedGitHubToken.length > 0,
    });
    if (!check.ok) {
      // Symmetric structured log so a main-loop capability denial is greppable
      // in ops. Returning the denial only to the model (as `text`/
      // `structuredError`) leaves operators blind to a misconfigured grant that
      // quietly burns tokens — the OpenCode silent-failure class. The event name
      // and payload shape match the CLI Explorer gate (`cli/pushd.ts`) so a
      // single grep/dashboard covers both; the *stream* follows the Symmetric
      // structured logs convention — `console.error` with a semantic `level`
      // field, decoupled (cf. `lib/context-memory.ts` / `lib/verbatim-retain.ts`
      // doing `console.error({ level: 'warn', … })`). stderr keeps it off the
      // user-output / --json stdout channel.
      try {
        const granted =
          check.type === 'ROLE_CAPABILITY_DENIED'
            ? Array.from(
                getEffectiveCapabilities(options.role as AgentRole, CLI_EXECUTION_MODE, {
                  remoteGitHubAvailable: resolvedGitHubToken.length > 0,
                }),
              )
            : [];
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'role_capability_denied',
            type: check.type,
            role: typeof options.role === 'string' ? options.role : null,
            tool: canonicalForCheck || (typeof call?.tool === 'string' ? call.tool : null),
            required: getToolCapabilities(canonicalForCheck),
            granted,
          }),
        );
      } catch {
        // JSON.stringify cycle guard — never let logging crash the executor.
      }
      return {
        ok: false,
        text: formatRoleCapabilityDenial(call?.tool ?? '(unknown)', check),
        structuredError: {
          code: check.type,
          message: check.message,
          retryable: false,
        },
      };
    }
  }
  // --- Pre-hooks (shared with web via lib/tool-hooks) ---
  //
  // When the caller supplies a `ToolHookRegistry`, evaluate it now —
  // after the role-capability check, before the per-tool switch. The
  // CLI's default registry (see `cli/tool-hooks-default.ts`) includes
  // Protect Main; callers can layer more rules on top. First deny wins.
  if (options.hooks && options.hooks.pre && options.hooks.pre.length > 0) {
    const toolNameForHooks = callCanonical || (typeof call?.tool === 'string' ? call.tool : '');
    const hookContext = {
      sandboxId: null,
      allowedRepo: options.allowedRepo ?? '',
      activeProvider: options.providerId,
      activeModel: options.modelId,
      capabilityLedger: options.capabilityLedger,
      defaultBranch: options.defaultBranch,
      isMainProtected: options.isMainProtected,
      getCurrentBranch: options.getCurrentBranch,
    };
    const preResult = await evaluatePreHooks(
      options.hooks,
      toolNameForHooks,
      call?.args ?? {},
      hookContext,
    );
    if (preResult?.decision === 'deny') {
      const reason = preResult.reason || 'Blocked by pre-execution hook.';
      // Symmetric structured log so a pre-hook / Protect Main block is greppable
      // in ops, matching the capability-denial (`role_capability_denied`) and
      // auditor-gate (`auditor_gate_unsafe_blocked`) events. Without it a
      // Protect Main refusal returns only to the model — the OpenCode
      // silent-denial class, for a hook reason instead of a capability one.
      // CLI path → `console.error` (stdout is reserved for user output / --json).
      try {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'pre_hook_denied',
            type: preResult.errorType ?? 'PRE_HOOK_BLOCKED',
            role: typeof options.role === 'string' ? options.role : null,
            tool: toolNameForHooks || null,
            reason,
          }),
        );
      } catch {
        // JSON.stringify cycle guard — never let logging crash the executor.
      }
      return {
        ok: false,
        text: `[Tool Blocked — ${toolNameForHooks}]\n${reason}`,
        structuredError: {
          code: preResult.errorType ?? 'PRE_HOOK_BLOCKED',
          message: reason,
          retryable: false,
        },
      };
    }
    if (preResult?.modifiedArgs && call && typeof call === 'object') {
      call.args = { ...call.args, ...preResult.modifiedArgs };
    }
  }

  // Forward a canonicalized `alwaysAllow` set into the per-case guard via
  // options so command guards see the same set without re-resolving env on
  // every call. We always normalize (even when an explicit array was
  // passed) to keep alias semantics consistent at the gate.
  const alwaysAllowList = resolveToolPolicyList(options.alwaysAllow, 'PUSH_ALWAYS_ALLOW');
  if (alwaysAllowList.size > 0) {
    options = { ...options, alwaysAllow: [...alwaysAllowList] };
  }

  // GitHub tools route to the shared core dispatcher, NOT the CLI switch — the
  // capability gate above already cleared them. Handled here (before the
  // switch) because several canonical GitHub names collide with CLI-native
  // switch cases (`read_file`, `list_directory`/`list_dir`, `search_files`).
  if (callIsGitHubTool) {
    if (!resolvedGitHubToken) {
      return {
        ok: false,
        text: `[GitHub — ${call.tool}] No GitHub token configured. Set PUSH_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN, or log in with \`gh auth login\`, to use GitHub tools.`,
        structuredError: {
          code: 'GITHUB_NO_TOKEN',
          message: 'No GitHub token configured for GitHub tools',
          retryable: false,
        },
      };
    }
    // Map public → canonical, then parse args into the typed core call.
    const canonicalName = resolveToolName(call.tool) ?? call.tool;
    const githubCall = parseGitHubCoreToolCall(
      canonicalName,
      (call.args as Record<string, unknown>) ?? {},
    );
    if (!githubCall) {
      return {
        ok: false,
        text: `[GitHub — ${call.tool}] Invalid or missing arguments. Check the tool signature and required fields (repo is always required).`,
        structuredError: {
          code: 'INVALID_ARGS',
          message: `Could not parse arguments for GitHub tool "${call.tool}"`,
          retryable: false,
        },
      };
    }
    const runtime = createCliGitHubRuntime(resolvedGitHubToken);
    // Wrap the core call: several executeGitHubCoreTool paths throw on 404/403/
    // timeouts. This GitHub dispatch runs BEFORE the switch's try/catch, so a
    // throw here would reject executeToolCall — the engine would treat a single
    // GitHub failure as a fatal run error instead of a recoverable tool result.
    // Convert to a structured tool result so the model can react (same contract
    // as every other CLI tool).
    let result;
    try {
      result = await executeGitHubCoreTool(runtime, githubCall);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        text: `[GitHub — ${call.tool}] ${message}`,
        structuredError: classifyToolError(err),
      };
    }
    // The core returns { text, card? }. Surface text to the model; informative
    // core text (e.g. "Not found") stays ok:true — same as the web transport,
    // which doesn't reclassify core text into errors.
    return {
      ok: true,
      text: result.text,
      meta: result.card ? { card: result.card } : undefined,
    };
  }

  try {
    // Public provider-family aliases (notably Kimi K3's `Edit`) execute through
    // the same canonical cases used by policy, hooks, and capability checks.
    switch (callCanonical) {
      case 'memory_grep':
      case 'memory_expand': {
        // Scope reads to the workspace's repo/branch from git — never from
        // model args. CLI memory is branch-scoped (no chatId).
        const identity = await resolveWorkspaceIdentity(workspaceRoot);
        if (!identity.repoFullName) {
          return {
            ok: false,
            text: `[Tool Error — ${call.tool}] Memory tools require a git repo with a known remote.`,
            structuredError: {
              code: 'INVALID_ARG',
              message: 'no repo scope for memory retrieval',
              retryable: false,
            },
          };
        }
        const memCtx = {
          scope: { repoFullName: identity.repoFullName, branch: identity.branch ?? undefined },
          store: getDefaultMemoryStore(),
        };
        const memResult =
          call.tool === 'memory_grep'
            ? await runMemoryGrep(call.args, memCtx)
            : await runMemoryExpand(call.args, memCtx);
        return { ok: true, text: memResult.text, meta: memResult.meta };
      }

      case 'read_file': {
        const filePath = await ensureInsideWorkspace(
          workspaceRoot,
          asString(call.args.path, 'path'),
        );
        const raw = await fs.readFile(filePath, 'utf8');
        const startLine = asOptionalNumber(call.args.start_line);
        const endLine = asOptionalNumber(call.args.end_line);

        const rendered = renderAnchoredRange(raw, startLine, endLine);
        const rawLines = String(raw).split(/\r?\n/);
        const relevantRaw = rawLines.slice(rendered.startLine - 1, rendered.endLine).join('\n');
        const truncatedRead = truncateReadFileOutput(
          rendered.text || '<empty file>',
          relevantRaw,
          rendered.startLine,
        );
        return {
          ok: true,
          text: truncatedRead.text,
          meta: {
            path: filePath,
            start_line: rendered.startLine,
            end_line: rendered.endLine,
            total_lines: rendered.totalLines,
            lines: rendered.endLine - rendered.startLine + 1,
            version: calculateContentVersion(raw),
            anchored: true,
            truncated: truncatedRead.truncated,
            truncated_at_line: truncatedRead.truncatedAtLine,
            remaining_bytes: truncatedRead.remainingBytes,
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
            type: entry.isSymbolicLink()
              ? 'symlink'
              : entry.isDirectory()
                ? 'dir'
                : entry.isFile()
                  ? 'file'
                  : 'other',
          }))
          .sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            if (a.type === 'dir') return -1;
            if (b.type === 'dir') return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 300);
        const prefixMap = { dir: 'd', file: 'f', symlink: 'l', other: 'f' };
        const text = mapped
          .map((entry) => `${prefixMap[entry.type] || 'f'} ${entry.name}`)
          .join('\n');
        return {
          ok: true,
          text: text || '<empty directory>',
          meta: { path: dirPath, count: mapped.length },
        };
      }

      case 'search_files': {
        const pattern = asString(call.args.pattern, 'pattern').trim();
        if (!pattern) throw new Error('pattern cannot be empty');
        const searchPath =
          typeof call.args.path === 'string'
            ? await ensureInsideWorkspace(workspaceRoot, call.args.path)
            : workspaceRoot;
        const maxResults = clamp(
          asOptionalNumber(call.args.max_results) ?? DEFAULT_SEARCH_RESULTS,
          1,
          1000,
        );
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
        const maxResults = clamp(
          asOptionalNumber(call.args.max_results) ?? DEFAULT_WEB_SEARCH_RESULTS,
          1,
          MAX_WEB_SEARCH_RESULTS,
        );
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
          // Permanent config failures (no backend wired) aren't retryable;
          // pinging the same broken state again won't help the model.
          const isConfigError = err instanceof Error && err.name === 'WebSearchConfigError';
          return {
            ok: false,
            text: `Web search (${sourceHint}) failed: ${message}`,
            structuredError: {
              code: 'WEB_SEARCH_ERROR',
              message,
              retryable: !isConfigError,
            },
            meta: { query, max_results: maxResults, source: sourceHint, backend },
          };
        }
      }

      // Likely model guesses fall through to the CLI-native handler — mirrors
      // the `switch_branch` / `git_switch_branch` pairing. The capability
      // gate already canonicalized these via CLI_TOOL_ALIASES.
      case 'fetch':
      case 'web_fetch':
      case 'get_url':
      case 'fetch_page':
      case 'fetch_url': {
        const rawUrl = asString(call.args.url, 'url').trim();
        if (!rawUrl) throw new Error('url must be a non-empty string');
        const maxChars = clamp(
          asOptionalNumber(call.args.max_chars) ?? MAX_TOOL_OUTPUT_CHARS,
          MIN_FETCH_URL_CHARS,
          MAX_TOOL_OUTPUT_CHARS,
        );

        let parsedUrl;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          return {
            ok: false,
            text: `fetch_url failed: "${rawUrl}" is not a valid absolute URL`,
            structuredError: {
              code: 'FETCH_URL_ERROR',
              message: 'invalid absolute URL',
              retryable: false,
            },
            meta: { url: rawUrl },
          };
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return {
            ok: false,
            text: `fetch_url failed: only http(s) URLs are supported (got "${parsedUrl.protocol}")`,
            structuredError: {
              code: 'FETCH_URL_ERROR',
              message: `unsupported protocol "${parsedUrl.protocol}"`,
              retryable: false,
            },
            meta: { url: rawUrl },
          };
        }

        try {
          const page = await executeFetchUrl(parsedUrl.toString(), options.signal);
          const isHtml = /html/i.test(page.contentType);
          const title = isHtml ? extractHtmlTitle(page.body) : '';
          let content = isHtml ? htmlToReadableText(page.body) : page.body.trim();
          const totalChars = content.length;
          const charsTruncated = totalChars > maxChars;
          // `bodyCut` alone can also mean dropped content: a byte-capped HTML
          // page can strip down to fewer than max_chars readable chars.
          const truncated = charsTruncated || Boolean(page.bodyCut);
          if (charsTruncated) content = content.slice(0, maxChars);

          const headerLines = [`URL: ${page.finalUrl}`];
          if (title) headerLines.push(`Title: ${title}`);
          headerLines.push(`Content-Type: ${page.contentType.split(';')[0].trim() || 'unknown'}`);
          const truncationNote = charsTruncated
            ? `\n\n[truncated ${totalChars - maxChars} chars — re-call with a larger max_chars (cap ${MAX_TOOL_OUTPUT_CHARS}) or fetch a more specific page]`
            : truncated
              ? `\n\n[page exceeded the ${MAX_FETCH_URL_CONTENT_LENGTH}-byte read cap — content beyond it was dropped]`
              : '';

          return {
            ok: true,
            text: `${headerLines.join('\n')}\n\n${content || '<no readable text content>'}${truncationNote}`,
            meta: {
              url: rawUrl,
              final_url: page.finalUrl,
              status: page.status,
              content_type: page.contentType,
              chars: content.length,
              total_chars: totalChars,
              truncated,
            },
          };
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          const message = err instanceof Error ? err.message : String(err);
          // Classify by failure mode (see PR self-review "HTTP status
          // classification"): transient statuses + timeouts/network retry;
          // permanent ones (bad URL class, missing page, non-text body,
          // oversized body) don't — re-calling the same URL can't help.
          const status =
            err instanceof Error && err.name === 'FetchUrlHttpError' ? err.status : undefined;
          const permanent =
            (typeof status === 'number' && !isRetryableHttpStatus(status)) ||
            (err instanceof Error &&
              (err.name === 'FetchUrlContentTypeError' || err.name === 'FetchUrlTooLargeError'));
          return {
            ok: false,
            text: `fetch_url failed for ${parsedUrl.toString()}: ${message}`,
            structuredError: {
              code: 'FETCH_URL_ERROR',
              message,
              retryable: !permanent,
            },
            meta: { url: rawUrl, ...(typeof status === 'number' ? { status } : {}) },
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
        const timeoutMs = clamp(
          asOptionalNumber(call.args.timeout_ms) ?? DEFAULT_EXEC_TIMEOUT_MS,
          1_000,
          MAX_EXEC_TIMEOUT_MS,
        );
        const guard = await guardExecCommand(command, options, 'exec');
        if (!guard.ok) {
          return guard.result;
        }

        const elapsed = startElapsedMs();
        try {
          const execOpts = {
            cwd: workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 4_000_000,
            env: scrubEnv(),
          };
          if (options.signal) execOpts.signal = options.signal;
          const { stdout, stderr } = await runCommandInExecSandbox(
            command,
            workspaceRoot,
            execOpts,
          );
          // Reduce the MODEL-FACING tool-result text. This is also what gets
          // persisted to the CLI transcript, so reduction is intentionally part
          // of the recorded context (the omission marker tells the model to
          // re-run for full detail); the streaming exec_start/exec_poll session
          // buffers are a separate path and stay raw. Exit code is still printed
          // verbatim by formatExecOutput.
          const reduced = reduceToolOutput({ command, stdout, stderr, exitCode: 0 });
          const recall = await reductionRecallMarker(
            reduced,
            formatExecOutput(stdout, stderr, 0),
            command,
            workspaceRoot,
          );
          return {
            ok: true,
            text: truncateText(formatExecOutput(reduced.stdout, reduced.stderr, 0)) + recall,
            meta: {
              command,
              timeout_ms: timeoutMs,
              ...reductionMeta(reduced),
              card: buildCommandToolCard({
                command,
                stdout,
                stderr,
                exitCode: 0,
                durationMs: elapsed(),
              }),
            },
          };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          const reduced = reduceToolOutput({
            command,
            stdout: err.stdout || '',
            stderr: err.stderr || err.message,
            exitCode,
          });
          const recall = await reductionRecallMarker(
            reduced,
            formatExecOutput(
              err.stdout || '',
              err.stderr || err.message,
              exitCode,
              Boolean(err.killed),
            ),
            command,
            workspaceRoot,
          );
          return {
            ok: false,
            text:
              truncateText(
                formatExecOutput(reduced.stdout, reduced.stderr, exitCode, Boolean(err.killed)),
              ) + recall,
            structuredError: {
              code: err.killed ? 'EXEC_TIMEOUT' : 'EXEC_FAILED',
              message: err.killed ? 'Command timed out' : `Command exited with code ${exitCode}`,
              retryable: true,
            },
            meta: {
              command,
              timeout_ms: timeoutMs,
              exit_code: exitCode,
              timed_out: Boolean(err.killed),
              ...reductionMeta(reduced),
              card: buildCommandToolCard({
                command,
                stdout: err.stdout || '',
                stderr: err.stderr || err.message,
                exitCode,
                durationMs: elapsed(),
              }),
            },
          };
        }
      }

      case 'exec_start': {
        const command = asString(call.args.command, 'command');
        const timeoutMs = clamp(
          asOptionalNumber(call.args.timeout_ms) ?? DEFAULT_EXEC_SESSION_TIMEOUT_MS,
          1_000,
          MAX_EXEC_SESSION_TIMEOUT_MS,
        );
        const tty = call.args.tty === true;
        const guard = await guardExecCommand(command, options, 'exec_start');
        if (!guard.ok) return guard.result;

        const session = await startExecSession(command, workspaceRoot, timeoutMs, tty);
        const status = formatSessionStatus(session);
        return {
          ok: true,
          text: `Started exec session ${session.id} (${status}). Use exec_poll to read output and exec_write for stdin.`,
          meta: {
            session_id: session.id,
            command,
            timeout_ms: timeoutMs,
            tty_requested: tty,
            tty_mode: session.ttyMode,
            running: session.running,
            status,
          },
        };
      }

      case 'exec_poll': {
        const sessionId = asString(call.args.session_id, 'session_id');
        const session = EXEC_SESSIONS.get(sessionId);
        if (!session) {
          return {
            ok: false,
            text: `No exec session found: ${sessionId}`,
            structuredError: {
              code: 'NOT_FOUND',
              message: `Unknown exec session: ${sessionId}`,
              retryable: false,
            },
          };
        }

        const fromSeqRaw = asOptionalNumber(call.args.from_seq) ?? 0;
        const fromSeq = Number.isFinite(fromSeqRaw) ? Math.max(0, Math.floor(fromSeqRaw)) : 0;
        const maxChars = clamp(
          asOptionalNumber(call.args.max_chars) ?? DEFAULT_EXEC_POLL_MAX_CHARS,
          256,
          MAX_EXEC_POLL_MAX_CHARS,
        );
        const collected = collectSessionOutput(session, fromSeq, maxChars);
        const latestSeq = session.nextSeq;
        const historyTruncated = fromSeq < session.firstAvailableSeq - 1;
        const output = collected.text || '<no new output>';
        const status = formatSessionStatus(session);

        let finalOutput = output;
        if (session.interactiveTrap) {
          finalOutput +=
            '\n\n[push] [INTERACTIVE_PROMPT_DETECTED] The process appears to be waiting for input. Use exec_write to respond or exec_stop to kill it.';
        }

        return {
          ok: true,
          text: truncateText(
            `session_id: ${session.id}\nstatus: ${status}\nfrom_seq: ${fromSeq}\nnext_seq: ${latestSeq}\n\noutput:\n${finalOutput}`,
          ),
          meta: {
            session_id: session.id,
            running: session.running,
            interactive_trap: session.interactiveTrap,
            status,
            exit_code: session.exitCode,
            signal: session.exitSignal,
            timed_out: session.timedOut,
            from_seq: fromSeq,
            next_seq: latestSeq,
            first_available_seq: session.firstAvailableSeq,
            returned_chunks: collected.returnedChunks,
            history_truncated: historyTruncated,
            output_truncated: collected.truncated,
            tty_mode: session.ttyMode,
          },
        };
      }

      case 'exec_wait': {
        const sessionId = asString(call.args.session_id, 'session_id');
        const session = EXEC_SESSIONS.get(sessionId);
        if (!session) {
          return {
            ok: false,
            text: `No exec session found: ${sessionId}`,
            structuredError: {
              code: 'NOT_FOUND',
              message: `Unknown exec session: ${sessionId}`,
              retryable: false,
            },
          };
        }

        const fromSeqRaw = asOptionalNumber(call.args.from_seq) ?? 0;
        const fromSeq = Number.isFinite(fromSeqRaw) ? Math.max(0, Math.floor(fromSeqRaw)) : 0;
        const maxChars = clamp(
          asOptionalNumber(call.args.max_chars) ?? DEFAULT_EXEC_POLL_MAX_CHARS,
          256,
          MAX_EXEC_POLL_MAX_CHARS,
        );
        const waitMs = clamp(
          asOptionalNumber(call.args.timeout_ms) ?? DEFAULT_EXEC_WAIT_MS,
          1_000,
          MAX_EXEC_WAIT_MS,
        );

        // Block until the process exits, an interactive prompt is detected, the
        // wait budget elapses, or the run is aborted (Stop). This moves the poll
        // loop off the model: one `exec_wait` replaces the many `exec_poll`
        // round-trips the model would otherwise spend spinning on a quiet
        // long-running command. `waitForSessionExit` resolves immediately on
        // exit or abort (event-driven, not a busy-wait) and removes its own
        // waiter on every path; the slice only bounds how quickly we notice an
        // interactive trap. Aborting stops *waiting* — it never kills the
        // command (that is exec_stop's job).
        const deadline = Date.now() + waitMs;
        while (
          session.running &&
          !session.interactiveTrap &&
          !options.signal?.aborted &&
          Date.now() < deadline
        ) {
          const slice = Math.min(EXEC_WAIT_SLICE_MS, deadline - Date.now());
          if (slice <= 0) break;
          await waitForSessionExit(session, slice, options.signal);
        }

        const collected = collectSessionOutput(session, fromSeq, maxChars);
        const latestSeq = session.nextSeq;
        const historyTruncated = fromSeq < session.firstAvailableSeq - 1;
        const status = formatSessionStatus(session);
        const waited = !session.running
          ? 'exited'
          : session.interactiveTrap
            ? 'needs_input'
            : options.signal?.aborted
              ? 'aborted'
              : 'running';

        let finalOutput = collected.text || '<no new output>';
        if (session.interactiveTrap) {
          finalOutput +=
            '\n\n[push] [INTERACTIVE_PROMPT_DETECTED] The process appears to be waiting for input. Use exec_write to respond or exec_stop to kill it.';
        } else if (waited === 'running') {
          finalOutput += `\n\n[push] still running after ${waitMs}ms — call exec_wait again to keep waiting, or exec_stop to kill it.`;
        }

        return {
          ok: true,
          text: truncateText(
            `session_id: ${session.id}\nstatus: ${status}\nwaited: ${waited}\nfrom_seq: ${fromSeq}\nnext_seq: ${latestSeq}\n\noutput:\n${finalOutput}`,
          ),
          meta: {
            session_id: session.id,
            running: session.running,
            interactive_trap: session.interactiveTrap,
            waited,
            status,
            exit_code: session.exitCode,
            signal: session.exitSignal,
            timed_out: session.timedOut,
            from_seq: fromSeq,
            next_seq: latestSeq,
            first_available_seq: session.firstAvailableSeq,
            returned_chunks: collected.returnedChunks,
            history_truncated: historyTruncated,
            output_truncated: collected.truncated,
            tty_mode: session.ttyMode,
          },
        };
      }

      case 'exec_write': {
        const sessionId = asString(call.args.session_id, 'session_id');
        const session = EXEC_SESSIONS.get(sessionId);
        if (!session) {
          return {
            ok: false,
            text: `No exec session found: ${sessionId}`,
            structuredError: {
              code: 'NOT_FOUND',
              message: `Unknown exec session: ${sessionId}`,
              retryable: false,
            },
          };
        }
        if (!session.running || !session.child?.stdin || session.child.stdin.destroyed) {
          return {
            ok: false,
            text: `Exec session ${sessionId} is not accepting input (status: ${formatSessionStatus(session)}).`,
            structuredError: {
              code: 'EXEC_FAILED',
              message: 'Session is not running',
              retryable: false,
            },
          };
        }

        const input = asString(call.args.input, 'input');
        const payload = call.args.append_newline === true ? `${input}\n` : input;
        await new Promise((resolve, reject) => {
          session.child.stdin.write(payload, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return {
          ok: true,
          text: `Wrote ${payload.length} bytes to exec session ${sessionId}.`,
          meta: {
            session_id: sessionId,
            bytes: payload.length,
            append_newline: call.args.append_newline === true,
          },
        };
      }

      case 'exec_stop': {
        const sessionId = asString(call.args.session_id, 'session_id');
        const session = EXEC_SESSIONS.get(sessionId);
        if (!session) {
          return {
            ok: false,
            text: `No exec session found: ${sessionId}`,
            structuredError: {
              code: 'NOT_FOUND',
              message: `Unknown exec session: ${sessionId}`,
              retryable: false,
            },
          };
        }

        const signalName = normalizeSignal(call.args.signal);
        if (session.running) {
          stopSessionProcess(session, signalName);
          await waitForSessionExit(session, 2_500);
          if (session.running) {
            stopSessionProcess(session, 'SIGKILL');
            await waitForSessionExit(session, 1_500);
          }
        }

        removeExecSession(sessionId);
        const status = formatSessionStatus(session);
        return {
          ok: true,
          text: `Stopped exec session ${sessionId} (${status}).`,
          meta: {
            session_id: sessionId,
            status,
            running: session.running,
            exit_code: session.exitCode,
            signal: session.exitSignal,
            timed_out: session.timedOut,
          },
        };
      }

      case 'exec_list_sessions': {
        const sessions = [...EXEC_SESSIONS.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 200);

        const rows = sessions.map((session) => {
          const ageSec = Math.max(0, Math.round((Date.now() - session.createdAt) / 1000));
          return `${session.id} [${formatSessionStatus(session)}] tty=${session.ttyMode} age=${ageSec}s cmd=${session.command}`;
        });

        const running = sessions.filter((session) => session.running).length;
        return {
          ok: true,
          text: truncateText(rows.length > 0 ? rows.join('\n') : 'No exec sessions.'),
          meta: {
            count: sessions.length,
            running,
          },
        };
      }

      case 'write_file': {
        const filePath = await ensureInsideWorkspace(
          workspaceRoot,
          asString(call.args.path, 'path'),
        );
        const content = asString(call.args.content, 'content');
        await backupFile(filePath, workspaceRoot);
        // Prior content feeds the transcript edit card (meta.editDiff); a
        // missing file is a create — diffed against empty.
        let beforeContent = '';
        try {
          beforeContent = await fs.readFile(filePath, 'utf8');
        } catch {
          beforeContent = '';
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        // Post-edit diagnostics loop (crush pattern): surface breakage the
        // write just introduced in the same tool result. Never fails the
        // already-succeeded write; see cli/post-edit-diagnostics.ts.
        // `options.postEditDiagnostics` is a per-call override seam (tests,
        // embedders) — production resolves via PUSH_POST_EDIT_DIAGNOSTICS,
        // forwarded from config by applyConfigToEnv; no caller threads it.
        const writeDiag = await runPostEditDiagnostics(workspaceRoot, filePath, {
          explicitEnabled:
            typeof options.postEditDiagnostics === 'boolean'
              ? options.postEditDiagnostics
              : undefined,
        });
        const writeRelPath = path.relative(workspaceRoot, filePath) || '.';
        const writeEditDiff = buildEditDiffMeta(writeRelPath, beforeContent, content);
        // Model-visible orientation: an update to an existing file echoes the
        // changed regions back (confirmed post-write state, not what the
        // model *believes* it wrote). Creates skip the echo — the diff would
        // just replay the content the model authored one message ago.
        const writeChangeNote =
          writeEditDiff && beforeContent !== ''
            ? `\n\nChanges (+${writeEditDiff.adds} -${writeEditDiff.dels}):\n${renderEditDiffText(writeEditDiff, { maxLines: 40 })}`
            : '';
        return {
          ok: true,
          text: `Wrote ${content.length} bytes to ${writeRelPath}${writeChangeNote}${writeDiag.note ?? ''}`,
          meta: {
            path: filePath,
            bytes: content.length,
            version: calculateContentVersion(content),
            ...(writeDiag.meta ? { diagnostics: writeDiag.meta } : {}),
            ...(writeEditDiff ? { editDiff: writeEditDiff } : {}),
            ...(writeEditDiff ? { card: buildEditDiffToolCard(writeEditDiff) } : {}),
          },
        };
      }

      case 'edit_file': {
        const filePath = await ensureInsideWorkspace(
          workspaceRoot,
          asString(call.args.path, 'path'),
        );
        const hasArg = (name) => Object.prototype.hasOwnProperty.call(call.args, name);
        const hasEditsArg = hasArg('edits');
        const searchArgNames = ['search', 'replace', 'old_string', 'new_string', 'replace_all'];
        const hasSearchArgs = searchArgNames.some(hasArg);

        if (hasEditsArg && hasSearchArgs) {
          return {
            ok: false,
            text: 'Ambiguous edit_file call: provide either edits[] or search/replace arguments, not both.',
            structuredError: {
              code: 'EDIT_AMBIGUOUS',
              message: 'edit_file received both hashline edits and search/replace arguments',
              retryable: true,
            },
            meta: { path: filePath },
          };
        }

        const edits = Array.isArray(call.args.edits) ? call.args.edits : null;
        if (!edits && !hasSearchArgs) {
          throw new Error(
            'edits must be an array, or provide search+replace (aliases old_string+new_string)',
          );
        }
        if (hasEditsArg && !edits) {
          throw new Error(
            'edits must be an array, or provide search+replace (aliases old_string+new_string)',
          );
        }

        let searchReplaceArgs = null;
        if (hasSearchArgs) {
          const hasSearch = hasArg('search');
          const hasOldString = hasArg('old_string');
          const hasReplace = hasArg('replace');
          const hasNewString = hasArg('new_string');
          const search = hasSearch
            ? asString(call.args.search, 'search')
            : asString(call.args.old_string, 'old_string');
          const replace = hasReplace
            ? asString(call.args.replace, 'replace')
            : asString(call.args.new_string, 'new_string');

          if (
            (hasSearch &&
              hasOldString &&
              search !== asString(call.args.old_string, 'old_string')) ||
            (hasReplace && hasNewString && replace !== asString(call.args.new_string, 'new_string'))
          ) {
            return {
              ok: false,
              text: 'Ambiguous edit_file call: search/replace aliases contain conflicting values.',
              structuredError: {
                code: 'EDIT_AMBIGUOUS',
                message: 'search/replace aliases contain conflicting values',
                retryable: true,
              },
              meta: { path: filePath },
            };
          }
          if (hasArg('replace_all') && typeof call.args.replace_all !== 'boolean') {
            throw new Error('replace_all must be a boolean');
          }

          searchReplaceArgs = {
            search,
            replace,
            ...(hasArg('replace_all') ? { replace_all: call.args.replace_all } : {}),
          };
        }

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

        let appliedContent;
        let editCount;
        let warnings;
        let affectedLines;
        let successText;

        if (searchReplaceArgs) {
          const applied = applySearchReplace(before, searchReplaceArgs);
          if ('error' in applied) {
            const ambiguous = typeof applied.occurrences === 'number' && applied.occurrences > 1;
            return {
              ok: false,
              text: `Search/replace edit failed: ${applied.error}.`,
              structuredError: {
                code: ambiguous ? 'EDIT_AMBIGUOUS' : 'EDIT_NO_MATCH',
                message: applied.error,
                retryable: true,
              },
              meta: {
                path: filePath,
                version_before: versionBefore,
                ...(typeof applied.occurrences === 'number'
                  ? { occurrences: applied.occurrences }
                  : {}),
              },
            };
          }

          appliedContent = applied.content;
          editCount = applied.count;
          warnings = [];
          // Single forward pass over the result: matches arrive in ascending
          // resultStart order, so count newlines incrementally instead of
          // re-splitting the whole prefix per match (quadratic on large
          // replace_all runs). Dedupe so several matches on one line don't
          // repeat an identical context preview.
          {
            let lineNo = 1;
            let scanned = 0;
            const seen = new Set();
            affectedLines = [];
            for (const { resultStart } of applied.matches) {
              for (; scanned < resultStart; scanned += 1) {
                if (applied.content[scanned] === '\n') lineNo += 1;
              }
              if (!seen.has(lineNo)) {
                seen.add(lineNo);
                affectedLines.push(lineNo);
              }
            }
          }
          successText = `Applied search/replace edit to ${path.relative(workspaceRoot, filePath) || '.'} (${applied.count} ${applied.count === 1 ? 'occurrence' : 'occurrences'})`;
        } else {
          const applied = applyHashlineEdits(before, edits);
          appliedContent = applied.content;
          editCount = applied.applied.length;
          warnings = applied.warnings;
          affectedLines = applied.applied.map(({ line }) => line);
          successText = `Applied ${applied.applied.length} hashline edits to ${path.relative(workspaceRoot, filePath) || '.'}`;
        }

        // Backup only once the edit is definitely happening — a backup taken
        // before the validation/apply returns above would become the newest
        // .bak for this file, and undo_edit restores the newest match, so a
        // failed edit would shadow the backup of the last successful one.
        await backupFile(filePath, workspaceRoot);
        await fs.writeFile(filePath, appliedContent, 'utf8');
        const versionAfter = calculateContentVersion(appliedContent);

        // Build context preview around each edit site
        const afterLines = appliedContent.split('\n');
        const previews = affectedLines.map((line) => {
          const center = line - 1; // 0-indexed
          const start = Math.max(0, center - 3);
          const end = Math.min(afterLines.length, center + 4);
          return afterLines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}| ${l}`)
            .join('\n');
        });
        const previewText =
          previews.length > 0 ? `\n\nContext after edits:\n${previews.join('\n---\n')}` : '';
        const warningText =
          warnings.length > 0
            ? `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join('\n')}`
            : '';

        // Post-edit diagnostics loop (crush pattern) — same contract as the
        // write_file arm above.
        const editDiag = await runPostEditDiagnostics(workspaceRoot, filePath, {
          explicitEnabled:
            typeof options.postEditDiagnostics === 'boolean'
              ? options.postEditDiagnostics
              : undefined,
        });

        const editRelPath = path.relative(workspaceRoot, filePath) || '.';
        const editFileDiff = buildEditDiffMeta(editRelPath, before, appliedContent);
        return {
          ok: true,
          text: `${successText}${warningText}${previewText}${editDiag.note ?? ''}`,
          meta: {
            path: filePath,
            edits: editCount,
            version_before: versionBefore,
            version_after: versionAfter,
            warnings: warnings.length,
            ...(editDiag.meta ? { diagnostics: editDiag.meta } : {}),
            ...(editFileDiff ? { editDiff: editFileDiff } : {}),
            ...(editFileDiff ? { card: buildEditDiffToolCard(editFileDiff) } : {}),
          },
        };
      }

      case 'read_symbols': {
        const filePath = await ensureInsideWorkspace(
          workspaceRoot,
          asString(call.args.path, 'path'),
        );
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const symbols = [];
        lines.forEach((line, i) => {
          for (const { pat, kind } of SYMBOL_PATTERNS) {
            if (pat.test(line)) {
              symbols.push({ line: i + 1, kind, text: line.trim() });
              break;
            }
          }
        });
        const text =
          symbols.length > 0
            ? symbols.map((s) => `${s.line}| [${s.kind}] ${s.text}`).join('\n')
            : 'No symbols found';
        return {
          ok: true,
          text: truncateText(text),
          meta: { path: filePath, symbolCount: symbols.length },
        };
      }

      case 'read_symbol': {
        const filePath = await ensureInsideWorkspace(
          workspaceRoot,
          asString(call.args.path, 'path'),
        );
        const symbolName = asString(call.args.symbol, 'symbol').trim();
        if (!symbolName) throw new Error('symbol cannot be empty');
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');

        // Find all top-level symbol start positions (skip nested declarations)
        const symbolStarts: { line: number; name: string; kind: string; indent: number }[] = [];
        lines.forEach((line, i) => {
          for (const { pat, kind, nameGroup } of SYMBOL_PATTERNS) {
            const m = line.match(pat);
            if (m) {
              const indent = line.search(/\S/);
              symbolStarts.push({ line: i, name: m[nameGroup] || '', kind, indent });
              break;
            }
          }
        });

        // Find the target symbol
        const targetIdx = symbolStarts.findIndex((s) => s.name === symbolName);
        if (targetIdx === -1) {
          const available = symbolStarts
            .map((s) => s.name)
            .filter(Boolean)
            .join(', ');
          return {
            ok: false,
            text: `Symbol "${symbolName}" not found.${available ? ` Available: ${available}` : ''}`,
            structuredError: {
              code: 'SYMBOL_NOT_FOUND',
              message: `Symbol "${symbolName}" not found`,
              retryable: false,
            },
          };
        }

        const startLine = symbolStarts[targetIdx].line;
        const targetIndent = symbolStarts[targetIdx].indent;
        // End at next symbol at same or lesser indentation (skip nested declarations)
        let endLine = lines.length - 1;
        for (let j = targetIdx + 1; j < symbolStarts.length; j++) {
          if (symbolStarts[j].indent <= targetIndent) {
            endLine = symbolStarts[j].line - 1;
            break;
          }
        }

        // Trim trailing blank lines
        let actualEnd = endLine;
        while (actualEnd > startLine && lines[actualEnd].trim() === '') actualEnd--;

        const symbolLines = lines.slice(startLine, actualEnd + 1);
        const numbered = symbolLines.map((l, i) => `${startLine + i + 1}| ${l}`).join('\n');
        return {
          ok: true,
          text: truncateText(numbered),
          meta: {
            path: filePath,
            symbol: symbolName,
            kind: symbolStarts[targetIdx].kind,
            start_line: startLine + 1,
            end_line: actualEnd + 1,
            lines: actualEnd - startLine + 1,
          },
        };
      }

      case 'git_status': {
        try {
          const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], {
            cwd: workspaceRoot,
          });
          const lines = stdout.trim().split('\n');
          const branchLine = lines[0] || '';
          const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$/);
          const branch = branchMatch ? branchMatch[1] : 'unknown';
          const tracking = branchMatch ? branchMatch[2] || null : null;
          const aheadBehind = branchMatch?.[3] || null;
          const changes = lines
            .slice(1)
            .filter((l) => l.trim())
            .map((l) => {
              const xy = l.slice(0, 2);
              return {
                status: xy.trim(),
                path: l.slice(3),
                staged: xy[0] !== ' ' && xy[0] !== '?',
                unstaged: xy[1] !== ' ' && xy[1] !== '?',
              };
            });
          const staged = changes.filter((c) => c.staged);
          const unstaged = changes.filter((c) => c.unstaged);
          const untracked = changes.filter((c) => c.status === '??');

          // Build structured text for clearer agent reasoning
          const sections = [
            `Branch: ${branch}${tracking ? ` → ${tracking}` : ''}${aheadBehind ? ` [${aheadBehind}]` : ''}`,
          ];
          if (staged.length)
            sections.push(`Staged (${staged.length}): ${staged.map((c) => c.path).join(', ')}`);
          if (unstaged.length)
            sections.push(
              `Unstaged (${unstaged.length}): ${unstaged.map((c) => c.path).join(', ')}`,
            );
          if (untracked.length)
            sections.push(
              `Untracked (${untracked.length}): ${untracked.map((c) => c.path).join(', ')}`,
            );
          if (!changes.length) sections.push('Clean working tree');

          return {
            ok: true,
            text: sections.join('\n'),
            meta: {
              branch,
              tracking,
              aheadBehind,
              changedFiles: changes.length,
              staged: staged.length,
              unstaged: unstaged.length,
              untracked: untracked.length,
              card: buildGitStatusToolCard({
                repoPath: workspaceRoot,
                branch,
                statusLine: sections[0],
                changedFiles: changes.length,
                stagedFiles: staged.length,
                unstagedFiles: unstaged.length,
                untrackedFiles: untracked.length,
                preview: changes.map((change) => `${change.status} ${change.path}`),
              }),
            },
          };
        } catch (err) {
          return {
            ok: false,
            text: `git status failed: ${err.message}`,
            structuredError: { code: 'GIT_ERROR', message: err.message, retryable: false },
          };
        }
      }

      case 'git_diff': {
        const diffPath = call.args.path
          ? await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'))
          : null;
        const staged = call.args.staged === true;
        const gitArgs = ['diff', '--stat'];
        if (staged) gitArgs.push('--staged');
        if (diffPath) gitArgs.push('--', diffPath);
        try {
          // Get stat summary
          const { stdout: statOut } = await execFileAsync('git', gitArgs, {
            cwd: workspaceRoot,
            maxBuffer: 2_000_000,
          });
          // Get full diff
          const fullArgs = ['diff'];
          if (staged) fullArgs.push('--staged');
          if (diffPath) fullArgs.push('--', diffPath);
          const { stdout: diffOut } = await execFileAsync('git', fullArgs, {
            cwd: workspaceRoot,
            maxBuffer: 2_000_000,
          });

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
          const changedFileCount = (summaryLine.match(/(\d+) files? changed/) || [])[1];
          const totalFilesChanged = changedFileCount
            ? parseInt(changedFileCount, 10)
            : filesChanged.length;

          return {
            ok: true,
            text: truncateText(diffOut.trim() || 'No changes'),
            meta: {
              staged,
              path: diffPath,
              filesChanged: totalFilesChanged,
              insertions: insertions ? parseInt(insertions, 10) : 0,
              deletions: deletions ? parseInt(deletions, 10) : 0,
              files: filesChanged,
              card: buildDiffPreviewToolCard(diffOut.trim(), {
                filesChanged: totalFilesChanged,
                additions: insertions ? parseInt(insertions, 10) : 0,
                deletions: deletions ? parseInt(deletions, 10) : 0,
              }),
            },
          };
        } catch (err) {
          return {
            ok: false,
            text: `git diff failed: ${err.message}`,
            structuredError: { code: 'GIT_ERROR', message: err.message, retryable: false },
          };
        }
      }

      case 'git_commit': {
        const message = asString(call.args.message, 'message');
        const paths = Array.isArray(call.args.paths) ? call.args.paths : [];

        // This is a mutating operation — validate paths are inside workspace
        const resolvedPaths = await Promise.all(
          paths.map((p) => ensureInsideWorkspace(workspaceRoot, p)),
        );

        // Stage specified files, or all (excluding .push/ — sessions, backups,
        // internal state) if none specified, then commit — via the sanctioned
        // backend write.
        const addArgs =
          resolvedPaths.length > 0 ? ['--', ...resolvedPaths] : ['-A', '--', '.', ':!.push'];

        // Auditor commit gate (opt-out, default on). Resolved against the
        // per-surface setting (`options.auditorGate`) with `PUSH_AUDITOR_GATE`
        // override via the shared `lib/auditor-policy.ts` resolver, so CLI,
        // daemon, and web agree. When enabled, the gate runs the Auditor over
        // the staged diff before the commit lands (via PushGit's PreCommitGate
        // seam); UNSAFE blocks (interactive approval may override). When off,
        // the PushGit facade commits with no gate — same behavior as before.
        const gateEnabled = resolveAuditorGateEnabled({
          explicit: options.auditorGate,
          env: process.env[AUDITOR_GATE_ENV_VAR],
        });
        const preCommit = gateEnabled
          ? makeAuditorPreCommitGate({
              providerId: typeof options.providerId === 'string' ? options.providerId : '',
              model: typeof options.model === 'string' ? options.model : '',
              approvalFn: options.approvalFn,
              signal: options.signal,
              workspaceRoot,
              // Stage exactly what the commit will stage, then read the staged
              // diff. PushGit.commit re-runs `git add` with the same addArgs
              // (idempotent) before committing the index this produced.
              getStagedDiff: async () => {
                await execFileAsync('git', ['add', ...addArgs], { cwd: workspaceRoot });
                const { stdout } = await execFileAsync('git', ['diff', '--cached'], {
                  cwd: workspaceRoot,
                  maxBuffer: 16_000_000,
                });
                return stdout;
              },
            })
          : undefined;

        // No timeout for commit writes: slow pre-commit hooks, large staging
        // sets, or busy disks must not be killed (the prior direct execFile
        // flow was unbounded).
        const pushGit = createLocalPushGit(workspaceRoot, { timeoutMs: 0, preCommit });
        const commitOutcome = await pushGit.commit({ message, addArgs });

        if (commitOutcome.blocked) {
          const reason = commitOutcome.reason || 'commit blocked by pre-commit gate';
          return {
            ok: false,
            text: `[Auditor] Commit blocked. ${reason}\nChanges remain staged — address the issues and retry, or have the operator approve.`,
            structuredError: { code: 'AUDITOR_UNSAFE', message: reason, retryable: false },
          };
        }

        const commitResult = commitOutcome.result;
        if (!commitOutcome.ok || !commitResult) {
          const detail =
            commitResult?.stderr ||
            commitResult?.stdout ||
            commitResult?.error ||
            'git commit failed';
          return {
            ok: false,
            text: `git commit failed: ${detail}`,
            structuredError: { code: 'GIT_ERROR', message: detail, retryable: true },
          };
        }

        const sha = await createLocalGitBackend(workspaceRoot, { timeoutMs: 0 }).headSha({
          short: true,
        });
        const [identity, commitInfo] = await Promise.all([
          resolveWorkspaceIdentity(workspaceRoot),
          execFileAsync('git', ['show', '-s', '--format=%an%x00%cI', 'HEAD'], {
            cwd: workspaceRoot,
          }).catch(() => ({ stdout: '' })),
        ]);
        const [authorRaw, dateRaw] = String(commitInfo.stdout || '')
          .trim()
          .split('\0');
        const author = authorRaw || 'unknown';
        const date = dateRaw || new Date().toISOString();
        const committedSha = sha ?? 'unknown';
        return {
          ok: true,
          text: commitResult.stdout.trim(),
          meta: {
            sha: committedSha,
            message,
            filesStaged: resolvedPaths.length || 'all',
            card: buildCommitToolCard({
              repo: identity.repoFullName,
              sha: committedSha,
              message,
              author,
              date,
            }),
            // The gate ran for this commit. We don't assert 'safe' here: the
            // commit may have proceeded via an interactive UNSAFE override or
            // an empty-diff skip. The per-branch verdict lives in the
            // structured logs (auditor_gate_safe / _unsafe_overridden / etc.).
            ...(gateEnabled ? { auditorGate: 'enabled' } : {}),
          },
        };
      }

      // `create_branch` / `sandbox_create_branch` (registry/web names) fall
      // through to the CLI-native handler — mirrors the switch_branch aliases.
      case 'create_branch':
      case 'sandbox_create_branch':
      case 'git_create_branch': {
        const name = asString(call.args.name, 'name').trim();
        const from = typeof call.args.from === 'string' ? call.args.from.trim() : '';

        // Validate name + optional base ref via the shared helper (see
        // isInvalidGitRef). Both create and switch validate identically.
        if (isInvalidGitRef(name)) {
          return {
            ok: false,
            text: `Invalid branch name "${name}". ${GIT_REF_DETAIL}`,
            structuredError: {
              code: 'INVALID_ARG',
              message: 'Invalid branch name',
              retryable: false,
            },
          };
        }
        if (from && isInvalidGitRef(from)) {
          return {
            ok: false,
            text: `Invalid base ref "${from}". ${GIT_REF_DETAIL}`,
            structuredError: {
              code: 'INVALID_ARG',
              message: 'Invalid base ref',
              retryable: false,
            },
          };
        }

        // Atomic `checkout -b` (only moves HEAD on success) via the sanctioned
        // backend write. Unbounded timeout (the prior direct execFile flow had
        // none) so the write isn't killed on slow disks / large repos.
        const createResult = await createLocalGitBackend(workspaceRoot, {
          timeoutMs: 0,
        }).createBranch(name, from || undefined);
        if (!createResult.ok) {
          const detail =
            createResult.stderr ||
            createResult.stdout ||
            createResult.error ||
            'git create_branch failed';
          return {
            ok: false,
            text: `git create_branch failed: ${detail}`,
            structuredError: { code: 'GIT_ERROR', message: detail, retryable: false },
          };
        }
        return {
          ok: true,
          text: `Created and switched to ${name}${from ? ` from ${from}` : ''}.`,
          meta: { branch: name, from: from || null },
        };
      }

      // `switch_branch` (registry/web public name) and `sandbox_switch_branch`
      // (long-form alias) fall through to the CLI-native handler — mirrors the
      // `artifact` / `create_artifact` pairing. The capability gate already
      // canonicalized these via CLI_TOOL_ALIASES.
      case 'switch_branch':
      case 'sandbox_switch_branch':
      case 'git_switch_branch': {
        const branch = asString(call.args.branch, 'branch').trim();

        // Shared ref validation (see isInvalidGitRef). Branch-only (no path
        // operand), so the syntactic ambiguity that makes raw `git checkout
        // <x>` dangerous doesn't apply here.
        if (isInvalidGitRef(branch)) {
          return {
            ok: false,
            text: `Invalid branch name "${branch}". ${GIT_REF_DETAIL}`,
            structuredError: {
              code: 'INVALID_ARG',
              message: 'Invalid branch name',
              retryable: false,
            },
          };
        }

        // Sanctioned switch via the shared backend. `switchBranch` uses
        // `git switch` (branch-only — a path collision fails fast rather than a
        // silent path-mode checkout) with a depth-1 fetch fallback for shallow
        // clones that don't have the target branch locally yet. Unbounded
        // timeout so a slow fetch on a large/shallow repo isn't killed.
        const switchResult = await createLocalGitBackend(workspaceRoot, {
          timeoutMs: 0,
        }).switchBranch(branch);
        if (!switchResult.ok) {
          const detail =
            switchResult.stderr ||
            switchResult.stdout ||
            switchResult.error ||
            'git switch_branch failed';
          return {
            ok: false,
            text: `git switch_branch failed: ${detail}`,
            structuredError: { code: 'GIT_ERROR', message: detail, retryable: false },
          };
        }
        return {
          ok: true,
          text: `Switched to ${branch}.`,
          meta: { branch },
        };
      }

      case 'undo_edit': {
        const filePath = await ensureInsideWorkspace(
          workspaceRoot,
          asString(call.args.path, 'path'),
        );
        const backupDir = path.join(workspaceRoot, '.push', 'backups');
        // Flatten both separators — path.relative emits OS-native ones (backslash
        // on Windows), so matching only `/` would leave the separator in the name
        // and scatter backups into nested dirs instead of one flat backups/ folder.
        const relative = path.relative(workspaceRoot, filePath).replace(/[/\\]/g, '__');
        const prefix = `${relative}.`;

        let entries;
        try {
          entries = await fs.readdir(backupDir);
        } catch {
          return {
            ok: false,
            text: `No backups found for ${call.args.path}`,
            structuredError: {
              code: 'NO_BACKUP',
              message: 'Backup directory does not exist',
              retryable: false,
            },
          };
        }

        const matches = entries
          .filter((e) => e.startsWith(prefix) && e.endsWith('.bak'))
          .sort()
          .reverse();

        if (matches.length === 0) {
          return {
            ok: false,
            text: `No backups found for ${call.args.path}`,
            structuredError: {
              code: 'NO_BACKUP',
              message: 'No matching backup files',
              retryable: false,
            },
          };
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
        const memoryDir = path.join(workspaceRoot, '.push');
        await fs.mkdir(memoryDir, { recursive: true });

        // Structured entry: save_memory({type, content, tags?, files?})
        const entryType = typeof call.args.type === 'string' ? call.args.type.trim() : '';
        if (entryType) {
          const VALID_TYPES = ['decision', 'task', 'next', 'fact', 'blocker'];
          if (!VALID_TYPES.includes(entryType)) {
            return {
              ok: false,
              text: `Invalid memory type "${entryType}". Use one of: ${VALID_TYPES.join(', ')}`,
              structuredError: {
                code: 'INVALID_MEMORY_TYPE',
                message: `Invalid type: ${entryType}`,
                retryable: false,
              },
            };
          }
          const content = asString(call.args.content, 'content').slice(0, 500);
          const tags = Array.isArray(call.args.tags)
            ? call.args.tags.filter((t) => typeof t === 'string').slice(0, 5)
            : [];
          const files = Array.isArray(call.args.files)
            ? call.args.files.filter((f) => typeof f === 'string').slice(0, 10)
            : [];

          const memoryJsonPath = path.join(memoryDir, 'memory.json');
          let entries = [];
          try {
            const raw = await fs.readFile(memoryJsonPath, 'utf8');
            entries = JSON.parse(raw);
            if (!Array.isArray(entries)) entries = [];
          } catch {
            /* no existing file */
          }

          entries.push({ type: entryType, content, tags, files, date: new Date().toISOString() });
          // Keep max 50 entries, drop oldest
          if (entries.length > 50) entries = entries.slice(-50);
          await fs.writeFile(memoryJsonPath, JSON.stringify(entries, null, 2), 'utf8');
          return {
            ok: true,
            text: `Memory entry saved (${entryType}: ${content.slice(0, 60)}…). ${entries.length} total entries.`,
            meta: { path: memoryJsonPath, type: entryType, totalEntries: entries.length },
          };
        }

        // Legacy: free-text save_memory({content})
        const content = asString(call.args.content, 'content');
        const memoryPath = path.join(memoryDir, 'memory.md');
        await fs.writeFile(memoryPath, content, 'utf8');
        return {
          ok: true,
          text: `Memory saved (${content.length} chars). Will be loaded into system prompt on next session.`,
          meta: { path: memoryPath, chars: content.length },
        };
      }

      // Both the canonical name (`create_artifact`) and the public alias
      // (`artifact`, advertised in lib/tool-registry.ts → exampleJson)
      // dispatch here. The CLI executor doesn't run callers through
      // resolveToolName so without this fallthrough a model emitting
      // the advertised public name would hit the "unknown tool" path.
      case 'artifact':
      case 'create_artifact': {
        // Defense in depth: today the Coder/Explorer kernel detectors
        // filter out non-sandbox sources before they reach this
        // executor, so the role check below is unreachable on the
        // normal path. The check still belongs here in case a future
        // entry point bypasses that filter — without it, a Coder-
        // emitted artifact would be persisted and misattributed as
        // orchestrator. Pair this with options.role plumbing in
        // pushd.ts when the Coder grant lands.
        const role: AgentRole =
          typeof options.role === 'string' && isAgentRole(options.role)
            ? options.role
            : 'orchestrator';
        if (!roleCanUseTool(role, 'create_artifact', CLI_EXECUTION_MODE)) {
          return {
            ok: false,
            text: `Role "${role}" cannot create artifacts. Required capability: artifacts:write.`,
            structuredError: {
              code: 'CAPABILITY_DENIED',
              message: `Role "${role}" lacks artifacts:write capability.`,
              retryable: false,
            },
          };
        }

        // Validate the model-supplied args. Failure maps to the
        // structuredError envelope shape the CLI uses elsewhere so the
        // model can recover with a fixed payload rather than retrying
        // a malformed call repeatedly.
        const validation = validateCreateArtifactArgs(call.args);
        if (!validation.ok) {
          return {
            ok: false,
            text: `Cannot create artifact (${validation.code} on ${validation.field}): ${validation.message}`,
            structuredError: {
              code: validation.code,
              message: validation.message,
              retryable: false,
            },
          };
        }

        // Resolve the durable scope — repoFullName + branch via git.
        // CLI sessions don't have a chatId, so the artifact files under
        // the branch-scoped key (per the user's decision in the design
        // round). Web callers pass chatId through the (future) Worker
        // path and hit the chat-scoped key.
        const identity = await resolveWorkspaceIdentity(workspaceRoot);
        const scope: ArtifactScope = {
          repoFullName: identity.repoFullName,
          branch: identity.branch,
        };

        const author: ArtifactAuthor = {
          surface: 'cli',
          role,
          runId: typeof options.runId === 'string' ? options.runId : undefined,
          createdAt: Date.now(),
        };

        // Wrap construction + persistence so a transient FS error
        // (disk full, EACCES, race on tempdir cleanup) becomes a
        // retryable structured error instead of an uncaught throw the
        // engine has no envelope for.
        try {
          const record = buildArtifactRecord(validation.args, { scope, author });
          const store = new CliFlatJsonArtifactStore();
          await store.put(record);

          return {
            ok: true,
            text: summarizeArtifact(record),
            meta: {
              artifactId: record.id,
              kind: record.kind,
              scope,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            text: `Failed to persist artifact: ${message}`,
            structuredError: {
              code: 'ARTIFACT_PERSIST_FAILED',
              message,
              retryable: true,
            },
          };
        }
      }

      case 'lsp_diagnostics': {
        const specificPath = call.args.path
          ? await ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'))
          : null;
        const result = await runDiagnostics(workspaceRoot, specificPath);

        if (result.error) {
          return {
            ok: false,
            text: `Diagnostics error: ${result.error.message}`,
            structuredError: {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
            },
            meta: {
              projectType: result.projectType,
              card: buildTypeCheckToolCard({
                tool:
                  result.projectType === 'typescript'
                    ? 'tsc'
                    : result.projectType === 'python'
                      ? 'pyright'
                      : 'unknown',
                diagnostics: [],
                exitCode: 1,
                errorCount: 1,
              }),
            },
          };
        }

        const { diagnostics, projectType } = result;

        if (diagnostics.length === 0) {
          return {
            ok: true,
            text: `No diagnostics found (${projectType} project).`,
            meta: {
              projectType,
              errors: 0,
              warnings: 0,
              card: buildTypeCheckToolCard({
                tool:
                  projectType === 'typescript'
                    ? 'tsc'
                    : projectType === 'python'
                      ? 'pyright'
                      : 'unknown',
                diagnostics: [],
                exitCode: 0,
              }),
            },
          };
        }

        const errors = diagnostics.filter((d) => d.severity === 'error');
        const warnings = diagnostics.filter((d) => d.severity === 'warning');

        // Format diagnostics for readable output
        const formatted = diagnostics
          .slice(0, 50) // Limit to first 50 to avoid flooding context
          .map(
            (d) =>
              `${d.file}:${d.line}:${d.col} [${d.severity}] ${d.code ? `(${d.code}) ` : ''}${d.message}`,
          )
          .join('\n');

        const moreMsg =
          diagnostics.length > 50 ? `\n\n...and ${diagnostics.length - 50} more issues` : '';

        return {
          ok: true,
          text: `Found ${errors.length} error(s) and ${warnings.length} warning(s) in ${projectType} project:\n\n${formatted}${moreMsg}`,
          meta: {
            projectType,
            errors: errors.length,
            warnings: warnings.length,
            total: diagnostics.length,
            diagnostics: diagnostics.slice(0, 50), // Include structured data for programmatic use
            card: buildTypeCheckToolCard({
              tool:
                projectType === 'typescript'
                  ? 'tsc'
                  : projectType === 'python'
                    ? 'pyright'
                    : 'unknown',
              diagnostics,
              exitCode: errors.length > 0 ? 1 : 0,
            }),
          },
        };
      }

      default:
        return {
          ok: false,
          text: `Unknown tool: ${call.tool}. Available: read_file, list_dir, search_files, web_search, fetch_url, exec, exec_start, exec_poll, exec_write, exec_stop, exec_list_sessions, write_file, edit_file, undo_edit, read_symbols, read_symbol, git_status, git_diff, git_commit, git_create_branch, git_switch_branch, save_memory, lsp_diagnostics${hasEnvGitHubToken() ? `, and GitHub tools (${[...GITHUB_PUBLIC_TOOL_NAMES].join(', ')})` : ''}`,
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
