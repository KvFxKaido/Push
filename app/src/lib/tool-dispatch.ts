/**
 * Unified tool dispatch — wraps both GitHub and Sandbox tool
 * detection/execution behind a single interface.
 *
 * This keeps useChat.ts clean: it calls detectAnyToolCall() once
 * and gets back the right type, then executeAnyToolCall() routes
 * to the correct implementation.
 */

import type { ToolExecutionResult, AcceptanceCriterion, StructuredToolError } from '@/types';
import { detectToolCall, executeToolCall, type ToolCall } from './github-tools';
import { detectSandboxToolCall, executeSandboxToolCall, getUnrecognizedSandboxToolName, IMPLEMENTED_SANDBOX_TOOLS, type SandboxToolCall } from './sandbox-tools';
import { detectScratchpadToolCall, type ScratchpadToolCall } from './scratchpad-tools';
import { detectWebSearchToolCall, executeWebSearch, type WebSearchToolCall } from './web-search-tools';
import { detectAskUserToolCall, type AskUserToolCall } from './ask-user-tools';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
import { execInSandbox } from './sandbox-client';
import { asRecord, detectToolFromText, extractBareToolJsonObjects, repairToolJson, detectTruncatedToolCall, diagnoseJsonSyntaxError } from './utils';

// Re-export for backwards compatibility — other modules import from here
export { extractBareToolJsonObjects };

// ---------------------------------------------------------------------------
// Parallel read-only tool detection
// ---------------------------------------------------------------------------

export const PARALLEL_READ_ONLY_GITHUB_TOOLS = new Set([
  'fetch_pr', 'list_prs', 'list_commits', 'read_file', 'list_directory',
  'list_branches', 'fetch_checks', 'search_files', 'list_commit_files',
  'get_workflow_runs', 'get_workflow_logs', 'check_pr_mergeable', 'find_existing_pr',
]);

export const PARALLEL_READ_ONLY_SANDBOX_TOOLS = new Set([
  'sandbox_read_file', 'sandbox_search', 'sandbox_list_dir', 'sandbox_diff',
]);

export const MAX_PARALLEL_TOOL_CALLS = 6;

/** Check whether a tool call is read-only (safe for parallel execution). */
export function isReadOnlyToolCall(toolCall: AnyToolCall): boolean {
  if (toolCall.source === 'github') {
    return PARALLEL_READ_ONLY_GITHUB_TOOLS.has(toolCall.call.tool);
  }
  if (toolCall.source === 'sandbox') {
    return PARALLEL_READ_ONLY_SANDBOX_TOOLS.has(toolCall.call.tool);
  }
  return false;
}

/** Result of scanning a response for all tool calls. */
export interface DetectedToolCalls {
  /** Read-only calls that can safely execute in parallel. */
  readOnly: AnyToolCall[];
  /** Optional trailing mutating call that must execute after reads. */
  mutating: AnyToolCall | null;
}

/**
 * Scan assistant output for ALL tool calls — reads + optional trailing mutation.
 * Returns the read-only calls (parallelizable) and the last mutating call (if any).
 * Falls back to single-call detection if only one call is found.
 */
export function detectAllToolCalls(text: string): DetectedToolCalls {
  const explicitToolObjects = extractBareToolJsonObjects(text);
  if (explicitToolObjects.length === 0) return { readOnly: [], mutating: null };

  // Preserve current safety behavior: only do broad bare-object scanning
  // when the response already contains at least one explicit tool wrapper.
  const parsedObjects = extractAllBareJsonObjects(text);
  if (parsedObjects.length === 0) return { readOnly: [], mutating: null };

  const allCalls: AnyToolCall[] = [];
  const seen = new Set<string>();

  for (const parsed of parsedObjects) {
    const serialized = JSON.stringify(parsed);
    const call = detectAnyToolCall(serialized);
    if (!call) continue;
    const key = getCanonicalInvocationKey(call);
    if (seen.has(key)) continue;
    seen.add(key);
    allCalls.push(call);
    if (allCalls.length > MAX_PARALLEL_TOOL_CALLS + 1) break; // +1 for possible trailing mutation
  }

  if (allCalls.length === 0) return { readOnly: [], mutating: null };

  // Single call — classify as read or mutation
  if (allCalls.length === 1) {
    if (isReadOnlyToolCall(allCalls[0])) {
      return { readOnly: allCalls, mutating: null };
    }
    return { readOnly: [], mutating: allCalls[0] };
  }

  // Multiple calls — split into reads + optional trailing mutation.
  // Strategy: collect the longest valid prefix of read-only calls,
  // then accept one trailing mutation. If a mutation appears mid-sequence,
  // treat it as the boundary — keep the reads before it and the mutation,
  // but discard anything after.
  const readOnly: AnyToolCall[] = [];
  let mutating: AnyToolCall | null = null;

  for (let i = 0; i < allCalls.length; i++) {
    if (isReadOnlyToolCall(allCalls[i])) {
      if (mutating) {
        // Read after a mutation — stop here (don't process further calls)
        break;
      }
      readOnly.push(allCalls[i]);
    } else {
      if (mutating) {
        // Second mutation — stop here, keep what we have
        break;
      }
      mutating = allCalls[i];
    }
  }

  // Cap parallel reads — truncate to the limit instead of bailing entirely
  if (readOnly.length > MAX_PARALLEL_TOOL_CALLS) {
    readOnly.length = MAX_PARALLEL_TOOL_CALLS;
  }

  return { readOnly, mutating };
}

