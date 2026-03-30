/**
 * Tool Hooks — pre/post execution interception layer.
 *
 * Hooks decouple safety policy and observability from tool executors.
 * A hook registry holds matcher + callback pairs. Before execution,
 * pre-hooks can deny, allow, or modify the call. After execution,
 * post-hooks can inject context or override the result.
 *
 * Evaluation order for pre-hooks: first match that returns 'deny' wins.
 * If no hook denies, execution proceeds. Hooks returning 'passthrough'
 * are skipped. Multiple 'allow' results are merged (last modifiedArgs wins).
 */

import type {
  ToolHookContext,
  PreToolUseResult,
  PostToolUseResult,
  ToolExecutionResult,
} from '@/types';

// ---------------------------------------------------------------------------
// Hook entry types
// ---------------------------------------------------------------------------

/** Callback signature for pre-tool-use hooks. */
export type PreToolUseHook = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolHookContext,
) => Promise<PreToolUseResult> | PreToolUseResult;

/** Callback signature for post-tool-use hooks. */
export type PostToolUseHook = (
  toolName: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult,
  context: ToolHookContext,
) => Promise<PostToolUseResult> | PostToolUseResult;

/** A registered hook with a name matcher. */
export interface PreToolHookEntry {
  /** Regex or pipe-delimited string matched against the tool name. */
  matcher: RegExp | string;
  hook: PreToolUseHook;
}

export interface PostToolHookEntry {
  /** Regex or pipe-delimited string matched against the tool name. */
  matcher: RegExp | string;
  hook: PostToolUseHook;
}

/** Registry holding pre and post tool hooks. */
export interface ToolHookRegistry {
  pre: PreToolHookEntry[];
  post: PostToolHookEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesToolName(matcher: RegExp | string, toolName: string): boolean {
  if (matcher instanceof RegExp) return matcher.test(toolName);
  // Pipe-delimited string: "Write|Edit|Bash"
  return matcher.split('|').some((m) => m.trim() === toolName);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate pre-hooks against a tool call. Returns the merged result,
 * or null if all hooks passed through.
 *
 * First 'deny' short-circuits. Multiple 'allow' results merge
 * (last modifiedArgs wins, systemMessages concatenate).
 */
export async function evaluatePreHooks(
  registry: ToolHookRegistry,
  toolName: string,
  args: Record<string, unknown>,
  context: ToolHookContext,
): Promise<PreToolUseResult | null> {
  const matching = registry.pre.filter((e) => matchesToolName(e.matcher, toolName));
  if (matching.length === 0) return null;

  let merged: PreToolUseResult | null = null;

  for (const entry of matching) {
    const result = await entry.hook(toolName, args, context);

    if (result.decision === 'deny') {
      return result; // Short-circuit: first deny wins
    }

    if (result.decision === 'allow') {
      if (!merged) {
        merged = { ...result };
      } else {
        // Merge: last modifiedArgs wins, systemMessages concatenate
        if (result.modifiedArgs) merged.modifiedArgs = result.modifiedArgs;
        if (result.systemMessage) {
          merged.systemMessage = merged.systemMessage
            ? `${merged.systemMessage}\n${result.systemMessage}`
            : result.systemMessage;
        }
      }
    }
    // 'passthrough' — skip
  }

  return merged;
}

/**
 * Evaluate post-hooks against a tool result. Returns the merged result,
 * or null if all hooks passed through.
 *
 * Last resultOverride wins. systemMessages concatenate.
 * For action-based results (inject/halt), the first action wins —
 * subsequent hooks cannot override a halt/inject decision.
 */
export async function evaluatePostHooks(
  registry: ToolHookRegistry,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult,
  context: ToolHookContext,
): Promise<PostToolUseResult | null> {
  const matching = registry.post.filter((e) => matchesToolName(e.matcher, toolName));
  if (matching.length === 0) return null;

  let merged: PostToolUseResult | null = null;

  for (const entry of matching) {
    const hookResult = await entry.hook(toolName, args, result, context);
    const hasLegacyFields = hookResult.systemMessage || hookResult.resultOverride;
    const hasActionFields = hookResult.action;
    if (!hasLegacyFields && !hasActionFields) continue;

    if (!merged) {
      merged = { ...hookResult };
    } else {
      if (hookResult.resultOverride) merged.resultOverride = hookResult.resultOverride;
      if (hookResult.systemMessage) {
        merged.systemMessage = merged.systemMessage
          ? `${merged.systemMessage}\n${hookResult.systemMessage}`
          : hookResult.systemMessage;
      }
      // First action wins — don't let later hooks override inject/halt
      if (hookResult.action && !merged.action) {
        merged.action = hookResult.action;
        merged.injectMessage = hookResult.injectMessage;
        merged.haltSummary = hookResult.haltSummary;
      }
    }
  }

  return merged;
}

/**
 * Create an empty hook registry. Consumers register hooks by pushing
 * entries onto the `pre` and `post` arrays.
 */
export function createToolHookRegistry(): ToolHookRegistry {
  return { pre: [], post: [] };
}
