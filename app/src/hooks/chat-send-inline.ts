/**
 * chat-send-inline.ts — the Inline Foreground Lane.
 *
 * PR 2 of `docs/decisions/Inline Foreground Lane — Local While Watched.md`:
 * when delegation-mode is `inline` (the default), the user's raw turn runs
 * the coder kernel **in the browser as the lead agent** — no Orchestrator
 * handoff, no Planner, no brief — streaming into the normal chat
 * transcript. The turn lives inside the existing run-session machinery
 * (`acquireRunSession` → this lane → `finalizeRunSession` in
 * `useChat.sendMessage`), so it inherits the tab lock, heartbeats, RunHost
 * registration, and adoption-on-silence like every foreground run.
 *
 * Owns, per the decision doc's lane spec:
 *   - kernel bindings — `runInPageCoderKernel` with the chat's locked
 *     provider/model, memory tools scoped repo/branch/chat, branch context
 *     + Protect Main, project instructions;
 *   - streaming bridge — `teePushStream` mirrors `text_delta`/reasoning
 *     events into the streaming assistant placeholder while the kernel
 *     consumes the stream unchanged; the kernel's final summary completes
 *     the message;
 *   - per-round checkpointing — the kernel's `onCheckpoint` (cadence 1)
 *     bridges into the legacy + V1 capture via `flushCheckpoint('turn')`,
 *     with `checkpointRefs.apiMessages` pointed at the kernel transcript so
 *     an adopted continuation (`runCheckpointToCoderResumeState`) resumes
 *     from a checkpoint that was *born* as coder state — round, messages,
 *     and working memory align by construction;
 *   - Auditor invocation — the same `runCoderAuditorGate` the delegated
 *     arc uses, with the pre-run HEAD/untracked snapshot;
 *   - measurement — `inline_turn_started` / `inline_turn_completed`, A/B
 *     comparable with `delegation_engine_job_started` and
 *     `coder_delegation_measured`.
 *
 * Sibling module per the `useChat.ts` max-lines guard — the dispatch in
 * `sendMessage` stays a two-line branch.
 */

import type { MutableRefObject } from 'react';
import { getProviderPushStream } from '@/lib/orchestrator';
import { getSandboxDiff } from '@/lib/sandbox-client';
import {
  capturePreCoderSnapshot,
  createCoderCheckpointAnswerer,
  runCoderAuditorGate,
  runInPageCoderKernel,
  teePushStream,
} from '@/lib/inline-coder-run';
import { resolveHarnessSettings } from '@/lib/model-capabilities';
import { buildMemoryScope, runContextMemoryBestEffort } from '@/lib/memory-context-helpers';
import { invalidateMemoryForChangedFiles } from '@/lib/context-memory';
import {
  extractChangedPathsFromDiff,
  recordVerificationArtifact,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import type { CoderCheckpointState } from '@push/lib/coder-agent';
import type { LlmMessage, PushStream, PushStreamEvent } from '@push/lib/provider-contract';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type { ChatCard, ChatMessage } from '@/types';
import type { SendLoopContext } from './chat-send-types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface InlineCoderTurnArgs {
  /** The user's raw turn — the kernel's task, verbatim. */
  trimmedText: string;
  /** Seed transcript from `prepareSendContext` (ends with the user turn). */
  apiMessages: ChatMessage[];
  /** Engine run id (post-`acquireRunSession`), for the measurement logs. */
  runId: string;
  agentsMdRef: MutableRefObject<string | null>;
  instructionFilenameRef: MutableRefObject<string | null>;
  getVerificationPolicyForChat: (chatId: string) => VerificationPolicy;
}

export interface InlineCoderTurnResult {
  /** True only when the kernel ran to a normal completion. */
  completedNormally: boolean;
}

// ---------------------------------------------------------------------------
// Prior-context seeding (decision doc, open question 1: bounded
// recent-history block in the preamble for v1 — mirrors the shape of the
// DO's `formatPriorTurnsPreamble`, but from the local transcript).
// ---------------------------------------------------------------------------

const PRIOR_TURNS_MAX = 6;
const PRIOR_TURN_MAX_CHARS = 700;

