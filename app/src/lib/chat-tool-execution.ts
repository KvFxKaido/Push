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
  LocalPcBinding,
  RelayBinding,
  ReasoningBlock,
  ToolExecutionResult,
} from '@/types';
import type { ApprovalGateRegistry } from '@/lib/approval-gates';
import { createDefaultApprovalGates } from '@/lib/approval-gates';
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
import { createId } from '@push/lib/id-utils';
import {
  buildToolCallParseErrorBlock,
  formatToolResultEnvelope,
  MAX_TOOL_CALL_DIAGNOSIS_RETRIES,
  type ToolCallRecoveryResult,
} from '@/lib/tool-call-recovery';
import { recordMalformedToolCallMetric } from '@/lib/tool-call-metrics';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  EMPTY_CORRELATION_CONTEXT,
  type CorrelationContext,
} from '@push/lib/correlation-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DEFAULT_APPROVAL_GATES = createDefaultApprovalGates();

/** Context that stays constant for the duration of a sendMessage call. */
export interface ToolExecRunContext {
  repoFullName: string | null;
  /**
   * Active chat id for this turn. Required because tools that scope
   * persistence by chat (notably `create_artifact`) need it
   * unconditionally — passing it via `correlation` accidentally
   * left it undefined on the single/batched paths that build the
   * context without correlation tags. `null` is reserved for callers
   * that genuinely have no chat (none today on the web surface).
   */
  chatId: string | null;
  sandboxId: string | null;
  /**
   * Daemon binding for `kind: 'local-pc'` OR `kind: 'relay'` sessions.
   * When set, sandbox tool calls route through `pushd` over the paired
   * WebSocket (loopback or Worker-relayed) instead of the cloud
   * sandbox provider. `sandboxId` may be `null` when this is set —
   * the dispatcher chooses the transport. The shape discriminator
   * (`'deploymentUrl' in binding` → relay, else local) is read by
   * the downstream helpers in `local-daemon-sandbox-client.ts`.
   */
  localDaemonBinding?: LocalPcBinding | RelayBinding;
  isMainProtected: boolean;
  defaultBranch: string | undefined;
  provider: ActiveProvider;
  model: string | undefined;
  approvalGates?: ApprovalGateRegistry;
  /**
   * Passive correlation tags to attach to the tool-execution span as
   * `push.*` attributes (see `lib/correlation-context.ts`). The caller
   * builds this from whatever ids it already knows (`chatId`, `runId`,
   * `executionId`, `toolCallId`, etc.) — this field never alters tool
   * behavior, only observability.
   */
  correlation?: CorrelationContext;
  /**
   * AbortSignal threaded into daemon-routed sandbox tools so mid-run
   * cancellation can fire `cancel_run` over the same WS. Web's chat
   * loop wires this from `abortControllerRef.current?.signal`. Tools
   * that don't observe a signal ignore it.
   */
  abortSignal?: AbortSignal;
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
  return withActiveSpan(
    'tool.execute',
    {
      scope: 'push.tools',
      kind: SpanKind.INTERNAL,
      attributes: {
        ...correlationToSpanAttributes(ctx.correlation ?? EMPTY_CORRELATION_CONTEXT),
        'push.tool.name': call.call.tool,
        'push.tool.source': call.source,
        'push.provider': ctx.provider,
        'push.model': ctx.model,
        'push.has_repo': Boolean(ctx.repoFullName),
        'push.has_sandbox': Boolean(ctx.sandboxId),
      },
    },
    async (span) => {
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
          undefined,
          ctx.approvalGates ?? DEFAULT_APPROVAL_GATES,
          undefined,
          undefined,
          ctx.chatId ?? undefined,
          ctx.localDaemonBinding,
          ctx.abortSignal,
        );
      }

      const durationMs = Date.now() - start;
      const cards: ChatCard[] = [];
      if (result.card && result.card.type !== 'sandbox-state') {
        cards.push(result.card);
      }

      setSpanAttributes(span, {
        'push.tool.duration_ms': durationMs,
        'push.tool.card_count': cards.length,
        'push.tool.error_type': result.structuredError?.type,
        'push.tool.retryable': result.structuredError?.retryable,
      });
      if (result.structuredError) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.structuredError.message,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      return { call, raw: result, cards, durationMs };
    },
  );
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
    // R11: stamp delegate result messages with their LAUNCH branch (captured
    // at delegation dispatch into ToolExecutionResult.originBranch). For
    // non-delegate tools this is undefined and the message stays unstamped,
    // falling back to conv.branch via effectiveMessageBranch.
    branch: rawResult.raw.originBranch,
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
  branchSwitch: ToolExecutionResult['branchSwitch'];
  sandboxUnreachable: string | undefined;
}

/**
 * Extract side effects from a tool execution result.
 */
export function extractSideEffects(result: ToolExecutionResult): ToolSideEffects {
  return {
    promotion: result.promotion,
    branchSwitch: result.branchSwitch,
    sandboxUnreachable:
      result.structuredError?.type === 'SANDBOX_UNREACHABLE'
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
  reasoningBlocks: ReasoningBlock[],
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
  model: string | undefined,
): RecoveryAction {
  const reasoningBlocksField =
    reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {};
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
        {
          id: createId(),
          role: 'assistant' as const,
          content: accumulated,
          timestamp: Date.now(),
          status: 'done' as const,
          ...reasoningBlocksField,
        },
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
  reasoningBlocks: ReasoningBlock[],
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
): MultipleMutationsErrorAction {
  const rejectedMutations = detected.mutating
    ? [detected.mutating, ...detected.extraMutations]
    : detected.extraMutations;
  const rejectedToolNames = rejectedMutations.map((call) => getToolName(call));

  const parseErrorHeader = buildToolCallParseErrorBlock({
    errorType: 'multiple_mutating_calls',
    problem: `Extra tool calls detected after the turn's mutation transaction: ${rejectedToolNames.join(', ')}.`,
    hint: 'A turn may emit read-only calls first, then up to MAX_FILE_MUTATION_BATCH (8) pure file mutations as one batch (for example write/edit/patch on sandbox-backed surfaces, or CLI-only undo_edit where available), then at most one trailing side-effect (exec, commit, push, delegate, workflow_run). Any of the following lands here: a second side-effect, a file mutation or read emitted after a side-effect, a read emitted after the mutation batch starts, or file-mutation overflow beyond the batch limit. Reorder your calls or split them across turns.',
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
      {
        id: createId(),
        role: 'assistant' as const,
        content: accumulated,
        timestamp: Date.now(),
        status: 'done' as const,
        ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
      },
      errorMessage,
    ],
    assistantUpdate: {
      content: accumulated,
      thinking: thinkingAccumulated,
      toolMeta,
    },
  };
}
