/**
 * chat-tool-execution.ts
 *
 * Extracted from useChat.ts — consolidates the repeated pattern of:
 *   detect tool → ensure sandbox → execute → handle side effects → build result message → update state
 *
 * Pure-ish helpers with explicit parameters. No React hooks, no closures over hook state.
 */

import type {
  ChatMessage,
  ChatCard,
  ToolExecutionResult,
  AIProviderType,
  ActiveRepo,
} from '@/types';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import { executeAnyToolCall } from '@/lib/tool-dispatch';
import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  buildToolResultMetaLine,
  getToolName,
  type ToolResultMetaSnapshot,
} from '@/lib/chat-tool-messages';
import type { ActiveProvider } from '@/lib/orchestrator';
import { createId } from '@/hooks/chat-persistence';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context that stays constant for the duration of a sendMessage call. */
export interface ToolExecRunContext {
  repoFullName: string | null;
  sandboxId: string | null;
  isMainProtected: boolean;
  defaultBranch: string | undefined;
  provider: ActiveProvider;
  model: string | null | undefined;
}

/** Result of executing one tool call, ready to be applied to state. */
export interface ToolExecOutcome {
  /** The built ChatMessage for the tool result. */
  resultMessage: ChatMessage;
  /** Cards to attach to the assistant message that triggered the call. */
  cards: ChatCard[];
  /** The raw execution result (for side-effect handling). */
  raw: ToolExecutionResult;
  /** How long execution took. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Single tool execution + result message building
// ---------------------------------------------------------------------------

/**
 * Execute a single tool call and build the result message.
 * Does NOT touch React state — returns data for the caller to apply.
 */
export async function executeAndBuildResult(
  call: AnyToolCall,
  ctx: ToolExecRunContext,
  metaLine: string,
): Promise<ToolExecOutcome> {
  const start = Date.now();

  let result: ToolExecutionResult;
  if (call.source === 'github' && !ctx.repoFullName) {
    result = { text: '[Tool Error] No active repo selected — please select a repo in the UI.' };
  } else {
    result = await executeAnyToolCall(
      call,
      ctx.repoFullName || '',
      ctx.sandboxId,
      ctx.isMainProtected,
      ctx.defaultBranch,
      ctx.provider,
      ctx.model,
    );
  }

  const durationMs = Date.now() - start;

  const cards: ChatCard[] = [];
  if (result.card && result.card.type !== 'sandbox-state') {
    cards.push(result.card);
  }

  const resultMessage = buildToolResultMessage({
    id: createId(),
    timestamp: Date.now(),
    text: result.text,
    metaLine,
    toolMeta: buildToolMeta({
      toolName: getToolName(call),
      source: call.source,
      provider: ctx.provider,
      durationMs,
      isError: result.text.includes('[Tool Error]'),
    }),
  });

  return { resultMessage, cards, raw: result, durationMs };
}

// ---------------------------------------------------------------------------
// Parallel tool execution
// ---------------------------------------------------------------------------

/**
 * Execute multiple read-only tool calls in parallel, returning outcomes.
 */
export async function executeParallelTools(
  calls: AnyToolCall[],
  ctx: ToolExecRunContext,
  metaLine: string,
): Promise<ToolExecOutcome[]> {
  return Promise.all(calls.map((call) => executeAndBuildResult(call, ctx, metaLine)));
}

// ---------------------------------------------------------------------------
// Build meta line (convenience wrapper for the round context)
// ---------------------------------------------------------------------------

export function buildMetaLine(
  round: number,
  apiMessages: readonly Pick<ChatMessage, 'content'>[],
  provider: ActiveProvider,
  model: string | null | undefined,
  sandboxStatus: ToolResultMetaSnapshot | null,
): string {
  return buildToolResultMetaLine(round, apiMessages, provider, model, sandboxStatus);
}

// ---------------------------------------------------------------------------
// Side-effect handling from tool results
// ---------------------------------------------------------------------------

export interface ToolSideEffects {
  promotion: ToolExecutionResult['promotion'] | undefined;
  branchSwitch: string | undefined;
  sandboxUnreachable: string | undefined;
}

/**
 * Extract side effects from a tool execution result.
 * Returns structured data so the caller can apply them without
 * knowing the shape of ToolExecutionResult.
 */
export function extractSideEffects(result: ToolExecutionResult): ToolSideEffects {
  return {
    promotion: result.promotion,
    branchSwitch: result.branchSwitch,
    sandboxUnreachable: result.structuredError?.type === 'SANDBOX_UNREACHABLE'
      ? result.structuredError.message
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// State update helpers (pure functions that return new state)
// ---------------------------------------------------------------------------

/**
 * Apply tool result cards to the conversation's latest assistant message.
 * Returns updated messages array, or null if no cards to apply.
 */
export function applyCardsToMessages(
  messages: ChatMessage[],
  cards: ChatCard[],
): ChatMessage[] | null {
  if (cards.length === 0) return null;
  return appendCardsToLatestToolCall(messages, cards);
}

/**
 * Apply side effects from one or more tool outcomes.
 * Returns the combined side effects to be handled by the caller.
 */
export function collectSideEffects(outcomes: ToolExecOutcome[]): ToolSideEffects {
  const combined: ToolSideEffects = {
    promotion: undefined,
    branchSwitch: undefined,
    sandboxUnreachable: undefined,
  };

  for (const outcome of outcomes) {
    const effects = extractSideEffects(outcome.raw);
    if (effects.promotion) combined.promotion = effects.promotion;
    if (effects.branchSwitch) combined.branchSwitch = effects.branchSwitch;
    if (effects.sandboxUnreachable) combined.sandboxUnreachable = effects.sandboxUnreachable;
  }

  return combined;
}
