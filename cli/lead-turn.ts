/**
 * CLI lead-kernel lane — Agent Runtime Decisions §10, Active Runtime Work #8.
 *
 * Runs a terminal-chat turn as a `leadMode: true` run of the **shared** coder
 * kernel (`lib/coder-agent.ts`). This replaced the CLI-local engine round
 * loop (the former `cli/engine.ts:runAssistantLoop`, now removed) and is the
 * same kernel + lead framing the web's Inline Foreground Lane uses
 * (`app/src/lib/inline-coder-run.ts`),
 * assembled with the CLI's local reach: `executeToolCall` against the real
 * filesystem, the CLI provider streams, and the existing approval gates.
 *
 * `runAssistantTurn` routes every lead turn here — the CLI-local engine
 * loop's `PUSH_LEAD_RUNTIME=engine` opt-out was retired once the lane baked
 * (it was the default since 2026-06-12, mirroring how the web's inline lane
 * shipped behind a preference and then became the only path).
 *
 * Event protocol: the lane speaks the engine's existing event vocabulary
 * (`assistant_token`, `assistant_thinking_token`, `assistant_done`,
 * `assistant.tool_prose`, `status`, `tool.execution_complete`,
 * `run_complete`, `error`) so the TUI, REPL, and daemon attach clients share
 * one ordered transcript vocabulary.
 *
 * Safety boundary unchanged: tools execute through the same
 * `executeToolCall` the engine loop uses, so the Auditor commit gate,
 * high-risk exec approval, and disabled-tool policy all apply identically
 * (the "protected during convergence" list in §10).
 */

import {
  runCoderAgent,
  type CoderAgentCallbacks,
  type CoderLoopMessage,
  type CoderToolExecContext,
  type CoderToolExecResult,
  type DetectedToolCalls,
} from '../lib/coder-agent.ts';
import { groupCallsByPhase, MAX_SIDE_EFFECT_CHAIN } from '../lib/tool-call-grouping.ts';
import { RUN_TOKEN_BUDGET_ENV_VAR, resolveRunTokenBudget } from '../lib/run-cost-budget.ts';
import { isEditDiff } from '../lib/edit-diff.ts';
import { isToolCard } from '../lib/tool-cards.ts';
import { splitAppendOnlyVisibleContent } from '../lib/tool-prose.ts';
import { createRuntimeContext } from '../lib/runtime-context.ts';
import type {
  AIProviderType,
  LlmMessage,
  PushStream,
  PushStreamEvent,
} from '../lib/provider-contract.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { decideStreamFailover } from '../lib/provider-failover.ts';
import {
  createCoderPolicy,
  formatCoderPolicyEvent,
  resolveCoderCompletionGuard,
  type CoderPolicyContext,
  type CoderPolicyAfterResult,
} from '../lib/coder-policy.ts';
import { classifyTurnIntent } from '../lib/turn-intent.ts';
import { resolveWorkspaceIdentity } from '../lib/workspace-identity.ts';
import { cliProviderModelSupportsNativeToolCalling } from './native-tool-gate.js';
import {
  createProviderStream,
  classifyCliStreamError,
  cliStreamRetryDelayMs,
  resolveCliFailoverCandidates,
  MAX_RETRIES,
} from './provider.js';
import type { ProviderConfig } from './provider.js';
import { getCliNativeToolSchemas } from './tool-function-schemas.js';
import {
  detectAllToolCalls as cliDetectAllToolCalls,
  detectNativeToolCalls as cliDetectNativeToolCalls,
  detectToolCall as cliDetectToolCall,
  executeToolCall,
  getGitHubToolProtocolAsync,
  isCliToolDisabled,
  FILE_MUTATION_TOOLS,
  READ_ONLY_TOOLS,
  REPEAT_EXEMPT_TOOLS,
  TOOL_PROTOCOL,
} from './tools.js';
import {
  buildWorkspaceSnapshot,
  loadMemory,
  loadProjectInstructions,
} from './workspace-context.js';
import {
  appendSessionEvent as appendSessionEventRaw,
  makeRunId,
  saveSessionState,
} from './session-store.js';
import type { SessionState } from './session-store.js';
import { isParseErrorMessage, isToolResultMessage } from './context-manager.js';
import type { Message } from './context-manager.js';
import { maybeCompactLeadHistory } from './lead-compaction.js';
import { normalizeTrimmedRoleAlternation } from '../lib/coder-context-trim.ts';
import { isHandoffBlock } from '../lib/llm-compaction.ts';
import { routeReplaysReasoningContent } from '../lib/reasoning-replay-routing.ts';
import { getDefaultCliHookRegistry, readCliCurrentBranch } from './tool-hooks-default.ts';
import {
  LEAD_EXPLORER_DELEGATION_PROTOCOL,
  LEAD_MAX_PARALLEL_EXPLORERS,
  runLeadExplorerDelegation,
} from './lead-explorer.js';
import type { RunOptions, RunResult } from './engine.js';
import type { NativeToolCall } from '../lib/provider-contract.js';
import { MAX_ALLOWED_ROUNDS } from './engine.js';
import { computeAdaptation, resetAdaptationState } from './harness-adaptation.js';
import { recordMalformedToolCall, resetToolCallMetrics } from './tool-call-metrics.js';
import { recordWriteFile, resetWriteFileMetrics } from './edit-metrics.js';
import { resetContextMetrics } from './context-metrics.js';
import { loadUserGoalFile } from './user-goal-file.js';
import {
  deriveUserGoalAnchor,
  formatUserGoalBlock,
  type UserGoalAnchor,
} from '../lib/user-goal-anchor.js';

// ─── CLI call shapes ─────────────────────────────────────────────

/** Flat CLI tool-call shape produced by `cli/tools.ts` detectors. */
interface CliToolCall {
  tool: string;
  args?: Record<string, unknown>;
  source?: string;
}

/**
 * Kernel-shaped wrapper around a CLI call. The kernel's structural cast
 * reads `toolCall.call.tool`, so each detected call is nested rather than
 * handed over flat.
 */
export interface CliKernelCall {
  source: 'cli';
  call: CliToolCall;
}

function wrapCall(call: CliToolCall): CliKernelCall {
  return { source: 'cli', call };
}

/**
 * Per-call classifier options. The parallel-delegation bucket is opt-in and
 * lead-only: `runLeadKernelTurn` passes `LEAD_MAX_PARALLEL_EXPLORERS` so the
 * lead can fan out Explorers alongside its reads; every other caller (the
 * daemon's delegated Coder/Explorer nodes, tests calling the bare wrappers)
 * omits it and keeps the historical shape — a `delegate_explorer` call falls
 * through to the trailing `mutating` slot exactly as before.
 */
