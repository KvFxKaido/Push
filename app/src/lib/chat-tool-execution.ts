/**
 * chat-tool-execution.ts
 *
 * Extracted from useChat.ts — consolidates the repeated pattern of:
 *   detect tool → ensure sandbox → execute → handle side effects → build result message → update state
 *
 * Pure-ish helpers with explicit parameters. No React hooks, no closures over hook state.
 */

import type { ChatMessage, ChatCard, ReasoningBlock, ToolExecutionResult } from '@/types';
import type { ToolDispatchBinding } from '@/lib/local-daemon-sandbox-client';
import type { ApprovalGateRegistry } from '@/lib/approval-gates';
import type { AgentRole } from '@push/lib/runtime-contract';
import type { ResponsesReasoningItem } from '@push/lib/provider-contract';
import { startElapsedMs } from '@push/lib/monotonic-elapsed';
import type { ApprovalCallback } from '@push/lib/tool-execution-runtime';
import type { ExecutionMode } from '@push/lib/capabilities';
import { createDefaultApprovalGates } from '@/lib/approval-gates';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import {
  executeAnyToolCall,
  MAX_FILE_MUTATION_BATCH,
  MAX_SIDE_EFFECT_CHAIN,
} from '@/lib/tool-dispatch';
import {
  appendCardsToLatestToolCall,
  buildToolMeta,
  buildToolResultMessage,
  buildToolResultMetaLine,
  getToolName,
  getToolStatusDetail,
  type BuildToolResultMetaLineOptions,
  type ToolResultMetaSnapshot,
} from '@/lib/chat-tool-messages';
import type { ActiveProvider } from '@/lib/orchestrator';
import { createId } from '@push/lib/id-utils';
import {
  buildToolCallParseErrorBlock,
  buildValidationFailedHint,
  composeToolResultBody,
  formatToolResultEnvelope,
  MAX_TOOL_CALL_DIAGNOSIS_RETRIES,
  type ToolCallRecoveryResult,
} from '@/lib/tool-call-recovery';
import { recordMalformedToolCallMetric } from '@/lib/tool-call-metrics';
import { getToolSource } from '@push/lib/tool-call-diagnosis';
import { buildToolResultBlock } from '@push/lib/tool-blocks';
import type { RuntimeIntervention } from '@push/lib/runtime-intervention';
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
   * Agent role making the call. Required so the kernel role-capability
   * check in `WebToolExecutionRuntime.execute` runs unconditionally —
   * a binding that forgets to set it gets `ROLE_REQUIRED` rather than
   * silently bypassing enforcement (closes audit item #3 from the
   * OpenCode silent-failure inventory). The chat hooks pass
   * `'orchestrator'` here; delegated paths supply their own role.
   */
  role: AgentRole;
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
   * Daemon binding for Remote sessions.
   * When set, sandbox tool calls route through `pushd` over the paired
   * WebSocket (loopback or Worker-relayed) instead of the cloud
   * sandbox provider. `sandboxId` may be `null` when this is set —
   * the dispatcher chooses the transport. The shape discriminator
   * (`'deploymentUrl' in binding` → relay, else local) is read by
   * the downstream helpers in `local-daemon-sandbox-client.ts`.
   */
  localDaemonBinding?: ToolDispatchBinding;
  /**
   * Resolved execution mode for capability checks — populated at the
   * round-loop seam from `workspaceContext.mode` via
   * `workspaceModeToExecutionMode`. Forwarded into the runtime
   * `ToolExecutionContext` so the prompt builder and the capability
   * gate read the same input.
   */
  executionMode?: ExecutionMode;
  isMainProtected: boolean;
  /** Push's active branch for this workspace, for auto-branch-on-commit /
   *  branch-aware tool routing. Optional — callers without branch context
   *  (and pre-existing fixtures) omit it; the consumer treats absent as "no
   *  branch info" and no-ops the auto-branch step. */
  currentBranch?: string;
  defaultBranch?: string;
  provider: ActiveProvider;
  model: string | undefined;
  approvalGates?: ApprovalGateRegistry;
  /**
   * Runtime-driven approval callback. When a policy gate returns 'ask_user',
   * the runtime awaits this — rendering a Confirmation card and suspending
   * until the user decides — instead of bouncing a structured error back to
   * the model (the control-plane-in-prompt smell). Absent → the model-bounce
   * fallback for headless/delegated paths with no UI. See lib/approval-bridge.ts.
   */
  approvalCallback?: ApprovalCallback;
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
  /**
   * Live-output observer for long-running `sandbox_exec` (cloud detached
   * path). The chat hooks wire this to a throttled status-bar tail (see
   * `exec-progress.ts`); absent means no live tail (delegated/CLI paths).
   */
  onExecProgress?: (chunk: { stdout: string; stderr: string }) => void;
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
      const elapsed = startElapsedMs();

      let result: ToolExecutionResult;
      if (call.source === 'github' && !ctx.repoFullName) {
        result = { text: '[Tool Error] No active repo selected — please select a repo in the UI.' };
      } else {
        result = await executeAnyToolCall(
          call,
          ctx.repoFullName || '',
          ctx.sandboxId,
          ctx.role,
          ctx.isMainProtected,
          ctx.defaultBranch,
          ctx.provider,
          ctx.model,
          undefined,
          ctx.approvalGates ?? DEFAULT_APPROVAL_GATES,
          undefined,
          ctx.approvalCallback,
          ctx.chatId ?? undefined,
          ctx.localDaemonBinding,
          ctx.abortSignal,
          ctx.executionMode,
          ctx.onExecProgress,
          ctx.currentBranch,
        );
      }

      const durationMs = elapsed();
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
  options: { toolUseId?: string; currentBranch?: string } = {},
): ToolExecOutcome {
  const isError = rawResult.raw.text.includes('[Tool Error]');
  const resultMessage = buildToolResultMessage({
    id: createId(),
    timestamp: Date.now(),
    text: rawResult.raw.text,
    metaLine,
    toolMeta: buildToolMeta({
      toolName: getToolName(rawResult.call),
      target: getToolStatusDetail(rawResult.call),
      source: rawResult.call.source,
      provider,
      durationMs: rawResult.durationMs,
      isError,
    }),
    // Delegate result messages keep their launch branch (captured at
    // delegation dispatch). Other tools stamp the branch active when the result
    // is written, with branch-switch tools using their payload target.
    branch: rawResult.raw.originBranch ?? rawResult.raw.branchSwitch?.name ?? options.currentBranch,
    ...(options.toolUseId
      ? {
          toolResults: [
            buildToolResultBlock({
              toolUseId: options.toolUseId,
              // Persist the SAME body the text envelope wraps (metaLine + result)
              // so the sidecar doesn't drop runtime [meta]/[pulse] context on
              // replay once Slice 2 prefers blocks over the text fallback.
              content: composeToolResultBody(rawResult.raw.text, metaLine),
              isError,
            }),
          ],
        }
      : {}),
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
  currentBranch?: string,
  responsesReasoningItems: ResponsesReasoningItem[] = [],
): RecoveryAction {
  const reasoningBlocksField =
    reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {};
  const responsesReasoningItemsField =
    responsesReasoningItems.length > 0
      ? { responsesReasoningItems: [...responsesReasoningItems] }
      : {};
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
      ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
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
          ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
          ...reasoningBlocksField,
          ...responsesReasoningItemsField,
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
  /** Typed runtime intervention that produced this corrective action, if any. */
  runtimeIntervention?: RuntimeIntervention;
  /** Info for updating the assistant message in conversation state. */
  assistantUpdate: {
    content: string;
    thinking?: string;
    toolMeta: ReturnType<typeof buildToolMeta>;
  };
}

/**
 * Build the error response when the LLM emits one or more tool-call-shaped
 * candidates that failed source validation in the same turn. Each candidate
 * carries a `tool` key but supplied wrong/missing args (or an unrecognized
 * tool name), so no source claimed them. Before this surface existed, those
 * drops were silent whenever any other call in the turn validated — biasing
 * detection toward whichever surviving tool had the loosest validator
 * (notably `sandbox_diff`, which takes no args).
 */
export function handleDroppedCandidatesError(
  detected: {
    droppedCandidates: import('@push/lib/deep-reviewer-agent').DroppedToolCallCandidate[];
  },
  accumulated: string,
  thinkingAccumulated: string,
  reasoningBlocks: ReasoningBlock[],
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
  model: string | undefined,
  currentBranch?: string,
  responsesReasoningItems: ResponsesReasoningItem[] = [],
): MultipleMutationsErrorAction {
  const dropped = detected.droppedCandidates;
  const primary = dropped[0];
  // Resolved canonical names where the alias table recognized the tool,
  // raw names where it didn't. Surface both shapes so the model gets
  // pinpointed feedback on the calls it just emitted.
  const summarize = (d: (typeof dropped)[number]) =>
    d.resolvedToolName ? `${d.rawToolName} (${d.resolvedToolName})` : `${d.rawToolName} (unknown)`;
  const summary = dropped.map(summarize).join(', ');
  const parseErrorHeader = buildToolCallParseErrorBlock({
    errorType: 'validation_failed',
    detectedTool: primary?.resolvedToolName || primary?.rawToolName || null,
    problem: `Tool call${dropped.length === 1 ? '' : 's'} failed validation and ${dropped.length === 1 ? 'was' : 'were'} not executed: ${summary}. No other calls ran this turn so the surviving result would not mislead the next step.`,
    hint: buildValidationFailedHint(primary?.resolvedToolName || primary?.rawToolName || null),
  });

  // Derive the tool's source from the resolved canonical name so toolMeta
  // (and the downstream run-event preview) routes to the right
  // observability bucket. Falling back to the raw name handles aliases
  // the registry knows but didn't carry on the candidate. `getToolSource`
  // ultimately returns 'sandbox' for unrecognized names — matching the
  // legacy default — so a fully-unknown tool stays where it was before.
  const primaryToolName = primary?.resolvedToolName || primary?.rawToolName || null;
  const toolSource = getToolSource(primaryToolName);

  const toolMeta = buildToolMeta({
    toolName: primaryToolName || 'unknown',
    source: toolSource,
    provider,
    durationMs: 0,
    isError: true,
  });

  // Mirror `handleRecoveryResult`: record the validation_failed drop in
  // the in-memory compliance counter so this surface shows up alongside
  // the other malformed-call paths instead of dropping out of the stats.
  recordMalformedToolCallMetric({
    provider,
    model,
    reason: 'validation_failed',
    toolName: primaryToolName,
  });

  const errorMessage: ChatMessage = {
    id: createId(),
    role: 'user',
    content: formatToolResultEnvelope(parseErrorHeader),
    timestamp: Date.now(),
    status: 'done',
    isToolResult: true,
    ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
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
        ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
        ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
        ...(responsesReasoningItems.length > 0
          ? { responsesReasoningItems: [...responsesReasoningItems] }
          : {}),
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

/**
 * Build the error response when the LLM emits a turn whose tool calls
 * can't be fully accommodated. Two distinct failure shapes flow through
 * this surface, distinguished by source list so the model sees the
 * right correction hint:
 *
 *   - `batchOverflow` — file mutations exceeding MAX_FILE_MUTATION_BATCH.
 *     Hint: continue the batch on the next turn.
 *   - `extraMutations` — ordering violations (a side-effect beyond the
 *     MAX_SIDE_EFFECT_CHAIN cap, a non-side-effect call after the chain
 *     began, or a read after the mutation batch started). Hint: reorder
 *     or split.
 *
 * Mirrors the CLI's per-call error-code split (PR #680) so model-facing
 * vocabulary is consistent across surfaces. Pre-split, web emitted a
 * single MULTI_MUTATION_NOT_ALLOWED for both cases with a vague hint
 * mentioning both possibilities; post-split, each case lists its own
 * tool names and code.
 *
 * Returns the messages and state updates needed — caller applies them
 * to React state.
 */
export function handleMultipleMutationsError(
  detected: {
    sideEffects: AnyToolCall[];
    batchOverflow: AnyToolCall[];
    extraMutations: AnyToolCall[];
  },
  accumulated: string,
  thinkingAccumulated: string,
  reasoningBlocks: ReasoningBlock[],
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
  currentBranch?: string,
  runtimeIntervention?: RuntimeIntervention,
  responsesReasoningItems: ResponsesReasoningItem[] = [],
): MultipleMutationsErrorAction {
  // `sideEffects` ONLY count as rejected ordering calls when actual
  // ordering extras are present (i.e. the model exceeded the chain cap
  // or violated the reads→mutations→side-effects order). When only
  // `batchOverflow` triggered the rejection, the chain may be a
  // legitimate trailing exec — it gets aborted as collateral damage of
  // the conservative "reject whole turn on overflow" policy, but it
  // must NOT be labeled as a per-call ordering violation in the
  // model-facing error. Codex P2 / Copilot review on PR #684 caught
  // this misclassification.
  const hasOrderingViolations = detected.extraMutations.length > 0;
  const orderingRejected: AnyToolCall[] = hasOrderingViolations
    ? [...detected.sideEffects, ...detected.extraMutations]
    : [];
  const batchOverflowNames = detected.batchOverflow.map((call) => getToolName(call));
  const orderingNames = orderingRejected.map((call) => getToolName(call));
  // For the toolMeta primary tool (the assistant message header
  // surface), prefer the first rejected ordering call when present
  // (closer to current behavior), else the first batch-overflow call.
  const primaryMutation = orderingRejected[0] ?? detected.batchOverflow[0];
  const rejectedToolNames = [...orderingNames, ...batchOverflowNames];

  const problemParts: string[] = [];
  if (batchOverflowNames.length > 0) {
    problemParts.push(
      `File-mutation batch overflow (FILE_MUTATION_BATCH_OVERFLOW): ${batchOverflowNames.join(', ')}.`,
    );
  }
  if (hasOrderingViolations) {
    problemParts.push(
      `Per-turn ordering violation (MULTI_MUTATION_NOT_ALLOWED): ${orderingNames.join(', ')}.`,
    );
  }

  const hintParts: string[] = [];
  if (batchOverflowNames.length > 0) {
    hintParts.push(
      `At most ${MAX_FILE_MUTATION_BATCH} file mutations per turn — continue the batch on the next turn.`,
    );
  }
  if (hasOrderingViolations) {
    hintParts.push(
      `A turn may emit read-only calls first, then up to ${MAX_FILE_MUTATION_BATCH} pure file mutations as one batch (write/edit/patch on sandbox-backed surfaces), then a trailing chain of up to ${MAX_SIDE_EFFECT_CHAIN} side-effecting calls (exec, commit, push, delegate, workflow_run) that run sequentially and stop on the first failure. Use at most one mutation per file path in the batch; combine same-file edits into one call. Reorder or split across turns.`,
    );
  }

  const parseErrorHeader = buildToolCallParseErrorBlock({
    errorType: 'multiple_mutating_calls',
    problem: problemParts.join(' '),
    hint: hintParts.join(' '),
  });

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
    ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
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
        ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
        ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
        ...(responsesReasoningItems.length > 0
          ? { responsesReasoningItems: [...responsesReasoningItems] }
          : {}),
      },
      errorMessage,
    ],
    ...(runtimeIntervention ? { runtimeIntervention } : {}),
    assistantUpdate: {
      content: accumulated,
      thinking: thinkingAccumulated,
      toolMeta,
    },
  };
}

/**
 * Build the injection for a graded loop-detection verdict (warn/block/compact).
 * Mirrors `handleMultipleMutationsError`'s shape so the web round loop can route
 * loop steering through the same conversation + apiMessages plumbing: the
 * model's tool-call turn is recorded, then a `[TOOL_RESULT]`-enveloped steering
 * note is appended so the model sees why its batch was skipped. The steering
 * copy comes from `buildLoopSteeringText` (shared kernel); this helper only
 * handles web message construction.
 */
export function buildLoopSteerInjection(
  steeringText: string,
  accumulated: string,
  thinkingAccumulated: string,
  reasoningBlocks: ReasoningBlock[],
  apiMessages: readonly ChatMessage[],
  provider: ActiveProvider,
  currentBranch?: string,
  responsesReasoningItems: ResponsesReasoningItem[] = [],
): MultipleMutationsErrorAction {
  const toolMeta = buildToolMeta({
    toolName: 'loop_detected',
    source: 'sandbox',
    provider,
    durationMs: 0,
    isError: true,
  });

  const errorMessage: ChatMessage = {
    id: createId(),
    role: 'user',
    content: formatToolResultEnvelope(steeringText),
    timestamp: Date.now(),
    status: 'done',
    isToolResult: true,
    ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
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
        ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
        ...(reasoningBlocks.length > 0 ? { reasoningBlocks: [...reasoningBlocks] } : {}),
        ...(responsesReasoningItems.length > 0
          ? { responsesReasoningItems: [...responsesReasoningItems] }
          : {}),
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
