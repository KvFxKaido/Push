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
  DelegationOutcome,
  ExplorerDelegationArgs,
  ExplorerDelegationEnvelope,
  HarnessProfileSettings,
  MemoryScope,
  RunEventInput,
  BranchSwitchPayload,
} from '@/types';
import {
  generateCheckpointAnswer as generateCheckpointAnswerLib,
  resolveLeadRoundOptions,
  runCoderAgent as runCoderAgentLib,
  summarizeCoderStateForHandoff,
  type CoderAgentOptions,
  type CoderCheckpointState,
  type CoderLoopMessage,
} from '@push/lib/coder-agent';
import type { MemoryRecord } from '@push/lib/runtime-contract';
import type { SessionDigest } from '@push/lib/session-digest';
import { createMemoryToolExecutor } from '@push/lib/memory-tool-exec';
import {
  buildCoderDetectors,
  buildCoderEvaluateAfterModel,
  buildCoderToolExec,
  type CoderBindingServices,
} from '@push/lib/coder-agent-bindings';
import type {
  LlmContentPart,
  LlmMessage,
  PushStream,
  PushStreamEvent,
} from '@push/lib/provider-contract';
import type { CorrelationContext } from '@push/lib/correlation-context';
import { getActiveProvider, getProviderPushStream, type ActiveProvider } from './orchestrator';
import { getModelForRole } from './providers';
import { resolvePushCapabilityProfile } from './model-catalog';
import { getToolFunctionSchemasForSources } from '@push/lib/tool-function-schemas';
import type { ToolRegistrySource } from '@push/lib/tool-registry';
import { getUserProfile } from '@/hooks/useUserProfile';
import {
  detectSandboxToolCall,
  executeSandboxToolCall,
  getSandboxToolProtocol,
  type SandboxToolCall,
} from './sandbox-tools';
import { nativeFsScopeFrom } from './native-fs';
import {
  detectWebSearchToolCall,
  executeWebSearch,
  WEB_SEARCH_TOOL_PROTOCOL,
  type WebSearchToolCall,
} from './web-search-tools';
import { getWebSearchMode, isNativeWebSearchEnabled } from './web-search-mode';
import { MEMORY_TOOL_PROTOCOL } from './memory-tools';
import {
  SCRATCHPAD_TOOL_PROTOCOL,
  buildScratchpadContext,
  executeScratchpadToolCall,
} from './scratchpad-tools';
import {
  TODO_TOOL_PROTOCOL,
  buildTodoContext,
  executeTodoToolCall,
  type TodoItem,
} from './todo-tools';
import { WebToolExecutionRuntime } from './web-tool-execution-runtime';
import { createDefaultApprovalGates } from './approval-gates';
import { buildGitHubToolProtocol } from './github-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { ARTIFACT_TOOL_PROTOCOL } from './artifact-tools';
import { CapabilityLedger, ROLE_CAPABILITIES, type Capability } from './capabilities';
import {
  detectAllToolCalls,
  detectAnyToolCall,
  detectNativeToolCalls,
  type AnyToolCall,
} from './tool-dispatch';
import {
  classifySandboxUnreachableRecovery,
  type SandboxUnreachableRecoveryPolicy,
} from './sandbox-recovery-policy';
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
import {
  buildMemoryScope,
  retrieveMemoryKnownContextLine,
  runContextMemoryBestEffort,
  withMemoryContext,
} from './memory-context-helpers';
import { writeDecisionMemory, writeExplorerMemory } from './context-memory';
import { runExplorerAgent } from './explorer-agent';
import { buildDelegationResultCard, formatCompactDelegationToolResult } from './delegation-result';
import { summarizeToolResultPreview, utf8ByteLength } from './chat-run-events';
import { getToolPublicName } from '@push/lib/tool-registry';
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
 * workflow tools, `ask_user`, `create_artifact`) plus a narrow `delegate`
 * arc. The lead does its own coding, so only `delegate_explorer` (read-only
 * investigation) is executable on the `delegate` source — `delegate_coder` and
 * `plan_tasks` are refused in the executor below and excluded from the native
 * schema set. A delegated Coder leaves this set undefined, so the same
 * `delegate_*` calls are refused at the source gate.
 */
