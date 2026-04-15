/**
 * App compatibility wrapper for the shared Coder agent.
 *
 * The canonical module now lives in `lib/coder-agent.ts` (moved in Phase 5D
 * step 2, following the Phase 5D step 1 Explorer precedent). This wrapper
 * preserves the Web-side public API so existing call sites
 * (`useAgentDelegation.ts`, `coder-agent.test.ts`,
 * `delegation-handoff.integration.test.ts`) keep working unchanged.
 *
 * It re-exports the 10 pure helpers + `generateCheckpointAnswer` from the
 * lib kernel and injects the DI points the lib kernel needs at the call
 * boundary:
 *
 *  1. `userProfile`             — `getUserProfile()` from `@/hooks/useUserProfile`
 *  2. `taskPreamble`            — `buildCoderDelegationBrief(envelope)` + plannerBrief
 *  3. `symbolSummary`           — `symbolLedger.getSummary()`
 *  4. `toolExec`                — closure wrapping `policyRegistry.evaluateBeforeTool`
 *                                 → `withActiveSpan` + capability check + `executeSandboxToolCall`
 *                                 /`executeWebSearch` → `policyRegistry.evaluateAfterTool`, plus a
 *                                 sandbox health-check probe on `SANDBOX_UNREACHABLE`
 *  5. `detectAllToolCalls`      — wrapped to filter sandbox-source parallel reads
 *  6. `detectAnyToolCall`       — wrapped to keep Coder on sandbox/web-search tools
 *  7. `webSearchToolProtocol`   — `WEB_SEARCH_TOOL_PROTOCOL`
 *  8. `evaluateAfterModel`      — flattened adapter around `policyRegistry.evaluateAfterModel`
 *  9. `verificationPolicyBlock` — `formatVerificationPolicyBlock(verificationPolicy)`
 * 10. `approvalModeBlock`       — `buildApprovalModeBlock(getApprovalMode())`
 *
 * The `'demo'` provider guard stays here — the lib kernel assumes a real
 * provider and rejecting demo is a Web-layer concern.
 */

import type {
  ChatMessage,
  ChatCard,
  AcceptanceCriterion,
  CriterionResult,
  DelegationEnvelope,
  CoderCallbacks,
  CoderResult,
  HarnessProfileSettings,
} from '@/types';
import {
  runCoderAgent as runCoderAgentLib,
  generateCheckpointAnswer as generateCheckpointAnswerLib,
  applyObservationUpdates,
  detectUpdateStateCall,
  formatCoderState,
  formatCoderStateDiff,
  invalidateObservationDependencies,
  normalizeTrimmedRoleAlternation,
  shouldInjectCoderStateOnToolResult,
  summarizeCoderStateForHandoff,
  type CoderAgentOptions,
  type CoderAfterModelResult,
  type CoderToolExecResult,
} from '@push/lib/coder-agent';
import { getActiveProvider, getProviderStreamFn, type ActiveProvider } from './orchestrator';
import { getUserProfile } from '@/hooks/useUserProfile';
import { getModelForRole } from './providers';
import {
  detectSandboxToolCall,
  executeSandboxToolCall,
  getSandboxToolProtocol,
} from './sandbox-tools';
import {
  detectWebSearchToolCall,
  executeWebSearch,
  WEB_SEARCH_TOOL_PROTOCOL,
} from './web-search-tools';
import { CapabilityLedger, ROLE_CAPABILITIES } from './capabilities';
import { detectAllToolCalls, detectAnyToolCall, type AnyToolCall } from './tool-dispatch';
import { fileLedger } from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import { getSandboxDiff, execInSandbox, sandboxStatus } from './sandbox-client';
import { parseDiffStats } from './diff-utils';
import { buildCoderDelegationBrief } from './role-context';
import { getApprovalMode, buildApprovalModeBlock } from './approval-mode';
import { TurnPolicyRegistry, type TurnContext } from './turn-policy';
import { createCoderPolicy } from './turn-policies/coder-policy';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from './tracing';
import {
  correlationToSpanAttributes,
  EMPTY_CORRELATION_CONTEXT,
  type CorrelationContext,
} from '@push/lib/correlation-context';
import { formatVerificationPolicyBlock, type VerificationPolicy } from './verification-policy';

