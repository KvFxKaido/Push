/**
 * Unified tool dispatch — wraps both GitHub and Sandbox tool
 * detection/execution behind a single interface.
 *
 * This keeps useChat.ts clean: it calls detectAnyToolCall() once
 * and gets back the right type, then executeAnyToolCall() routes
 * to the correct implementation.
 */

import type { ToolExecutionResult } from '@/types';
import { detectToolCall, executeToolCall, type ToolCall } from './github-tools';
import { detectSandboxToolCall, executeSandboxToolCall, getUnrecognizedSandboxToolName, IMPLEMENTED_SANDBOX_TOOLS, type SandboxToolCall } from './sandbox-tools';
import { detectScratchpadToolCall, type ScratchpadToolCall } from './scratchpad-tools';
import { detectWebSearchToolCall, executeWebSearch, type WebSearchToolCall } from './web-search-tools';
import { getActiveProvider, type ActiveProvider } from './orchestrator';
import { execInSandbox } from './sandbox-client';
import { asRecord, detectToolFromText, extractBareToolJsonObjects, repairToolJson, detectTruncatedToolCall } from './utils';

// Re-export for backwards compatibility — other modules import from here
export { extractBareToolJsonObjects };

export type AnyToolCall =
  | { source: 'github'; call: ToolCall }
  | { source: 'sandbox'; call: SandboxToolCall }
  | { source: 'delegate'; call: { tool: 'delegate_coder'; args: { task?: string; tasks?: string[]; files?: string[] } } }
  | { source: 'scratchpad'; call: ScratchpadToolCall }
  | { source: 'web-search'; call: WebSearchToolCall };

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

  // Check sandbox tools (sandbox_ prefix)
  const sandboxCall = detectSandboxToolCall(text);
  if (sandboxCall) return { source: 'sandbox', call: sandboxCall };

  // Check GitHub tools
  const githubCall = detectToolCall(text);
  if (githubCall) return { source: 'github', call: githubCall };

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
        return { text: '[Tool Error] No active sandbox. Start a sandbox first.' };
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
  'delegate_coder', 'set_scratchpad', 'append_scratchpad', 'read_scratchpad', 'web_search',
]);

const KNOWN_TOOL_NAMES = new Set([
  ...IMPLEMENTED_SANDBOX_TOOLS,
  ...GITHUB_TOOL_NAMES,
  ...OTHER_TOOL_NAMES,
]);

// ---------------------------------------------------------------------------
// Diagnosis result type
// ---------------------------------------------------------------------------

export interface ToolCallDiagnosis {
  reason: 'truncated' | 'validation_failed' | 'malformed_json' | 'natural_language_intent';
  toolName: string | null;
  errorMessage: string;
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
      errorMessage: `Your tool call for "${truncated.toolName}" was truncated (JSON cut off). Please retry with the complete JSON block.`,
    };
  }

  // Phase 2: Validation failure — JSON parses (or repairs), has a known tool name,
  // but the subsystem validator rejected it (wrong/missing args)
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const toolName = extractKnownToolName(fenceMatch[1].trim());
    if (toolName) {
      return {
        reason: 'validation_failed',
        toolName,
        errorMessage: `Your call to "${toolName}" has invalid or missing arguments. Check the tool protocol and retry with the correct argument format.`,
      };
    }
  }

  for (const parsed of extractBareToolJsonObjects(text)) {
    const obj = asRecord(parsed);
    if (obj && typeof obj.tool === 'string' && KNOWN_TOOL_NAMES.has(obj.tool)) {
      return {
        reason: 'validation_failed',
        toolName: obj.tool,
        errorMessage: `Your call to "${obj.tool}" has invalid or missing arguments. Check the tool protocol and retry with the correct argument format.`,
      };
    }
  }

  // Phase 3: Broad pattern match — garbled JSON that neither parsed nor repaired
  const broadPattern = /[{,]\s*["']?tool["']?\s*:\s*["']/;
  if (broadPattern.test(text)) {
    // Try to extract the tool name from the garbled text
    const nameMatch = text.match(/["']?tool["']?\s*:\s*["']([^"']+)["']/);
    const toolName = nameMatch?.[1] || null;
    return {
      reason: 'malformed_json',
      toolName,
      errorMessage: toolName
        ? `Your tool call for "${toolName}" had malformed JSON. Please retry with valid JSON using the exact format from the tool protocol.`
        : `Your last tool call had malformed JSON and could not be parsed. Please retry with valid JSON using the exact format from the tool protocol.`,
    };
  }

  // Phase 4: Natural language tool intent — model described using a tool
  // without emitting JSON (e.g. "I'll delegate to the coder" or
  // "Let me run sandbox_exec").
  const nlIntent = detectNaturalLanguageToolIntent(text);
  if (nlIntent) return nlIntent;

  return null;
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

// --- delegate_coder detection ---

function detectDelegateCoder(text: string): AnyToolCall | null {
  return detectToolFromText<AnyToolCall>(text, (parsed) => {
    const parsedObj = asRecord(parsed);
    const args = asRecord(parsedObj?.args);
    const task = typeof args?.task === 'string' ? args.task : undefined;
    const tasks = Array.isArray(args?.tasks) ? args.tasks.filter((v): v is string => typeof v === 'string') : undefined;
    const files = Array.isArray(args?.files) ? args.files.filter((v): v is string => typeof v === 'string') : undefined;
    if (parsedObj?.tool === 'delegate_coder' && (task || (tasks && tasks.length > 0))) {
      return {
        source: 'delegate',
        call: { tool: 'delegate_coder', args: { task, tasks, files } },
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