export interface CliDetectOptions {
  maxParallelDelegations?: number | null;
}

/**
 * Wrap `cli/tools.ts`'s flat `{ calls, malformed }` detector output into the
 * `DetectedToolCalls` shape the lib Coder kernel expects.
 *
 * Classification (shared state machine — `lib/tool-call-grouping.ts`):
 * - `READ_ONLY_TOOLS` → `readOnly`
 * - `delegate_explorer` → `parallelDelegations` when the caller opts in
 *   (lead lane only; rides the read phase), else the trailing slot
 * - `FILE_MUTATION_TOOLS` (pure file writes/edits) → `fileMutations`,
 *   batched into one mutation transaction per turn
 * - Anything else (`exec`, `git_commit`, etc.) → the trailing `mutating`
 *   side-effect slot (at most one)
 * - Overflow after the trailing slot, a second side-effect, or delegation
 *   fan-out past the cap → `extraMutations`
 *
 * Reads that appear after a mutation has started are treated as a boundary:
 * the sequence stops there so we don't silently reorder the model's intent.
 *
 * Moved here from `cli/pushd.ts` so both the daemon's delegated nodes and the
 * lead-kernel lane share one classifier; pushd re-exports it for its tests.
 * The hand-rolled state machine was replaced by the shared
 * `groupCallsByPhase` kernel when the delegation bucket landed — caps stay
 * disabled (`null`) so the reads/mutations behavior is unchanged.
 */
export function wrapCliDetectAllToolCalls(
  text: string,
  options?: CliDetectOptions,
): DetectedToolCalls<CliKernelCall> {
  const { calls, malformed } = cliDetectAllToolCalls(text) as {
    calls: CliToolCall[];
    malformed?: { reason: string; sample: string; rawToolName?: string }[];
  };
  return classifyCliToolCalls(calls, malformedReportsToDroppedCandidates(malformed ?? []), options);
}

export function wrapCliDetectNativeToolCalls(
  nativeCalls: readonly NativeToolCall[],
  options?: CliDetectOptions,
): DetectedToolCalls<CliKernelCall> {
  const { calls, malformed } = cliDetectNativeToolCalls(nativeCalls) as {
    calls: CliToolCall[];
    malformed?: { reason: string; sample: string; rawToolName?: string }[];
  };
  return classifyCliToolCalls(calls, malformedReportsToDroppedCandidates(malformed ?? []), options);
}

function malformedReportsToDroppedCandidates(
  reports: readonly { reason: string; sample: string; rawToolName?: string }[],
): DetectedToolCalls<CliKernelCall>['droppedCandidates'] {
  return reports.map((report) => ({
    // Deliberately drop the parser-recovered name. The kernel's shared
    // dropped-candidate hint (buildValidationFailedHint → getToolSpec) resolves
    // names against the SHARED tool registry, where CLI-local names collide
    // with GitHub tools — e.g. `read_file` resolves to the GitHub
    // `repo_read(repo, path, ...)`, so a malformed local read would be
    // "corrected" toward the wrong tool/args. An empty name makes the kernel
    // emit its generic (always-correct) envelope hint instead.
    rawToolName: '',
    resolvedToolName: null,
    sample: report.sample,
  }));
}

/**
 * Grouping predicates over the kernel-wrapped CLI call shape. The
 * parallel-delegation predicate matches the lead's Explorer fan-out tool
 * only; the shared grouper consults it solely when the caller enables the
 * bucket via `maxParallelDelegations`.
 */
const CLI_GROUPING_PREDICATES = {
  isReadOnly: (wrapped: CliKernelCall): boolean => READ_ONLY_TOOLS.has(wrapped.call.tool),
  isFileMutation: (wrapped: CliKernelCall): boolean => FILE_MUTATION_TOOLS.has(wrapped.call.tool),
  isParallelDelegation: (wrapped: CliKernelCall): boolean =>
    wrapped.call.tool === 'delegate_explorer',
};

function classifyCliToolCalls(
  calls: readonly CliToolCall[],
  droppedCandidates: DetectedToolCalls<CliKernelCall>['droppedCandidates'] = [],
  options?: CliDetectOptions,
): DetectedToolCalls<CliKernelCall> {
  // Shared per-turn grouping kernel (`lib/tool-call-grouping.ts`) — the same
  // state machine the web dispatcher runs. Read/mutation caps stay disabled
  // (`null`) to preserve this classifier's historical uncapped behavior; the
  // delegation cap is the caller's opt-in (lead lane only). With the caps
  // null, `batchOverflow` is empty by construction — merged defensively so a
  // future cap can't silently drop calls.
  const grouped = groupCallsByPhase(calls.map(wrapCall), CLI_GROUPING_PREDICATES, {
    maxParallelReads: null,
    maxFileMutationBatch: null,
    maxParallelDelegations: options?.maxParallelDelegations ?? null,
    // Reads/mutations stay uncapped (historical CLI behavior), but the
    // side-effect chain shares the canonical cap: it bounds approval
    // prompts per turn, and 3 covers the dominant exec → exec → commit
    // chain interleaved-tool-calling models emit.
    maxSideEffectChain: MAX_SIDE_EFFECT_CHAIN,
  });
  return {
    readOnly: grouped.readOnly,
    parallelDelegations: grouped.parallelDelegations,
    fileMutations: grouped.fileMutations,
    sideEffects: grouped.sideEffects,
    extraMutations: [...grouped.extraMutations, ...grouped.batchOverflow],
    droppedCandidates,
  };
}

/**
 * Wraps the CLI single-call detector into the kernel's nested shape.
 * Returns `null` when no tool call is present, matching the kernel's
 * `detectAnyToolCall` slot contract.
 */
export function wrapCliDetectAnyToolCall(text: string): CliKernelCall | null {
  const call = cliDetectToolCall(text) as CliToolCall | null;
  if (!call) return null;
  return wrapCall(call);
}

// ─── Turn preamble ───────────────────────────────────────────────

const PRIOR_TURNS_MAX = 6;
const PRIOR_TURN_MAX_CHARS = 700;

interface LeadConversationContext {
  prior: Message[];
  referencedFiles: string | null;
}