// ---------------------------------------------------------------------------
// Pure-helper re-exports — the Coder agent test suite and useAgentDelegation
// import these from `./coder-agent`. Keep the paths unchanged.
// ---------------------------------------------------------------------------

export {
  applyObservationUpdates,
  detectUpdateStateCall,
  formatCoderState,
  formatCoderStateDiff,
  invalidateObservationDependencies,
  normalizeTrimmedRoleAlternation,
  shouldInjectCoderStateOnToolResult,
  summarizeCoderStateForHandoff,
};

export type { CoderAgentOptions, CoderAfterModelResult, CoderToolExecResult };

// ---------------------------------------------------------------------------
// Checkpoint answer — Web-facing signature preserved.
// ---------------------------------------------------------------------------

export async function generateCheckpointAnswer(
  question: string,
  coderContext: string,
  recentChatHistory?: ChatMessage[],
  signal?: AbortSignal,
  providerOverride?: ActiveProvider,
  modelOverride?: string,
): Promise<string> {
  const activeProvider = providerOverride || getActiveProvider();
  if (activeProvider === 'demo') {
    return 'No AI provider configured. Try a different approach.';
  }
  const { streamFn } = getProviderStreamFn(activeProvider);
  const roleModel = getModelForRole(activeProvider, 'orchestrator');
  const modelId = modelOverride || roleModel?.id;

  return generateCheckpointAnswerLib(question, coderContext, {
    streamFn: streamFn as unknown as Parameters<typeof generateCheckpointAnswerLib>[2]['streamFn'],
    modelId,
    recentChatHistory,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Fetch a compact sandbox state summary (changed files + stats).
// Used to auto-sync sandbox state back to the Orchestrator after Coder finishes.
// ---------------------------------------------------------------------------

async function fetchSandboxStateSummary(sandboxId: string): Promise<string> {
  try {
    const diffResult = await getSandboxDiff(sandboxId);
    if (diffResult.error) {
      return `\n\n[Sandbox State] Could not retrieve diff: ${diffResult.error}`;
    }
    if (!diffResult.diff) {
      return '\n\n[Sandbox State] No uncommitted changes.';
    }
    const { fileNames, additions, deletions } = parseDiffStats(diffResult.diff);
    const MAX_FILES_LISTED = 10;
    const fileList =
      fileNames.length > MAX_FILES_LISTED
        ? `${fileNames.slice(0, MAX_FILES_LISTED).join(', ')} (+${fileNames.length - MAX_FILES_LISTED} more)`
        : fileNames.join(', ');
    return `\n\n[Sandbox State] ${fileNames.length} file(s) changed, +${additions} -${deletions}. Files: ${fileList}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `\n\n[Sandbox State] Failed to fetch diff: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// runCoderAgent — preserves the original Web-facing signature (envelope form
// and legacy positional form). Internally builds the lib `CoderAgentOptions`
// by wiring every DI slot to the real Web services.
// ---------------------------------------------------------------------------

export async function runCoderAgent(
  taskOrEnvelope: string | DelegationEnvelope,
  sandboxId: string,
  filesOrCallbacks: string[] | CoderCallbacks,
  onStatus?: (phase: string, detail?: string) => void,
  agentsMd?: string,
  signal?: AbortSignal,
  onCheckpoint?: (question: string, context: string) => Promise<string>,
  acceptanceCriteria?: AcceptanceCriterion[],
  onWorkingMemoryUpdate?: (state: import('@/types').CoderWorkingMemory) => void,
  providerOverride?: ActiveProvider,
  modelOverride?: string,
  delegationContext?: {
    intent?: string;
    deliverable?: string;
    knownContext?: string[];
    constraints?: string[];
    branchContext?: { activeBranch: string; defaultBranch: string; protectMain: boolean };
    instructionFilename?: string;
    harnessSettings?: HarnessProfileSettings;
    plannerBrief?: string;
    verificationPolicy?: VerificationPolicy;
    declaredCapabilities?: import('./capabilities').Capability[];
    /**
     * Passive correlation tags captured by the caller and threaded into
     * tool-execution spans (`push.chat_id`, `push.execution_id`, etc.).
     * Never alters tool behavior — see `lib/correlation-context.ts`.
     */
    correlation?: CorrelationContext;
  },
): Promise<CoderResult> {
  // --- Normalise: envelope-based call → unified locals ---
  let task: string;
  let files: string[];
  let statusFn: (phase: string, detail?: string) => void;
  let effectiveAgentsMd: string | undefined;
  let effectiveSignal: AbortSignal | undefined;
  let effectiveOnCheckpoint: ((question: string, context: string) => Promise<string>) | undefined;
  let effectiveAcceptanceCriteria: AcceptanceCriterion[] | undefined;
  let effectiveOnWorkingMemoryUpdate:
    | ((state: import('@/types').CoderWorkingMemory) => void)
    | undefined;
  let effectiveProviderOverride: ActiveProvider | undefined;
  let effectiveModelOverride: string | undefined;
  let effectiveDelegationContext: typeof delegationContext;
  let effectiveHarnessSettings: HarnessProfileSettings | undefined;
  let effectivePlannerBrief: string | undefined;
  let envelopeDeclaredCapabilities: import('./capabilities').Capability[] | undefined;

  if (typeof taskOrEnvelope === 'object') {
    const envelope = taskOrEnvelope;
    const callbacks = filesOrCallbacks as CoderCallbacks;
    task = envelope.task;
    files = envelope.files;
    statusFn = callbacks.onStatus;
    effectiveAgentsMd = envelope.projectInstructions;
    effectiveSignal = callbacks.signal;
    effectiveOnCheckpoint = callbacks.onCheckpoint;
    effectiveAcceptanceCriteria = envelope.acceptanceCriteria;
    effectiveOnWorkingMemoryUpdate = callbacks.onWorkingMemoryUpdate;
    effectiveProviderOverride =
      envelope.provider === 'demo' ? undefined : (envelope.provider as ActiveProvider);
    effectiveModelOverride = envelope.model;
    effectiveHarnessSettings = envelope.harnessSettings;
    effectivePlannerBrief = envelope.plannerBrief;
    envelopeDeclaredCapabilities = envelope.declaredCapabilities;
    effectiveDelegationContext = {
      intent: envelope.intent,
      deliverable: envelope.deliverable,
      knownContext: envelope.knownContext,
      constraints: envelope.constraints,
      branchContext: envelope.branchContext,
      instructionFilename: envelope.instructionFilename,
      verificationPolicy: envelope.verificationPolicy,
      correlation: envelope.correlation,
    };
  } else {
    task = taskOrEnvelope;
    files = filesOrCallbacks as string[];
    statusFn = onStatus!;
    effectiveAgentsMd = agentsMd;
    effectiveSignal = signal;
    effectiveOnCheckpoint = onCheckpoint;
    effectiveAcceptanceCriteria = acceptanceCriteria;
    effectiveOnWorkingMemoryUpdate = onWorkingMemoryUpdate;
    effectiveProviderOverride = providerOverride;
    effectiveModelOverride = modelOverride;
    effectiveHarnessSettings = delegationContext?.harnessSettings;
    effectivePlannerBrief = delegationContext?.plannerBrief;
    effectiveDelegationContext = delegationContext;
    envelopeDeclaredCapabilities = delegationContext?.declaredCapabilities;
  }

  // --- Resolve provider/model ---
  const activeProvider = effectiveProviderOverride || getActiveProvider();
  if (activeProvider === 'demo') {
    throw new Error('No AI provider configured. Add an API key in Settings.');
  }
  const { streamFn } = getProviderStreamFn(activeProvider);
  const roleModel = getModelForRole(activeProvider, 'coder');
  const coderModelId = effectiveModelOverride || roleModel?.id;

  // --- Capability ledger ---
  const declaredCaps = envelopeDeclaredCapabilities ?? Array.from(ROLE_CAPABILITIES.coder);
  const capabilityLedger = new CapabilityLedger(declaredCaps);

  // --- Turn policy registry (Coder-only) ---
  const policyRegistry = new TurnPolicyRegistry();
  policyRegistry.register(createCoderPolicy());
  const turnCtx: TurnContext = {
    role: 'coder',
    round: 0,
    maxRounds: effectiveHarnessSettings?.maxCoderRounds ?? 30,
    sandboxId,
    allowedRepo: '',
    activeProvider,
    activeModel: coderModelId,
    signal: effectiveSignal,
  };

  // --- Build pre-built string slots ---
  let taskPreamble = buildCoderDelegationBrief({
    task,
    files,
    acceptanceCriteria: effectiveAcceptanceCriteria,
    intent: effectiveDelegationContext?.intent,
    deliverable: effectiveDelegationContext?.deliverable,
    knownContext: effectiveDelegationContext?.knownContext,
    constraints: effectiveDelegationContext?.constraints,
    provider: activeProvider,
    model: coderModelId,
  } as DelegationEnvelope);
  if (effectivePlannerBrief) {
    taskPreamble += '\n\n' + effectivePlannerBrief;
  }

  const verificationPolicyBlock = formatVerificationPolicyBlock(
    effectiveDelegationContext?.verificationPolicy,
  );
  const approvalModeBlock = buildApprovalModeBlock(getApprovalMode());

  // --- DetectAllToolCalls wrapper: filter sandbox-only parallel path ---
  const detectAllToolCallsFiltered = (text: string) => {
    const raw = detectAllToolCalls(text);
    const sandboxReads = raw.readOnly.filter((c) => c.source === 'sandbox');
    const sandboxFileMutations = raw.fileMutations.filter((c) => c.source === 'sandbox');
    const sandboxMutating = raw.mutating?.source === 'sandbox' ? raw.mutating : null;
    return {
      readOnly: sandboxReads,
      fileMutations: sandboxFileMutations,
      mutating: sandboxMutating,
      extraMutations: raw.extraMutations,
    };
  };

  const detectCoderToolCall = (text: string): AnyToolCall | null => {
    const sandboxCall = detectSandboxToolCall(text);
    if (sandboxCall) return { source: 'sandbox', call: sandboxCall };

    const webSearchCall = detectWebSearchToolCall(text);
    if (webSearchCall) return { source: 'web-search', call: webSearchCall };

    const recoveredCall = detectAnyToolCall(text);
    if (recoveredCall?.source === 'sandbox' || recoveredCall?.source === 'web-search') {
      return recoveredCall;
    }
    return null;
  };

  // --- toolExec closure: evaluateBeforeTool + withActiveSpan + execute + evaluateAfterTool ---
  const toolExec = async (
    call: AnyToolCall,
    execCtx: { round: number; phase?: string },
  ): Promise<CoderToolExecResult<ChatCard>> => {
    turnCtx.round = execCtx.round;
    turnCtx.phase = execCtx.phase;

    // Extract structural tool/args via cast. Scratchpad is the only variant
    // where `.call.args` is absent, and Coder never dispatches scratchpad,
    // so the cast is safe in practice and the before-hook reads both fields
    // as `unknown`.
    const callStructural = call as unknown as {
      call: { tool: string; args?: Record<string, unknown> };
    };

    if (call.source !== 'sandbox' && call.source !== 'web-search') {
      return {
        kind: 'denied',
        reason: `Coder can only execute sandbox and web_search tools. "${callStructural.call.tool}" is not available to Coder.`,
      };
    }

    // Phase-aware tool gating
    const beforeResult = await policyRegistry.evaluateBeforeTool(
      callStructural.call.tool,
      (callStructural.call.args ?? {}) as Record<string, unknown>,
      turnCtx,
    );
    if (beforeResult?.action === 'deny') {
      return { kind: 'denied', reason: beforeResult.reason };
    }

    // --- Execute via appropriate source ---
    if (call.source === 'web-search') {
      const wsCall = call as Extract<AnyToolCall, { source: 'web-search' }>;
      const wsResult = await withActiveSpan(
        'tool.execute',
        {
          scope: 'push.coder',
          kind: SpanKind.INTERNAL,
          attributes: {
            ...correlationToSpanAttributes(
              effectiveDelegationContext?.correlation ?? EMPTY_CORRELATION_CONTEXT,
            ),
            'push.agent.role': 'coder',
            'push.round': execCtx.round,
            'push.tool.name': 'web_search',
            'push.tool.source': 'web-search',
            'push.provider': activeProvider,
            'push.model': coderModelId,
          },
        },
        async (span) => {
          if (!capabilityLedger.isToolAllowed('web_search')) {
            const missing = capabilityLedger.getMissingCapabilities('web_search');
            return {
              text: `[Tool Blocked — web_search] This tool requires capabilities not declared for this run: ${missing.join(', ')}. The delegation must include these capabilities to use this tool.`,
              structuredError: {
                type: 'APPROVAL_GATE_BLOCKED' as const,
                retryable: false,
                message: `Capability violation: ${missing.join(', ')} not declared`,
              },
            };
          }
          const inner = await executeWebSearch(wsCall.call.args.query, activeProvider);
          capabilityLedger.recordToolUse('web_search');
          setSpanAttributes(span, {
            'push.tool.error_type': inner.structuredError?.type,
            'push.tool.retryable': inner.structuredError?.retryable,
          });
          if (inner.structuredError) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: inner.structuredError.message,
            });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          return inner;
        },
      );

      const afterToolResult = await policyRegistry.evaluateAfterTool(
        'web_search',
        call.call.args as Record<string, unknown>,
        wsResult.text,
        Boolean(wsResult.structuredError),
        turnCtx,
      );
      const policyPost =
        afterToolResult?.action === 'inject'
          ? { kind: 'inject' as const, content: afterToolResult.message.content }
          : afterToolResult?.action === 'halt'
            ? { kind: 'halt' as const, summary: afterToolResult.summary }
            : undefined;

      return {
        kind: 'executed',
        resultText: wsResult.text,
        card: wsResult.card,
        errorType: wsResult.structuredError?.type,
        policyPost,
      };
    }

    // --- Sandbox path (default) ---
    const sandboxCall = call as Extract<AnyToolCall, { source: 'sandbox' }>;
    const sbResult = await withActiveSpan(
      'tool.execute',
      {
        scope: 'push.coder',
        kind: SpanKind.INTERNAL,
        attributes: {
          ...correlationToSpanAttributes(
            effectiveDelegationContext?.correlation ?? EMPTY_CORRELATION_CONTEXT,
          ),
          'push.agent.role': 'coder',
          'push.round': execCtx.round,
          'push.tool.name': sandboxCall.call.tool,
          'push.tool.source': 'sandbox',
          'push.provider': activeProvider,
          'push.model': coderModelId,
        },
      },
      async (span) => {
        if (!capabilityLedger.isToolAllowed(sandboxCall.call.tool)) {
          const missing = capabilityLedger.getMissingCapabilities(sandboxCall.call.tool);
          return {
            text: `[Tool Blocked — ${sandboxCall.call.tool}] This tool requires capabilities not declared for this run: ${missing.join(', ')}. The delegation must include these capabilities to use this tool.`,
            structuredError: {
              type: 'APPROVAL_GATE_BLOCKED' as const,
              retryable: false,
              message: `Capability violation: ${missing.join(', ')} not declared`,
            },
          };
        }
        const inner = await executeSandboxToolCall(
          sandboxCall.call as Parameters<typeof executeSandboxToolCall>[0],
          sandboxId,
          {
            auditorProviderOverride: activeProvider,
            auditorModelOverride: coderModelId,
          },
        );
        capabilityLedger.recordToolUse(sandboxCall.call.tool);
        setSpanAttributes(span, {
          'push.tool.error_type': inner.structuredError?.type,
          'push.tool.retryable': inner.structuredError?.retryable,
        });
        if (inner.structuredError) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: inner.structuredError.message,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return inner;
      },
    );

    // --- Sandbox health check on SANDBOX_UNREACHABLE ---
    let sandboxProbePolicyPost:
      | { kind: 'inject'; content: string }
      | { kind: 'halt'; summary: string }
      | undefined;
    if (sbResult.structuredError?.type === 'SANDBOX_UNREACHABLE') {
      statusFn('Health check', 'Sandbox unreachable — validating...');
      try {
        const status = await sandboxStatus(sandboxId);
        const healthMsg = status.error
          ? `Sandbox health check failed: ${status.error}. Container may be expired or terminated.`
          : `Sandbox is reachable. HEAD=${status.head}, ${status.changedFiles.length} dirty file(s). Previous error may have been transient.`;
        sandboxProbePolicyPost = {
          kind: 'inject',
          content: `[SANDBOX_HEALTH_CHECK]\n${healthMsg}\nIf the container is unstable, stop mutation attempts and summarize your progress so far.\n[/SANDBOX_HEALTH_CHECK]`,
        };
      } catch {
        sandboxProbePolicyPost = {
          kind: 'halt',
          summary: `[Coder stopped — sandbox is unreachable. Container may have expired or terminated. Task is incomplete.]`,
        };
      }
    }

    // --- Policy bridge: afterToolExec ---
    const afterToolResult = await policyRegistry.evaluateAfterTool(
      sandboxCall.call.tool,
      sandboxCall.call.args as Record<string, unknown>,
      sbResult.text,
      Boolean(sbResult.structuredError),
      turnCtx,
    );
    const policyFromAfter =
      afterToolResult?.action === 'inject'
        ? { kind: 'inject' as const, content: afterToolResult.message.content }
        : afterToolResult?.action === 'halt'
          ? { kind: 'halt' as const, summary: afterToolResult.summary }
          : undefined;

    // Prefer sandbox health probe over afterTool policy (health probe is the
    // more urgent signal and the original inline code ran it first).
    const policyPost = sandboxProbePolicyPost ?? policyFromAfter;

    return {
      kind: 'executed',
      resultText: sbResult.text,
      card: sbResult.card,
      errorType: sbResult.structuredError?.type,
      policyPost,
    };
  };

  // --- evaluateAfterModel closure ---
  const evaluateAfterModel = async (
    response: string,
    round: number,
  ): Promise<CoderAfterModelResult> => {
    turnCtx.round = round;
    // Coder policy's afterModelCall hooks ignore `messages` (see
    // turn-policies/coder-policy.ts — _messages is underscore-prefixed). An
    // empty buffer keeps the lib kernel free of ChatMessage coupling.
    const emptyMessages: ChatMessage[] = [];
    const result = await policyRegistry.evaluateAfterModel(response, emptyMessages, turnCtx);
    if (!result) return null;
    if (result.action === 'halt') {
      return { action: 'halt', summary: result.summary };
    }
    return { action: 'inject', content: result.message.content };
  };

  // --- Build lib options ---
  const libOptions: CoderAgentOptions<AnyToolCall, ChatCard> = {
    provider: activeProvider,
    streamFn: streamFn as unknown as CoderAgentOptions<AnyToolCall, ChatCard>['streamFn'],
    modelId: coderModelId,
    sandboxId,
    allowedRepo: '',
    branchContext: effectiveDelegationContext?.branchContext,
    projectInstructions: effectiveAgentsMd,
    instructionFilename: effectiveDelegationContext?.instructionFilename,
    userProfile: getUserProfile(),
    taskPreamble,
    symbolSummary: symbolLedger.getSummary(),
    toolExec,
    detectAllToolCalls: detectAllToolCallsFiltered,
    detectAnyToolCall: detectCoderToolCall,
    webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
    sandboxToolProtocol: getSandboxToolProtocol(),
    verificationPolicyBlock,
    approvalModeBlock,
    evaluateAfterModel,
    acceptanceCriteria: effectiveAcceptanceCriteria,
    harnessMaxRounds: effectiveHarnessSettings?.maxCoderRounds,
    harnessContextResetsEnabled: effectiveHarnessSettings?.contextResetsEnabled,
  };

  // --- Run the lib kernel ---
  const result = await runCoderAgentLib(libOptions, {
    onStatus: statusFn,
    signal: effectiveSignal,
    onCheckpointRequest: effectiveOnCheckpoint,
    onWorkingMemoryUpdate: effectiveOnWorkingMemoryUpdate,
    onAdvanceRound: () => fileLedger.advanceRound(),
    getFileAwarenessSummary: () => fileLedger.getAwarenessSummary(),
    runAcceptanceCriterion: async (criterion) => {
      const checkResult = await execInSandbox(sandboxId, criterion.check);
      return {
        exitCode: checkResult.exitCode,
        output: (checkResult.stdout + '\n' + checkResult.stderr).trim(),
      };
    },
    fetchSandboxStateSummary: () => fetchSandboxStateSummary(sandboxId),
  });

  // --- Attach capability snapshot at the shell boundary ---
  const criteriaResults: CriterionResult[] | undefined = result.criteriaResults?.map((r) => ({
    id: r.id,
    passed: r.passed,
    exitCode: r.exitCode,
    output: r.output,
  }));

  return {
    summary: result.summary,
    cards: result.cards,
    rounds: result.rounds,
    checkpoints: result.checkpoints,
    criteriaResults,
    capabilitySnapshot: capabilityLedger.snapshot(),
  };
}