/** Extract the tool name from a unified tool call. */
function getToolCallName(toolCall: AnyToolCall): string {
  switch (toolCall.source) {
    case 'github': return toolCall.call.tool;
    case 'sandbox': return toolCall.call.tool;
    case 'delegate': return 'delegate_coder';
    case 'scratchpad': return toolCall.call.tool;
    case 'web-search': return 'web_search';
    default: return 'unknown';
  }
}

/**
 * Build a canonical key for deduping logically-identical tool invocations.
 * Uses stable-key JSON serialization so key order differences do not matter.
 */
function getCanonicalInvocationKey(toolCall: AnyToolCall): string {
  const canonical: CanonicalToolInvocation = {
    source: toolCall.source,
    toolName: getToolCallName(toolCall),
    args: getToolCallArgs(toolCall),
  };
  return `${canonical.source}:${canonical.toolName}:${stableJsonStringify(canonical.args)}`;
}

interface CanonicalToolInvocation {
  source: AnyToolCall['source'];
  toolName: string;
  args: unknown;
}

/** Build a normalized arg payload for canonical invocation dedupe. */
function getToolCallArgs(toolCall: AnyToolCall): unknown {
  switch (toolCall.source) {
    case 'github':
    case 'sandbox':
    case 'delegate':
    case 'web-search':
      return toolCall.call.args;
    case 'scratchpad':
      return { tool: toolCall.call.tool, content: toolCall.call.content };
    default:
      return {};
  }
}

/**
 * Stable JSON stringify: recursively sorts object keys and drops undefined
 * object properties so logically-equivalent payloads produce the same key.
 */
function stableJsonStringify(value: unknown): string {
  const normalized = normalizeJsonValue(value);
  return JSON.stringify(normalized === undefined ? null : normalized);
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = normalizeJsonValue(item);
      // Mirror JSON.stringify behavior for arrays: undefined -> null.
      return normalized === undefined ? null : normalized;
    });
  }
  if (typeof value === 'object') {
    const record = asRecord(value);
    if (!record) return undefined;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const normalized = normalizeJsonValue(record[key]);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  // Functions/symbols/bigints are not valid JSON values.
  return undefined;
}

export type AnyToolCall =
  | { source: 'github'; call: ToolCall }
  | { source: 'sandbox'; call: SandboxToolCall }
  | { source: 'delegate'; call: { tool: 'delegate_coder'; args: { task?: string; tasks?: string[]; files?: string[]; acceptanceCriteria?: AcceptanceCriterion[] } } }
  | { source: 'scratchpad'; call: ScratchpadToolCall }
  | { source: 'web-search'; call: WebSearchToolCall }
  | { source: 'ask-user'; call: AskUserToolCall };

/**
 * Scan assistant output for any tool call (GitHub, Sandbox, Scratchpad, or delegation).
 * Returns the first match, or null if no tool call is detected.
 */
export function detectAnyToolCall(text: string): AnyToolCall | null {
  // Check for delegate_coder first (it's a special dispatch, not a repo tool)
  const delegateMatch = detectDelegateCoder(text);
  if (delegateMatch) return delegateMatch;

  // Check scratchpad tools (set_scratchpad, append_scratchpad)
  const scratchpadCall = detectScratchpadToolCall(text);
  if (scratchpadCall) return { source: 'scratchpad', call: scratchpadCall };

  // Check web search tool
  const webSearchCall = detectWebSearchToolCall(text);
  if (webSearchCall) return { source: 'web-search', call: webSearchCall };

  // Check ask_user tool
  const askUserCall = detectAskUserToolCall(text);
  if (askUserCall) return { source: 'ask-user', call: askUserCall };

  // Check sandbox tools (sandbox_ prefix)
  const sandboxCall = detectSandboxToolCall(text);
  if (sandboxCall) return { source: 'sandbox', call: sandboxCall };

  // Check GitHub tools
  const githubCall = detectToolCall(text);
  if (githubCall) return { source: 'github', call: githubCall };

  // Last resort: try to recover bare JSON args (missing {"tool":..,"args":..} wrapper).
  // Some models emit just the arguments object without the required wrapper format.
  const recovered = tryRecoverBareToolArgs(text);
  if (recovered) return recovered;

  return null;
}

/** Tools that modify the main branch (commit/push). Blocked when Protect Main is active. */
const PROTECTED_MAIN_TOOLS = new Set(['sandbox_prepare_commit', 'sandbox_push']);

/**
 * Check the current git branch in the sandbox. Returns the branch name or null on error.
 */
