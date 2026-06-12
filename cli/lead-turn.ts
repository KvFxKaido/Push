/**
 * CLI lead-kernel lane — Agent Runtime Decisions §10, Active Runtime Work #8.
 *
 * Runs a terminal-chat turn as a `leadMode: true` run of the **shared** coder
 * kernel (`lib/coder-agent.ts`) instead of the CLI-local engine loop
 * (`cli/engine.ts:runAssistantLoop`). This is the same kernel + lead framing
 * the web's Inline Foreground Lane uses (`app/src/lib/inline-coder-run.ts`),
 * assembled with the CLI's local reach: `executeToolCall` against the real
 * filesystem, the CLI provider streams, and the existing approval gates.
 *
 * Opt-in for now: `runAssistantTurn` routes here only when
 * `RunOptions.leadRuntime === 'kernel'` or `PUSH_LEAD_RUNTIME=kernel` —
 * mirroring how the web shipped the inline lane behind a preference before
 * defaulting it. The engine loop stays the default until the lane is measured.
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
import type {
  AIProviderType,
  LlmMessage,
  PushStream,
  PushStreamEvent,
} from '../lib/provider-contract.ts';
import { normalizeReasoning } from '../lib/reasoning-tokens.ts';
import { createProviderStream } from './provider.js';
import type { ProviderConfig } from './provider.js';
import {
  detectAllToolCalls as cliDetectAllToolCalls,
  detectToolCall as cliDetectToolCall,
  executeToolCall,
  getGitHubToolProtocolAsync,
  FILE_MUTATION_TOOLS,
  READ_ONLY_TOOLS,
  TOOL_PROTOCOL,
} from './tools.js';
import { buildWorkspaceSnapshot, loadProjectInstructions } from './workspace-context.js';
import {
  appendSessionEvent as appendSessionEventRaw,
  makeRunId,
  saveSessionState,
} from './session-store.js';
import type { SessionState } from './session-store.js';
import { isParseErrorMessage, isToolResultMessage } from './context-manager.js';
import type { Message } from './context-manager.js';
import { getDefaultCliHookRegistry, readCliCurrentBranch } from './tool-hooks-default.ts';
import type { RunOptions, RunResult } from './engine.js';

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
 * snapshot, bounded recent conversation, and the raw user turn. Mirrors the
 * web lane's `buildInlineTurnPreamble` (no delegation-brief ceremony) with
 * one CLI addition — the workspace snapshot block the engine loop injects
 * via its system prompt rides in the preamble here, since the kernel owns
 * its own system prompt.
 *
 * `messages` is the session transcript *including* the just-appended user
 * turn (callers append before running the turn); the trailing user message
 * is dropped from the history block so the task isn't duplicated.
 */
export function buildLeadTurnPreamble(
  userText: string,
  messages: ReadonlyArray<Message>,
  workspaceSnapshot: string,
): string {
  const conversational = messages.filter((m) => {
    if (m.role !== 'user' && m.role !== 'assistant') return false;
    if (typeof m.content !== 'string' || !m.content.trim()) return false;
    if (isToolResultMessage(m)) return false;
    if (isParseErrorMessage(m)) return false;
    return true;
  });
  const last = conversational[conversational.length - 1];
  if (last && last.role === 'user' && last.content.trim() === userText.trim()) {
    conversational.pop();
  }
  const prior = conversational.slice(-PRIOR_TURNS_MAX);

  const lines: string[] = [];
  if (workspaceSnapshot.trim()) {
    lines.push(workspaceSnapshot.trim());
    lines.push('');
  }
  if (prior.length > 0) {
    lines.push('Prior conversation in this chat (oldest to newest, truncated):');
    for (const msg of prior) {
      const text = msg.content.trim();
      const clipped =
        text.length > PRIOR_TURN_MAX_CHARS ? `${text.slice(0, PRIOR_TURN_MAX_CHARS)}…` : text;
      lines.push(`[${msg.role}] ${clipped}`);
    }
    lines.push('');
  }
  lines.push(`Task: ${userText}`);
  return lines.join('\n');
}

