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
  type BuildToolResultMetaLineOptions,
  type ToolResultMetaSnapshot,
} from '@/lib/chat-tool-messages';
import type { ActiveProvider } from '@/lib/orchestrator';
import { createId } from '@/hooks/chat-persistence';
import {
  buildToolCallParseErrorBlock,
  formatToolResultEnvelope,
  MAX_TOOL_CALL_DIAGNOSIS_RETRIES,
  type ToolCallRecoveryResult,
} from '@/lib/tool-call-recovery';
import { recordMalformedToolCallMetric } from '@/lib/tool-call-metrics';

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
  model: string | undefined;
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
  options?: BuildToolResultMetaLineOptions,
): string {
  return buildToolResultMetaLine(round, apiMessages, provider, model, sandboxStatus, options);
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

// ---------------------------------------------------------------------------
// Recovery result handling (extracted from useChat streaming loop)
// ---------------------------------------------------------------------------

/** Instruction for the streaming loop after handling a recovery result. */
export interface RecoveryAction {
  /** 'continue' = re-stream, 'break' = exit loop normally. */
  loopAction: 'continue' | 'break';
  /** Updated apiMessages to feed back into the loop. */
  apiMessages: ChatMessage[];
  /**
   * Conversation messages update derived from the recovery handling.
   * Contains the assistant content and optional metadata; currently always
   * populated by handleRecoveryResult, but remains nullable for future use.
   */
  conversationUpdate: {
    assistantContent: string;
    assistantThinking?: string;
    assistantMalformed?: boolean;
    assistantToolMeta?: ReturnType<typeof buildToolMeta>;
    appendMessage?: ChatMessage;
    markDirty?: boolean;
  } | null;
  /** Whether the loop completed normally (for the break case). */
  loopCompletedNormally?: boolean;
}

/**
 * Side-effectful helper that decides what to do with a ToolCallRecoveryResult.
 *
 * Records telemetry, emits log messages, and returns an action
 * describing what the streaming loop should do next. Does NOT call
 * setConversations or mutate any refs — the caller applies the action.
 */
export function handleRecoveryResult(
  recoveryResult: ToolCallRecoveryResult,
  accumulated: string,
  thinkingAccumulated: string,
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
  model: string | undefined,
): RecoveryAction {
  // --- Telemetry ---
  const diagnosis =
    recoveryResult.kind === 'telemetry_only' ||
    recoveryResult.kind === 'diagnosis_exhausted' ||
    (recoveryResult.kind === 'feedback' && recoveryResult.diagnosis)
      ? recoveryResult.diagnosis
      : null;

  if (diagnosis) {
    recordMalformedToolCallMetric({
      provider,
      model,
      reason: diagnosis.reason,
      toolName: diagnosis.toolName,
    });
    console.warn(
      `[Push] Tool call diagnosis: ${diagnosis.reason}${diagnosis.toolName ? ` (${diagnosis.toolName})` : ''}${diagnosis.telemetryOnly ? ' (telemetry-only)' : ''}`,
    );
  }

  // --- Feedback: inject error message and re-stream ---
  if (recoveryResult.kind === 'feedback') {
    const { feedback } = recoveryResult;

    if (feedback.mode === 'unimplemented_tool') {
      console.warn(`[Push] Unimplemented tool call detected: ${feedback.toolName}`);
    } else if (feedback.mode === 'recover_plain_text') {
      console.warn(
        `[Push] Diagnosis retry cap reached (${MAX_TOOL_CALL_DIAGNOSIS_RETRIES}) — injecting recovery message`,
      );
    }

    const feedbackMsg: ChatMessage = {
      id: createId(),
      role: 'user',
      content: feedback.content,
      timestamp: Date.now(),
      status: 'done',
      isToolResult: true,
      toolMeta: buildToolMeta({
        toolName: feedback.toolName,
        source: feedback.source,
        provider,
        durationMs: 0,
        isError: true,
      }),
    };

    const assistantToolMeta =
      feedback.mode === 'unimplemented_tool'
        ? undefined
        : buildToolMeta({
            toolName: feedback.toolName,
            source: feedback.source,
            provider,
            durationMs: 0,
            isError: true,
          });

    return {
      loopAction: 'continue',
      apiMessages: [
        ...apiMessages,
        { id: createId(), role: 'assistant' as const, content: accumulated, timestamp: Date.now(), status: 'done' as const },
        feedbackMsg,
      ],
      conversationUpdate: {
        assistantContent: accumulated,
        assistantThinking: thinkingAccumulated,
        assistantMalformed: feedback.markMalformed,
        assistantToolMeta,
        appendMessage: feedbackMsg,
      },
    };
  }

  // --- Diagnosis exhausted: let message through with isMalformed ---
  if (recoveryResult.kind === 'diagnosis_exhausted') {
    console.warn('[Push] Recovery also failed — letting message through');
  }

  // --- None / telemetry_only / diagnosis_exhausted: finalize message ---
  return {
    loopAction: 'break',
    apiMessages: [...apiMessages],
    conversationUpdate: {
      assistantContent: accumulated,
      assistantThinking: thinkingAccumulated,
      assistantMalformed: recoveryResult.kind === 'diagnosis_exhausted' || undefined,
      markDirty: true,
    },
    loopCompletedNormally: true,
  };
}

// ---------------------------------------------------------------------------
// Multiple-mutations error handling (extracted from useChat streaming loop)
// ---------------------------------------------------------------------------

/** Result of handling a multiple-mutations parse error. */
export interface MultipleMutationsErrorAction {
  /** Error message to inject into the conversation. */
  errorMessage: ChatMessage;
  /** Updated apiMessages with assistant + error appended. */
  apiMessages: ChatMessage[];
  /** Info for updating the assistant message in conversation state. */
  assistantUpdate: {
    content: string;
    thinking?: string;
    toolMeta: ReturnType<typeof buildToolMeta>;
  };
}

/**
 * Build the error response when the LLM emits multiple mutating tool calls
 * in a single turn. Returns the messages and state updates needed — caller
 * applies them to React state.
 */
export function handleMultipleMutationsError(
  detected: { mutating: AnyToolCall | null; extraMutations: AnyToolCall[] },
  accumulated: string,
  thinkingAccumulated: string,
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
): MultipleMutationsErrorAction {
  const rejectedMutations = detected.mutating
    ? [detected.mutating, ...detected.extraMutations]
    : detected.extraMutations;
  const rejectedToolNames = rejectedMutations.map((call) => getToolName(call));

  const parseErrorHeader = buildToolCallParseErrorBlock({
    errorType: 'multiple_mutating_calls',
    problem: `Only one mutating tool call can run per turn. Received ${rejectedToolNames.length}: ${rejectedToolNames.join(', ')}.`,
    hint: 'Put read-only tools first and one mutating tool last. For multiple coding tasks, use one coder call with "tasks".',
  });

  const primaryMutation = rejectedMutations[0];
  const toolMeta = buildToolMeta({
    toolName: rejectedToolNames[0] || 'unknown',
    source: primaryMutation?.source || 'sandbox',
    provider,
    durationMs: 0,
    isError: true,
  });

  const errorMessage: ChatMessage = {
    id: createId(),
    role: 'user',
    content: formatToolResultEnvelope(parseErrorHeader),
    timestamp: Date.now(),
    status: 'done',
    isToolResult: true,
    toolMeta,
  };

  return {
    errorMessage,
    apiMessages: [
      ...apiMessages,
      { id: createId(), role: 'assistant' as const, content: accumulated, timestamp: Date.now(), status: 'done' as const },
      errorMessage,
    ],
    assistantUpdate: {
      content: accumulated,
      thinking: thinkingAccumulated,
      toolMeta,
    },
  };
}
