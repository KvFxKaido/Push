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

/** Raw result from executing a tool call (before building the ChatMessage). */
export interface ToolExecRawResult {
  call: AnyToolCall;
  raw: ToolExecutionResult;
  cards: ChatCard[];
  durationMs: number;
}

/** Full outcome with the built ChatMessage, ready to be applied to state. */
export interface ToolExecOutcome extends ToolExecRawResult {
  resultMessage: ChatMessage;
}

// ---------------------------------------------------------------------------
// Execute a single tool call (no message building)
// ---------------------------------------------------------------------------

/**
 * Execute a single GitHub/Sandbox tool call and return the raw result.
 * Does NOT build the ChatMessage — the caller should fetch sandbox status
 * *after* execution and then call `buildToolOutcome()`.
 */
export async function executeTool(
  call: AnyToolCall,
  ctx: ToolExecRunContext,
): Promise<ToolExecRawResult> {
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

  return { call, raw: result, cards, durationMs };
}

// ---------------------------------------------------------------------------
// Build the ChatMessage from a raw result + post-execution meta line
// ---------------------------------------------------------------------------

/**
 * Build a ToolExecOutcome (with ChatMessage) from a raw execution result.
 * Call this *after* fetching sandbox status so the meta line is accurate.
 */
export function buildToolOutcome(
  rawResult: ToolExecRawResult,
  metaLine: string,
  provider: ActiveProvider,
): ToolExecOutcome {
  const resultMessage = buildToolResultMessage({
    id: createId(),
    timestamp: Date.now(),
    text: rawResult.raw.text,
    metaLine,
    toolMeta: buildToolMeta({
      toolName: getToolName(rawResult.call),
      source: rawResult.call.source,
      provider,
      durationMs: rawResult.durationMs,
      isError: rawResult.raw.text.includes('[Tool Error]'),
    }),
  });

  return { ...rawResult, resultMessage };
}

// ---------------------------------------------------------------------------
// Parallel tool execution
// ---------------------------------------------------------------------------

/**
 * Execute multiple read-only tool calls in parallel, returning raw results.
 * Caller should fetch sandbox status after, then map with `buildToolOutcome()`.
 */
export async function executeParallelTools(
  calls: AnyToolCall[],
  ctx: ToolExecRunContext,
): Promise<ToolExecRawResult[]> {
  return Promise.all(calls.map((call) => executeTool(call, ctx)));
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
 * Collect side effects from one or more raw tool results.
 */
export function collectSideEffects(results: ToolExecRawResult[]): ToolSideEffects {
  const combined: ToolSideEffects = {
    promotion: undefined,
    branchSwitch: undefined,
    sandboxUnreachable: undefined,
  };

  for (const result of results) {
    const effects = extractSideEffects(result.raw);
    if (effects.promotion) combined.promotion = effects.promotion;
    if (effects.branchSwitch) combined.branchSwitch = effects.branchSwitch;
    if (effects.sandboxUnreachable) combined.sandboxUnreachable = effects.sandboxUnreachable;
  }

  return combined;
}
