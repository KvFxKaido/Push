/**
 * In-page Coder kernel-run builder — PR 1 of the Inline Foreground Lane
 * (see `docs/decisions/Inline Foreground Lane — Local While Watched.md`,
 * §"Implementation plan").
 *
 * The delegated arc has always run the shared Coder kernel in the browser
 * with web bindings; the assembly lived inside `coder-agent.ts`'s
 * `runCoderAgent` wrapper and a handful of inline closures in
 * `coder-delegation-handler.ts` / `useAgentDelegation.ts`. The inline
 * foreground lane (PR 2) needs the exact same wiring minus the
 * delegation-brief ceremony, so the reusable pieces move here:
 *
 *   - `runInPageCoderKernel` — the bindings builder. Takes a structured
 *     spec (resolved provider/model, sandbox, pre-built task preamble,
 *     memory scope, harness settings) and runs the lib kernel with the
 *     full browser service surface: capability ledger, turn policy,
 *     tool exec/detectors over web services, memory tools, tracing,
 *     file/symbol ledgers. `coder-agent.ts`'s `runCoderAgent` is now a
 *     signature-normalizing + preamble-building shim over this.
 *   - `teePushStream` — the streaming bridge primitive. Wraps a
 *     `PushStream` so every event is mirrored to an observer while
 *     flowing to the kernel unchanged. Dormant until PR 2's lane uses
 *     it to feed the chat transcript placeholder; the delegated arc
 *     does not tee.
 *   - `capturePreCoderSnapshot` — pre-run HEAD + untracked-file baseline
 *     the Auditor needs for ranged diffs and new-untracked detection
 *     (PRs #604/#606). Extracted from `coder-delegation-handler.ts`.
 *   - `createCoderCheckpointAnswerer` — the interactive-checkpoint
 *     answerer closure (Orchestrator-LLM answer + decision-memory
 *     write). Extracted from `coder-delegation-handler.ts`.
 *   - `runCoderAuditorGate` — the gated Auditor invocation
 *     (`evaluateAfterCoder` + non-empty summaries → `handleCoderAuditor`,
 *     else null). Extracted from `useAgentDelegation.ts`; the hook stays
 *     the policy owner by choosing to call the gate.
 *
 * Option-parity discipline: the delegated arc's kernel options must be
 * byte-equivalent before/after this extraction. `inline-coder-run.test.ts`
 * pins the assembled `CoderAgentOptions` at the lib boundary;
 * `delegation-handoff.integration.test.ts` pins the end-to-end prompt
 * surface.
 */

import type {
  ChatMessage,
  ChatCard,
  AcceptanceCriterion,
  AgentStatus,
  AgentStatusSource,
  CoderResult,
  CoderWorkingMemory,
  CriterionResult,
  HarnessProfileSettings,
  MemoryScope,
  RunEventInput,
} from '@/types';
import {
  generateCheckpointAnswer as generateCheckpointAnswerLib,
  runCoderAgent as runCoderAgentLib,
  summarizeCoderStateForHandoff,
  type CoderAgentOptions,
  type CoderCheckpointState,
} from '@push/lib/coder-agent';
import { createMemoryToolExecutor } from '@push/lib/memory-tool-exec';
import {
  buildCoderDetectors,
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  type CoderBindingServices,
} from '@push/lib/coder-agent-bindings';
import type { LlmMessage, PushStream, PushStreamEvent } from '@push/lib/provider-contract';
import type { CorrelationContext } from '@push/lib/correlation-context';
import { getActiveProvider, getProviderPushStream, type ActiveProvider } from './orchestrator';
import { getModelForRole } from './providers';
import { getUserProfile } from '@/hooks/useUserProfile';
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
import { MEMORY_TOOL_PROTOCOL } from './memory-tools';
import { CapabilityLedger, ROLE_CAPABILITIES, type Capability } from './capabilities';
import { detectAllToolCalls, detectAnyToolCall, type AnyToolCall } from './tool-dispatch';
import { fileLedger } from './file-awareness-ledger';
import { symbolLedger } from './symbol-persistence-ledger';
import { getSandboxDiff, execInSandbox, sandboxStatus } from './sandbox-client';
import { parseDiffStats } from './diff-utils';
import { getApprovalMode, buildApprovalModeBlock } from './approval-mode';
import { TurnPolicyRegistry, type TurnContext } from './turn-policy';
import { createCoderPolicy } from './turn-policies/coder-policy';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from './tracing';
import { formatVerificationPolicyBlock, type VerificationPolicy } from './verification-policy';
import { runContextMemoryBestEffort } from './memory-context-helpers';
import { writeDecisionMemory } from './context-memory';
import {
  handleCoderAuditor,
  parseUntrackedFileSet,
  type AuditorHandlerContext,
  type AuditorHandlerResult,
  type HandleCoderAuditorInput,
} from './auditor-delegation-handler';

