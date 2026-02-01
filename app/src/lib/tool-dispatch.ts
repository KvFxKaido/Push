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
import { detectSandboxToolCall, executeSandboxToolCall, type SandboxToolCall } from './sandbox-tools';

export type AnyToolCall =
  | { source: 'github'; call: ToolCall }
  | { source: 'sandbox'; call: SandboxToolCall }
  | { source: 'delegate'; call: { tool: 'delegate_coder'; args: { task: string; files?: string[] } } };

/**
 * Scan assistant output for any tool call (GitHub, Sandbox, or delegation).
 * Returns the first match, or null if no tool call is detected.
 */
export function detectAnyToolCall(text: string): AnyToolCall | null {
  // Check for delegate_coder first (it's a special dispatch, not a repo tool)
  const delegateMatch = detectDelegateCoder(text);
  if (delegateMatch) return delegateMatch;

  // Check sandbox tools (sandbox_ prefix)
  const sandboxCall = detectSandboxToolCall(text);
  if (sandboxCall) return { source: 'sandbox', call: sandboxCall };

  // Check GitHub tools
  const githubCall = detectToolCall(text);
  if (githubCall) return { source: 'github', call: githubCall };

  return null;
}

/**
 * Execute a detected tool call through the appropriate handler.
 */
export async function executeAnyToolCall(
  toolCall: AnyToolCall,
  allowedRepo: string,
  sandboxId: string | null,
): Promise<ToolExecutionResult> {
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

    default:
      return { text: '[Tool Error] Unknown tool source.' };
  }
}

// --- delegate_coder detection ---

function detectDelegateCoder(text: string): AnyToolCall | null {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool === 'delegate_coder' && parsed.args?.task) {
        return {
          source: 'delegate',
          call: { tool: 'delegate_coder', args: { task: parsed.args.task, files: parsed.args.files } },
        };
      }
    } catch {
      // Not valid JSON
    }
  }

  // Bare JSON fallback
  const bareRegex = /\{[\s\S]*?"tool"\s*:\s*"delegate_coder"[\s\S]*?\}/g;
  while ((match = bareRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool === 'delegate_coder' && parsed.args?.task) {
        return {
          source: 'delegate',
          call: { tool: 'delegate_coder', args: { task: parsed.args.task, files: parsed.args.files } },
        };
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}