export function buildInlineTurnPreamble(
  trimmedText: string,
  apiMessages: ReadonlyArray<ChatMessage>,
): string {
  const prior = apiMessages
    .slice(0, -1)
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        !m.isToolCall &&
        !m.isToolResult &&
        Boolean((m.displayContent ?? m.content).trim()),
    )
    .slice(-PRIOR_TURNS_MAX);

  const lines: string[] = [];
  if (prior.length > 0) {
    lines.push('Prior conversation in this chat (oldest to newest, truncated):');
    for (const msg of prior) {
      const text = (msg.displayContent ?? msg.content).trim();
      const clipped =
        text.length > PRIOR_TURN_MAX_CHARS ? `${text.slice(0, PRIOR_TURN_MAX_CHARS)}…` : text;
      lines.push(`[${msg.role}] ${clipped}`);
    }
    lines.push('');
  }
  lines.push(`Task: ${trimmedText}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Streaming bridge — mirror kernel stream events into the placeholder
// ---------------------------------------------------------------------------

/**
 * Build the tee observer that feeds the streaming assistant placeholder.
 * Accumulates per kernel round (a `done` event resets the buffer on the
 * next delta) so the placeholder always shows the round in flight; the
 * kernel's final summary replaces it at completion.
 */
export function createInlineTranscriptMirror(
  ctx: SendLoopContext,
): (event: PushStreamEvent) => void {
  const { chatId } = ctx;
  let accumulated = '';
  let thinking = '';
  let roundSettled = false;

  return (event) => {
    if (ctx.abortRef.current) return;
    if (event.type === 'done') {
      roundSettled = true;
      return;
    }
    if (event.type !== 'text_delta' && event.type !== 'reasoning_delta') return;
    if (roundSettled) {
      accumulated = '';
      thinking = '';
      roundSettled = false;
    }
    if (event.type === 'text_delta') {
      accumulated += event.text;
      ctx.updateAgentStatus({ active: true, phase: 'Responding...' }, { chatId, log: false });
    } else {
      thinking += event.text;
      ctx.updateAgentStatus({ active: true, phase: 'Reasoning...' }, { chatId, log: false });
    }
    ctx.emitRunEngineEvent({
      type: 'ACCUMULATED_UPDATED',
      timestamp: Date.now(),
      text: accumulated,
      thinking,
    });
    ctx.setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      const lastIdx = msgs.length - 1;
      if (msgs[lastIdx]?.role !== 'assistant') return prev;
      msgs[lastIdx] = {
        ...msgs[lastIdx],
        content: accumulated,
        thinking: thinking || undefined,
        status: 'streaming',
      };
      return { ...prev, [chatId]: { ...conv, messages: msgs } };
    });
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

type InlineTurnOutcome = 'ok' | 'aborted' | 'failed' | 'precondition-failed';

function logInlineTurnCompleted(fields: {
  chatId: string;
  runId: string;
  outcome: InlineTurnOutcome;
  elapsedMs: number;
  rounds?: number;
  checkpoints?: number;
  error?: string;
}): void {
  console.log(
    JSON.stringify({
      level:
        fields.outcome === 'failed' || fields.outcome === 'precondition-failed' ? 'error' : 'info',
      event: 'inline_turn_completed',
      mode: 'inline',
      chatId: fields.chatId,
      runId: fields.runId,
      outcome: fields.outcome,
      elapsedMs: fields.elapsedMs,
      rounds: fields.rounds ?? null,
      checkpoints: fields.checkpoints ?? null,
      ...(fields.error ? { error: fields.error } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Message finalization
// ---------------------------------------------------------------------------

function completeAssistantMessage(
  ctx: SendLoopContext,
  update: { content: string; cards?: ChatCard[] },
): void {
  const { chatId } = ctx;
  ctx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = [...conv.messages];
    const lastIdx = msgs.length - 1;
    if (msgs[lastIdx]?.role !== 'assistant') return prev;
    msgs[lastIdx] = {
      ...msgs[lastIdx],
      content: update.content,
      thinking: undefined,
      status: 'done',
      ...(update.cards && update.cards.length > 0 ? { cards: update.cards } : {}),
    };
    ctx.dirtyConversationIdsRef.current.add(chatId);
    return { ...prev, [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() } };
  });
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

export async function startInlineCoderTurn(
  ctx: SendLoopContext,
  args: InlineCoderTurnArgs,
): Promise<InlineCoderTurnResult> {
  const { chatId, lockedProvider, resolvedModel } = ctx;
  const startedMs = Date.now();

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'inline_turn_started',
      mode: 'inline',
      chatId,
      runId: args.runId,
      provider: lockedProvider,
      model: resolvedModel ?? null,
    }),
  );

  // --- Preconditions: the lane needs a live sandbox up front (mirrors the
  // engine route's lazy ensure; `prepareSendContext`'s prewarm is mode-gated
  // and may not have fired). ---
  let sandboxId = ctx.sandboxIdRef.current;
  if (!sandboxId && ctx.ensureSandboxRef.current) {
    ctx.updateAgentStatus({ active: true, phase: 'Starting sandbox...' }, { chatId });
    try {
      sandboxId = await ctx.ensureSandboxRef.current();
      if (sandboxId) ctx.sandboxIdRef.current = sandboxId;
    } catch {
      /* fall through to the precondition error below */
    }
  }
  const repoFullName = ctx.repoRef.current;
  const branchInfo = ctx.branchInfoRef.current;
  const activeBranch = branchInfo?.currentBranch ?? branchInfo?.defaultBranch ?? '';
  if (!sandboxId || !repoFullName || !activeBranch) {
    completeAssistantMessage(ctx, {
      content:
        '[Inline turn unavailable] This turn needs an active sandbox, repo, and branch. Try again once the workspace is ready.',
    });
    logInlineTurnCompleted({
      chatId,
      runId: args.runId,
      outcome: 'precondition-failed',
      elapsedMs: Date.now() - startedMs,
      error: !sandboxId ? 'no sandbox' : !repoFullName ? 'no repo' : 'no branch',
    });
    return { completedNormally: false };
  }

  const memoryScope = buildMemoryScope(chatId, repoFullName, activeBranch);
  const verificationPolicy = args.getVerificationPolicyForChat(chatId);
  const harnessSettings = resolveHarnessSettings(lockedProvider, resolvedModel || undefined);

  // Pre-run HEAD + untracked baseline for the Auditor (PRs #604/#606).
  const { preCoderHead, preCoderUntrackedFiles } = await capturePreCoderSnapshot(sandboxId);

  // --- Kernel bindings ---
  const mirror = createInlineTranscriptMirror(ctx);
  const stream = teePushStream(
    getProviderPushStream(lockedProvider) as unknown as PushStream<LlmMessage>,
    mirror,
  );

  const answerCheckpoint = createCoderCheckpointAnswerer({
    chatId,
    apiMessages: args.apiMessages,
    provider: lockedProvider,
    model: resolvedModel || undefined,
    memoryScope,
    readLatestCoderState: () => ctx.lastCoderStateRef.current,
    getSignal: () => ctx.abortControllerRef.current?.signal,
    updateAgentStatus: ctx.updateAgentStatus,
  });

  // Per-round durability bridge: point the V1 capture at the kernel's own
  // transcript so the persisted checkpoint round-trips through
  // `runCheckpointToCoderResumeState` as coder state, not a reconstruction.
  // ROUND_STARTED keeps the engine's round (which the capture reads)
  // aligned with the kernel's. CoderLoopMessage is a structural subset of
  // ChatMessage for everything the capture reads (role/content/parts/
  // reasoning/tool flags) — the cast is the documented seam.
  const onCheckpoint = async (state: CoderCheckpointState<ChatCard>): Promise<void> => {
    ctx.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: Date.now(), round: state.round });
    ctx.checkpointRefs.apiMessages.current = state.messages as unknown as ChatMessage[];
    ctx.lastCoderStateRef.current = state.workingMemory;
    ctx.flushCheckpoint('turn');
  };

  ctx.lastCoderStateRef.current = null;

  let result: Awaited<ReturnType<typeof runInPageCoderKernel>>;
  try {
    result = await runInPageCoderKernel(
      {
        provider: lockedProvider,
        modelId: resolvedModel || undefined,
        sandboxId,
        taskPreamble: buildInlineTurnPreamble(args.trimmedText, args.apiMessages),
        branchContext: {
          activeBranch,
          defaultBranch: branchInfo?.defaultBranch || 'main',
          protectMain: ctx.isMainProtectedRef.current,
        },
        projectInstructions: args.agentsMdRef.current || undefined,
        instructionFilename: args.instructionFilenameRef.current || undefined,
        verificationPolicy,
        harnessSettings,
        memoryScope: { repoFullName, branch: activeBranch, chatId },
        correlation: { surface: 'web', chatId, runId: args.runId },
        stream,
        // Per-round capture: the foreground client mirror is the durable
        // copy adoption resumes from, so don't skip rounds.
        checkpointCadenceRounds: 1,
      },
      {
        onStatus: (phase, detail) =>
          ctx.updateAgentStatus({ active: true, phase, detail }, { chatId, source: 'coder' }),
        signal: ctx.abortControllerRef.current?.signal,
        onCheckpointRequest: answerCheckpoint,
        onCheckpoint,
        onWorkingMemoryUpdate: (state) => {
          ctx.lastCoderStateRef.current = state;
        },
        onRunEvent: (event) => ctx.appendRunEvent(chatId, event),
      },
    );
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || ctx.abortRef.current;
    if (isAbort) {
      completeAssistantMessage(ctx, { content: 'Cancelled by user.' });
      logInlineTurnCompleted({
        chatId,
        runId: args.runId,
        outcome: 'aborted',
        elapsedMs: Date.now() - startedMs,
      });
      return { completedNormally: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    completeAssistantMessage(ctx, { content: `[Inline turn failed] ${msg}` });
    // Emit the terminal failure ourselves so `finalizeRunSession` sees a
    // terminal phase and doesn't mislabel the exit as a plain abort.
    ctx.emitRunEngineEvent({ type: 'LOOP_FAILED', timestamp: Date.now(), reason: msg });
    logInlineTurnCompleted({
      chatId,
      runId: args.runId,
      outcome: 'failed',
      elapsedMs: Date.now() - startedMs,
      error: msg,
    });
    return { completedNormally: false };
  }

  // --- Post-run evidence: diff capture + verification-state recording
  // (same signals the delegated arc records, so the commit gate sees an
  // inline turn's mutations the same way). ---
  let lastTaskDiff: string | null = null;
  try {
    const diffResult = await getSandboxDiff(sandboxId);
    lastTaskDiff = diffResult.diff || null;
  } catch {
    /* verification state can still update from the summary */
  }
  let latestDiffPaths: string[] | undefined;
  if (lastTaskDiff) {
    latestDiffPaths = extractChangedPathsFromDiff(lastTaskDiff);
    const touchedPaths = latestDiffPaths;
    ctx.updateVerificationState(chatId, (state) =>
      recordVerificationMutation(state, {
        source: 'coder',
        touchedPaths,
        detail: 'Inline turn mutated the workspace.',
      }),
    );
  }
  ctx.updateVerificationState(chatId, (state) =>
    recordVerificationArtifact(
      state,
      `Inline turn produced evidence: ${summarizeToolResultPreview(result.summary)}`,
    ),
  );

  // --- Auditor: same gate as the delegated arc. ---
  const auditorGate = await runCoderAuditorGate(
    {
      repoRef: ctx.repoRef,
      branchInfoRef: ctx.branchInfoRef,
      readLatestCoderState: () => ctx.lastCoderStateRef.current,
      appendRunEvent: ctx.appendRunEvent,
      updateAgentStatus: ctx.updateAgentStatus,
      updateVerificationStateForChat: ctx.updateVerificationState,
    },
    {
      chatId,
      baseCorrelation: { surface: 'web', chatId, runId: args.runId },
      lockedProviderForChat: lockedProvider,
      resolvedModelForChat: resolvedModel || undefined,
      verificationPolicy,
      auditorInput: {
        taskList: [args.trimmedText],
        allCards: result.cards,
        summaries: [result.summary],
        allCriteriaResults: result.criteriaResults ?? [],
        totalRounds: result.rounds,
        totalCheckpoints: result.checkpoints,
        lastTaskDiff,
        latestDiffPaths,
        coderMemoryScope: memoryScope,
        verificationCommandsById: new Map(),
        harnessSettings,
        currentSandboxId: sandboxId,
        originBranch: branchInfo?.currentBranch,
        preCoderHead,
        preCoderUntrackedFiles,
      },
    },
  );

  // --- Memory hygiene: file-backed context that the turn mutated is stale. ---
  if (memoryScope && latestDiffPaths && latestDiffPaths.length > 0) {
    const changedPaths = latestDiffPaths;
    await runContextMemoryBestEffort('invalidating memory after inline turn', () =>
      invalidateMemoryForChangedFiles({
        scope: {
          repoFullName: memoryScope.repoFullName,
          branch: memoryScope.branch,
          chatId: memoryScope.chatId,
        },
        changedPaths,
        reason: 'Inline turn updated file-backed context.',
      }),
    );
  }

  // --- Complete the transcript: kernel summary (+ Auditor verdict line)
  // replaces the streamed placeholder; kernel cards ride on the message. ---
  const finalContent = auditorGate?.auditorSummaryLine
    ? `${result.summary}\n\n${auditorGate.auditorSummaryLine}`
    : result.summary;
  completeAssistantMessage(ctx, { content: finalContent, cards: result.cards });
  ctx.updateAgentStatus({ active: false, phase: '' });

  logInlineTurnCompleted({
    chatId,
    runId: args.runId,
    outcome: 'ok',
    elapsedMs: Date.now() - startedMs,
    rounds: result.rounds,
    checkpoints: result.checkpoints,
  });
  return { completedNormally: true };
}