const LEAD_EXTRA_TOOL_SOURCES: ReadonlySet<string> = new Set<string>([
  'github',
  'ask-user',
  'artifacts',
  'delegate',
]);

/**
 * Canonical delegation tools the lead may NOT execute even though it wires the
 * `delegate` source. Excluded from the native function-schema set so a
 * native-calling model can't fire an advertised-but-denied `delegate_coder` /
 * `plan_tasks` (which would silently no-op). `delegate_explorer` stays in.
 */
const LEAD_EXCLUDED_DELEGATION_TOOLS: ReadonlySet<string> = new Set<string>([
  'delegate_coder',
  'plan_tasks',
]);

/** Max Explorer sub-agents the inline lead may fan out in a single turn. */
const INLINE_MAX_PARALLEL_EXPLORERS = 2;

/**
 * The registry tool sources wired for the inline lead — the surface a native
 * `tools` array may advertise. Base sandbox + web-search (always wired), memory
 * only when a scope is threaded, plus the lead's extra GitHub/ask/artifact and
 * (explorer-only) delegate sources. Mirrors exactly what the kernel advertises
 * in the prompt; optional chat-hook sources (scratchpad/todo) join only when
 * handlers are present and must stay in lockstep with the protocols passed to
 * the kernel below. The `delegate` source is scoped to `delegate_explorer` via
 * `LEAD_EXCLUDED_DELEGATION_TOOLS` at the schema call.
 */
function leadNativeToolSources(options: {
  hasMemoryScope: boolean;
  hasScratchpad: boolean;
  hasTodo: boolean;
}): ReadonlySet<ToolRegistrySource> {
  const sources = new Set<ToolRegistrySource>(['sandbox', 'web-search']);
  if (options.hasMemoryScope) sources.add('memory');
  if (options.hasScratchpad) sources.add('scratchpad');
  if (options.hasTodo) sources.add('todo');
  for (const source of LEAD_EXTRA_TOOL_SOURCES) sources.add(source as ToolRegistrySource);
  return sources;
}

const delegateExplorerPublicName = getToolPublicName('delegate_explorer');

/**
 * Tool protocol advertised to the inline lead for read-only Explorer
 * delegation. The lead stays the implementer — this only offloads
 * investigation. Guidance only (the executor and capability gate are the real
 * controls); kept here next to the wiring so the advertised shape and the
 * executor can't drift.
 */
export const LEAD_EXPLORER_DELEGATION_PROTOCOL = `[DELEGATE_EXPLORER]
Offload read-only investigation to a fresh Explorer sub-agent. The Explorer can read files, search the codebase, and inspect PRs/CI — it cannot edit, run commands, or commit. Reach for it to trace a flow or map architecture across many files without spending your own context; you remain the lead and do all editing yourself once it reports back.

Format:
{"tool": "${delegateExplorerPublicName}", "args": {"task": "<precise objective>", "files": ["src/foo.ts"], "knownContext": ["already-validated fact"], "deliverable": "<expected report>"}}

- "task" is required and should be a concrete objective, not a vague prompt.
- "files" / "knownContext" / "deliverable" are optional and sharpen the brief.
- You may emit up to ${INLINE_MAX_PARALLEL_EXPLORERS} ${delegateExplorerPublicName} calls in one turn (write them together) to investigate independent threads in parallel; they run concurrently and report back before your next turn. A third in the same turn is rejected — split it across turns.
[/DELEGATE_EXPLORER]`;

// ---------------------------------------------------------------------------
// Inline Explorer delegation
// ---------------------------------------------------------------------------

/** Run-context the inline Explorer delegation closure reads from the kernel spec. */
interface InlineExplorerRunContext {
  sandboxId: string;
  repoFullName: string;
  branchContext?: { activeBranch: string; defaultBranch: string; protectMain: boolean };
  provider: ActiveProvider;
  modelId: string | undefined;
  projectInstructions?: string;
  instructionFilename?: string;
  memoryScope?: { repoFullName: string; branch?: string; chatId?: string };
  signal?: AbortSignal;
  onStatus: (phase: string, detail?: string) => void;
  onRunEvent?: (event: RunEventInput) => void;
}