async function getSandboxBranch(sandboxId: string): Promise<string | null> {
  try {
    const result = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
    if (result.exitCode === 0 && result.stdout?.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Best-effort — fail-safe (return null → will block)
  }
  return null;
}

/**
 * Execute a detected tool call through the appropriate handler.
 *
 * Note: 'scratchpad' and 'delegate' tools are handled at a higher level (useChat),
 * not here. They're detected here but executed in the chat hook.
 *
 * @param isMainProtected — when true, commit/push tools on the default branch are blocked.
 * @param defaultBranch — the repo's default branch name (e.g. 'main', 'master').
 */
export async function executeAnyToolCall(
  toolCall: AnyToolCall,
  allowedRepo: string,
  sandboxId: string | null,
  isMainProtected?: boolean,
  defaultBranch?: string,
  activeProvider?: ActiveProvider,
): Promise<ToolExecutionResult> {
  // Enforce Protect Main: block commit/push tools when on the default branch
  if (isMainProtected && toolCall.source === 'sandbox' && PROTECTED_MAIN_TOOLS.has(toolCall.call.tool) && sandboxId) {
    const currentBranch = await getSandboxBranch(sandboxId);
    const mainBranches = new Set(['main', 'master']);
    if (defaultBranch) mainBranches.add(defaultBranch);
    // Block if we can't determine the branch (fail-safe) or if we're on the default branch
    if (!currentBranch || mainBranches.has(currentBranch)) {
      return {
        text: `[Tool Error] Protect Main is enabled. Commits and pushes to the main/default branch are blocked. Create a new branch first (e.g. sandbox_exec with "git checkout -b feature/my-change"), then retry.`,
      };
    }
  }

  switch (toolCall.source) {
    case 'github':
      return executeToolCall(toolCall.call, allowedRepo);

    case 'sandbox':
      if (!sandboxId) {
        const err: StructuredToolError = {
          type: 'SANDBOX_UNREACHABLE',
          retryable: true,
          message: 'No active sandbox session',
          detail: `Attempted tool: ${toolCall.call.tool}`,
        };
        return {
          text: `[Tool Error] No active sandbox. The sandbox may still be starting — wait a moment and retry. If this persists, the user needs to start a sandbox from the UI.\nerror_type: ${err.type}\nretryable: ${err.retryable}`,
          structuredError: err,
        };
      }
      return executeSandboxToolCall(toolCall.call, sandboxId);

    case 'delegate':
      // Delegation is handled at a higher level (useChat), not here.
      // Return a placeholder — useChat intercepts this before it reaches here.
      return { text: '[Tool Error] Delegation must be handled by the chat hook.' };

    case 'scratchpad':
      // Scratchpad is handled at a higher level (useChat), not here.
      // Return a placeholder — useChat intercepts this before it reaches here.
      return { text: '[Tool Error] Scratchpad must be handled by the chat hook.' };

    case 'web-search': {
      // Route through unified search: Tavily (if key set) → provider-native → DuckDuckGo free
      const provider = activeProvider || getActiveProvider();
      return executeWebSearch(toolCall.call.args.query, provider);
    }

    case 'ask-user':
      return {
        text: '[Tool Result] Question sent to user. The system will wait for their response.',
        card: { type: 'ask-user', data: toolCall.call.args }
      };

    default:
      return { text: '[Tool Error] Unknown tool source.' };
  }
}

/**
 * Check if text contains a tool call for a tool that exists with the sandbox_ prefix
 * but is not actually implemented. Returns the tool name, or null if no such tool found.
 * Used by useChat to inject a specific "tool does not exist" error message.
 */
export function detectUnimplementedToolCall(text: string): string | null {
  return getUnrecognizedSandboxToolName(text);
}

// ---------------------------------------------------------------------------
// Known tool names — union of all tool subsystems
// ---------------------------------------------------------------------------

const GITHUB_TOOL_NAMES = new Set([
  'fetch_pr', 'list_prs', 'list_commits', 'read_file', 'grep_file', 'list_directory',
  'list_branches', 'fetch_checks', 'search_files', 'list_commit_files',
  'trigger_workflow', 'get_workflow_runs', 'get_workflow_logs',
  'create_branch', 'create_pr', 'merge_pr', 'delete_branch',
  'check_pr_mergeable', 'find_existing_pr',
]);

const OTHER_TOOL_NAMES = new Set([
  'delegate_coder', 'set_scratchpad', 'append_scratchpad', 'read_scratchpad', 'web_search', 'ask_user',
]);

export const KNOWN_TOOL_NAMES = new Set([
  ...IMPLEMENTED_SANDBOX_TOOLS,
  ...GITHUB_TOOL_NAMES,
  ...OTHER_TOOL_NAMES,
]);

// ---------------------------------------------------------------------------
// Tool source resolution — maps a tool name to its subsystem source
// ---------------------------------------------------------------------------

export function getToolSource(toolName: string | null): AnyToolCall['source'] {
  if (!toolName) return 'sandbox';
  if (GITHUB_TOOL_NAMES.has(toolName)) return 'github';
  if (IMPLEMENTED_SANDBOX_TOOLS.has(toolName)) return 'sandbox';
  if (toolName === 'delegate_coder') return 'delegate';
  if (toolName === 'web_search') return 'web-search';
  if (toolName === 'ask_user') return 'ask-user';
  if (['set_scratchpad', 'append_scratchpad', 'read_scratchpad'].includes(toolName)) return 'scratchpad';
  if (toolName === 'ask_user') return 'ask-user';
  return 'sandbox'; // Fallback
}

// ---------------------------------------------------------------------------
// Diagnosis result type
// ---------------------------------------------------------------------------

export interface ToolCallDiagnosis {
  reason: 'truncated' | 'validation_failed' | 'malformed_json' | 'natural_language_intent';
  toolName: string | null;
  errorMessage: string;
  source?: AnyToolCall['source'];
  /** When true, record the metric but do not inject an error or trigger a retry. */
  telemetryOnly?: boolean;
}

// ---------------------------------------------------------------------------
// diagnoseToolCallFailure — replaces detectMalformedToolAttempt
// Three-phase check, only runs when detectAnyToolCall returned null.
// ---------------------------------------------------------------------------

/**
 * Diagnose why a tool call was not detected. Returns a specific error
 * message if the text looks like a failed tool call attempt, or null
 * if the text is genuinely not a tool call.
 */
export function diagnoseToolCallFailure(text: string): ToolCallDiagnosis | null {
  // Phase 1: Truncation — JSON cut off mid-stream
  const truncated = detectTruncatedToolCall(text);
  if (truncated) {
    return {
      reason: 'truncated',
      toolName: truncated.toolName,
      source: getToolSource(truncated.toolName),
      errorMessage: `Your tool call for "${truncated.toolName}" was truncated (JSON cut off). Please retry with the complete JSON block.`,
    };
  }

  // Phase 2: Validation failure — JSON parses (or repairs), has a known tool name,
  // but the subsystem validator rejected it (wrong/missing args)
  const fenceRegex = /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const toolName = extractKnownToolName(fenceMatch[1].trim());
    if (toolName) {
      return {
        reason: 'validation_failed',
        toolName,
        errorMessage: buildValidationErrorMessage(toolName),
        source: getToolSource(toolName),
      };
    }
  }

  for (const parsed of extractBareToolJsonObjects(text)) {
    const obj = asRecord(parsed);
    if (obj && typeof obj.tool === 'string' && KNOWN_TOOL_NAMES.has(obj.tool)) {
      return {
        reason: 'validation_failed',
        toolName: obj.tool,
        errorMessage: buildValidationErrorMessage(obj.tool),
        source: getToolSource(obj.tool),
      };
    }
  }

  // Phase 3: Malformed JSON — the text contains something that looks like a tool call
  // (has "tool": "<known_name>" or similar) but is structurally broken JSON that
  // repair couldn't fix. Return a specific syntax-error diagnosis so the model
  // gets actionable feedback like "missing opening brace" instead of silence.
  const malformedDiagnosis = diagnoseMalformedToolJson(text);
  if (malformedDiagnosis) return malformedDiagnosis;

  // Phase 3.5: Bare JSON args — telemetry only. Records the metric so we can track
  // how often models emit bare args, but does NOT trigger a retry (too imprecise).
  const bareObjects = extractAllBareJsonObjects(text);
  for (const obj of bareObjects) {
    if (typeof obj.tool === 'string') continue; // already handled by earlier phases
    const inferred = inferToolFromArgs(obj);
    if (inferred) {
      return {
        reason: 'validation_failed',
        toolName: inferred,
        errorMessage: `Your response contains what looks like "${inferred}" arguments but is missing the required wrapper format. Use this structure:\n\n`
          + '```json\n'
          + `{"tool": "${inferred}", "args": ${JSON.stringify(obj)}}\n`
          + '```\n\n'
          + 'Always wrap tool calls in {"tool": "...", "args": {...}} format.',
        telemetryOnly: true,
      };
    }
  }

  // Phase 4: Natural language tool intent — actionable. These are high-signal
  // cases ("I'll use sandbox_exec...") where the model clearly intended a tool
  // call but emitted prose instead of JSON; return a diagnosis so the caller can
  // inject a correction and retry.
  const nlIntent = detectNaturalLanguageToolIntent(text);
  if (nlIntent) return nlIntent;

  return null;
}

