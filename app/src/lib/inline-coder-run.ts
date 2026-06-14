/**
 * In-page Coder kernel-run builder — PR 1 of the Inline Foreground Lane
 * (see `docs/archive/decisions/Inline Foreground Lane — Local While Watched.md`,
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
  BranchSwitchPayload,
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
import { WebToolExecutionRuntime } from './web-tool-execution-runtime';
import { createDefaultApprovalGates } from './approval-gates';
import { buildGitHubToolProtocol } from './github-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { ARTIFACT_TOOL_PROTOCOL } from './artifact-tools';
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
import { buildVerificationAcceptanceCriteria } from './verification-runtime';
import { runContextMemoryBestEffort } from './memory-context-helpers';
import { writeDecisionMemory } from './context-memory';
import {
  handleCoderAuditor,
  parseUntrackedFileSet,
  type AuditorHandlerContext,
  type AuditorHandlerResult,
  type HandleCoderAuditorInput,
} from './auditor-delegation-handler';

/**
 * Tool sources the inline foreground lead may execute beyond the Coder's
 * sandbox/web/memory surface — Orchestrator parity (GitHub PR/commit/CI +
 * workflow tools, `ask_user`, `create_artifact`). Delegation is intentionally
 * absent: the inline lane is a single agent with no delegation arc wired, so
 * `delegate_*` would be advertised-but-denied.
 */
const LEAD_EXTRA_TOOL_SOURCES: ReadonlySet<string> = new Set<string>([
  'github',
  'ask-user',
  'artifacts',
]);

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
// Inline verification criteria (post-kernel gate)
// ---------------------------------------------------------------------------

export interface InlineVerificationResult {
  criteriaResults: CriterionResult[];
  /** id → check command, for the Auditor's verification-memory command tags. */
  verificationCommandsById: Map<string, string>;
  /** Pass/fail block folded into the turn summary ('' when nothing ran). */
  summaryLine: string;
}

/**
 * Run the verification policy's command rules as post-kernel acceptance
 * checks for an inline turn — restoring the gate the delegated arc enforced
 * in-kernel (`buildVerificationAcceptanceCriteria` → `runCoderAgent`'s
 * acceptance criteria).
 *
 * Why post-kernel and not passed as kernel `acceptanceCriteria`: the kernel
 * runs criteria unconditionally once the Coder is done
 * (`lib/coder-agent.ts` ~1657), so handing them to the kernel would fire
 * typecheck/test on read-only conversational turns ("what changed
 * recently?"). The inline lane instead runs them itself, and the caller
 * gates this on "the turn actually edited" — so enforcement lives in code
 * (CLAUDE.md "behavior lives in code, not prompts"), the Auditor regains its
 * `criteriaResults` evidence, and verification memory regains its command
 * tags (the empty `verificationCommandsById` map the lane used to pass).
 *
 * Best-effort: a policy with no command rules runs nothing; a check that
 * throws is recorded as a failure (exit -1), never aborting the turn.
 */