// ---------------------------------------------------------------------------
// Stream tee
// ---------------------------------------------------------------------------

/**
 * Wrap a `PushStream` so every event is mirrored to `observe` while being
 * yielded to the consumer unchanged. The kernel consumes its stream
 * internally and exposes no token callback — the tee is how the inline
 * lane feeds `text_delta`/reasoning events into the chat transcript's
 * streaming placeholder without touching the kernel.
 *
 * Observer errors are swallowed: a UI mirror must never break the run.
 */
export function teePushStream(
  stream: PushStream<LlmMessage>,
  observe: (event: PushStreamEvent) => void,
): PushStream<LlmMessage> {
  return (req) =>
    (async function* () {
      for await (const event of stream(req)) {
        try {
          observe(event);
        } catch {
          /* mirror is best-effort; the kernel's copy always flows */
        }
        yield event;
      }
    })();
}

// ---------------------------------------------------------------------------
// Pre-Coder snapshot (Auditor baseline)
// ---------------------------------------------------------------------------

export interface PreCoderSnapshot {
  /**
   * HEAD SHA captured BEFORE the Coder runs, when git was healthy. The
   * Auditor uses it as `since_ref` so committed-but-clean-tree work stays
   * visible (PR #604). Undefined when the fetch failed.
   */
  preCoderHead: string | undefined;
  /**
   * Untracked paths captured BEFORE the Coder runs, the baseline that
   * keeps pre-existing ambient gunk from false-positives in the
   * untracked-evidence signal (PR #606). Undefined when the fetch failed
   * or omitted git_status.
   */
  preCoderUntrackedFiles: readonly string[] | undefined;
}

/**
 * Best-effort pre-run snapshot for the Auditor. A failure leaves both
 * fields undefined and the Auditor falls back to working-tree-only /
 * conservative behavior — never throws.
 */
export async function capturePreCoderSnapshot(sandboxId: string): Promise<PreCoderSnapshot> {
  try {
    const preDiff = await getSandboxDiff(sandboxId);
    return {
      preCoderHead: preDiff.head_sha,
      preCoderUntrackedFiles: preDiff.git_status
        ? Array.from(parseUntrackedFileSet(preDiff.git_status))
        : undefined,
    };
  } catch {
    return { preCoderHead: undefined, preCoderUntrackedFiles: undefined };
  }
}

// ---------------------------------------------------------------------------
// Interactive-checkpoint answerer
// ---------------------------------------------------------------------------

/**
 * Web-facing checkpoint-answer generator. Lives here (not in
 * `coder-agent.ts`) so the answerer factory below doesn't create a
 * `coder-agent` ↔ `inline-coder-run` import cycle; `coder-agent.ts`
 * re-exports it to preserve the historical import surface.
 */
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

export interface CoderCheckpointAnswererOptions {
  chatId: string;
  /** Multi-task progress prefix for status lines (e.g. `[2/3] `). */
  statusPrefix?: string;
  /** Recent chat history; the answerer slices the last 6 turns itself. */
  apiMessages: ChatMessage[];
  provider: ActiveProvider;
  model?: string;
  /** Decision-memory write scope; null skips persistence. */
  memoryScope: MemoryScope | null;
  readLatestCoderState: () => CoderWorkingMemory | null;
  /** Read at answer time so an answerer built early still sees the live signal. */
  getSignal: () => AbortSignal | undefined;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  /** Status attribution; the delegated arc uses 'coder'. */
  statusSource?: AgentStatusSource;
}

/**
 * Build the `onCheckpointRequest` closure: when the Coder pauses to ask
 * for guidance, answer with the lead model over recent chat history plus
 * the latest working-memory snapshot, and persist the Q/A as decision
 * memory. Extracted verbatim from the delegated arc's per-task closure.
 */