function selectLeadConversationContext(
  userText: string,
  messages: ReadonlyArray<Message>,
): LeadConversationContext {
  const conversational = messages.filter((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return false;
    if (typeof m.content !== 'string' || !m.content.trim()) return false;
    if (isToolResultMessage(m)) return false;
    if (isParseErrorMessage(m)) return false;
    return true;
  });

  let referencedFiles: string | null = null;
  const tail = conversational[conversational.length - 1];
  const beforeTail = conversational[conversational.length - 2];
  if (
    tail?.role === 'user' &&
    tail.content.trimStart().startsWith('[REFERENCED_FILES]') &&
    beforeTail?.role === 'user' &&
    beforeTail.content.trim() === userText.trim()
  ) {
    referencedFiles = tail.content.trim();
    conversational.splice(conversational.length - 2, 2);
  } else if (tail?.role === 'user' && tail.content.trim() === userText.trim()) {
    conversational.pop();
  }

  let prior = conversational.slice(-PRIOR_TURNS_MAX);
  let latestHandoff: Message | null = null;
  for (let i = conversational.length - 1; i >= 0; i--) {
    if (isHandoffBlock(conversational[i].content)) {
      latestHandoff = conversational[i];
      break;
    }
  }
  if (latestHandoff && !prior.includes(latestHandoff)) {
    prior = [latestHandoff, ...prior];
  }

  return { prior, referencedFiles };
}

function boundedLeadHistoryContent(message: Message): string {
  const text = message.content.trim();
  if (isHandoffBlock(text) || text.length <= PRIOR_TURN_MAX_CHARS) return text;
  return `${text.slice(0, PRIOR_TURN_MAX_CHARS)}…`;
}

function hasReplayableLeadReasoning(userText: string, messages: ReadonlyArray<Message>): boolean {
  return selectLeadConversationContext(userText, messages).prior.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.reasoningContent === 'string' &&
      message.reasoningContent.length > 0,
  );
}

/**
 * Promote the bounded recent transcript to real provider messages only when it
 * carries plain reasoning that must be replayed structurally. The ordinary CLI
 * path intentionally stays on its compact text preamble; this conditional seed
 * avoids changing non-reasoning sessions while letting `toOpenAIChat` emit the
 * persisted assistant `reasoning_content` after a process resume.
 */
export function buildLeadReasoningReplaySeed(
  userText: string,
  messages: ReadonlyArray<Message>,
  taskPreamble: string,
): CoderLoopMessage[] | undefined {
  const { prior } = selectLeadConversationContext(userText, messages);
  if (
    !prior.some(
      (message) =>
        message.role === 'assistant' &&
        typeof message.reasoningContent === 'string' &&
        message.reasoningContent.length > 0,
    )
  ) {
    return undefined;
  }

  const seed = prior.map(
    (message, index): CoderLoopMessage => ({
      id: `cli-history-${index}`,
      role: message.role as 'user' | 'assistant',
      content: boundedLeadHistoryContent(message),
      timestamp: index,
      ...(message.role === 'assistant' && message.reasoningContent
        ? { reasoningContent: message.reasoningContent }
        : {}),
      ...(message.reasoningBlocks && message.reasoningBlocks.length > 0
        ? { reasoningBlocks: message.reasoningBlocks }
        : {}),
    }),
  );
  seed.push({
    id: 'cli-current-turn',
    role: 'user',
    content: taskPreamble,
    timestamp: Date.now(),
  });
  // The old text preamble collapsed all history into one string, so role
  // adjacency never mattered. A structured seed can end up with consecutive
  // same-role turns — the `[CONTEXT HANDOFF]` block is a `user` message
  // (lead-compaction.ts), and the appended `taskPreamble` is also `user`, so a
  // window that already ends on a user turn now sends `user, user` to the
  // provider. Strict-alternation reasoners (the very routes this replay targets)
  // reject that. Every reachable collision here is user↔user, which this shared
  // helper merges/bridges; it never touches the reasoning-bearing assistant
  // turns. (fugu review on #1537.)
  normalizeTrimmedRoleAlternation(seed, 0);
  return seed;
}

/**
 * Build the kernel task preamble for a lead turn: optional workspace
 * snapshot, optional persisted workspace memory, bounded recent
 * conversation, and the raw user turn. Mirrors the web lane's
 * `buildInlineTurnPreamble` (no delegation-brief ceremony) with the CLI
 * additions the engine loop injects via its system prompt — the workspace
 * snapshot and the `[MEMORY]` block (`save_memory` entries; same wrapper
 * vocabulary as `enrichCliBuilder`) ride in the preamble here, since the
 * kernel owns its own system prompt. Without the memory block the default
 * lane silently dropped saved project conventions (Codex P2, PR #905).
 *
 * `messages` is the session transcript *including* the just-appended user
 * turn (callers append before running the turn); the trailing user message
 * is dropped from the history block so the task isn't duplicated.
 */
export function buildLeadTurnPreamble(
  userText: string,
  messages: ReadonlyArray<Message>,
  workspaceSnapshot: string,
  memory?: string | null,
  userGoalAnchor?: UserGoalAnchor | null,
  options: { includePriorConversation?: boolean } = {},
): string {
  const { prior, referencedFiles } = selectLeadConversationContext(userText, messages);
  // The current turn can be one or two trailing user messages:
  // `appendUserMessageWithFileReferences` pushes the raw line and then, when
  // the line carries `@file` tokens, a synthetic `[REFERENCED_FILES]` block.
  // Detach the whole current turn from the prior-conversation render so the
  // reference block rides the Task section verbatim instead of being clipped
  // to PRIOR_TURN_MAX_CHARS as "prior conversation" — which silently dropped
  // most referenced file content on the default kernel lane (Codex P2, #936).
  const lines: string[] = [];
  if (workspaceSnapshot.trim()) {
    lines.push(workspaceSnapshot.trim());
    lines.push('');
  }
  if (memory && memory.trim()) {
    lines.push(`[MEMORY]\n${memory.trim()}\n[/MEMORY]`);
    lines.push('');
  }
  if (options.includePriorConversation !== false && prior.length > 0) {
    lines.push('Prior conversation in this chat (oldest to newest, truncated):');
    for (const msg of prior) {
      lines.push(`[${msg.role}] ${boundedLeadHistoryContent(msg)}`);
    }
    lines.push('');
  }
  if (userGoalAnchor) {
    lines.push(formatUserGoalBlock(userGoalAnchor));
    lines.push('');
  }
  lines.push(`Task: ${userText}`);
  if (referencedFiles) {
    lines.push('');
    lines.push(referencedFiles);
  }
  return lines.join('\n');
}

// ─── Lead turn runner ────────────────────────────────────────────