/**
 * Execute a single `delegate_explorer` call from the inline lead. Mirrors the
 * Orchestrator's `explorer-delegation-handler.ts` outcome assembly (memory
 * enrichment → run → DelegationOutcome → compact tool result + result card →
 * memory write), minus the React-ref plumbing. Returns the
 * `SandboxToolExecResult` subset the kernel's `executeExtraToolCall` consumes.
 * Best-effort and self-contained: any failure (including abort) becomes a
 * `[Tool Error]` / cancellation result the lead sees, never a thrown loop
 * break — so a fanned-out Explorer that fails doesn't take down its sibling.
 */
async function runInlineExplorerDelegation(
  args: ExplorerDelegationArgs,
  ctx: InlineExplorerRunContext,
): Promise<{ text: string; card?: ChatCard }> {
  const task = args.task?.trim();
  if (!task) {
    return { text: '[Tool Error] delegate_explorer requires a non-empty "task" string.' };
  }
  const executionId = crypto.randomUUID();
  const startMs = Date.now();
  // Already-aborted short-circuit: if the turn was cancelled before this
  // delegation ran (e.g. a sibling in the same parallel fan-out already saw the
  // abort), don't spin up an Explorer or the memory round-trip just to await a
  // rejection. Checked before emitting `subagent.started` so no started event
  // goes unpaired.
  if (ctx.signal?.aborted) {
    return { text: '[Explorer cancelled by user.]' };
  }
  ctx.onRunEvent?.({ type: 'subagent.started', executionId, agent: 'explorer', detail: task });

  const memoryScope = buildMemoryScope(
    ctx.memoryScope?.chatId ?? '',
    ctx.memoryScope?.repoFullName ?? ctx.repoFullName,
    ctx.memoryScope?.branch ?? ctx.branchContext?.activeBranch,
  );
  const memoryLine = await retrieveMemoryKnownContextLine(
    memoryScope,
    'explorer',
    task,
    args.files,
  );

  try {
    const envelope: ExplorerDelegationEnvelope = {
      task,
      files: args.files || [],
      intent: args.intent,
      deliverable: args.deliverable,
      knownContext: withMemoryContext(args.knownContext, memoryLine),
      constraints: args.constraints,
      branchContext: ctx.branchContext,
      provider: ctx.provider,
      model: ctx.modelId || undefined,
      projectInstructions: ctx.projectInstructions,
      instructionFilename: ctx.instructionFilename,
    };
    const result = await runExplorerAgent(envelope, ctx.sandboxId, ctx.repoFullName, {
      onStatus: (phase, detail) => ctx.onStatus(phase, detail),
      signal: ctx.signal,
      onRunEvent: ctx.onRunEvent,
    });

    const outcome: DelegationOutcome = {
      agent: 'explorer',
      status: result.hitRoundCap
        ? 'incomplete'
        : result.rounds > 0 && result.summary.trim()
          ? 'complete'
          : 'inconclusive',
      summary: result.summary,
      evidence: result.summary.trim()
        ? [{ kind: 'observation', label: 'Investigation findings' }]
        : [],
      checks: [],
      gateVerdicts: [],
      missingRequirements: [],
      nextRequiredAction: result.hitRoundCap
        ? 'Investigation hit round cap — re-explore with a narrower scope or proceed with partial findings'
        : null,
      rounds: result.rounds,
      checkpoints: 0,
      elapsedMs: Date.now() - startMs,
    };

    const text = formatCompactDelegationToolResult({ agent: 'explorer', outcome });
    const card = buildDelegationResultCard({ agent: 'explorer', outcome });

    if (memoryScope && outcome.status === 'complete') {
      await runContextMemoryBestEffort('persisting inline explorer memory', () =>
        writeExplorerMemory({
          scope: memoryScope,
          summary: result.summary,
          relatedFiles: args.files,
          rounds: result.rounds,
        }),
      );
    }

    ctx.onRunEvent?.({
      type: 'subagent.completed',
      executionId,
      agent: 'explorer',
      summary: summarizeToolResultPreview(result.summary),
      delegationOutcome: outcome,
      orchestratorBytes: utf8ByteLength(text),
    });
    return { text, card };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    const msg = err instanceof Error ? err.message : String(err);
    ctx.onRunEvent?.({
      type: 'subagent.failed',
      executionId,
      agent: 'explorer',
      error: summarizeToolResultPreview(msg),
    });
    if (isAbort || ctx.signal?.aborted) {
      return { text: '[Explorer cancelled by user.]' };
    }
    return { text: `[Tool Error] Explorer failed: ${msg}` };
  }
}

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