// ---------------------------------------------------------------------------
// Arg hints for common tools — shown in validation error messages
// ---------------------------------------------------------------------------

const TOOL_ARG_HINTS: Record<string, string> = {
  // GitHub tools
  read_file: '{"tool": "read_file", "args": {"repo": "owner/name", "path": "path/to/file"}}',
  list_directory: '{"tool": "list_directory", "args": {"repo": "owner/name", "path": "optional/path"}}',
  search_files: '{"tool": "search_files", "args": {"repo": "owner/name", "query": "search term"}}',
  grep_file: '{"tool": "grep_file", "args": {"repo": "owner/name", "path": "path/to/file", "pattern": "regex"}}',
  fetch_pr: '{"tool": "fetch_pr", "args": {"repo": "owner/name", "pr": 123}}',
  list_prs: '{"tool": "list_prs", "args": {"repo": "owner/name"}}',
  list_commits: '{"tool": "list_commits", "args": {"repo": "owner/name"}}',
  list_branches: '{"tool": "list_branches", "args": {"repo": "owner/name"}}',
  fetch_checks: '{"tool": "fetch_checks", "args": {"repo": "owner/name", "ref": "branch-or-sha"}}',
  create_branch: '{"tool": "create_branch", "args": {"repo": "owner/name", "branch_name": "feature/x"}}',
  create_pr: '{"tool": "create_pr", "args": {"repo": "owner/name", "title": "PR title", "body": "description", "head": "feature-branch", "base": "main"}}',
  // Sandbox tools
  sandbox_exec: '{"tool": "sandbox_exec", "args": {"command": "your command"}}',
  sandbox_read_file: '{"tool": "sandbox_read_file", "args": {"path": "/workspace/path/to/file"}}',
  sandbox_write_file: '{"tool": "sandbox_write_file", "args": {"path": "/workspace/path/to/file", "content": "file content"}}',
  sandbox_edit_file: '{"tool": "sandbox_edit_file", "args": {"path": "/workspace/path/to/file", "edits": [{"op": "replace_line", "ref": "abc1234", "content": "replacement"}]}}',
  sandbox_list_dir: '{"tool": "sandbox_list_dir", "args": {"path": "/workspace"}}',
  sandbox_search: '{"tool": "sandbox_search", "args": {"query": "search term"}}',
  sandbox_diff: '{"tool": "sandbox_diff", "args": {}}',
  sandbox_prepare_commit: '{"tool": "sandbox_prepare_commit", "args": {"message": "commit message"}}',
  sandbox_push: '{"tool": "sandbox_push", "args": {}}',
  delegate_coder: '{"tool": "delegate_coder", "args": {"task": "describe the task"}}',
  web_search: '{"tool": "web_search", "args": {"query": "search query"}}',
  ask_user: '{"tool": "ask_user", "args": {"question": "...?", "options": [{"id": "1", "label": "..."}]}}',
};