export function createCoderCheckpointAnswerer(
  opts: CoderCheckpointAnswererOptions,
): (question: string, context: string) => Promise<string> {
  const prefix = opts.statusPrefix ?? '';
  const source = opts.statusSource ?? 'coder';
  return async (question: string, context: string): Promise<string> => {
    opts.updateAgentStatus(
      { active: true, phase: `${prefix}Coder checkpoint`, detail: question },
      { chatId: opts.chatId, source },
    );

    const stateSummary = summarizeCoderStateForHandoff(opts.readLatestCoderState());
    const checkpointContext = [
      context.trim(),
      stateSummary ? `Latest coder state:\n${stateSummary}` : null,
    ]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join('\n\n');

    const answer = await generateCheckpointAnswer(
      question,
      checkpointContext,
      opts.apiMessages.slice(-6),
      opts.getSignal(),
      opts.provider,
      opts.model,
    );

    const memoryScope = opts.memoryScope;
    if (memoryScope) {
      await runContextMemoryBestEffort('persisting checkpoint decision memory', () =>
        writeDecisionMemory({
          scope: memoryScope,
          question,
          answer,
        }),
      );
    }

    opts.updateAgentStatus(
      { active: true, phase: `${prefix}Coder resuming...` },
      { chatId: opts.chatId, source },
    );
    return answer;
  };
}

// ---------------------------------------------------------------------------
// Auditor-invocation gate
// ---------------------------------------------------------------------------

/**
 * Gated Auditor invocation shared by the delegated arc and the inline
 * lane: fire `handleCoderAuditor` only when the harness profile asks for
 * post-Coder evaluation AND the Coder produced something to evaluate.
 * Returns null when the gate doesn't fire so callers can fold the
 * verdict (or its absence) into their outcome assembly.
 */
export async function runCoderAuditorGate(
  ctx: AuditorHandlerContext,
  input: HandleCoderAuditorInput,
): Promise<AuditorHandlerResult | null> {
  const { harnessSettings, summaries } = input.auditorInput;
  if (!harnessSettings.evaluateAfterCoder || summaries.length === 0) {
    return null;
  }
  return handleCoderAuditor(ctx, input);
}

// ---------------------------------------------------------------------------
// In-page kernel-run builder
// ---------------------------------------------------------------------------

/**
 * Everything the browser bindings need, post-resolution: the caller has
 * already applied provider/model overrides and built the task preamble
 * for its arc (delegation brief + planner + preload for the delegated
 * arc; raw user turn + context blocks for the inline lane).
 */
export interface InPageCoderKernelSpec {
  provider: ActiveProvider;
  modelId: string | undefined;
  sandboxId: string;
  /** Fully-built task preamble — the kernel consumes it verbatim. */
  taskPreamble: string;
  declaredCapabilities?: Capability[];
  branchContext?: { activeBranch: string; defaultBranch: string; protectMain: boolean };
  projectInstructions?: string;
  instructionFilename?: string;
  verificationPolicy?: VerificationPolicy;
  acceptanceCriteria?: AcceptanceCriterion[];
  harnessSettings?: HarnessProfileSettings;
  /**
   * Memory read/write scope (LCM). From session context, never the model.
   * Absent → memory tools are neither wired nor advertised.
   */
  memoryScope?: { repoFullName: string; branch?: string; chatId?: string };
  correlation?: CorrelationContext;
  /**
   * Override the provider stream — the inline lane passes a
   * `teePushStream` wrapper so tokens mirror into the transcript.
   * Defaults to `getProviderPushStream(provider)`.
   */
  stream?: PushStream<LlmMessage>;
  /** Seed the loop from a prior checkpoint (resume/adoption paths). */
  resumeState?: CoderCheckpointState<ChatCard>;
  /** Override the kernel's checkpoint cadence (rounds). */
  checkpointCadenceRounds?: number;
}

export interface InPageCoderKernelCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  onCheckpointRequest?: (question: string, context: string) => Promise<string>;
  /** Durable-resume checkpoint hook — the inline lane bridges this into V1 capture. */
  onCheckpoint?: (state: CoderCheckpointState<ChatCard>) => Promise<void>;
  onWorkingMemoryUpdate?: (state: CoderWorkingMemory) => void;
  onRunEvent?: (event: RunEventInput) => void;
}

// ---------------------------------------------------------------------------
// Fetch a compact sandbox state summary (changed files + stats), used to
// auto-sync sandbox state back to the lead loop after the Coder finishes.
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

/**
 * Run the shared Coder kernel in the browser with the full web service
 * surface. This is the single assembly point both arcs route through —
 * the option bag built here is what the parity tests pin.
 */