export async function runInlineVerificationCriteria(
  sandboxId: string,
  policy: VerificationPolicy | undefined,
  signal?: AbortSignal,
): Promise<InlineVerificationResult> {
  const criteria =
    policy && Array.isArray(policy.rules) && policy.rules.length > 0
      ? buildVerificationAcceptanceCriteria(policy, 'always')
      : [];
  const verificationCommandsById = new Map<string, string>();
  const criteriaResults: CriterionResult[] = [];
  // Serial by design — not a perf oversight. The checks share one sandbox, so
  // running them concurrently (Promise.all) would contend for the same
  // workspace/CPU and interleave their output; the kernel's own
  // acceptance-criteria loop (`lib/coder-agent.ts`) is serial for the same
  // reason, and the per-iteration abort check below depends on the ordering.
  // Policies carry a handful of command rules (typecheck/test), so the
  // wall-clock cost is bounded.
  for (const criterion of criteria) {
    if (signal?.aborted) break;
    verificationCommandsById.set(criterion.id, criterion.check);
    try {
      const checkResult = await execInSandbox(sandboxId, criterion.check);
      const expectedExit = criterion.exitCode ?? 0;
      criteriaResults.push({
        id: criterion.id,
        passed: checkResult.exitCode === expectedExit,
        exitCode: checkResult.exitCode,
        output: `${checkResult.stdout}\n${checkResult.stderr}`.trim(),
      });
    } catch (err) {
      criteriaResults.push({
        id: criterion.id,
        passed: false,
        exitCode: -1,
        output: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let summaryLine = '';
  if (criteriaResults.length > 0) {
    const passed = criteriaResults.filter((r) => r.passed).length;
    summaryLine = `\n\n[Acceptance Criteria] ${passed}/${criteriaResults.length} passed`;
    for (const r of criteriaResults) {
      summaryLine += `\n  ${r.passed ? '✓' : '✗'} ${r.id} (exit=${r.exitCode})${
        r.passed ? '' : `: ${r.output.slice(0, 200)}`
      }`;
    }
  }

  return { criteriaResults, verificationCommandsById, summaryLine };
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
  /**
   * Grant the run the Orchestrator's full tool surface — GitHub PR/commit/CI +
   * workflow tools, `ask_user`, and `create_artifact` — on top of the Coder's
   * sandbox/web/memory surface. The Inline Foreground Lane sets this so the
   * collapsed single lead matches the old Orchestrator (the surface a
   * conversational turn like "what changed recently?" needs). The delegated
   * arc leaves it false: a delegated Coder keeps its narrow surface and the
   * Orchestrator above it owns those tools.
   */
  leadToolSurface?: boolean;
}

export interface InPageCoderKernelCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  onCheckpointRequest?: (question: string, context: string) => Promise<string>;
  /** Durable-resume checkpoint hook — the inline lane bridges this into V1 capture. */
  onCheckpoint?: (state: CoderCheckpointState<ChatCard>) => Promise<void>;
  onWorkingMemoryUpdate?: (state: CoderWorkingMemory) => void;
  onRunEvent?: (event: RunEventInput) => void;
  /** Branch stamp tee for desync detection (see branch-desync.ts). Fires
   *  after each stamped `sandbox_exec` completes. Inline lane only — the
   *  delegated arc leaves it undefined (reconciling the foreground UI from
   *  inside a delegated run is an open design question, not an oversight). */
  onSandboxExecBranch?: (info: { command: string; branch: string }) => void;
  /** Branch-switch payload tee for kernel-executed typed branch tools. Inline
   *  lane only — the delegated arc leaves it undefined deliberately, matching
   *  the desync stamp convention above. */
  onBranchSwitchPayload?: (payload: BranchSwitchPayload) => void;
  /**
   * Sandbox-loss tee. The Orchestrator loop fires `onSandboxUnreachable` off
   * any tool result carrying `structuredError.type === 'SANDBOX_UNREACHABLE'`
   * (`chat-send-helpers.ts` applyPostExecutionSideEffects #8) so the workspace
   * kicks off sandbox recovery. Kernel-led turns bypass that dispatch seam, so
   * the inline lane teas the signal straight out of the kernel's tool
   * executors instead. Inline lane only — the delegated arc reconciles through
   * its own dispatch path.
   */
  onSandboxUnreachable?: (message: string) => void;
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

  // --- Lead tool surface (Inline Foreground Lane → Orchestrator parity) ---
  // When enabled, the lead also wields GitHub PR/CI/workflow tools, ask_user,
  // and create_artifact, executed through the same `WebToolExecutionRuntime`
  // the Orchestrator uses (role 'coder' — its grant already covers pr:*,
  // workflow:*, user:ask, artifacts:write, so the runtime's own role gate
  // passes). The matching protocols are threaded into `extraToolProtocols`
  // below, so nothing is advertised without a wired executor.
  const leadRuntime = spec.leadToolSurface ? new WebToolExecutionRuntime() : null;
  // Supervised-mode approval gates, threaded exactly like the normal chat
  // executor (`chat-tool-execution.ts`) so the lead's remote side effects
  // (create_pr / merge_pr / delete_branch / trigger_workflow) require approval
  // instead of executing silently. Built once per run, not per tool call.
  const leadApprovalGates = leadRuntime ? createDefaultApprovalGates() : null;

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
    executeSandboxToolCall: async (call, id, opts) => {
      const result = await executeSandboxToolCall(call, id, {
        auditorProviderOverride: opts.auditorProviderOverride as ActiveProvider,
        auditorModelOverride: opts.auditorModelOverride,
        currentBranch: spec.branchContext?.activeBranch,
        defaultBranch: spec.branchContext?.defaultBranch,
      });
      if (call.tool === 'sandbox_exec' && result.branch) {
        callbacks.onSandboxExecBranch?.({ command: call.args.command, branch: result.branch });
      }
      if (result.branchSwitch) {
        callbacks.onBranchSwitchPayload?.(result.branchSwitch);
      }
      if (result.structuredError?.type === 'SANDBOX_UNREACHABLE') {
        callbacks.onSandboxUnreachable?.(result.structuredError.message);
      }
      return result;
    },
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
    // Lead tool surface: github / ask-user / artifacts, executed via the web
    // runtime. Absent (undefined) for the delegated Coder, which keeps its
    // narrow three-source surface.
    extraToolSources: leadRuntime ? LEAD_EXTRA_TOOL_SOURCES : undefined,
    executeExtraToolCall: leadRuntime
      ? async (call, execCtx) => {
          void execCtx;
          const result = await leadRuntime.execute(call, {
            allowedRepo: spec.memoryScope?.repoFullName ?? '',
            sandboxId: spec.sandboxId,
            role: 'coder',
            isMainProtected: spec.branchContext?.protectMain ?? false,
            defaultBranch: spec.branchContext?.defaultBranch,
            activeProvider: spec.provider,
            activeModel: spec.modelId,
            capabilityLedger,
            approvalGates: leadApprovalGates ?? undefined,
            chatId: spec.memoryScope?.chatId,
            executionMode: 'cloud',
          });
          if (result.structuredError?.type === 'SANDBOX_UNREACHABLE') {
            callbacks.onSandboxUnreachable?.(result.structuredError.message);
          }
          return {
            text: result.text,
            card: result.card,
            structuredError: result.structuredError,
          };
        }
      : undefined,
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
    // On the lead surface, fold the repo name into the workspace block so the
    // GitHub tools have the `repo` arg they need (the executor rejects repo
    // mismatches). The delegated arc keeps its branchContext untouched.
    branchContext:
      spec.branchContext && leadRuntime
        ? { ...spec.branchContext, repoFullName: spec.memoryScope?.repoFullName }
        : spec.branchContext,
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
    // Lead tool surface (Orchestrator parity): advertise GitHub (delegation-
    // free — the single lead has no delegation arc), ask_user, and
    // create_artifact only when the matching executors are wired above.
    extraToolProtocols: leadRuntime
      ? [
          buildGitHubToolProtocol({ includeDelegation: false }),
          ASK_USER_TOOL_PROTOCOL,
          ARTIFACT_TOOL_PROTOCOL,
        ]
      : undefined,
    verificationPolicyBlock,
    approvalModeBlock,
    evaluateAfterModel,
    acceptanceCriteria: spec.acceptanceCriteria,
    // The lead is a watched foreground run, so it doesn't inherit the profile's
    // delegated-Coder round wall — leave the cap unset so the kernel applies its
    // high invisible backstop (LEAD_MAX_ROUNDS). The delegated arc keeps the
    // profile cap.
    harnessMaxRounds: spec.leadToolSurface ? undefined : spec.harnessSettings?.maxCoderRounds,
    harnessContextResetsEnabled: spec.harnessSettings?.contextResetsEnabled,
    resumeState: spec.resumeState,
    checkpointCadenceRounds: spec.checkpointCadenceRounds,
    // The lead surface is the conversational lead — swap the kernel's
    // implementer prompt for lead-mode framing (same trigger as the tool
    // surface). The delegated arc leaves this unset.
    leadMode: spec.leadToolSurface,
    // This is the web surface, whose sandbox/GitHub tools use the canonical
    // registry public names the lead tool-routing/error guidance references —
    // so opt into that guidance here. The CLI lead leaves it off (its
    // TOOL_PROTOCOL uses different names).
    leadToolGuidance: spec.leadToolSurface,
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
