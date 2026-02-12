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
import { detectSandboxToolCall, executeSandboxToolCall, getUnrecognizedSandboxToolName, type SandboxToolCall } from './sandbox-tools';
import { detectScratchpadToolCall, type ScratchpadToolCall } from './scratchpad-tools';
import { detectWebSearchToolCall, executeWebSearch, type WebSearchToolCall } from './web-search-tools';
import { getActiveProvider } from './orchestrator';
import { execInSandbox } from './sandbox-client';

// ---------------------------------------------------------------------------
// Shared: brace-counting JSON extractor (handles nested objects)
// ---------------------------------------------------------------------------

/**
 * Extract bare JSON objects containing a "tool" key from text.
 * Uses brace-counting instead of regex so nested objects like
 * {"tool":"x","args":{"repo":"a/b","path":"c"}} are captured correctly.
 */
type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

export function extractBareToolJsonObjects(text: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;

  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;

    // Brace-count to find the matching closing }
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
      if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) {
      // Unclosed brace — skip it and keep scanning. An unmatched {
      // in prose or a code snippet shouldn't prevent us from finding
      // a valid tool-call JSON later in the text.
      i = braceIdx + 1;
      continue;
    }

    const candidate = text.slice(braceIdx, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      const parsedObj = asRecord(parsed);
      if (parsedObj && typeof parsedObj.tool === 'string') {
        results.push(parsed);
      }
    } catch {
      // Not valid JSON — skip
    }

    i = end + 1;
  }

  return results;
}

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
      const provider = getActiveProvider();
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

/**
 * Check if text contains what looks like a tool call attempt that failed to parse.
 * Returns true if there's a {"tool": or "tool": pattern but detectAnyToolCall returned null.
 * Used by useChat to inject error feedback so the LLM can retry.
 */
export function detectMalformedToolAttempt(text: string): boolean {
  // Look for patterns that strongly suggest an intended tool call
  return /[{,]\s*"tool"\s*:\s*"/.test(text);
}

// --- delegate_coder detection ---

function detectDelegateCoder(text: string): AnyToolCall | null {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
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
    } catch {
      // Not valid JSON
    }
  }

  // Bare JSON fallback (brace-counting handles nested objects)
  for (const parsed of extractBareToolJsonObjects(text)) {
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
  }

  return null;
}