export async function runInPageCoderKernel(
  spec: InPageCoderKernelSpec,
  callbacks: InPageCoderKernelCallbacks,
): Promise<CoderResult> {
  if (spec.provider === 'demo') {
    throw new Error('No AI provider configured. Add an API key in Settings.');
  }

  // --- Capability ledger ---
  const declaredCaps = spec.declaredCapabilities ?? Array.from(ROLE_CAPABILITIES.coder);
  const capabilityLedger = new CapabilityLedger(declaredCaps);

  // --- Turn policy registry (Coder-only) ---
  const policyRegistry = new TurnPolicyRegistry();
  policyRegistry.register(createCoderPolicy());
  const turnCtx: TurnContext = {
    role: 'coder',
    round: 0,
    maxRounds: spec.harnessSettings?.maxCoderRounds ?? 30,
    sandboxId: spec.sandboxId,
    allowedRepo: '',
    activeProvider: spec.provider,
    activeModel: spec.modelId,
    signal: callbacks.signal,
  };

  const verificationPolicyBlock = formatVerificationPolicyBlock(spec.verificationPolicy);
  const approvalModeBlock = buildApprovalModeBlock(getApprovalMode());

  // --- Bindings services: the Web-side adapter into the shared
  // `lib/coder-agent-bindings.ts` closure builders. ---
  const bindingsServices: CoderBindingServices<
    AnyToolCall,
    SandboxToolCall,
    WebSearchToolCall,
    ChatCard
  > = {
    policy: policyRegistry,
    capabilityLedger,
    turnCtx,
    onStatus: callbacks.onStatus,
    correlation: spec.correlation,
    activeProvider: spec.provider,
    activeModel: spec.modelId,
    sandboxId: spec.sandboxId,
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
    // Memory tools (LCM) — only wired when the caller threaded a scope;
    // captured from session context, never from model args. Absent scope →
    // undefined → kernel denies memory.
    executeMemory: spec.memoryScope
      ? createMemoryToolExecutor({
          repoFullName: spec.memoryScope.repoFullName,
          branch: spec.memoryScope.branch,
          chatId: spec.memoryScope.chatId,
        })
      : undefined,
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
    provider: spec.provider,
    stream:
      spec.stream ?? (getProviderPushStream(spec.provider) as unknown as PushStream<LlmMessage>),
    modelId: spec.modelId,
    sandboxId: spec.sandboxId,
    allowedRepo: '',
    branchContext: spec.branchContext,
    projectInstructions: spec.projectInstructions,
    instructionFilename: spec.instructionFilename,
    userProfile: getUserProfile(),
    taskPreamble: spec.taskPreamble,
    symbolSummary: symbolLedger.getSummary(),
    toolExec,
    detectAllToolCalls: detectAllToolCallsFiltered,
    detectAnyToolCall: detectCoderToolCall,
    webSearchToolProtocol: WEB_SEARCH_TOOL_PROTOCOL,
    sandboxToolProtocol: getSandboxToolProtocol(),
    // Advertise memory tools only when scope was threaded (so executeMemory
    // is wired) — keeps advertising aligned with executor support (LCM).
    memoryToolProtocol: spec.memoryScope ? MEMORY_TOOL_PROTOCOL : undefined,
    verificationPolicyBlock,
    approvalModeBlock,
    evaluateAfterModel,
    acceptanceCriteria: spec.acceptanceCriteria,
    harnessMaxRounds: spec.harnessSettings?.maxCoderRounds,
    harnessContextResetsEnabled: spec.harnessSettings?.contextResetsEnabled,
    resumeState: spec.resumeState,
    checkpointCadenceRounds: spec.checkpointCadenceRounds,
  };

  // --- Run the lib kernel ---
  const result = await runCoderAgentLib(libOptions, {
    onStatus: callbacks.onStatus,
    signal: callbacks.signal,
    onCheckpointRequest: callbacks.onCheckpointRequest,
    onCheckpoint: callbacks.onCheckpoint,
    onWorkingMemoryUpdate: callbacks.onWorkingMemoryUpdate,
    onAdvanceRound: () => fileLedger.advanceRound(),
    getFileAwarenessSummary: () => fileLedger.getAwarenessSummary(),
    runAcceptanceCriterion: async (criterion) => {
      const checkResult = await execInSandbox(spec.sandboxId, criterion.check);
      return {
        exitCode: checkResult.exitCode,
        output: (checkResult.stdout + '\n' + checkResult.stderr).trim(),
      };
    },
    fetchSandboxStateSummary: () => fetchSandboxStateSummary(spec.sandboxId),
    onRunEvent: callbacks.onRunEvent,
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