export interface InlineScratchpadHandlers {
  content: string;
  replace: (content: string) => void;
  append: (content: string) => void;
}

export interface InlineTodoHandlers {
  todos: readonly TodoItem[];
  replace: (todos: TodoItem[]) => void;
  clear: () => void;
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
  /**
   * Raw visible-transcript seed for conversational lead turns. The provider
   * stream's `toLLMMessages` runs the single context transform over it each
   * round (no pre-transform — see inline-conversation-context.ts); the digest
   * inputs below feed that transform.
   */
  initialMessages?: CoderLoopMessage[];
  /** Multipart initial user turn; text fallback remains `taskPreamble`. */
  initialUserContentParts?: LlmContentPart[];
  /** User-linked library text rendered into the lead system prompt. */
  linkedLibraryContent?: string;
  /**
   * Session-digest inputs threaded to the stream's context transform for
   * conversational lead turns. `records` is the scope-filtered memory store
   * prefetch; `priorSessionDigest` is the last digest this chat emitted (for
   * cross-turn merge); `onSessionDigestEmitted` caches the merged digest. All
   * undefined on task turns and the delegated arc.
   */
  sessionDigestRecords?: ReadonlyArray<MemoryRecord>;
  priorSessionDigest?: SessionDigest;
  onSessionDigestEmitted?: (digest: SessionDigest | null) => void;
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
  scratchpad?: InlineScratchpadHandlers;
  todo?: InlineTodoHandlers;
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
  /**
   * Whether this turn is a coding task (vs. a conversational lead turn). The
   * inline lane derives it from `classifyTurnIntent` and the kernel stamps it
   * onto the turn context so the Coder no-fake-completion guard refuses to fire
   * on a conversational reply. Omitted → treated as a task (the delegated arc
   * and worker engine always run real tasks). See `turn-intent.ts`.
   */
  taskInFlight?: boolean;
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
  onSandboxUnreachable?: (message: string, policy?: SandboxUnreachableRecoveryPolicy) => void;
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
  const leadExtraToolSources = leadRuntime
    ? new Set<string>([
        ...LEAD_EXTRA_TOOL_SOURCES,
        ...(spec.scratchpad ? ['scratchpad'] : []),
        ...(spec.todo ? ['todo'] : []),
      ])
    : undefined;
  let scratchpadContent = spec.scratchpad?.content ?? '';
  let todos = [...(spec.todo?.todos ?? [])];

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
    // Undefined (delegated arc / engine) → task; the inline lane passes false
    // for conversational turns so the no-fake-completion guard stays quiet.
    taskInFlight: spec.taskInFlight,
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
        // Thread the Coder's memory scope so a reduced sandbox_exec retains its
        // full output (LCM Phase 3 recall). This direct path bypasses
        // WebToolExecutionRuntime, so without it retention would no-op for Coder
        // runs — the primary coding path.
        memoryScope: spec.memoryScope,
        // Thread Protect Main so a delegated/inline coder push hits the boundary
        // gate (this path reaches handleSandboxPush). The background CF-route
        // coder maps typed sandbox_push to not_implemented_yet; its raw
        // `git push` via sandbox_exec+allowDirectGit is a separate path gated by
        // the git-guard, not this boundary gate.
        isMainProtected: spec.branchContext?.protectMain ?? false,
        // Native (APK) file-op routing: on-device clone scope. Resolves to the
        // local working copy on native (flag on); no-op / cloud everywhere else.
        nativeFsScope: nativeFsScopeFrom(
          spec.memoryScope?.repoFullName,
          spec.branchContext?.activeBranch || spec.branchContext?.defaultBranch,
        ),
      });
      if (call.tool === 'sandbox_exec' && result.branch) {
        callbacks.onSandboxExecBranch?.({ command: call.args.command, branch: result.branch });
      }
      if (result.branchSwitch) {
        callbacks.onBranchSwitchPayload?.(result.branchSwitch);
      }
      if (result.structuredError?.type === 'SANDBOX_UNREACHABLE') {
        callbacks.onSandboxUnreachable?.(
          result.structuredError.message,
          classifySandboxUnreachableRecovery({ source: 'sandbox', call }),
        );
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
    // Lead surface: enable the parallel-delegation bucket so the lead can fan
    // out up to INLINE_MAX_PARALLEL_EXPLORERS Explorers in one turn (they run
    // in the kernel's read-phase Promise.all). The delegated Coder keeps the
    // default (no parallel delegations — explorer falls through to `mutating`).
    detectAllToolCalls: leadRuntime
      ? (text: string) =>
          detectAllToolCalls(text, { maxParallelDelegations: INLINE_MAX_PARALLEL_EXPLORERS })
      : detectAllToolCalls,
    tagSandboxCall: (call): AnyToolCall => ({ source: 'sandbox', call }),
    tagWebSearchCall: (call): AnyToolCall => ({ source: 'web-search', call }),
    // Lead tool surface: github / ask-user / artifacts, executed via the web
    // runtime. Absent (undefined) for the delegated Coder, which keeps its
    // narrow three-source surface.
    extraToolSources: leadExtraToolSources,
    executeExtraToolCall: leadRuntime
      ? async (call, execCtx) => {
          void execCtx;
          // Explorer-only delegation arc: the lead offloads read-only
          // investigation but does its own coding. `delegate_coder` /
          // `plan_tasks` are refused (the source clears the gate, the tool
          // doesn't) so the model gets a clear correction instead of a hang.
          if (call.source === 'delegate') {
            const delegateCall = call.call;
            if (delegateCall.tool === 'delegate_explorer') {
              return runInlineExplorerDelegation(delegateCall.args, {
                sandboxId: spec.sandboxId,
                repoFullName: spec.memoryScope?.repoFullName ?? '',
                branchContext: spec.branchContext,
                provider: spec.provider,
                modelId: spec.modelId,
                projectInstructions: spec.projectInstructions,
                instructionFilename: spec.instructionFilename,
                memoryScope: spec.memoryScope,
                signal: callbacks.signal,
                onStatus: callbacks.onStatus,
                onRunEvent: callbacks.onRunEvent,
              });
            }
            return {
              text: `[Tool Error] The lead does its own coding — "${delegateCall.tool}" is not available here. Use ${delegateExplorerPublicName} for read-only investigation, or make the change yourself.`,
            };
          }
          if (call.source === 'scratchpad') {
            if (!spec.scratchpad) {
              return {
                text: '[Tool Error] Scratchpad not available. The scratchpad may not be initialized — try again after the UI loads.',
              };
            }
            const result = executeScratchpadToolCall(
              call.call,
              scratchpadContent,
              spec.scratchpad.replace,
              spec.scratchpad.append,
            );
            if (result.ok) {
              if (call.call.tool === 'set_scratchpad') {
                scratchpadContent = call.call.content;
              } else if (call.call.tool === 'append_scratchpad') {
                const prev = scratchpadContent.trim();
                scratchpadContent = prev ? `${prev}\n\n${call.call.content}` : call.call.content;
              }
            }
            return { text: result.text };
          }
          if (call.source === 'todo') {
            if (!spec.todo) {
              return {
                text: '[Tool Error] Todo list not available. It may not be initialized — try again after the UI loads.',
              };
            }
            const result = executeTodoToolCall(call.call, todos, {
              replace: spec.todo.replace,
              clear: spec.todo.clear,
            });
            if (result.ok && result.nextTodos) {
              todos = result.nextTodos;
            }
            return { text: result.text };
          }
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
            callbacks.onSandboxUnreachable?.(
              result.structuredError.message,
              classifySandboxUnreachableRecovery(call),
            );
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
  const leadContextBlocks = [
    spec.scratchpad ? buildScratchpadContext(scratchpadContent) : null,
    spec.todo ? buildTodoContext(todos) : null,
    spec.linkedLibraryContent,
  ].filter((block): block is string => Boolean(block && block.trim()));

  // --- Build lib options ---
  // The web inline lead wires the full GitHub/ask/artifact tool surface, so its
  // lead guidance stays 'full'. The shared resolver keeps this lane's lead
  // round/scope decision in lockstep with the background CoderJob DO.
  const leadRound = resolveLeadRoundOptions({
    isLead: Boolean(spec.leadToolSurface),
    maxCoderRounds: spec.harnessSettings?.maxCoderRounds,
    surface: 'full',
  });
  const capabilityProfile = resolvePushCapabilityProfile(spec.provider, spec.modelId);
  // Web-search surface gate, resolved once per run. Suppress the prompt-
  // engineered `web_search` protocol when the provider's native server-side
  // search is active (the provider stream injects its own tool — advertising
  // both creates a duplicate surface / name collision, e.g. Anthropic's native
  // tool is also literally `web_search`) or when web search is turned off.
  // Mirrors the Orchestrator loop's gate in `orchestrator.ts` so both lanes of
  // the lead behave identically. Web surface → `console.log` per CLAUDE.md.
  const webSearchEnabled = getWebSearchMode() !== 'off';
  const nativeWebSearchActive =
    webSearchEnabled && isNativeWebSearchEnabled(spec.provider, spec.modelId);
  const webSearchProtocol =
    webSearchEnabled && !nativeWebSearchActive ? WEB_SEARCH_TOOL_PROTOCOL : '';
  if (!webSearchProtocol) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'inline_prompt_web_search_suppressed',
        provider: spec.provider,
        model: spec.modelId,
        reason: !webSearchEnabled ? 'mode_off' : 'native_active',
      }),
    );
  }
  // Native-FC gate decision, resolved once per run. The lead surface attaches
  // native tool schemas only when the model is native-capable; otherwise the
  // run silently lands on the text-dispatch `[TOOL_RESULT]` path. That fallback
  // was previously untraced — a provider/model with no native-tool capability
  // (e.g. an Ollama Cloud id absent from models.dev's `toolCall` metadata)
  // dropped to text-dispatch with no log line, so a weak model distrusting the
  // `[TOOL_RESULT]` envelope read as an inexplicable runtime quirk. Emit one
  // structured line per branch (enabled ↔ gated-off) so ops can distinguish the
  // two without inferring from downstream behavior. Web surface → `console.log`
  // per the logging-stream rule in CLAUDE.md.
  const nativeFcEligible = Boolean(leadRuntime) && capabilityProfile.toolCalling === 'native';
  console.log(
    JSON.stringify(
      nativeFcEligible
        ? {
            level: 'info',
            event: 'native_fc_enabled',
            provider: spec.provider,
            model: spec.modelId,
            toolCalling: capabilityProfile.toolCalling,
          }
        : {
            level: 'info',
            event: 'native_fc_gated_off',
            provider: spec.provider,
            model: spec.modelId,
            toolCalling: capabilityProfile.toolCalling,
            reason: !leadRuntime ? 'not_lead_runtime' : 'model_not_native_capable',
          },
    ),
  );
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
    initialMessages: spec.initialMessages,
    initialUserContentParts: spec.initialUserContentParts,
    linkedLibraryContent: leadContextBlocks.length > 0 ? leadContextBlocks.join('\n\n') : undefined,
    sessionDigestRecords: spec.sessionDigestRecords,
    priorSessionDigest: spec.priorSessionDigest,
    onSessionDigestEmitted: spec.onSessionDigestEmitted,
    symbolSummary: symbolLedger.getSummary(),
    toolExec,
    detectAllToolCalls: detectAllToolCallsFiltered,
    // Lead surface only. The delegated sub-Coder stays text-dispatch by
    // invariant; native schemas are already lead-gated, but withholding the
    // native detector too enforces it at the dispatch layer — a stray
    // `native_tool_call` on a delegated run degrades to the text arm instead
    // of executing. (#1162 review, Codex P2.)
    detectNativeToolCalls: leadRuntime
      ? (calls) =>
          detectNativeToolCalls(calls, {
            maxParallelDelegations: INLINE_MAX_PARALLEL_EXPLORERS,
          })
      : undefined,
    detectAnyToolCall: detectCoderToolCall,
    webSearchToolProtocol: webSearchProtocol,
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
          ...(spec.scratchpad ? [SCRATCHPAD_TOOL_PROTOCOL] : []),
          ...(spec.todo ? [TODO_TOOL_PROTOCOL] : []),
          ASK_USER_TOOL_PROTOCOL,
          ARTIFACT_TOOL_PROTOCOL,
          LEAD_EXPLORER_DELEGATION_PROTOCOL,
        ]
      : undefined,
    verificationPolicyBlock,
    approvalModeBlock,
    evaluateAfterModel,
    acceptanceCriteria: spec.acceptanceCriteria,
    // The lead is a watched foreground run, so it doesn't inherit the profile's
    // delegated-Coder round wall — the resolver leaves the cap unset so the
    // kernel applies its high invisible backstop (LEAD_MAX_ROUNDS); the
    // delegated arc keeps the profile cap.
    harnessMaxRounds: leadRound.harnessMaxRounds,
    // Per-run token budget (consumption circuit breaker). Independent of the
    // round cap, so it applies to the lead (whose round cap is the high
    // backstop) as well as the delegated arc. The shim routes delegated
    // sub-Coders through here too, so this one site covers both web lanes.
    harnessTokenBudget: spec.harnessSettings?.runTokenBudget,
    harnessContextResetsEnabled: spec.harnessSettings?.contextResetsEnabled,
    resumeState: spec.resumeState,
    checkpointCadenceRounds: spec.checkpointCadenceRounds,
    // The lead surface is the conversational lead — swap the kernel's
    // implementer prompt for lead-mode framing. The delegated arc leaves this
    // unset.
    persona: leadRound.persona,
    leadToolScope: leadRound.leadToolScope,
    // This is the web surface, whose sandbox/GitHub tools use the canonical
    // registry public names the lead tool-routing/error guidance references —
    // so opt into that guidance here. The CLI lead leaves it off (its
    // TOOL_PROTOCOL uses different names).
    leadToolGuidance: spec.leadToolSurface,
    // Native function calling for models that support it. Additive: the binding
    // emits native tool_calls which the stream carries directly into dispatch.
    // Two guards:
    //   1. Lead surface only (`leadRuntime`). The delegated Coder wires a
    //      narrower surface and stays text-dispatch for now.
    //   2. Scope schemas to the EXACT sources wired for this run — base
    //      sandbox/web (+ memory when a scope is threaded) plus the lead's
    //      extra GitHub/ask/artifact surface. Advertising a tool the lead
    //      can't execute (e.g. `delegate_*`) would let a native call no-op.
    nativeToolSchemas: nativeFcEligible
      ? getToolFunctionSchemasForSources(
          leadNativeToolSources({
            hasMemoryScope: Boolean(spec.memoryScope),
            hasScratchpad: Boolean(spec.scratchpad),
            hasTodo: Boolean(spec.todo),
          }),
          {
            // Pin the GitHub tools' `repo` arg to the active repo so the model
            // emits it correctly instead of a placeholder that trips the
            // executor's repo-mismatch rejection (validation_failed churn).
            activeRepo: spec.memoryScope?.repoFullName,
            // The `delegate` source is wired for `delegate_explorer` only —
            // keep `delegate_coder` / `plan_tasks` out of the native schema so
            // a native call can't fire an advertised-but-denied delegation.
            excludeTools: LEAD_EXCLUDED_DELEGATION_TOOLS,
          },
        )
      : undefined,
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
