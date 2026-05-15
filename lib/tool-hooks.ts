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
 * are skipped. Multiple 'allow' results are merged (last modifiedArgs
 * wins, systemMessages concatenate).
 *
 * Lives in `lib/` so both web and CLI executors evaluate the same hooks
 * against the same default rule set. Per-surface bindings construct the
 * registry via `createDefaultPreHooks` and inject surface-specific
 * context (sandbox branch reader, approval mode provider, …).
 */

import type { CapabilityLedger } from './capabilities.ts';

// ---------------------------------------------------------------------------
// Hook context — what a hook sees about the current call
// ---------------------------------------------------------------------------

/**
 * Context passed to tool hooks for decision-making.
 *
 * Kept narrow on purpose: hooks should rely on inputs (toolName, args)
 * plus minimal session state, not on transitive references back into
 * the orchestrator. New fields are added when a real hook needs them.
 */
export interface ToolHookContext {
  sandboxId: string | null;
  allowedRepo: string;
  activeProvider?: string;
  activeModel?: string;
  /** When present, the capability ledger for the current run. */
  capabilityLedger?: CapabilityLedger;
  /** Repo default branch name (`main`, `master`, …). */
  defaultBranch?: string;
  /** Protect Main toggle — when true, commits/pushes to default branch are denied. */
  isMainProtected?: boolean;
  /**
   * Async getter for the current sandbox branch. Hooks that need to
   * make branch-aware decisions (e.g. Protect Main) call this lazily so
   * tool calls that don't care never pay the round-trip. Returns null
   * if the binding can't determine the branch. Each invocation may
   * round-trip; the binding is responsible for caching if needed.
   */
  getCurrentBranch?: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Hook result types
// ---------------------------------------------------------------------------

/** Result from a PreToolUse hook. */
export interface PreToolUseResult {
  /**
   * 'deny' blocks execution, 'allow' permits (and may carry modifiedArgs),
   * 'passthrough' defers to the next hook.
   */
  decision: 'allow' | 'deny' | 'passthrough';
  /**
   * Human-readable reason. On deny, surfaces to the model as the
   * `[Tool Blocked]` body — keep it self-explanatory and actionable.
   */
  reason?: string;
  /**
   * Optional structured-error code attached to a deny. Web's runtime
   * adapter promotes this into a `StructuredToolError` for telemetry
   * and downstream classification; CLI surfaces it in the
   * `[Tool Blocked]` line. Use stable SCREAMING_SNAKE_CASE identifiers
   * (e.g. `GIT_GUARD_BLOCKED`, `PROTECT_MAIN`).
   */
  errorType?: string;
  /** Replacement args — applied when decision is 'allow'. */
  modifiedArgs?: Record<string, unknown>;
  /** Appended to the tool result text after execution. */
  systemMessage?: string;
}

/**
 * Result from a PostToolUse hook.
 *
 * `ChatMessage` is referenced via `unknown` here so lib doesn't drag in
 * the rich web type. Web's adapter casts it back where the message is
 * actually rendered.
 */
export interface PostToolUseResult {
  /** Appended to the tool result text after execution. */
  systemMessage?: string;
  /** When set, replaces the tool result text sent to the model. */
  resultOverride?: string;
  /**
   * Runtime action requested by a post-tool policy.
   * - 'inject':  append an advisory message after the tool result
   * - 'halt':    stop the agent loop (e.g., repeated mutation failures)
   * When absent, the hook only modifies the result text (legacy behavior).
   */
  action?: 'inject' | 'halt';
  /**
   * Message to inject into the conversation (when action === 'inject').
   * Typed as `unknown` so lib stays free of ChatMessage; web casts at the
   * boundary where the message is rendered.
   */
  injectMessage?: unknown;
  /** Summary reason for halting (when action === 'halt'). */
  haltSummary?: string;
}

// ---------------------------------------------------------------------------
// Hook entry types
// ---------------------------------------------------------------------------

export type PreToolUseHook = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolHookContext,
) => Promise<PreToolUseResult> | PreToolUseResult;

/**
 * Post-hook callback. `result` is typed `unknown` here so lib stays free
 * of the rich per-surface tool-result types. Web passes its
 * `ToolExecutionResult`; CLI passes its own. Hooks narrow as needed.
 */
export type PostToolUseHook = (
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  context: ToolHookContext,
) => Promise<PostToolUseResult> | PostToolUseResult;

export interface PreToolHookEntry {
  /** Regex or pipe-delimited string matched against the tool name. */
  matcher: RegExp | string;
  hook: PreToolUseHook;
}

export interface PostToolHookEntry {
  matcher: RegExp | string;
  hook: PostToolUseHook;
}

export interface ToolHookRegistry {
  pre: PreToolHookEntry[];
  post: PostToolHookEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesToolName(matcher: RegExp | string, toolName: string): boolean {
  if (matcher instanceof RegExp) return matcher.test(toolName);
  return matcher.split('|').some((m) => m.trim() === toolName);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate pre-hooks against a tool call. Returns the merged result, or
 * null if all hooks passed through.
 *
 * First 'deny' short-circuits. Multiple 'allow' results merge (last
 * modifiedArgs wins, systemMessages concatenate).
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
      return result; // Short-circuit
    }

    if (result.decision === 'allow') {
      if (!merged) {
        merged = { ...result };
      } else {
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
 * Evaluate post-hooks. Last resultOverride wins. systemMessages
 * concatenate. For action-based results (inject/halt), the first action
 * wins — subsequent hooks cannot override a halt/inject decision.
 */
export async function evaluatePostHooks(
  registry: ToolHookRegistry,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
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
      if (hookResult.action && !merged.action) {
        merged.action = hookResult.action;
        merged.injectMessage = hookResult.injectMessage;
        merged.haltSummary = hookResult.haltSummary;
      }
    }
  }

  return merged;
}

export function createToolHookRegistry(): ToolHookRegistry {
  return { pre: [], post: [] };
}
