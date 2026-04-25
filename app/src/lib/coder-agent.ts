/**
 * App compatibility wrapper for the shared Coder agent.
 *
 * The canonical module lives in `lib/coder-agent.ts` (Phase 5D step 2).
 * Three of the 10 DI slots — the `toolExec` closure, the Coder-filtered
 * detectors, and the `evaluateAfterModel` bridge — are also shared, now
 * living in `lib/coder-agent-bindings.ts` so the Durable-Object Phase 1
 * background-jobs runtime (`docs/runbooks/Background Coder Tasks Phase 1.md`)
 * can call the same closure builders with server-side substitutes for
 * policy/tracing/HTTP execution.
 *
 * This wrapper preserves the Web-side public API so existing call sites
 * (`useAgentDelegation.ts`, `coder-agent.test.ts`,
 * `delegation-handoff.integration.test.ts`) keep working unchanged. It
 * owns the Web-only setup that is not yet lib-safe:
 *
 *  - provider/model resolution (`getActiveProvider`, `getProviderPushStream`,
 *    `getModelForRole`)
 *  - `'demo'` provider guard
 *  - `TurnPolicyRegistry` + `TurnContext` construction (pulls `ChatMessage`)
 *  - pre-built prompt blocks: `taskPreamble` (delegation brief),
 *    `verificationPolicyBlock`, `approvalModeBlock` (reads localStorage)
 *  - ledger services the lib kernel still calls via callbacks:
 *    `fileLedger`, `symbolLedger`, `execInSandbox`, `fetchSandboxStateSummary`
 *  - `CapabilityLedger` creation and post-run snapshot
 *
 * Everything the lib kernel sees as DI-injected services goes through the
 * `CoderBindingServices` object assembled below and fed into
 * `buildCoderToolExec` / `buildCoderDetectors` / `buildCoderEvaluateAfterModel`.
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
import {
  buildCoderDetectors,
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  type CoderBindingServices,
} from '@push/lib/coder-agent-bindings';
import type { LlmMessage, PushStream } from '@push/lib/provider-contract';
import { getActiveProvider, getProviderPushStream, type ActiveProvider } from './orchestrator';
import { getUserProfile } from '@/hooks/useUserProfile';
import { getModelForRole } from './providers';
import {
  detectSandboxToolCall,
  executeSandboxToolCall,
  getSandboxToolProtocol,
  type SandboxToolCall,
} from './sandbox-tools';
import {
  detectWebSearchToolCall,
  executeWebSearch,
  WEB_SEARCH_TOOL_PROTOCOL,
  type WebSearchToolCall,
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
import { type CorrelationContext } from '@push/lib/correlation-context';
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
  const roleModel = getModelForRole(activeProvider, 'orchestrator');
  const modelId = modelOverride || roleModel?.id;

  return generateCheckpointAnswerLib(question, coderContext, {
    stream: getProviderPushStream(activeProvider) as unknown as PushStream<LlmMessage>,
    provider: activeProvider,
    modelId,
    recentChatHistory: recentChatHistory as unknown as Parameters<
      typeof generateCheckpointAnswerLib
    >[2]['recentChatHistory'],
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

  // --- Bindings services: the Web-side adapter into the shared
  // `lib/coder-agent-bindings.ts` closure builders. The adapter layer
  // exists so the Durable-Object runtime (Phase 1 background jobs) can
  // build its own services object with server substitutes without
  // duplicating the policy/tracing/tool-exec plumbing.
  const bindingsServices: CoderBindingServices<
    AnyToolCall,
    SandboxToolCall,
    WebSearchToolCall,
    ChatCard
  > = {
    policy: policyRegistry,
    capabilityLedger,
    turnCtx,
    onStatus: statusFn,
    correlation: effectiveDelegationContext?.correlation,
    activeProvider,
    activeModel: coderModelId,
    sandboxId,
    tracing: {
      withActiveSpan<T>(
        name: string,
        options: { scope?: string; kind?: unknown; attributes?: Record<string, unknown> },
        fn: (span: { setStatus(status: { code: unknown; message?: string }): void }) => Promise<T>,
      ): Promise<T> {
        return withActiveSpan(
          name,
          options as Parameters<typeof withActiveSpan>[1],
          fn as unknown as Parameters<typeof withActiveSpan<T>>[2],
        );
      },
      setSpanAttributes: (span, attrs) =>
        setSpanAttributes(
          span as Parameters<typeof setSpanAttributes>[0],
          attrs as Parameters<typeof setSpanAttributes>[1],
        ),
      spanKindInternal: SpanKind.INTERNAL,
      spanStatusOk: SpanStatusCode.OK,
      spanStatusError: SpanStatusCode.ERROR,
    },
    executeSandboxToolCall: (call, id, opts) =>
      executeSandboxToolCall(call, id, {
        auditorProviderOverride: opts.auditorProviderOverride as ActiveProvider,
        auditorModelOverride: opts.auditorModelOverride,
      }),
    executeWebSearch: (query, provider) => executeWebSearch(query, provider as ActiveProvider),
    sandboxStatus,
    detectSandboxToolCall,
    detectWebSearchToolCall,
    detectAnyToolCall,
    detectAllToolCalls,
    tagSandboxCall: (call): AnyToolCall => ({ source: 'sandbox', call }),
    tagWebSearchCall: (call): AnyToolCall => ({ source: 'web-search', call }),
  };

  const { detectAllToolCalls: detectAllToolCallsFiltered, detectAnyToolCall: detectCoderToolCall } =
    buildCoderDetectors(bindingsServices);
  const toolExec = buildCoderToolExec(bindingsServices);
  const evaluateAfterModel = buildCoderEvaluateAfterModel(bindingsServices);

  // --- Build lib options ---
  const libOptions: CoderAgentOptions<AnyToolCall, ChatCard> = {
    provider: activeProvider,
    stream: getProviderPushStream(activeProvider) as unknown as PushStream<LlmMessage>,
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