/** Build an actionable validation error message, including arg hints when available. */
function buildValidationErrorMessage(toolName: string): string {
  const hint = TOOL_ARG_HINTS[toolName];
  if (hint) {
    return `Your call to "${toolName}" has invalid or missing arguments. Expected format:\n\n`
      + '```json\n'
      + `${hint}\n`
      + '```\n\n'
      + 'Check required fields and retry.';
  }
  return `Your call to "${toolName}" has invalid or missing arguments. Check the tool protocol and retry with the correct argument format.`;
}

// ---------------------------------------------------------------------------
// Phase 3: Malformed JSON diagnosis — catches structurally broken tool calls
// that repair couldn't fix and returns a pinpointed syntax error.
// ---------------------------------------------------------------------------

/**
 * Scan text for fragments that look like tool calls (contain `"tool": "<known_name>"`)
 * but are structurally broken JSON. Uses `diagnoseJsonSyntaxError()` to pinpoint
 * the specific problem (missing brace, unterminated string, unbalanced brackets, etc.).
 *
 * Returns a diagnosis with `reason: 'malformed_json'` and an actionable error message,
 * or null if no such fragment is found.
 */
function diagnoseMalformedToolJson(text: string): ToolCallDiagnosis | null {
  // Strategy: find regions of text that contain a known tool name in a
  // tool-call-like pattern but failed to parse. We look for:
  //   1. Fenced code blocks containing tool-like content that isn't valid JSON
  //   2. Bare text containing `"tool": "<name>"` patterns outside valid JSON

  // Check fenced blocks first (higher signal)
  const fenceRegex = /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const content = fenceMatch[1].trim();
    const diagnosis = tryDiagnoseFragment(content);
    if (diagnosis) return diagnosis;
  }

  // Check for bare tool-call-like patterns in the text
  // Match regions that contain "tool": "<name>" (with various quoting styles)
  const toolPattern = /["']?tool["']?\s*:\s*["'](\w+)["']/g;
  let toolMatch;
  while ((toolMatch = toolPattern.exec(text)) !== null) {
    const toolName = toolMatch[1];
    if (!KNOWN_TOOL_NAMES.has(toolName)) continue;

    // Skip matches inside inline code (backticks) — these are explanatory prose
    if (isInsideInlineCode(text, toolMatch.index)) continue;

    // Extract a reasonable region around this match (find enclosing braces or context)
    const regionStart = findPrecedingBrace(text, toolMatch.index);
    const regionEnd = findFollowingBrace(text, toolMatch.index + toolMatch[0].length);

    // Skip if no preceding '{' was found (match is in plain prose, not a JSON fragment)
    if (regionStart === toolMatch.index) continue;

    const region = text.slice(regionStart, regionEnd + 1);

    // Skip if this region is already valid JSON (handled by earlier phases)
    try { JSON.parse(region); continue; } catch { /* expected — this is broken JSON */ }

    // Skip if repair succeeds (handled by normal detection pipeline)
    if (repairToolJson(region)) continue;

    const diagnosis = tryDiagnoseFragment(region);
    if (diagnosis) return diagnosis;
  }

  return null;
}