// ─── Lead turn runner ────────────────────────────────────────────

/**
 * Run one terminal-chat turn as a `leadMode` run of the shared coder kernel.
 *
 * Contract matches `runAssistantLoop`: the caller has already appended the
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
    execMode = 'auto',
    disabledTools,
    alwaysAllow,
    auditorGate,
    suppressRunComplete = false,
    suppressEventPersist = false,
  } = options;
  const runId: string = options.runId || makeRunId();

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
  // ride the kernel's `projectInstructions` slot and the snapshot rides the
  // task preamble.
  const [snapshot, instructions, githubProtocol] = await Promise.all([
    buildWorkspaceSnapshot(state.cwd).catch((): string => ''),
    loadProjectInstructions(state.cwd).catch((): null => null),
    getGitHubToolProtocolAsync().catch((): string => ''),
  ]);

  const taskPreamble = buildLeadTurnPreamble(userText, state.messages as Message[], snapshot);

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
  const baseStream = createProviderStream(providerConfig, apiKey, {
    sessionId: state.sessionId,
  });
  const stream: PushStream<LlmMessage> = (req) =>
    (async function* () {
      for await (const event of normalizeReasoning(baseStream(req))) {
        mirror(event);
        yield event;
      }
    })();

  // Same executor + policy surface as the engine loop, with the actual role.
  const defaultCliHookRegistry = getDefaultCliHookRegistry();
  const toolExec = async (toolCall: CliKernelCall): Promise<CoderToolExecResult<unknown>> => {
    const rawCall =
      toolCall && typeof toolCall === 'object' && toolCall.call ? toolCall.call : toolCall;
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
      if (result && result.ok === true) {
        return { kind: 'executed', resultText };
      }
      // Tool ran but reported failure — feed the structured-error code into
      // the kernel's mutation-failure tracker via `errorType`.
      return {
        kind: 'executed',
        resultText,
        errorType: result?.structuredError?.code,
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
      state.workingMemory = JSON.parse(JSON.stringify(mem));
    },
    onRunEvent: (event) => {
      const { type, ...payload } = event as { type: string } & Record<string, unknown>;
      void persistEvent(type, payload);
      dispatchEvent(type, payload);
    },
  };

  try {
    const result = await runCoderAgent<CliKernelCall, unknown>(
      {
        provider: providerConfig.id as AIProviderType,
        stream,
        modelId: state.model || providerConfig.defaultModel,
        sandboxId: '',
        allowedRepo: '',
        userProfile: null,
        taskPreamble,
        symbolSummary: null,
        toolExec,
        detectAllToolCalls: wrapCliDetectAllToolCalls,
        detectAnyToolCall: wrapCliDetectAnyToolCall,
        webSearchToolProtocol: '',
        // The CLI's full tool protocol rides the kernel's sandbox slot, same
        // as the daemon's delegated Coder nodes.
        sandboxToolProtocol: TOOL_PROTOCOL,
        extraToolProtocols: githubProtocol ? [githubProtocol] : undefined,
        projectInstructions: instructions?.content || undefined,
        instructionFilename: instructions?.file || undefined,
        verificationPolicyBlock: null,
        approvalModeBlock: null,
        evaluateAfterModel: async () => null,
        harnessMaxRounds: maxRounds,
        leadMode: true,
      },
      callbacks,
    );

    const finalAssistantText: string = result.summary || '';
    (state.messages as Message[]).push({ role: 'assistant', content: finalAssistantText });
    state.rounds = (state.rounds ?? 0) + result.rounds;
    await saveSessionState(state);

    if (!suppressRunComplete) {
      await persistEvent('run_complete', {
        runId,
        outcome: 'success',
        summary: finalAssistantText.slice(0, 500),
      });
    }
    dispatchEvent('run_complete', { outcome: 'success', summary: finalAssistantText });
    return { outcome: 'success', finalAssistantText, rounds: result.rounds, runId };
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
