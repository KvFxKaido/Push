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
 * (`assistant_token`, `assistant_thinking_token`, `assistant_done`, `status`,
 * `tool.execution_complete`, `run_complete`, `error`) so the TUI, REPL, and
 * daemon attach clients render it without changes — no new envelope types.
 *
 * Safety boundary unchanged: tools execute through the same
 * `executeToolCall` the engine loop uses, so the Auditor commit gate,
 * high-risk exec approval, and disabled-tool policy all apply identically
 * (the "protected during convergence" list in §10).
 */

import {
  runCoderAgent,
  type CoderAgentCallbacks,
  type CoderToolExecResult,
  type DetectedToolCalls,
} from '../lib/coder-agent.ts';
import { RUN_TOKEN_BUDGET_ENV_VAR, resolveRunTokenBudget } from '../lib/run-cost-budget.ts';
import { isEditDiff } from '../lib/edit-diff.ts';
import { createRuntimeContext } from '../lib/runtime-context.ts';
import type {
  AIProviderType,
  LlmMessage,
  PushStream,
  PushStreamEvent,
} from '../lib/provider-contract.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { decideStreamFailover } from '../lib/provider-failover.ts';
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
import { isHandoffBlock } from '../lib/llm-compaction.ts';
import { getDefaultCliHookRegistry, readCliCurrentBranch } from './tool-hooks-default.ts';
import type { RunOptions, RunResult } from './engine.js';
import type { NativeToolCall } from '../lib/provider-contract.js';
import { DEFAULT_MAX_ROUNDS, MAX_ALLOWED_ROUNDS } from './engine.js';
import { computeAdaptation, resetAdaptationState } from './harness-adaptation.js';
import { recordMalformedToolCall, resetToolCallMetrics } from './tool-call-metrics.js';
import { recordWriteFile, resetWriteFileMetrics } from './edit-metrics.js';
import { resetContextMetrics } from './context-metrics.js';
import { writeTargetOf } from '../lib/loop-detection.ts';

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
 * Wrap `cli/tools.ts`'s flat `{ calls, malformed }` detector output into the
 * `DetectedToolCalls` shape the lib Coder kernel expects.
 *
 * Classification:
 * - `READ_ONLY_TOOLS` → `readOnly`
 * - `FILE_MUTATION_TOOLS` (pure file writes/edits) → `fileMutations`,
 *   batched into one mutation transaction per turn
 * - Anything else (`exec`, `git_commit`, etc.) → the trailing `mutating`
 *   side-effect slot (at most one)
 * - Overflow after the trailing slot, or a second side-effect → `extraMutations`
 *
 * Reads that appear after a mutation has started are treated as a boundary:
 * the sequence stops there so we don't silently reorder the model's intent.
 *
 * Moved here from `cli/pushd.ts` so both the daemon's delegated nodes and the
 * lead-kernel lane share one classifier; pushd re-exports it for its tests.
 */
export function wrapCliDetectAllToolCalls(text: string): DetectedToolCalls<CliKernelCall> {
  const { calls } = cliDetectAllToolCalls(text) as { calls: CliToolCall[] };
  return classifyCliToolCalls(calls);
}

export function wrapCliDetectNativeToolCalls(
  nativeCalls: readonly NativeToolCall[],
): DetectedToolCalls<CliKernelCall> {
  const { calls } = cliDetectNativeToolCalls(nativeCalls) as { calls: CliToolCall[] };
  return classifyCliToolCalls(calls);
}