/**
 * Try to diagnose a single text fragment as malformed tool JSON.
 * Returns a diagnosis or null if the fragment isn't recognizable as a tool call.
 */
function tryDiagnoseFragment(fragment: string): ToolCallDiagnosis | null {
  // Skip if it parses cleanly
  try { JSON.parse(fragment); return null; } catch { /* expected */ }

  // Skip if repair succeeds (the normal pipeline will handle it)
  if (repairToolJson(fragment)) return null;

  // Extract tool name from the fragment
  const nameMatch = fragment.match(/["']?tool["']?\s*:\s*["'](\w+)["']/);
  if (!nameMatch) return null;
  const toolName = nameMatch[1];
  if (!KNOWN_TOOL_NAMES.has(toolName)) return null;

  // Get the specific syntax error
  const syntaxError = diagnoseJsonSyntaxError(fragment);
  if (!syntaxError) return null;

  const hint = TOOL_ARG_HINTS[toolName];
  const hintBlock = hint
    ? `\n\nExpected format:\n\`\`\`json\n${hint}\n\`\`\``
    : '';

  return {
    reason: 'malformed_json',
    toolName,
    errorMessage: `Your call to "${toolName}" has a JSON syntax error: ${syntaxError.message}${hintBlock}\n\nPlease output a valid JSON block with balanced braces and proper quoting.`,
    source: getToolSource(toolName),
  };
}

/**
 * Check if position `pos` in `text` is inside an inline code span (single backticks).
 * Counts unescaped backticks before the position — odd count means inside inline code.
 * Ignores fenced code blocks (triple backticks) which are handled separately.
 */
function isInsideInlineCode(text: string, pos: number): boolean {
  let backtickCount = 0;
  for (let i = 0; i < pos; i++) {
    if (text[i] === '`') {
      // Skip fenced code blocks (triple backticks)
      if (text[i + 1] === '`' && text[i + 2] === '`') {
        const closeIdx = text.indexOf('```', i + 3);
        if (closeIdx !== -1 && closeIdx < pos) {
          i = closeIdx + 2; // Skip past closing fence
          continue;
        }
        return false; // Inside a fenced block — handled by the fenced block scanner
      }
      backtickCount++;
    }
  }
  return backtickCount % 2 === 1;
}

/**
 * Find the position of the nearest `{` before `pos` in text (for region extraction).
 * Returns `pos` if no preceding brace is found within a reasonable distance.
 */
function findPrecedingBrace(text: string, pos: number): number {
  const searchStart = Math.max(0, pos - 200);
  for (let i = pos - 1; i >= searchStart; i--) {
    if (text[i] === '{') return i;
  }
  return pos;
}

/**
 * Find the position of the nearest balanced `}` after `pos` in text (for region extraction).
 * Falls back to end-of-line or end-of-text if no closing brace is found.
 */
function findFollowingBrace(text: string, pos: number): number {
  const searchEnd = Math.min(text.length, pos + 2000);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = pos; i < searchEnd; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      if (depth === 0) return i;
      depth--;
    }
  }
  // No balanced brace found — return end of current line or end of search
  const newlineIdx = text.indexOf('\n', pos);
  return newlineIdx !== -1 && newlineIdx < searchEnd ? newlineIdx : searchEnd - 1;
}

/**
 * Try to extract a known tool name from a JSON-like string.
 * Attempts JSON.parse first, then repair.
 */