/**
 * Default exec approval mode for a caller that doesn't thread one through
 * `RunOptions.execMode` — the daemon's `send_user_message`/crash-recovery
 * paths in `pushd.ts` are the only current callers that omit it. Reads the
 * live daemon setting (`set_daemon_runtime_config` sets this env var) rather
 * than hardcoding 'auto', so the setting has an actual effect on daemon
 * chat turns instead of persisting config + env + an audit row with zero
 * runtime effect (Codex P1 on #1318). Same idiom cli.ts's own default uses
 * (`cli.ts:1034`); callers that already thread execMode explicitly (the
 * direct CLI path, sub-agent delegation) are unaffected since this default
 * only applies when the key is absent.
 */
export function resolveDefaultExecMode(): string {
  return process.env.PUSH_EXEC_MODE || 'auto';
}

/**
 * Run one terminal-chat turn as a `leadMode` run of the shared coder kernel.
 *
 * Contract: the caller has already appended the
 * user message to `state.messages`; this returns a `RunResult` and leaves
 * the assistant's final summary appended + persisted.
 */
export async function runLeadKernelTurn(
  state: SessionState,
  providerConfig: ProviderConfig,
  apiKey: string,
  userText: string,
  maxRounds: number,
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    emit,
    signal,
    approvalFn,
    askUserFn,
    allowExec = false,
    safeExecPatterns = [],
    execMode = resolveDefaultExecMode(),
    disabledTools,
    alwaysAllow,
    auditorGate,
    suppressRunComplete = false,
    suppressEventPersist = false,
  } = options;
  const runId: string = options.runId || makeRunId();
  const adaptationMetricsKey = `${state.sessionId}:${runId}`;
  // Coder working memory is NOT seeded onto the CLI runtimeContext: nothing on
  // the CLI reads runtimeContext.workingMemory.coder (the kernel keeps its own
  // loop reference and persists to state.workingMemory). Seeding it here would
  // create a write-only mirror that drifts from state.workingMemory.
  const runtimeContext =
    options.runtimeContext ??
    createRuntimeContext({
      correlation: { surface: 'cli', sessionId: state.sessionId, runId },
    });

  function dispatchEvent(type: string, payload: unknown): void {
    if (suppressRunComplete && type === 'run_complete') return;
    if (typeof emit === 'function') {
      emit({ type, payload, runId, sessionId: state.sessionId });
    }
  }

  // Persist-then-broadcast, daemon-compatible: `appendSessionEventRaw` bumps
  // `state.eventSeq` synchronously before its first await, so a dispatch
  // immediately after this call carries the right seq on the daemon's wire
  // envelope. Failures degrade to a `warning` event instead of vanishing
  // (symmetric structured logs — see CLAUDE.md).
  function persistEvent(type: string, payload: unknown): Promise<void> {
    if (suppressEventPersist) return Promise.resolve();
    return appendSessionEventRaw(state, type, payload, runId).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      dispatchEvent('warning', {
        code: 'LEAD_EVENT_PERSIST_FAILED',
        message: `Failed to persist ${type}: ${message}`,
      });
    });
  }

  // Workspace context — best-effort, same loaders as the engine's prompt
  // enrichment. The kernel owns its system prompt, so project instructions
  // ride the kernel's `projectInstructions` slot while the snapshot and the
  // persisted `[MEMORY]` block (`save_memory` entries) ride the task
  // preamble.
  const [snapshot, instructions, memory, githubProtocol, workspaceIdentity] = await Promise.all([
    buildWorkspaceSnapshot(state.cwd).catch((): string => ''),
    loadProjectInstructions(state.cwd).catch((): null => null),
    loadMemory(state.cwd).catch((): null => null),
    getGitHubToolProtocolAsync().catch((): string => ''),
    resolveWorkspaceIdentity(state.cwd),
  ]);

  // Pre-turn LLM compaction (§14, CLI parity): when the durable history has
  // grown past the budget, collapse the older span into a model-written
  // `[CONTEXT HANDOFF]` summary the preamble renders un-clipped — so the lead
  // stops silently forgetting everything beyond the last few turns. Fails soft;
  // the shared kernel's own context management backstops the within-turn wire.
  await maybeCompactLeadHistory(state, providerConfig, apiKey, {
    onStatus: (phase) => dispatchEvent('status', { source: 'lead', phase }),
    persistEvent,
  });

  const hasCompactedHistory = (state.messages as Message[]).some(
    (message) => typeof message.content === 'string' && isHandoffBlock(message.content),
  );
  let userGoalAnchor: UserGoalAnchor | null = null;
  if (hasCompactedHistory) {
    userGoalAnchor = await loadUserGoalFile(state.cwd);
    if (!userGoalAnchor) {
      const userTurns = (state.messages as Message[])
        .filter(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.trim().length > 0 &&
            !isToolResultMessage(message) &&
            !isHandoffBlock(message.content),
        )
        .map((message) => message.content.trim());
      userGoalAnchor = deriveUserGoalAnchor({
        firstUserTurn: userTurns[0],
        recentUserTurns: userTurns,
        branch: {
          repoFullName: workspaceIdentity.repoFullName,
          name: workspaceIdentity.branch,
        },
      });
    } else if (!userGoalAnchor.branchLabel && workspaceIdentity.branch) {
      const branchLabel = deriveUserGoalAnchor({
        firstUserTurn: userGoalAnchor.initialAsk,
        branch: {
          repoFullName: workspaceIdentity.repoFullName,
          name: workspaceIdentity.branch,
        },
      })?.branchLabel;
      userGoalAnchor = {
        ...userGoalAnchor,
        ...(branchLabel ? { branchLabel } : {}),
      };
    }
  }

  const leadModelId = state.model || providerConfig.defaultModel;
  // Promote history to a structured reasoning-replay seed only when BOTH the
  // session carries persisted plain reasoning AND the resolved route actually
  // replays `reasoning_content`. The route gate mirrors the web inline lane
  // (shared `routeReplaysReasoningContent`): without it, a session that switched
  // to a non-reasoning model — or a provider that never takes the field — would
  // replay stale reasoning to a route that never asked for it. #1537 review.
  const replayReasoningHistory =
    hasReplayableLeadReasoning(userText, state.messages as Message[]) &&
    routeReplaysReasoningContent(providerConfig.id, leadModelId);
  const taskPreamble = buildLeadTurnPreamble(
    userText,
    state.messages as Message[],
    snapshot,
    memory,
    userGoalAnchor,
    { includePriorConversation: !replayReasoningHistory },
  );
  const initialMessages = replayReasoningHistory
    ? buildLeadReasoningReplaySeed(userText, state.messages as Message[], taskPreamble)
    : undefined;
  const coderPolicy = createCoderPolicy({
    // CLI stdout is user/JSONL protocol output. Structured runtime diagnostics
    // must stay on stderr so machine-readable streams remain pure.
    onEvent: (event) => console.error(formatCoderPolicyEvent(event, 'cli_lead')),
  });
  const taskInFlight = classifyTurnIntent(userText) === 'task';
  const coderPolicyContext: CoderPolicyContext = {
    round: 0,
    maxRounds,
    allowedRepo: workspaceIdentity.repoFullName,
    taskInFlight,
    completionGuard: resolveCoderCompletionGuard(taskInFlight),
  };
  // Explorer fan-out honors the disabledTools policy end-to-end (Codex P2 on
  // #1370): when `delegate_explorer` is disabled, the arc is neither
  // advertised (protocol block, native schema, detector bucket) nor
  // special-cased in the executor — a stray call falls through to
  // `executeToolCall`, whose dispatch gate returns the canonical
  // TOOL_DISABLED denial.
  const explorerFanOutEnabled = !isCliToolDisabled('delegate_explorer', disabledTools);
  const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
    providerConfig.id,
    leadModelId,
  )
    ? getCliNativeToolSchemas({
        includeGitHub: Boolean(githubProtocol),
        // Lead-only surface: the Explorer fan-out schema parses from the same
        // protocol block advertised below, so prompt text and native schema
        // can't drift. The daemon's delegated nodes don't thread this — a
        // delegated sub-Coder neither advertises nor executes delegation.
        extraProtocolBlocks: explorerFanOutEnabled ? [LEAD_EXPLORER_DELEGATION_PROTOCOL] : [],
      })
    : undefined;

  // Tee the provider stream into the engine event vocabulary so the TUI /
  // REPL / daemon clients render the kernel's rounds exactly like engine
  // rounds. The kernel makes one stream call per round; each `done` commits
  // the streamed text as an assistant transcript entry (`assistant_done`).
  let reasoningOpen = false;
  let roundText = '';
  let visibleCharsEmitted = 0;
  const mirror = (event: PushStreamEvent): void => {
    if (event.type === 'reasoning_delta') {
      reasoningOpen = true;
      dispatchEvent('assistant_thinking_token', { text: event.text });
      return;
    }
    if (event.type === 'text_delta') {
      roundText += event.text;
      if (reasoningOpen) {
        reasoningOpen = false;
        dispatchEvent('assistant_thinking_done', {});
      }
      const visible = splitAppendOnlyVisibleContent(roundText).visible;
      if (visible.length > visibleCharsEmitted) {
        dispatchEvent('assistant_token', { text: visible.slice(visibleCharsEmitted) });
        visibleCharsEmitted = visible.length;
      }
      return;
    }
    if (event.type === 'done') {
      if (reasoningOpen) {
        reasoningOpen = false;
        dispatchEvent('assistant_thinking_done', {});
      }
      const messageId = `asst_${Date.now().toString(36)}`;
      void persistEvent('assistant_done', { messageId });
      dispatchEvent('assistant_done', { messageId });
      roundText = '';
      visibleCharsEmitted = 0;
    }
  };
  // Provider failover (decision #13), opt-in via PUSH_PROVIDER_FAILOVER. The
  // kernel makes one stream() call per round; this wrapper retries the same
  // provider on a transient failure, then fails over to another configured
  // provider of the SAME wire shape — round-scoped, so the locked provider is
  // tried first again on the next round. With the flag off the candidate list
  // is empty and `decideStreamFailover` collapses to the same-provider retry
  // the legacy `streamCompletion` applied. Failover only fires before any event
  // streamed this round (`yieldedAny`), so a partially-rendered round is never
  // re-attempted on another provider.
  const failoverEnabled =
    process.env.PUSH_PROVIDER_FAILOVER === '1' || process.env.PUSH_PROVIDER_FAILOVER === 'true';

  const stream: PushStream<LlmMessage> = (req) =>
    (async function* () {
      const tried = new Set<string>([providerConfig.id]);
      let activeConfig = providerConfig;
      let activeKey = apiKey;
      let activeModel = req.model;
      let sameProviderAttempt = 0;
      for (;;) {
        const providerStream = createProviderStream(activeConfig, activeKey, {
          sessionId: state.sessionId,
        });
        let yieldedAny = false;
        try {
          const requestTools =
            req.tools && cliProviderModelSupportsNativeToolCalling(activeConfig.id, activeModel)
              ? req.tools
              : undefined;
          const events = normalizeReasoning(
            providerStream({
              ...req,
              provider: activeConfig.id as AIProviderType,
              model: activeModel,
              tools: requestTools,
            }),
          );
          for await (const event of events) {
            yieldedAny = true;
            mirror(event);
            yield event;
          }
          return;
        } catch (err) {
          // Aborts never fail over — propagate so the lead turn's catch maps it
          // to an `aborted` outcome.
          if ((err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false)) {
            throw err;
          }
          const candidates = failoverEnabled
            ? resolveCliFailoverCandidates(activeConfig.id, tried)
            : [];
          const decision = decideStreamFailover({
            classification: classifyCliStreamError(err),
            aborted: signal?.aborted ?? false,
            hasOutput: yieldedAny,
            sameProviderAttempt,
            sameProviderMax: MAX_RETRIES - 1,
            tried,
            candidates: candidates.map((c) => c.config.id),
            retryDelayMs: cliStreamRetryDelayMs(sameProviderAttempt),
          });
          if (decision.action === 'give-up') throw err;
          if (decision.action === 'retry-same') {
            dispatchEvent('warning', {
              code: 'PROVIDER_RETRY',
              message: `Retrying ${activeConfig.id} after a transient error`,
              provider: activeConfig.id,
              attempt: sameProviderAttempt + 1,
            });
            sameProviderAttempt += 1;
            await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
            if (signal?.aborted) {
              const abortErr = new Error('Request aborted.');
              abortErr.name = 'AbortError';
              throw abortErr;
            }
            continue;
          }
          // decision.action === 'failover'
          const next = candidates.find((c) => c.config.id === decision.provider);
          if (!next) throw err; // resolver race — nothing left to fail over to
          dispatchEvent('warning', {
            code: 'PROVIDER_FAILOVER',
            message: `Provider ${activeConfig.id} failed; failing over to ${next.config.id}`,
            from: activeConfig.id,
            to: next.config.id,
          });
          activeConfig = next.config;
          activeKey = next.apiKey;
          activeModel = next.config.defaultModel;
          tried.add(next.config.id);
          sameProviderAttempt = 0;
          continue;
        }
      }
    })();

  // Same executor + policy surface as the engine loop, with the actual role.
  const defaultCliHookRegistry = getDefaultCliHookRegistry();
  function policyPostFrom(
    result: CoderPolicyAfterResult,
  ): { kind: 'inject'; content: string } | { kind: 'halt'; summary: string } | undefined {
    if (!result) return undefined;
    return result.action === 'inject'
      ? { kind: 'inject', content: result.content }
      : { kind: 'halt', summary: result.summary };
  }

  async function applyAfterToolPolicy(
    result: CoderToolExecResult,
    rawCall: CliToolCall,
  ): Promise<CoderToolExecResult> {
    if (result.kind !== 'executed') return result;
    const policyResult = await coderPolicy.evaluateAfterTool(
      rawCall.tool,
      rawCall.args ?? {},
      result.resultText,
      Boolean(result.errorType),
      coderPolicyContext,
    );
    const policyPost = policyPostFrom(policyResult);
    return policyPost ? { ...result, policyPost } : result;
  }

  const toolExec = async (
    toolCall: CliKernelCall,
    execCtx: CoderToolExecContext,
  ): Promise<CoderToolExecResult> => {
    // Fall through for a bare flat call (tests that drive the executor
    // directly) — production calls always arrive kernel-wrapped.
    const rawCall: CliToolCall =
      toolCall && typeof toolCall === 'object' && toolCall.call
        ? toolCall.call
        : (toolCall as unknown as CliToolCall);
    coderPolicyContext.round = execCtx.round;
    coderPolicyContext.phase = execCtx.phase;
    const beforeTool = await coderPolicy.evaluateBeforeTool(
      rawCall.tool,
      rawCall.args ?? {},
      coderPolicyContext,
    );
    if (beforeTool) {
      // The kernel always emits the paired completion event. Synthesize the
      // start before returning the denial so TUI transcript state never sees a
      // completion for an entry it was not told to create.
      const startPayload = {
        round: execCtx.round,
        executionId: execCtx.executionId,
        toolName: rawCall.tool,
        toolSource: 'coder',
        args: rawCall.args,
      };
      void persistEvent('tool.execution_start', startPayload);
      dispatchEvent('tool.execution_start', startPayload);
      return { kind: 'denied', reason: beforeTool.reason };
    }
    // Explorer-only delegation arc (§10): the lead offloads read-only
    // investigation but does its own coding — `delegate_explorer` is the
    // only delegation tool the lead executes (there is no `delegate_coder`
    // on this surface; unknown tools keep hitting executeToolCall's
    // UNKNOWN_TOOL error below). Routed before the `tool.execution_start`
    // synthesis: the delegation renders through its own `subagent.*`
    // lifecycle events (same as the daemon's delegated runs), not as a
    // sandbox-tool transcript row. Never throws — a failed Explorer must not
    // take down the siblings sharing the kernel's parallel batch. When the
    // fan-out is disabled by policy, fall through so `executeToolCall`'s
    // dispatch gate returns its canonical TOOL_DISABLED denial.
    if (rawCall.tool === 'delegate_explorer' && explorerFanOutEnabled) {
      const { resultText, card } = await runLeadExplorerDelegation(rawCall.args ?? {}, {
        cwd: state.cwd,
        sessionId: state.sessionId,
        providerConfig,
        apiKey,
        model: state.model,
        roleRouting: state.roleRouting,
        projectInstructions: instructions?.content || undefined,
        instructionFilename: instructions?.file || undefined,
        signal,
        // Default (no parallel-delegation bucket) detectors: an Explorer
        // cannot fan out further Explorers.
        detectors: {
          detectAllToolCalls: wrapCliDetectAllToolCalls,
          detectNativeToolCalls: wrapCliDetectNativeToolCalls,
          detectAnyToolCall: wrapCliDetectAnyToolCall,
        },
        onStatus: (phase, detail) => dispatchEvent('status', { source: 'explorer', phase, detail }),
        emitEvent: (type, payload) => {
          void persistEvent(type, payload);
          dispatchEvent(type, payload);
        },
      });
      return applyAfterToolPolicy(
        { kind: 'executed', resultText, ...(card ? { card } : {}) },
        rawCall,
      );
    }
    // Synthesize the start event the engine loop emits before each tool run
    // (Codex P2, PR #904): the TUI creates the transcript tool entry and its
    // file-awareness args queue on `tool.execution_start` — the kernel's own
    // `tool.execution_complete` only *updates* an existing entry. The kernel
    // mints the lifecycle id before invoking this host executor and reuses it
    // on completion, so parallel calls of the same tool remain independently
    // attributable.
    const startPayload = {
      round: execCtx.round,
      executionId: execCtx.executionId,
      toolName: rawCall.tool,
      toolSource: 'coder',
      args: rawCall.args,
    };
    void persistEvent('tool.execution_start', startPayload);
    dispatchEvent('tool.execution_start', startPayload);
    try {
      const result = await executeToolCall(rawCall, state.cwd, {
        role: 'coder',
        approvalFn,
        askUserFn,
        signal,
        allowExec,
        safeExecPatterns,
        execMode,
        disabledTools,
        alwaysAllow,
        auditorGate,
        providerId: providerConfig?.id,
        providerApiKey: apiKey,
        model: state.model,
        runId,
        hooks: defaultCliHookRegistry,
        getCurrentBranch: () => readCliCurrentBranch(state.cwd),
      });
      const resultText: string = typeof result?.text === 'string' ? result.text : '';
      // File-mutation results carry a structured diff in meta.editDiff
      // (cli/tools.ts) — lift it onto the exec result so the kernel can
      // stamp it on `tool.execution_complete` for transcript rendering.
      const meta = result?.meta as Record<string, unknown> | null | undefined;
      const metaDiff = meta?.editDiff;
      const editDiff = isEditDiff(metaDiff) ? metaDiff : undefined;
      // Typed render payload. GitHub tools (and any tool that builds one) return
      // it as `meta.card` (cli/tools.ts) — lift it the same way as editDiff so
      // the kernel can stamp it on `tool.execution_complete`. Without this the
      // CLI has a card slot it can never fill: `pr_list` / `ci_status` would emit
      // run events with no card and the TUI would be back to guessing.
      // `meta` is untyped, so validate at the boundary.
      const metaCard = meta?.card;
      const card = isToolCard(metaCard) ? metaCard : undefined;
      // Adaptive-harness signal: file-mutation OUTCOMES feed editErrorRate
      // (shrink Rule 2). Keyed on FILE_MUTATION_TOOLS (write_file / edit_file /
      // undo_edit) — the arg-shape oracle `writeTargetOf` misses edit_file's
      // `{path, edits, expected_version}` form, the main surgical-edit path.
      // Skip approval/capability DENIALS (`*_DENIED`): a human or policy saying
      // no is not model edit-flailing and must not inflate the error rate.
      if (FILE_MUTATION_TOOLS.has(rawCall.tool)) {
        const code = result?.structuredError?.code;
        const denied = typeof code === 'string' && code.endsWith('_DENIED');
        if (!denied) {
          // A STALE_WRITE is its own (diagnostic-only) category, NOT an edit
          // error — a model re-reading and retrying with a fresh
          // expected_version is normal, and counting it toward editErrorRate
          // would wrongly trip the 25% shrink. Track it as stale, not error.
          const stale = code === 'STALE_WRITE';
          recordWriteFile(adaptationMetricsKey, {
            error: result?.ok !== true && !stale,
            stale,
          });
        }
      }
      if (result && result.ok === true) {
        return applyAfterToolPolicy(
          {
            kind: 'executed',
            resultText,
            ...(editDiff ? { editDiff } : {}),
            ...(card ? { card } : {}),
          },
          rawCall,
        );
      }
      // Tool ran but reported failure — feed the structured-error code into
      // the kernel's mutation-failure tracker via `errorType`.
      return applyAfterToolPolicy(
        {
          kind: 'executed',
          resultText,
          errorType: result?.structuredError?.code,
          ...(editDiff ? { editDiff } : {}),
          ...(card ? { card } : {}),
        },
        rawCall,
      );
    } catch (err) {
      // Approval timeout, abort during exec, catastrophic I/O. Surface as
      // `denied` so the kernel reacts instead of spinning on the same call.
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'denied', reason: `lead tool executor error: ${message}` };
    }
  };

  const callbacks: CoderAgentCallbacks = {
    onStatus: (phase, detail, kind) => {
      // The kernel's statuses were built for the web's TRANSIENT bar, where each
      // replaces the last. This lane appends them to a PERMANENT transcript, so
      // only the durable half belongs here (`StatusKind` in lib/coder-agent.ts
      // carries the distinction).
      //
      // What this drops, and why it is not cosmetic: every round emitted
      // 'Coder working...' (Round N) and 'Coder executing...' (the raw tool
      // name) — the first pure loop bookkeeping, the second a strictly worse
      // duplicate of the tool card rendered directly beneath it. They also sat
      // BETWEEN every pair of tool rows, and `groupSilveryTranscriptRows` folds
      // only CONSECUTIVE tool calls: run length was always 1, so the fold could
      // never fire and the projection was dead in production despite passing its
      // own tests. Measured on a real 3-tool turn: 9 rows → 1.
      //
      // Filtering on `kind`, not on the phase string, is the point. This used to
      // read `if (phase === 'Coder reasoning') return` — a label rename in the
      // kernel would have silently restored the noise with nothing going red.
      if (kind === 'progress') return;
      dispatchEvent('status', { source: 'lead', phase, detail });
    },
    signal,
    // The lead asks the user directly when an interactive prompt exists —
    // there is no Orchestrator above it (§10). With no `askUserFn` (daemon
    // turns), the callback is omitted and the kernel treats a checkpoint as
    // completion, same as the delegated daemon nodes.
    onCheckpointRequest: askUserFn
      ? async (question: string, context: string): Promise<string> =>
          askUserFn(context ? `${question}\n\nContext: ${context}` : question)
      : undefined,
    onWorkingMemoryUpdate: (mem) => {
      // state.workingMemory is the CLI's single source of truth (persisted +
      // read by repo-commands); runtimeContext.workingMemory.coder is unused on
      // the CLI, so it is deliberately not mirrored here.
      state.workingMemory = JSON.parse(JSON.stringify(mem));
    },
    onRunEvent: (event) => {
      const { type, ...payload } = event as { type: string } & Record<string, unknown>;
      if (type === 'tool.call_malformed') {
        recordMalformedToolCall(payload.reason, state.sessionId);
        recordMalformedToolCall(payload.reason, adaptationMetricsKey);
      }
      void persistEvent(type, payload);
      dispatchEvent(type, payload);
    },
  };

  // Adaptive harness: each user turn gets a fresh metric window keyed by runId
  // (the plain sessionId bucket stays cumulative for the CLI's end-of-session
  // summary). The runId makes the key unique per turn, so it starts empty — no
  // reset needed up front; it's cleared in the `finally` below so the metric
  // maps don't accumulate one entry per turn on a long-running daemon.

  try {
    const result = await runCoderAgent<CliKernelCall>(
      {
        provider: providerConfig.id as AIProviderType,
        stream,
        modelId: leadModelId,
        sandboxId: '',
        allowedRepo: '',
        userProfile: null,
        taskPreamble,
        initialMessages,
        symbolSummary: null,
        toolExec,
        // Lead surface: enable the parallel-delegation bucket so the lead can
        // fan out up to LEAD_MAX_PARALLEL_EXPLORERS Explorers in one turn
        // (they ride the kernel's read-phase Promise.all). The daemon's
        // delegated nodes keep the default (no bucket — a delegation call
        // falls through to the trailing slot), as does a lead whose fan-out
        // is disabled by policy.
        detectAllToolCalls: (text: string) =>
          wrapCliDetectAllToolCalls(text, {
            maxParallelDelegations: explorerFanOutEnabled ? LEAD_MAX_PARALLEL_EXPLORERS : null,
          }),
        detectNativeToolCalls: (calls: readonly NativeToolCall[]) =>
          wrapCliDetectNativeToolCalls(calls, {
            maxParallelDelegations: explorerFanOutEnabled ? LEAD_MAX_PARALLEL_EXPLORERS : null,
          }),
        detectAnyToolCall: wrapCliDetectAnyToolCall,
        webSearchToolProtocol: '',
        // The CLI's full tool protocol rides the kernel's sandbox slot, same
        // as the daemon's delegated Coder nodes.
        sandboxToolProtocol: TOOL_PROTOCOL,
        // Lead-only extras: GitHub (when a token resolves) plus the Explorer
        // fan-out arc — advertised only when the matching executor paths are
        // wired above (toolExec's delegate_explorer route) and not disabled
        // by policy, so advertising stays aligned with executor support.
        extraToolProtocols: [
          ...(githubProtocol ? [githubProtocol] : []),
          ...(explorerFanOutEnabled ? [LEAD_EXPLORER_DELEGATION_PROTOCOL] : []),
        ],
        nativeToolSchemas,
        projectInstructions: instructions?.content || undefined,
        instructionFilename: instructions?.file || undefined,
        verificationPolicyBlock: null,
        approvalModeBlock: null,
        evaluateAfterModel: async (response, round) => {
          coderPolicyContext.round = round;
          const policyResult = await coderPolicy.evaluateAfterModel(
            response,
            [],
            coderPolicyContext,
          );
          if (!policyResult) return null;
          if (policyResult.action === 'halt') {
            return { action: 'halt', summary: policyResult.summary };
          }
          return {
            action: 'inject',
            content: policyResult.content,
            forceToolChoiceNextRound: policyResult.code === 'announced_no_action',
          };
        },
        harnessMaxRounds: maxRounds,
        // Adaptive harness: re-derive the effective cap each round from
        // in-session health signals (malformed calls, edit errors) — grow on
        // healthy progress toward MAX_ALLOWED_ROUNDS, shrink on flailing.
        // Disabled when the user set an explicit `--max-rounds`: that's a
        // deliberate cap, honored exactly (no grow, no shrink). Keyed on the
        // threaded `explicitMaxRounds` flag, NOT a value compare — an explicit
        // `--max-rounds 50` is indistinguishable from the default by value.
        // See cli/harness-adaptation.ts.
        adaptMaxRounds: options.explicitMaxRounds
          ? undefined
          : ({ round, currentMaxRounds }) => {
              const adaptation = computeAdaptation(adaptationMetricsKey, currentMaxRounds, {
                currentRound: round,
                maxAllowedRounds: MAX_ALLOWED_ROUNDS,
              });
              if (adaptation.wasAdapted) {
                const payload = {
                  round,
                  fromMaxRounds: currentMaxRounds,
                  toMaxRounds: adaptation.adjustedMaxRounds,
                  reasons: adaptation.reasons,
                };
                void persistEvent('harness.adaptation', payload);
                dispatchEvent('harness.adaptation', payload);
              }
              return adaptation.adjustedMaxRounds;
            },
        // Per-run token budget. Config (`config.runTokenBudget`) is forwarded
        // to `PUSH_RUN_TOKEN_BUDGET` by `applyConfigToEnv` at startup, so
        // resolving from env here folds in both the operator override and the
        // user setting. Null (uncapped) maps to undefined for the kernel.
        harnessTokenBudget:
          resolveRunTokenBudget({ env: process.env[RUN_TOKEN_BUDGET_ENV_VAR] }) ?? undefined,
        persona: 'lead',
        // Exempt poll-by-repeat tools (`exec_poll`) from the lead exact-repeat
        // breaker — a quiet long-running command is polled with identical args.
        repeatExemptTools: REPEAT_EXEMPT_TOOLS,
      },
      callbacks,
    );

    const finalAssistantText: string = result.summary || '';
    const finalReasoningContent = result.finalAssistantMessage?.reasoningContent;
    (state.messages as Message[]).push({
      role: 'assistant',
      content: finalAssistantText,
      ...(typeof finalReasoningContent === 'string' && finalReasoningContent.length > 0
        ? { reasoningContent: finalReasoningContent }
        : {}),
    });
    state.rounds = (state.rounds ?? 0) + result.rounds;
    await saveSessionState(state);

    // An abnormal stop is not success (Codex P2 #942). The RunResult outcome
    // and the `run_complete` event use different vocabularies: the event's
    // RUN_COMPLETE_OUTCOMES allows `max_rounds`/`failed` but NOT `error`, so a
    // repeated-tool-call loop maps to an `error` return + a `failed` event
    // (mirroring the catch path below). The round cap is `max_rounds` on both.
    // A token-budget halt is a graceful circuit-breaker stop ("incomplete"),
    // the same shape as the round cap — so it maps to the `max_rounds` outcome
    // on both the RunResult and the event (the kernel's summary already says it
    // was a budget stop). Keeping the existing vocabulary avoids widening the
    // outcome enum across the daemon protocol for a sibling stop class.
    const isCircuitBreakerStop =
      result.stopReason === 'max_rounds' || result.stopReason === 'budget_exceeded';
    const runOutcome: RunResult['outcome'] = isCircuitBreakerStop
      ? 'max_rounds'
      : result.stopReason === 'loop'
        ? 'error'
        : 'success';
    const eventOutcome = isCircuitBreakerStop
      ? 'max_rounds'
      : result.stopReason === 'loop'
        ? 'failed'
        : 'success';

    if (!suppressRunComplete) {
      await persistEvent('run_complete', {
        runId,
        outcome: eventOutcome,
        summary: finalAssistantText.slice(0, 500),
      });
    }
    dispatchEvent('run_complete', { outcome: eventOutcome, summary: finalAssistantText });
    return { outcome: runOutcome, finalAssistantText, rounds: result.rounds, runId };
  } catch (err) {
    const isAbort: boolean =
      (err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false);
    await saveSessionState(state);
    if (isAbort) {
      if (!suppressRunComplete) {
        await persistEvent('run_complete', {
          runId,
          outcome: 'aborted',
          summary: 'Aborted by user.',
        });
      }
      dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
      return { outcome: 'aborted', finalAssistantText: '', rounds: 0, runId };
    }
    const message = err instanceof Error ? err.message : String(err);
    await persistEvent('error', {
      code: 'LEAD_KERNEL_ERROR',
      message,
      retryable: false,
    });
    dispatchEvent('error', { code: 'LEAD_KERNEL_ERROR', message, retryable: false });
    if (!suppressRunComplete) {
      await persistEvent('run_complete', {
        runId,
        outcome: 'failed',
        summary: message.slice(0, 500),
      });
    }
    dispatchEvent('run_complete', { outcome: 'failed', summary: message.slice(0, 500) });
    return { outcome: 'error', finalAssistantText: message, rounds: 0, runId };
  } finally {
    // Drop this turn's per-turn adaptation metric window so the metric maps
    // don't accumulate one entry per turn for the life of a long-running
    // daemon. The cumulative sessionId bucket (read by the end-of-session
    // summary) is intentionally left untouched.
    resetToolCallMetrics(adaptationMetricsKey);
    resetWriteFileMetrics(adaptationMetricsKey);
    resetContextMetrics(adaptationMetricsKey);
    resetAdaptationState(adaptationMetricsKey);
  }
}