function classifyCliToolCalls(calls: readonly CliToolCall[]): DetectedToolCalls<CliKernelCall> {
  const readOnly: CliKernelCall[] = [];
  const fileMutations: CliKernelCall[] = [];
  const extraMutations: CliKernelCall[] = [];
  let mutating: CliKernelCall | null = null;
  let phase: 'reads' | 'mutations' | 'done' = 'reads';
  for (const call of calls) {
    const wrapped = wrapCall(call);
    const isRead = READ_ONLY_TOOLS.has(call.tool);
    const isFileMut = !isRead && FILE_MUTATION_TOOLS.has(call.tool);

    if (phase === 'done') {
      extraMutations.push(wrapped);
      continue;
    }

    if (isRead) {
      if (phase === 'reads') {
        readOnly.push(wrapped);
        continue;
      }
      // Read after a mutation started — ordering violation. Push it
      // into `extraMutations` (and flip `phase` so any remaining calls
      // land there too) so the caller can surface a structured error
      // instead of silently dropping the call.
      extraMutations.push(wrapped);
      phase = 'done';
      continue;
    }

    if (isFileMut) {
      phase = 'mutations';
      fileMutations.push(wrapped);
      continue;
    }

    // Side-effecting call (exec, git_commit, save_memory, etc.)
    mutating = wrapped;
    phase = 'done';
  }
  // CLI's `cliDetectAllToolCalls` reports parse/shape failures via the
  // `malformed` channel on its own `ToolDispatchResult`, separate from
  // the kernel's `DetectedToolCalls.droppedCandidates` slot the Web-side
  // detector populates. The CLI surfaces malformed reports through its
  // own event stream, so the kernel gets an empty array here. The shape
  // is still required so the kernel's `detected.droppedCandidates.length`
  // guard doesn't trip on `undefined.length`.
  return { readOnly, fileMutations, mutating, extraMutations, droppedCandidates: [] };
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
): string {
  const conversational = messages.filter((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return false;
    if (typeof m.content !== 'string' || !m.content.trim()) return false;
    if (isToolResultMessage(m)) return false;
    if (isParseErrorMessage(m)) return false;
    return true;
  });
  // The current turn can be one or two trailing user messages:
  // `appendUserMessageWithFileReferences` pushes the raw line and then, when
  // the line carries `@file` tokens, a synthetic `[REFERENCED_FILES]` block.
  // Detach the whole current turn from the prior-conversation render so the
  // reference block rides the Task section verbatim instead of being clipped
  // to PRIOR_TURN_MAX_CHARS as "prior conversation" — which silently dropped
  // most referenced file content on the default kernel lane (Codex P2, #936).
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
  // The most recent `[CONTEXT HANDOFF]` is the only surviving summary of the
  // turns compaction already removed from `state.messages`. The token-based
  // partition can preserve a tail longer than PRIOR_TURNS_MAX, pushing the
  // handoff out of this window — so carry it forward explicitly when it falls
  // outside, or the lead silently loses all the compacted history (§14).
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

  const lines: string[] = [];
  if (workspaceSnapshot.trim()) {
    lines.push(workspaceSnapshot.trim());
    lines.push('');
  }
  if (memory && memory.trim()) {
    lines.push(`[MEMORY]\n${memory.trim()}\n[/MEMORY]`);
    lines.push('');
  }
  if (prior.length > 0) {
    lines.push('Prior conversation in this chat (oldest to newest, truncated):');
    for (const msg of prior) {
      const text = msg.content.trim();
      // A `[CONTEXT HANDOFF]` block is a model-written compaction summary of the
      // turns that were collapsed (CLI parity, §14) — render it un-clipped so the
      // summary survives instead of being chopped to PRIOR_TURN_MAX_CHARS like a
      // raw turn. Same exemption pattern as the `[REFERENCED_FILES]` block.
      const clipped =
        !isHandoffBlock(text) && text.length > PRIOR_TURN_MAX_CHARS
          ? `${text.slice(0, PRIOR_TURN_MAX_CHARS)}…`
          : text;
      lines.push(`[${msg.role}] ${clipped}`);
    }
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
  const [snapshot, instructions, memory, githubProtocol] = await Promise.all([
    buildWorkspaceSnapshot(state.cwd).catch((): string => ''),
    loadProjectInstructions(state.cwd).catch((): null => null),
    loadMemory(state.cwd).catch((): null => null),
    getGitHubToolProtocolAsync().catch((): string => ''),
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

  const taskPreamble = buildLeadTurnPreamble(
    userText,
    state.messages as Message[],
    snapshot,
    memory,
  );
  const leadModelId = state.model || providerConfig.defaultModel;
  const nativeToolSchemas = cliProviderModelSupportsNativeToolCalling(
    providerConfig.id,
    leadModelId,
  )
    ? getCliNativeToolSchemas({ includeGitHub: Boolean(githubProtocol) })
    : undefined;

  // Tee the provider stream into the engine event vocabulary so the TUI /
  // REPL / daemon clients render the kernel's rounds exactly like engine
  // rounds. The kernel makes one stream call per round; each `done` commits
  // the streamed text as an assistant transcript entry (`assistant_done`).
  let reasoningOpen = false;
  const mirror = (event: PushStreamEvent): void => {
    if (event.type === 'reasoning_delta') {
      reasoningOpen = true;
      dispatchEvent('assistant_thinking_token', { text: event.text });
      return;
    }
    if (event.type === 'text_delta') {
      if (reasoningOpen) {
        reasoningOpen = false;
        dispatchEvent('assistant_thinking_done', {});
      }
      dispatchEvent('assistant_token', { text: event.text });
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
  let toolExecutionCounter = 0;
  const toolExec = async (
    toolCall: CliKernelCall,
    execCtx: { round: number; phase?: string },
  ): Promise<CoderToolExecResult<unknown>> => {
    // Fall through for a bare flat call (tests that drive the executor
    // directly) — production calls always arrive kernel-wrapped.
    const rawCall: CliToolCall =
      toolCall && typeof toolCall === 'object' && toolCall.call
        ? toolCall.call
        : (toolCall as unknown as CliToolCall);
    // Synthesize the start event the engine loop emits before each tool run
    // (Codex P2, PR #904): the TUI creates the transcript tool entry and its
    // file-awareness args queue on `tool.execution_start` — the kernel's own
    // `tool.execution_complete` only *updates* an existing entry, matched by
    // toolName, so without this the lane's tool calls never appear. The
    // kernel mints a separate executionId for its complete event; that's
    // fine — TUI correlation is name-keyed, not id-keyed.
    toolExecutionCounter += 1;
    const startPayload = {
      round: execCtx?.round ?? 0,
      executionId: `${runId}_lead_${toolExecutionCounter.toString(36)}`,
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
      const metaDiff = (result?.meta as Record<string, unknown> | null | undefined)?.editDiff;
      const editDiff = isEditDiff(metaDiff) ? metaDiff : undefined;
      // Adaptive-harness signal: a file-mutation call feeds editErrorRate
      // (shrink Rule 2). Classified via the shared `writeTargetOf` oracle so it
      // matches the kernel's own file-mutation detection. `stale` is
      // diagnostic-only on the CLI (no rule reads it), so we track error.
      if (writeTargetOf(rawCall.args)) {
        recordWriteFile(state.sessionId, { error: result?.ok !== true, stale: false });
      }
      if (result && result.ok === true) {
        return { kind: 'executed', resultText, ...(editDiff ? { editDiff } : {}) };
      }
      // Tool ran but reported failure — feed the structured-error code into
      // the kernel's mutation-failure tracker via `errorType`.
      return {
        kind: 'executed',
        resultText,
        errorType: result?.structuredError?.code,
        ...(editDiff ? { editDiff } : {}),
      };
    } catch (err) {
      // Approval timeout, abort during exec, catastrophic I/O. Surface as
      // `denied` so the kernel reacts instead of spinning on the same call.
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'denied', reason: `lead tool executor error: ${message}` };
    }
  };

  const callbacks: CoderAgentCallbacks<unknown> = {
    onStatus: (phase, detail) => {
      // The kernel's "Reasoning Sync" status mirrors the first ~150 chars of
      // each round's text — built for the web's transient status bar. The
      // TUI renders every status event as a transcript entry, and the lane
      // already streams the same text live (`assistant_token`), so here the
      // snippet is a truncated duplicate of the answer. Drop it; all other
      // statuses (rounds, checkpoints, halts) pass through.
      if (phase === 'Coder reasoning') return;
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
      // Adaptive-harness signal: malformed tool calls feed the shrink rule
      // (Rule 1). Recorded here off the existing event stream so no extra
      // kernel callback is needed.
      if (type === 'tool.call_malformed') {
        recordMalformedToolCall(payload.reason, state.sessionId);
      }
      void persistEvent(type, payload);
      dispatchEvent(type, payload);
    },
  };

  // Adaptive harness: each user turn gets a fresh round budget. Reset the
  // per-session signal counters + one-shot adaptation state so a rough prior
  // turn doesn't cap this one (they're session-scoped and otherwise accumulate
  // across turns). Signals re-accrue within this turn; `adaptMaxRounds` reads
  // them per round.
  resetToolCallMetrics(state.sessionId);
  resetWriteFileMetrics(state.sessionId);
  resetContextMetrics(state.sessionId);
  resetAdaptationState(state.sessionId);

  try {
    const result = await runCoderAgent<CliKernelCall, unknown>(
      {
        provider: providerConfig.id as AIProviderType,
        stream,
        modelId: leadModelId,
        sandboxId: '',
        allowedRepo: '',
        userProfile: null,
        taskPreamble,
        symbolSummary: null,
        toolExec,
        detectAllToolCalls: wrapCliDetectAllToolCalls,
        detectNativeToolCalls: wrapCliDetectNativeToolCalls,
        detectAnyToolCall: wrapCliDetectAnyToolCall,
        webSearchToolProtocol: '',
        // The CLI's full tool protocol rides the kernel's sandbox slot, same
        // as the daemon's delegated Coder nodes.
        sandboxToolProtocol: TOOL_PROTOCOL,
        extraToolProtocols: githubProtocol ? [githubProtocol] : undefined,
        nativeToolSchemas,
        projectInstructions: instructions?.content || undefined,
        instructionFilename: instructions?.file || undefined,
        verificationPolicyBlock: null,
        approvalModeBlock: null,
        evaluateAfterModel: async () => null,
        harnessMaxRounds: maxRounds,
        // Adaptive harness: re-derive the effective cap each round from
        // in-session health signals (malformed calls, edit errors) — grow on
        // healthy progress toward MAX_ALLOWED_ROUNDS, shrink on flailing.
        // Gated to the DEFAULT budget: an explicit `--max-rounds` is a
        // deliberate cap and is honored exactly (no grow, no shrink) — without
        // this, `--max-rounds 1` would balloon to 16 the moment round 0 lands
        // within the growth trigger margin. See cli/harness-adaptation.ts.
        adaptMaxRounds:
          maxRounds === DEFAULT_MAX_ROUNDS
            ? ({ round, currentMaxRounds }) =>
                computeAdaptation(state.sessionId, currentMaxRounds, {
                  currentRound: round,
                  maxAllowedRounds: MAX_ALLOWED_ROUNDS,
                }).adjustedMaxRounds
            : undefined,
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
    (state.messages as Message[]).push({ role: 'assistant', content: finalAssistantText });
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
  }
}