function extractKnownToolName(text: string): string | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(text);
    const obj = asRecord(parsed);
    if (obj && typeof obj.tool === 'string' && KNOWN_TOOL_NAMES.has(obj.tool)) {
      return obj.tool;
    }
  } catch {
    // Try repair
    const repaired = repairToolJson(text);
    if (repaired && typeof repaired.tool === 'string' && KNOWN_TOOL_NAMES.has(repaired.tool)) {
      return repaired.tool;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bare JSON recovery — models sometimes emit just the args object without
// the required {"tool":"..","args":{..}} wrapper. These helpers detect
// the pattern and auto-recover valid tool calls.
// ---------------------------------------------------------------------------

/**
 * Extract ALL top-level JSON objects from text, regardless of whether they
 * have a 'tool' key. Used for bare-args recovery.
 */
function extractAllBareJsonObjects(text: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = braceIdx; j < text.length; j++) {
      const ch = text[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }

    if (end === -1) { i = braceIdx + 1; continue; }

    try {
      const parsed = JSON.parse(text.slice(braceIdx, end + 1));
      const obj = asRecord(parsed);
      if (obj) results.push(obj);
    } catch { /* not valid JSON — skip */ }

    i = end + 1;
  }
  return results;
}

/**
 * Infer which tool a bare JSON args object belongs to, based on its keys.
 * Returns the tool name, or null if the args don't match any known pattern.
 */
function inferToolFromArgs(args: Record<string, unknown>): string | null {
  const hasRepo = typeof args.repo === 'string';
  const hasPath = typeof args.path === 'string';
  const hasCommand = typeof args.command === 'string';
  const hasContent = typeof args.content === 'string';
  const hasPattern = typeof args.pattern === 'string';
  const hasQuery = typeof args.query === 'string';
  const hasPr = args.pr !== undefined;
  const hasSha = typeof args.sha === 'string';
  const hasRef = typeof args.ref === 'string';
  const hasEdits = Array.isArray(args.edits);
  const hasMessage = typeof args.message === 'string';
  const hasFilePath = typeof args.file_path === 'string';
  const hasWorkflow = typeof args.workflow === 'string';
  const hasRunId = args.run_id !== undefined;

  const hasCount = args.count !== undefined;
  const hasState = typeof args.state === 'string';
  const hasBranchName = typeof args.branch_name === 'string';
  const hasTitle = typeof args.title === 'string';
  const hasHead = typeof args.head === 'string';
  const hasBase = typeof args.base === 'string';
  const hasPrNumber = args.pr_number !== undefined;
  const hasHeadBranch = typeof args.head_branch === 'string';

  // GitHub tools — identified by the 'repo' key
  if (hasRepo) {
    if (hasPath && hasPattern) return 'grep_file';
    if (hasPath) return 'read_file';
    if (hasQuery) return 'search_files';
    if (hasPr) return 'fetch_pr';
    if (hasSha) return 'list_commit_files';
    if (hasRef && hasWorkflow) return null; // ambiguous
    if (hasRef) return 'fetch_checks';
    if (hasWorkflow && hasRunId) return 'get_workflow_logs';
    if (hasWorkflow) return 'trigger_workflow';
    // Disambiguate repo-only patterns using secondary keys
    if (hasCount && !hasState) return 'list_commits';
    if (hasState) return 'list_prs';
    if (hasBranchName && hasTitle) return 'create_pr';
    if (hasBranchName && !hasTitle) return 'create_branch';
    if (hasPrNumber && typeof args.merge_method === 'string') return 'merge_pr';
    if (hasPrNumber) return 'check_pr_mergeable';
    if (hasHeadBranch) return 'find_existing_pr';
    if (hasTitle && hasHead && hasBase) return 'create_pr';
    // Still ambiguous (list_directory, list_branches, list_commits w/o count) — skip
    return null;
  }

  // Sandbox tools — no 'repo' key
  if (hasCommand) return 'sandbox_exec';
  if ((hasPath || hasFilePath) && hasEdits) return 'sandbox_edit_file';
  if ((hasPath || hasFilePath) && hasContent) return 'sandbox_write_file';
  if ((hasPath || hasFilePath) && !hasContent && !hasMessage) return 'sandbox_read_file';
  if (hasQuery && !hasRepo) return 'web_search';
  if (hasMessage && !hasRepo) return 'sandbox_prepare_commit';

  return null;
}

/**
 * Try to recover valid tool calls from bare JSON args objects.
 * Wraps inferred args in the {"tool":..,"args":..} format and validates
 * through the normal detection pipeline.
 */
function tryRecoverBareToolArgs(text: string): AnyToolCall | null {
  const objects = extractAllBareJsonObjects(text);

  for (const obj of objects) {
    // Skip objects that already have a 'tool' key — those went through normal detection
    if (typeof obj.tool === 'string') continue;

    const toolName = inferToolFromArgs(obj);
    if (!toolName) continue;

    // Wrap as proper tool call JSON and validate through existing detectors
    const wrappedJson = JSON.stringify({ tool: toolName, args: obj });

    if (GITHUB_TOOL_NAMES.has(toolName)) {
      const call = detectToolCall(wrappedJson);
      if (call) return { source: 'github', call };
    } else if (toolName.startsWith('sandbox_')) {
      const call = detectSandboxToolCall(wrappedJson);
      if (call) return { source: 'sandbox', call };
    } else if (toolName === 'web_search') {
      const call = detectWebSearchToolCall(wrappedJson);
      if (call) return { source: 'web-search', call };
    }
  }

  return null;
}

// --- delegate_coder detection ---

function detectDelegateCoder(text: string): AnyToolCall | null {
  return detectToolFromText<AnyToolCall>(text, (parsed) => {
    const parsedObj = asRecord(parsed);
    const args = asRecord(parsedObj?.args);
    const task = typeof args?.task === 'string' ? args.task : undefined;
    const tasks = Array.isArray(args?.tasks) ? args.tasks.filter((v): v is string => typeof v === 'string') : undefined;
    const files = Array.isArray(args?.files) ? args.files.filter((v): v is string => typeof v === 'string') : undefined;
    // Parse acceptance criteria if provided
    let acceptanceCriteria: AcceptanceCriterion[] | undefined;
    if (Array.isArray(args?.acceptanceCriteria)) {
      acceptanceCriteria = (args.acceptanceCriteria as unknown[]).filter((c): c is AcceptanceCriterion => {
        const cr = asRecord(c);
        return !!cr && typeof cr.id === 'string' && typeof cr.check === 'string';
      }).map(c => ({
        id: c.id,
        check: c.check,
        exitCode: typeof c.exitCode === 'number' ? c.exitCode : undefined,
        description: typeof c.description === 'string' ? c.description : undefined,
      }));
      if (acceptanceCriteria.length === 0) acceptanceCriteria = undefined;
    }
    if (parsedObj?.tool === 'delegate_coder' && (task || (tasks && tasks.length > 0))) {
      return {
        source: 'delegate',
        call: { tool: 'delegate_coder', args: { task, tasks, files, acceptanceCriteria } },
      };
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Natural language tool intent detection
// ---------------------------------------------------------------------------
// Some models (e.g. Codex via OpenRouter) describe wanting to use a tool in
// prose without emitting the JSON block. This detector catches common
// phrasing patterns and nudges the model to emit proper tool-call JSON.

/** Intent action verbs that signal the model wants to do something NOW. */
const INTENT_VERBS = `(?:I(?:'ll|\\s+will|\\s+am\\s+going\\s+to)|Let\\s+me|I'm\\s+going\\s+to|Going\\s+to|Now\\s+I(?:'ll|\\s+will))`;

interface NLIntentPattern {
  regex: RegExp;
  toolName: string;
  exampleJson: string;
}

/**
 * Patterns that match natural language expressions of tool-use intent.
 * Each includes the tool name and an example JSON to nudge the model.
 *
 * We use case-insensitive matching. The patterns require an action-verb
 * prefix (e.g. "I'll", "Let me") to avoid false-positives when the model
 * is merely explaining what a tool does.
 */
const NL_INTENT_PATTERNS: NLIntentPattern[] = [
  // delegate_coder — most common failure case (e.g. Codex says "I'll delegate to the coder")
  {
    regex: new RegExp(`${INTENT_VERBS}\\s+delegat(?:e|ing)\\s+(?:this\\s+)?(?:to\\s+)?(?:the\\s+)?coder`, 'i'),
    toolName: 'delegate_coder',
    exampleJson: '{"tool": "delegate_coder", "args": {"task": "describe the task here"}}',
  },
  {
    regex: new RegExp(`${INTENT_VERBS}\\s+delegat(?:e|ing)\\s+(?:this\\s+)?(?:task\\s+)?(?:to\\s+)?(?:the\\s+)?coder(?:\\s+agent)?`, 'i'),
    toolName: 'delegate_coder',
    exampleJson: '{"tool": "delegate_coder", "args": {"task": "describe the task here"}}',
  },
  // Generic: model mentions a known tool name by its exact name without JSON
  // e.g. "I'll use sandbox_exec to run the tests"
  // This is safe because it requires the actual tool identifier in the text.
  {
    regex: new RegExp(`${INTENT_VERBS}\\s+(?:use|call|invoke|try)\\s+(sandbox_\\w+|read_file|list_directory|search_files|grep_file|delegate_coder|web_search|fetch_pr|list_prs|list_commits|list_branches)`, 'i'),
    toolName: '', // filled dynamically from capture group
    exampleJson: '', // filled dynamically
  },
];

/**
 * Detect natural language expressions of tool-call intent.
 * Returns a diagnosis when the model described wanting to use a tool
 * but didn't emit a JSON block.
 */
function detectNaturalLanguageToolIntent(text: string): ToolCallDiagnosis | null {
  // Skip if text already contains JSON-like structures — those are handled
  // by the earlier phases (truncation, validation, malformed).
  if (/\{\s*"?'?tool/.test(text)) return null;

  const normalized = text.trim();
  // Don't match very short responses — too likely to false-positive
  if (normalized.length < 15) return null;

  for (const pattern of NL_INTENT_PATTERNS) {
    const match = pattern.regex.exec(normalized);
    if (!match) continue;

    // For the generic "I'll use <tool_name>" pattern, extract the tool name
    let toolName = pattern.toolName;
    let exampleJson = pattern.exampleJson;
    if (!toolName && match[1]) {
      toolName = match[1];
      // Build a generic example for the matched tool
      if (KNOWN_TOOL_NAMES.has(toolName)) {
        exampleJson = `{"tool": "${toolName}", "args": {}}`;
      } else {
        continue; // Not a real tool name — skip
      }
    }

    if (!toolName) continue;

    return {
      reason: 'natural_language_intent',
      toolName,
      errorMessage: `You described wanting to use "${toolName}" but didn't output the required JSON tool block. `
        + `To call a tool, output ONLY a fenced JSON block like this:\n\n`
        + '```json\n'
        + `${exampleJson}\n`
        + '```\n\n'
        + `Do not describe the tool call in prose — output the JSON block directly.`,
    };
  }

  return null;
}
