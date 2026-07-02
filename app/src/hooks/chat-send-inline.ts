/**
 * chat-send-inline.ts — the Inline Foreground Lane.
 *
 * PR 2 of `docs/archive/decisions/Inline Foreground Lane — Local While Watched.md`:
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
import { buildInlineConversationSeed } from '@/lib/inline-conversation-context';
import { getSandboxDiff, getSandboxEnvironment } from '@/lib/sandbox-client';
import { notifyWorkspaceMutation } from '@/lib/sandbox-mutation-signal';
import { getRepoMetadata } from '@/lib/repo-metadata';
import { getVibeVerbs } from '@/lib/repo-vibe-verbs';
import { translateCoderStatus } from '@/lib/inline-coder-status';
import { classifyTurnIntent } from '@/lib/turn-intent';
import {
  capturePreCoderSnapshot,
  createCoderCheckpointAnswerer,
  runCoderAuditorGate,
  runInlineVerificationCriteria,
  runInPageCoderKernel,
  teePushStream,
} from '@/lib/inline-coder-run';
import { resolveHarnessSettings } from '@/lib/model-capabilities';
import { getRunTokenBudgetPref } from '@/lib/run-token-budget-pref';
import { buildMemoryScope, runContextMemoryBestEffort } from '@/lib/memory-context-helpers';
import { invalidateMemoryForChangedFiles } from '@/lib/context-memory';
import {
  clearRuntimeCoderWorkingMemory,
  readRuntimeCoderWorkingMemory,
  setRuntimeCoderWorkingMemory,
} from '@push/lib/runtime-context';
import {
  extractChangedPathsFromDiff,
  recordVerificationArtifact,
  recordVerificationCommandResult,
  recordVerificationMutation,
} from '@/lib/verification-runtime';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { applyStampedSandboxExecBranchDesync } from '@/lib/branch-desync';
import { applyBranchSwitchPayload } from '@/lib/branch-fork-migration';
import { parseUntrackedFileSet } from '@/lib/auditor-delegation-handler';
import { resolveMessageWriteBranch, stampMessageBranch } from '@/lib/chat-message';
import { buildToolMeta, buildToolResultMessage } from '@/lib/chat-tool-messages';
import { stripToolCallPayload } from '@/lib/message-content';
import {
  buildPriorTurnAttachmentParts,
  mergeInitialUserContentParts,
} from '@/lib/attachment-content-parts';
import {
  buildLinkedLibraryContext,
  spliceLinkedImagesIntoLastUser,
} from '@/lib/linked-library-context';
import { getToolSourceFromName, isReadOnlyToolName } from '@push/lib/tool-registry';
import { createId } from '@push/lib/id-utils';
import { getDefaultMemoryStore } from '@push/lib/context-memory-store';
import { SESSION_DIGEST_HEADER, type SessionDigest } from '@push/lib/session-digest';
import type { CoderCheckpointState } from '@push/lib/coder-agent';
import type { CoderWorkingMemory } from '@push/lib/working-memory';
import type { RunEventInput } from '@push/lib/runtime-contract';
import type {
  LlmContentPart,
  LlmMessage,
  PushStream,
  PushStreamEvent,
} from '@push/lib/provider-contract';
import type { VerificationPolicy } from '@/lib/verification-policy';
import type { AttachmentData, ChatCard, ChatMessage } from '@/types';
import type { SendLoopContext } from './chat-send-types';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface InlineCoderTurnArgs {
  /** The user's raw turn — the kernel's task, verbatim. */
  trimmedText: string;
  /** Current-turn attachments, converted into multipart content for the kernel. */
  attachments?: AttachmentData[];
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
        m.visibleToModel !== false &&
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

const XML_TOOL_NS = String.raw`(?:[|｜]{1,2}[\w.\-]+[|｜]{1,2})?`;
const XML_TOOL_NS_REQUIRED = String.raw`[|｜]{1,2}[\w.\-]+[|｜]{1,2}`;
const XML_TOOL_CALL_BLOCK_PATTERN = String.raw`<${XML_TOOL_NS}(?:function_calls|tool_calls)\b[^>]*>[\s\S]*?<\/${XML_TOOL_NS}(?:function_calls|tool_calls)\s*>|<${XML_TOOL_NS}tool_call\b[^>]*>[\s\S]*?<\/${XML_TOOL_NS}tool_call\s*>|<${XML_TOOL_NS}invoke\b[^>]*?\bname\s*=[^>]*>[\s\S]*?<\/${XML_TOOL_NS}invoke\s*>`;
const XML_TOOL_CALL_BLOCK_RE = new RegExp(XML_TOOL_CALL_BLOCK_PATTERN, 'i');
const XML_TOOL_CALL_START_RE = new RegExp(
  String.raw`<(?:${XML_TOOL_NS_REQUIRED}(?:tool_call|function_calls|tool_calls|invoke)|${XML_TOOL_NS}(?:function_calls|tool_calls))\b`,
  'i',
);

/**
 * Split a kernel round's accumulated content into the user-facing prefix
 * and a flag for whether a tool-call / state-update construct has begun.
 *
 * The coder kernel emits tool calls as fenced or bare JSON in the SAME
 * `content` stream as user-facing prose, and only classifies a round
 * (`detectAllToolCalls`) once it has fully accumulated. So a naive mirror
 * that streams every `text_delta` into the transcript leaks raw protocol
 * JSON — partial tool calls, `coder_update_state` working-memory blobs —
 * into the chat bubble before the kernel knows the round is final (the
 * leak Codex flagged on #891). This strips the construct per delta instead.
 *
 * Conservative by construction: the kernel still consumes the untouched
 * stream via the tee, and the authoritative final message is the kernel
 * summary (`completeAssistantMessage`). So over-hiding here only trims the
 * in-flight preview, never the committed turn — which is why we can safely
 * hide a dangling (unbalanced) fence: a final-answer code block reappears
 * the moment its closing fence lands, and lands in full at completion.
 */
export function splitVisibleContent(text: string): { visible: string; toolCallActive: boolean } {
  let cut = -1;
  const mark = (idx: number) => {
    if (idx >= 0 && (cut === -1 || idx < cut)) cut = idx;
  };

  // A tool-call object/array wrapped in a code fence. Cut at the fence so
  // the ```` ```json ```` wrapper is hidden too, even once the closing fence
  // has balanced the count. The key match tolerates every shape the text
  // dispatcher executes — double/single/unquoted `tool` keys and a leading
  // `[` for fenced arrays (`lib/tool-dispatch.test.ts`) — so a balanced
  // `[{'tool':…}]` block can't reappear in the bubble (Codex #894).
  const fencedTool = /```[^\n`]*\r?\n[ \t]*\[?\s*\{\s*['"]?tool['"]?\s*:/.exec(text);
  if (fencedTool) mark(fencedTool.index);

  // The same object/array emitted bare (no fence). Matched anywhere, not
  // anchored to start: the kernel's `extractBareToolJsonObjects` brace-scans
  // the whole content, so a `prose then {"tool":…}` round IS executed as a
  // tool call — hiding it is correct, not a false positive. Over-hiding a
  // genuine inline-JSON mention is harmless (the kernel summary is the
  // authoritative final render; this only trims the in-flight preview).
  const bareTool = /\[?\s*\{\s*['"]?tool['"]?\s*:/.exec(text);
  if (bareTool) mark(bareTool.index);

  // XML / DSML wrapper forms recovered by `tool-call-xml-recovery.ts`,
  // including DeepSeek V4 Pro's doubled full-width namespace delimiters
  // (`<｜｜DSML｜｜tool_calls>`). The authoritative dispatcher still consumes
  // the untouched accumulated text; this only keeps raw envelopes out
  // of the streaming placeholder. Complete bare `<tool_call>` / `<invoke>`
  // blocks are hidden, while incomplete bare mentions stay visible so
  // streaming and final render agree.
  const xmlBlock = XML_TOOL_CALL_BLOCK_RE.exec(text);
  if (xmlBlock) mark(xmlBlock.index);
  const xmlTool = XML_TOOL_CALL_START_RE.exec(text);
  if (xmlTool) mark(xmlTool.index);

  // A trailing, unbalanced code fence: in a coder round a dangling ``` is a
  // tool block forming before its key has streamed in. A completed prose
  // fence is balanced and survives (a non-tool fence has no key to match
  // above, so it stays visible once closed).
  if (((text.match(/```/g) ?? []).length & 1) === 1) {
    mark(text.lastIndexOf('```'));
  }

  if (cut === -1) return { visible: text, toolCallActive: false };
  return { visible: text.slice(0, cut).replace(/\s+$/, ''), toolCallActive: true };
}

/**
 * Hand-off slot for a settled round's user-facing narration. The mirror
 * writes the round's visible prose here when the round's stream completes;
 * the first `tool.execution_complete` of that round consumes it (splicing
 * it into the transcript as a settled `tool_prose` message just above the
 * round's tool disclosure). If a new round starts before any tool completes
 * — a malformed-call recovery / nudge round — the stale narration is
 * dropped, matching the old behavior where non-final round text never
 * survived the placeholder reset.
 */
export interface InlineRoundProseSink {
  pending: string;
}

/**
 * Build the tee observer that feeds the streaming assistant placeholder.
 * Accumulates per kernel round (a `done` event resets the buffer on the
 * next delta) so the placeholder always shows the round in flight; the
 * kernel's final summary replaces it at completion. Tool-call /
 * state-update JSON is stripped per delta via `splitVisibleContent` so it
 * never reaches the transcript (or the `ACCUMULATED_UPDATED` preview a
 * watching viewer / adopted checkpoint mirrors).
 *
 * When a `proseSink` is supplied, each settled round's visible prose is
 * stashed there (instead of silently dying with the next round's reset) so
 * the tool-disclosure splicer can keep the model's narration in the
 * transcript between tool groups.
 */
export function createInlineTranscriptMirror(
  ctx: SendLoopContext,
  thinkingVerbs?: string[],
  placeholderId?: string,
  proseSink?: InlineRoundProseSink,
): (event: PushStreamEvent) => void {
  const { chatId } = ctx;
  let accumulated = '';
  let thinking = '';
  let roundSettled = false;

  return (event) => {
    if (ctx.abortRef.current) return;
    if (event.type === 'done') {
      roundSettled = true;
      if (proseSink) {
        // `splitVisibleContent` only cuts at tool-call constructs it can see
        // per delta (fenced/bare JSON, XML envelopes). A native tool-call
        // echo — `repo_read", "args": {...}}` content some providers emit
        // alongside delta.tool_calls — has none of those markers, so it
        // survives the cut and would persist into a settled tool_prose
        // message (Codex P2 on this PR; pre-stash it only flashed in the
        // placeholder and died with the round reset). The full
        // stripToolCallPayload pass covers echoes + orphaned JSON tails and
        // is cheap here: once per round on settled content, not per delta.
        // Its output is already trimmed; the splicer owns the final trim.
        proseSink.pending = stripToolCallPayload(splitVisibleContent(accumulated).visible);
      }
      return;
    }
    if (event.type !== 'text_delta' && event.type !== 'reasoning_delta') return;
    if (roundSettled) {
      accumulated = '';
      thinking = '';
      roundSettled = false;
      // A new round began without any tool consuming the stash — recovery /
      // nudge rounds produce no disclosure to anchor the narration to.
      if (proseSink) proseSink.pending = '';
    }
    if (event.type === 'text_delta') {
      accumulated += event.text;
    } else {
      thinking += event.text;
    }

    const { visible, toolCallActive } = splitVisibleContent(accumulated);

    // Phase: reasoning is "dead air" and visible prose streams as
    // "Responding..." — both rotate the themed vibe verbs; while a tool
    // construct is in flight, defer to the kernel's own `onStatus`
    // (Editing/Exploring) rather than fight it.
    if (event.type === 'reasoning_delta') {
      ctx.updateAgentStatus(
        {
          active: true,
          phase: 'Thinking…',
          ...(thinkingVerbs?.length ? { verbs: thinkingVerbs } : {}),
        },
        { chatId, log: false },
      );
    } else if (!toolCallActive) {
      ctx.updateAgentStatus(
        {
          active: true,
          phase: 'Responding...',
          ...(thinkingVerbs?.length ? { verbs: thinkingVerbs } : {}),
        },
        { chatId, log: false },
      );
    }

    ctx.emitRunEngineEvent({
      type: 'ACCUMULATED_UPDATED',
      timestamp: Date.now(),
      text: visible,
      thinking,
    });
    ctx.setConversations((prev) => {
      const conv = prev[chatId];
      if (!conv) return prev;
      const msgs = [...conv.messages];
      const targetIdx = resolveAssistantTargetIndex(msgs, placeholderId);
      if (targetIdx === -1) return prev;
      msgs[targetIdx] = {
        ...msgs[targetIdx],
        content: visible,
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

/**
 * Message-count threshold above which a conversational turn prefetches memory
 * records for the session-digest stage even without a compaction marker.
 * Mirrors `MIN_MESSAGES_BEFORE_PREFETCH` in `chat-stream-round.ts` (rough gate;
 * the real compaction decision happens in `manageContext`).
 */
const MIN_MESSAGES_BEFORE_INLINE_PREFETCH = 20;

const MAX_CACHED_INLINE_DIGESTS = 64;
const _lastInlineSessionDigests = new Map<string, SessionDigest>();

function readLatestCoderState(ctx: SendLoopContext): CoderWorkingMemory | null {
  return readRuntimeCoderWorkingMemory(ctx.runtimeContext);
}

function setLatestCoderState(ctx: SendLoopContext, state: CoderWorkingMemory): void {
  setRuntimeCoderWorkingMemory(ctx.runtimeContext, state);
}

function clearLatestCoderState(ctx: SendLoopContext): void {
  clearRuntimeCoderWorkingMemory(ctx.runtimeContext);
}

function recordInlineSessionDigest(chatId: string, digest: SessionDigest): void {
  if (_lastInlineSessionDigests.has(chatId)) {
    _lastInlineSessionDigests.delete(chatId);
  } else if (_lastInlineSessionDigests.size >= MAX_CACHED_INLINE_DIGESTS) {
    const oldest = _lastInlineSessionDigests.keys().next().value;
    if (oldest !== undefined) _lastInlineSessionDigests.delete(oldest);
  }
  _lastInlineSessionDigests.set(chatId, digest);
}

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

/**
 * Id of the last assistant message — the streaming placeholder this lane
 * finalizes. Captured once at turn start so later finalization targets it
 * explicitly rather than by position. A typed branch tool may update the
 * conversation branch mid-run, so finalization should stay anchored to the
 * placeholder instead of relying on list position.
 */
function lastAssistantMessageId(messages: readonly ChatMessage[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id;
  }
  return undefined;
}

/**
 * Resolve the index of the placeholder to finalize. Prefer the captured
 * `placeholderId` (immune to a branch divider appended mid-run); fall back to
 * the trailing assistant message when no id was captured (early-exit paths
 * before the kernel run, where no divider can exist yet). Returns -1 when no
 * assistant target exists — callers no-op rather than corrupting a non-target.
 */
function resolveAssistantTargetIndex(
  msgs: readonly ChatMessage[],
  placeholderId: string | undefined,
): number {
  if (placeholderId) {
    const idx = msgs.findIndex((m) => m.id === placeholderId);
    return idx !== -1 && msgs[idx]?.role === 'assistant' ? idx : -1;
  }
  const lastIdx = msgs.length - 1;
  return msgs[lastIdx]?.role === 'assistant' ? lastIdx : -1;
}

function completeAssistantMessage(
  ctx: SendLoopContext,
  update: { content: string; cards?: ChatCard[] },
  placeholderId?: string,
): void {
  const { chatId } = ctx;
  ctx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = [...conv.messages];
    const targetIdx = resolveAssistantTargetIndex(msgs, placeholderId);
    if (targetIdx === -1) return prev;
    msgs[targetIdx] = {
      ...msgs[targetIdx],
      content: update.content,
      // Preserve the reasoning streamed onto this message during the run — the
      // spread carries the last `thinking` write from the live handler above.
      // The old `thinking: undefined` here wiped the reasoning pane the instant
      // the turn settled, on every model (the answer streams fine, the pane
      // vanishes at stream-stop). The stranded-answer salvage already clears
      // thinking in-run when it promotes reasoning to content, so there's no
      // legitimate thinking left to drop here.
      status: 'done',
      ...(update.cards && update.cards.length > 0 ? { cards: update.cards } : {}),
    };
    ctx.dirtyConversationIdsRef.current.add(chatId);
    return { ...prev, [chatId]: { ...conv, messages: msgs, lastMessageAt: Date.now() } };
  });
}

type ToolCompleteEvent = Extract<RunEventInput, { type: 'tool.execution_complete' }>;

/**
 * Splices one synthetic isToolCall/isToolResult pair — plus the round's
 * pending narration, when the prose sink holds one — immediately before the
 * inline placeholder (resolved by id, so a `branch_*` divider appended
 * mid-run doesn't divert the disclosure onto the wrong message). Called live
 * from `onRunEvent` as each tool completes, so the transcript interleaves
 * the way the model actually worked: prose → tool group → prose → tool
 * group → final answer, instead of one adjacent block that
 * `groupChatMessages` collapses into a single summary row at completion.
 *
 * These messages are display-only: the prose message carries
 * `visibleToModel: false` (and `buildInlineTurnPreamble` filters
 * !isToolCall && !isToolResult from the next turn's model context), and
 * checkpoints capture the kernel transcript (not conv.messages), so none of
 * this feeds back to the model or corrupts resume state.
 *
 * When narration is consumed, the placeholder's streamed copy of that same
 * text is cleared in the same state update — the prose "moves" from the
 * live bubble into a settled message instead of showing twice while the
 * tool runs.
 *
 * Returns the synthetic call message's id (built outside the state updater
 * so it stays stable under React's double-invoked updater in strict mode —
 * the workspace-patch capture anchors its card to the last one). If the
 * splice no-op'd (no assistant target, a rare conv-deleted race), the
 * downstream findIndex consumers skip silently, so a stale id can't corrupt
 * state.
 */
function spliceInlineToolDisclosure(
  ctx: SendLoopContext,
  event: ToolCompleteEvent,
  proseSink: InlineRoundProseSink,
  placeholderId?: string,
): string {
  const { chatId } = ctx;
  const currentWriteBranch = resolveMessageWriteBranch(
    ctx.branchInfoRef.current,
    ctx.conversationsRef.current[chatId]?.branch,
  );

  const meta = buildToolMeta({
    toolName: event.toolName,
    target: event.target,
    source: event.toolSource,
    durationMs: event.durationMs,
    isError: event.isError,
  });
  const ts = Date.now();
  const callId = createId();
  // Synthetic assistant message marking the tool call.
  // visibleToModel: false — display-only; filterModelVisibleMessages
  // drops these so they never feed back to the model on mode switches
  // or Orchestrator-path replays (undefined would be treated as visible).
  const callMessage: ChatMessage = {
    id: callId,
    role: 'assistant',
    content: event.toolName,
    timestamp: ts,
    status: 'done',
    isToolCall: true,
    toolMeta: meta,
    visibleToModel: false,
  };
  // Synthetic user message carrying the tool result preview.
  const resultMessage: ChatMessage = {
    ...buildToolResultMessage({
      id: createId(),
      timestamp: ts,
      text: event.preview,
      toolMeta: meta,
    }),
    visibleToModel: false,
  };

  const prose = proseSink.pending.trim();
  proseSink.pending = '';
  const proseMessage: ChatMessage | null = prose
    ? {
        id: createId(),
        role: 'assistant',
        content: prose,
        timestamp: ts,
        status: 'done',
        kind: 'tool_prose',
        toolProseFor: callId,
        visibleToModel: false,
      }
    : null;

  const synthetic = [
    ...(proseMessage ? [stampMessageBranch(proseMessage, currentWriteBranch)] : []),
    stampMessageBranch(callMessage, currentWriteBranch),
    stampMessageBranch(resultMessage, currentWriteBranch),
  ];

  ctx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const msgs = [...conv.messages];
    const targetIdx = resolveAssistantTargetIndex(msgs, placeholderId);
    if (targetIdx === -1) return prev;
    msgs.splice(targetIdx, 0, ...synthetic);
    if (proseMessage) {
      // The placeholder still shows the settled round's streamed prose until
      // the next round's first delta resets it — clear it here so the
      // narration doesn't render twice while the tool executes. targetIdx
      // shifted by the splice above.
      const placeholderIdx = targetIdx + synthetic.length;
      msgs[placeholderIdx] = { ...msgs[placeholderIdx], content: '' };
    }
    return { ...prev, [chatId]: { ...conv, messages: msgs } };
  });

  return callId;
}

/**
 * Folds the kernel's result cards into the last synthetic tool-call message
 * at completion, so they render inside the collapsible disclosure (matching
 * the old Orchestrator behaviour). ToolCallSummary hoists pending-action
 * cards (ask-user, in-flight commit-review) out of the group regardless, so
 * they stay visible. No-ops silently when the anchor message is gone (the
 * same conv-deleted race the splicer tolerates).
 */
function attachCardsToInlineToolCall(
  ctx: SendLoopContext,
  messageId: string,
  cards: ChatCard[],
): void {
  if (cards.length === 0) return;
  const { chatId } = ctx;
  ctx.setConversations((prev) => {
    const conv = prev[chatId];
    if (!conv) return prev;
    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return prev;
    const msgs = [...conv.messages];
    msgs[idx] = { ...msgs[idx], cards: [...(msgs[idx].cards ?? []), ...cards] };
    return { ...prev, [chatId]: { ...conv, messages: msgs } };
  });
}

/**
 * Shield upstream error text before it reaches the assistant bubble.
 * Provider response bodies and sandbox stderr can carry raw JSON/HTML, and
 * the transcript renders GitHub-flavored markdown — so collapse to a single
 * bounded line and neutralize fence/tag characters so nothing renders as
 * markup or a fenced block (REVIEW.md "error-formatting paths" defect
 * class). The full message stays in the structured log for ops.
 *
 * Angle brackets become full-width look-alikes rather than HTML entities:
 * the markdown renderer decodes `&lt;` back to `<` before display, so the
 * entity form is a no-op (review #894) — the look-alike keeps the text
 * readable while guaranteeing it can never open a tag.
 */
function sanitizeErrorForChat(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const MAX = 200;
  const clipped = collapsed.length > MAX ? `${collapsed.slice(0, MAX)}…` : collapsed;
  return clipped.replace(/[<>`]/g, (c) => (c === '<' ? '＜' : c === '>' ? '＞' : "'"));
}

/**
 * Lightweight shape check at the `CoderLoopMessage` → `ChatMessage` seam.
 * The checkpoint bridge casts the kernel transcript into the V1 capture; if
 * the shapes ever diverge, an unchecked cast would persist a malformed
 * transcript that `runCheckpointToCoderResumeState` reads back at resume.
 * This makes the seam fail loud (skip + structured log) instead of silently
 * corrupting durable state. An empty transcript is structurally fine.
 */
function looksLikeChatMessages(messages: readonly unknown[]): boolean {
  if (messages.length === 0) return true;
  const first = messages[0] as { role?: unknown; content?: unknown } | null;
  return typeof first?.role === 'string' && first != null && 'content' in first;
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

  // Capture the streaming placeholder's id up front. Finalization targets it by
  // id so typed branch tools fired mid-run cannot divert the final summary /
  // tool disclosure onto a later assistant message.
  const placeholderId = lastAssistantMessageId(ctx.conversationsRef.current[chatId]?.messages);

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
    // Name the specific missing precondition so the user can act on it,
    // rather than a generic three-way error (the structured log records the
    // short form for ops).
    const missingReason = !sandboxId ? 'no sandbox' : !repoFullName ? 'no repo' : 'no branch';
    const missingLabel = !sandboxId
      ? 'an active sandbox'
      : !repoFullName
        ? 'a connected repo'
        : 'an active branch';
    completeAssistantMessage(
      ctx,
      {
        content: `[Inline turn unavailable] This turn needs ${missingLabel}. Try again once the workspace is ready.`,
      },
      placeholderId,
    );
    logInlineTurnCompleted({
      chatId,
      runId: args.runId,
      outcome: 'precondition-failed',
      elapsedMs: Date.now() - startedMs,
      error: missingReason,
    });
    return { completedNormally: false };
  }

  const memoryScope =
    ctx.runtimeContext.memory.scope ?? buildMemoryScope(chatId, repoFullName, activeBranch);
  const verificationPolicy = args.getVerificationPolicyForChat(chatId);
  const harnessSettings = resolveHarnessSettings(lockedProvider, resolvedModel || undefined, {
    runTokenBudget: getRunTokenBudgetPref(),
  });

  // Themed thinking verbs for the spinner, classified off real repo signals
  // the same way the Orchestrator round loop does (topics → domain, boot-time
  // manifests → language, name as fallback). Resolved once; the bar rotates.
  const repoMeta = getRepoMetadata(repoFullName);
  const thinkingVerbs = getVibeVerbs({
    fullName: repoFullName,
    topics: repoMeta?.topics ?? null,
    projectMarkers: getSandboxEnvironment(sandboxId)?.project_markers ?? null,
    language: repoMeta?.language ?? null,
  });

  // Bail before the snapshot round-trip if the user already cancelled (the
  // mirror guards every event the same way) — no point paying for a sandbox
  // call and kernel launch we'd immediately abort.
  if (ctx.abortRef.current) {
    completeAssistantMessage(ctx, { content: 'Cancelled by user.' }, placeholderId);
    logInlineTurnCompleted({
      chatId,
      runId: args.runId,
      outcome: 'aborted',
      elapsedMs: Date.now() - startedMs,
    });
    return { completedNormally: false };
  }

  // Pre-run HEAD + untracked baseline for the Auditor (PRs #604/#606).
  const { preCoderHead, preCoderUntrackedFiles } = await capturePreCoderSnapshot(sandboxId);

  // --- Kernel bindings ---
  // Round-narration hand-off between the stream mirror (producer) and the
  // tool-disclosure splicer in onRunEvent (consumer) — see InlineRoundProseSink.
  const roundProse: InlineRoundProseSink = { pending: '' };
  const mirror = createInlineTranscriptMirror(ctx, thinkingVerbs, placeholderId, roundProse);
  const stream = teePushStream(
    getProviderPushStream(lockedProvider) as unknown as PushStream<LlmMessage>,
    mirror,
  );

  const answerCheckpoint = createCoderCheckpointAnswerer({
    chatId,
    apiMessages: args.apiMessages,
    provider: lockedProvider,
    model: resolvedModel || undefined,
    // null = skip decision-memory persistence (the option's documented
    // off-switch). A `coder_checkpoint` in the delegated arc is the Orchestrator
    // ruling on a delegated Coder's question — a real decision worth keeping.
    // Inline is the lead answering *itself* from recent chat history, so writing
    // that self-consultation into durable decision memory would pollute it with
    // internal reasoning future turns retrieve as if it were a delegated ruling.
    memoryScope: null,
    readLatestCoderState: () => readLatestCoderState(ctx),
    getSignal: () => ctx.abortControllerRef.current?.signal,
    // Route the answerer's status through the same phase-first translation the
    // kernel's `onStatus` uses. The answerer emits delegated-arc vocabulary
    // ("Coder checkpoint" / "Coder resuming...") that `translateCoderStatus`
    // exists to keep off the single lead's spinner — wrapping here maps it to
    // "Thinking…" (rotating verbs) instead of leaking raw "Coder X" text. The
    // delegated arc passes its own raw `updateAgentStatus` and is unaffected.
    updateAgentStatus: (status, meta) => {
      const render = translateCoderStatus(status.phase ?? '', status.detail);
      ctx.updateAgentStatus(
        {
          ...status,
          phase: render.phase,
          detail: render.thinking ? undefined : render.detail,
          ...(render.thinking && thinkingVerbs?.length ? { verbs: thinkingVerbs } : {}),
        },
        meta,
      );
    },
  });

  // Per-round durability bridge: point the V1 capture at the kernel's own
  // transcript so the persisted checkpoint round-trips through
  // `runCheckpointToCoderResumeState` as coder state, not a reconstruction.
  // ROUND_STARTED keeps the engine's round (which the capture reads)
  // aligned with the kernel's. CoderLoopMessage is a structural subset of
  // ChatMessage for everything the capture reads (role/content/parts/
  // reasoning/tool flags) — the cast is the documented seam, asserted at
  // runtime so a future shape divergence fails loud instead of persisting a
  // malformed transcript adoption would read back.
  const onCheckpoint = async (state: CoderCheckpointState<ChatCard>): Promise<void> => {
    if (!looksLikeChatMessages(state.messages)) {
      const offender = state.messages[0];
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'coder_checkpoint_shape_invalid',
          mode: 'inline',
          chatId,
          runId: args.runId,
          round: state.round,
          // Surface the offending element's key signature so the divergence
          // is actionable from the log alone (review #894).
          gotKeys:
            offender && typeof offender === 'object'
              ? Object.keys(offender).join(',')
              : typeof offender,
        }),
      );
      return;
    }
    ctx.emitRunEngineEvent({ type: 'ROUND_STARTED', timestamp: Date.now(), round: state.round });
    ctx.checkpointRefs.apiMessages.current = state.messages as unknown as ChatMessage[];
    setLatestCoderState(ctx, state.workingMemory);
    ctx.flushCheckpoint('turn');
  };

  clearLatestCoderState(ctx);

  // Tool completions splice their disclosure into the transcript live (see
  // spliceInlineToolDisclosure); the array tracks that any ran (cards routing)
  // and the id anchors completion-time card attach + workspace-patch capture.
  const capturedToolEvents: ToolCompleteEvent[] = [];
  let lastLiveToolCallId: string | undefined;
  const taskInFlight = classifyTurnIntent(args.trimmedText) === 'task';

  const linkedLibraryIds = ctx.conversationsRef.current[chatId]?.linkedLibraryIds ?? [];
  const linkedLibraryPayload =
    linkedLibraryIds.length > 0
      ? await buildLinkedLibraryContext(linkedLibraryIds)
      : { systemText: undefined, imageAttachments: [] };
  const apiMessagesForContext = spliceLinkedImagesIntoLastUser(
    args.apiMessages,
    linkedLibraryPayload.imageAttachments,
  );

  let sessionDigestRecords: Awaited<ReturnType<ReturnType<typeof getDefaultMemoryStore>['list']>> =
    [];
  if (!taskInFlight) {
    // Mirror the Orchestrator's prefetch gate (chat-stream-round.ts): the memory
    // store's `list(predicate)` loads every record before filtering, so only pay
    // it when the session-digest stage can actually fire — a prior compaction
    // marker already in the transcript, or enough messages that compaction is
    // plausible this turn. Otherwise the digest no-ops and the read is wasted
    // work on every conversational turn (PR #574 review).
    const compactionLikely =
      apiMessagesForContext.some(
        (m) =>
          typeof m.content === 'string' &&
          (m.content.includes('[CONTEXT DIGEST]') ||
            m.content.includes(SESSION_DIGEST_HEADER) ||
            m.content.includes('[USER_GOAL]')),
      ) || apiMessagesForContext.length > MIN_MESSAGES_BEFORE_INLINE_PREFETCH;
    if (compactionLikely) {
      try {
        const listed = getDefaultMemoryStore().list((record) => record.scope.chatId === chatId);
        sessionDigestRecords = await Promise.resolve(listed);
      } catch {
        sessionDigestRecords = [];
      }
    }
  }

  const taskPreamble = buildInlineTurnPreamble(args.trimmedText, apiMessagesForContext);
  // Conversational turns seed the kernel with the raw visible transcript and let
  // the provider stream's `toLLMMessages` run the single context transform
  // (compaction / USER_GOAL / session digest / safety net) with the digest
  // inputs threaded below — no pre-transform here, so history management happens
  // exactly once (see inline-conversation-context.ts).
  const initialMessages = !taskInFlight
    ? buildInlineConversationSeed(apiMessagesForContext)
    : undefined;

  // Derive the exact window buildInlineTurnPreamble uses (same filter + cap)
  // so attachment extraction never drifts outside the text preamble's horizon.
  // `visibleToModel !== false` mirrors the Orchestrator's filterVisibleStage —
  // display-only messages (fork dividers, aborted partials) never reach the wire.
  const priorWindow = apiMessagesForContext
    .slice(0, -1)
    .filter(
      (m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        !m.isToolCall &&
        !m.isToolResult &&
        m.visibleToModel !== false &&
        Boolean((m.displayContent ?? m.content).trim()),
    )
    .slice(-PRIOR_TURNS_MAX);

  // Collect attachment parts from that window. Prefer pre-converted
  // contentParts (kernel turns store images there, not in attachments);
  // fall back to AttachmentData for web-UI user messages.
  const priorAttParts: LlmContentPart[] = priorWindow.flatMap((m) => {
    if (m.contentParts && m.contentParts.length > 0) {
      return m.contentParts.filter((p) => p.type === 'image_url');
    }
    if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
      return buildPriorTurnAttachmentParts(m.attachments);
    }
    return [];
  });

  // preamble text → prior-turn images → current-turn images; undefined when
  // there's no multimodal content (kernel uses the plain taskPreamble string).
  const initialUserContentParts = mergeInitialUserContentParts(taskPreamble, priorAttParts, [
    ...(args.attachments ?? []),
    ...linkedLibraryPayload.imageAttachments,
  ]);

  let result: Awaited<ReturnType<typeof runInPageCoderKernel>>;
  try {
    result = await runInPageCoderKernel(
      {
        provider: lockedProvider,
        modelId: resolvedModel || undefined,
        sandboxId,
        taskPreamble,
        initialMessages,
        initialUserContentParts,
        linkedLibraryContent: linkedLibraryPayload.systemText,
        // Digest inputs for the stream's single context transform (only the
        // conversational seed needs them; task turns leave them undefined).
        sessionDigestRecords: !taskInFlight ? sessionDigestRecords : undefined,
        priorSessionDigest: !taskInFlight ? _lastInlineSessionDigests.get(chatId) : undefined,
        onSessionDigestEmitted: !taskInFlight
          ? (digest) => {
              if (digest) recordInlineSessionDigest(chatId, digest);
            }
          : undefined,
        branchContext: {
          activeBranch,
          defaultBranch: branchInfo?.defaultBranch || 'main',
          protectMain: ctx.isMainProtectedRef.current,
        },
        projectInstructions: args.agentsMdRef.current || undefined,
        instructionFilename: args.instructionFilenameRef.current || undefined,
        verificationPolicy,
        harnessSettings,
        memoryScope: memoryScope ?? undefined,
        scratchpad: ctx.scratchpadRef.current,
        todo: ctx.todoRef.current,
        correlation: ctx.runtimeContext.correlation,
        stream,
        // Orchestrator parity: the collapsed single lead gets the GitHub
        // PR/commit/CI/workflow tools, ask_user, and create_artifact on top of
        // its sandbox/web/memory surface — the tools a conversational turn
        // ("what changed recently?") needs and the old Orchestrator had.
        leadToolSurface: true,
        // Task-aware backstop for the no-fake-completion guard: derive intent
        // from the same classifier the router uses, so even if a conversational
        // turn ever reaches this lane the guard stays quiet. `task` by default;
        // attachment-only turns (no text) read as a task and stay guarded.
        taskInFlight,
        // Per-round capture: the foreground client mirror is the durable
        // copy adoption resumes from, so don't skip rounds.
        checkpointCadenceRounds: 1,
      },
      {
        // Translate the kernel's internal phases ("Coder working...", "Coder
        // executing...") into user-facing vocabulary — phase-first for active
        // work, rotating themed verbs for the thinking dead air — so raw
        // coder-protocol vocabulary never reaches the spinner.
        onStatus: (phase, detail) => {
          const render = translateCoderStatus(phase, detail);
          ctx.updateAgentStatus(
            {
              active: true,
              phase: render.phase,
              detail: render.detail,
              ...(render.thinking ? { verbs: thinkingVerbs } : {}),
            },
            { chatId, source: 'coder' },
          );
        },
        signal: ctx.abortControllerRef.current?.signal,
        onCheckpointRequest: answerCheckpoint,
        onCheckpoint,
        onWorkingMemoryUpdate: (state) => {
          setLatestCoderState(ctx, state);
        },
        onRunEvent: (event) => {
          ctx.appendRunEvent(chatId, event);
          if (event.type === 'tool.execution_complete' && !ctx.abortRef.current) {
            const toolEvent = event as ToolCompleteEvent;
            capturedToolEvents.push(toolEvent);
            lastLiveToolCallId = spliceInlineToolDisclosure(
              ctx,
              toolEvent,
              roundProse,
              placeholderId,
            );
          }
        },
        // Desync detection for the inline lane. The orchestrator dispatch
        // seam (applyPostExecutionSideEffects) never runs for kernel-led
        // turns, so the stamp is teed straight out of the kernel's sandbox
        // executor instead.
        onSandboxExecBranch: ({ command, branch }) => {
          applyStampedSandboxExecBranchDesync(
            { command, branch },
            {
              chatId,
              appendRunEvent: ctx.appendRunEvent,
              activeChatIdRef: ctx.activeChatIdRef,
              conversationsRef: ctx.conversationsRef,
              branchInfoRef: ctx.branchInfoRef,
              setConversations: ctx.setConversations,
              dirtyConversationIdsRef: ctx.dirtyConversationIdsRef,
              runtimeHandlersRef: ctx.runtimeHandlersRef,
            },
          );
        },
        onBranchSwitchPayload: (payload) => {
          applyBranchSwitchPayload(payload, {
            chatId,
            appendRunEvent: ctx.appendRunEvent,
            activeChatIdRef: ctx.activeChatIdRef,
            conversationsRef: ctx.conversationsRef,
            branchInfoRef: ctx.branchInfoRef,
            setConversations: ctx.setConversations,
            dirtyConversationIdsRef: ctx.dirtyConversationIdsRef,
            runtimeHandlersRef: ctx.runtimeHandlersRef,
          });
        },
        // Sandbox-loss recovery parity. A kernel tool that hits a dead
        // sandbox surfaces `SANDBOX_UNREACHABLE`; the Orchestrator dispatch
        // seam (applyPostExecutionSideEffects #8) fires the recovery handler
        // off it, but that seam never runs for kernel-led turns — so route
        // it from the kernel's executor tee instead.
        onSandboxUnreachable: (message, policy) => {
          ctx.runtimeHandlersRef.current?.onSandboxUnreachable?.(message, policy);
        },
      },
    );
  } catch (err) {
    const isAbort =
      (err instanceof DOMException && err.name === 'AbortError') || ctx.abortRef.current;
    if (isAbort) {
      completeAssistantMessage(ctx, { content: 'Cancelled by user.' }, placeholderId);
      logInlineTurnCompleted({
        chatId,
        runId: args.runId,
        outcome: 'aborted',
        elapsedMs: Date.now() - startedMs,
      });
      return { completedNormally: false };
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Shield raw upstream text (provider bodies / sandbox stderr) from the
    // transcript; the full message still rides the structured log + engine
    // reason for ops/debugging.
    completeAssistantMessage(
      ctx,
      { content: `[Inline turn failed] ${sanitizeErrorForChat(msg)}` },
      placeholderId,
    );
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
  let postCoderHead: string | undefined;
  let postUntrackedFiles: Set<string> | undefined;
  let diffProbed = false;
  try {
    const diffResult = await getSandboxDiff(sandboxId);
    lastTaskDiff = diffResult.diff || null;
    postCoderHead = diffResult.head_sha;
    postUntrackedFiles = parseUntrackedFileSet(diffResult.git_status);
    diffProbed = true;
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

  // --- Auditor: a SAFE/UNSAFE commit gate, so it only fires when the turn
  // actually changed the workspace. A read-only/conversational turn ("what
  // changed recently?") produces a summary but no diff and no commit — the
  // Auditor would otherwise "evaluate" prose and append a spurious verdict.
  // "Changed" has three independent signals, since none alone is complete:
  //   - a non-empty `git diff HEAD` (tracked-file edits),
  //   - HEAD moved off the pre-run snapshot (the coder committed — a clean
  //     working tree isn't proof of no work),
  //   - a brand-new untracked file, which `git diff HEAD` doesn't show at
  //     all — it surfaces only as `?? path` in git_status, so compare the
  //     post-run untracked set against the pre-run baseline (review #897 P1).
  // When the diff probe failed we can't tell — but only treat that as a
  // possible change when the turn actually invoked a sandbox-workspace
  // mutator. A purely conversational / read-only turn ("what changed
  // recently?" answered from GitHub reads, memory lookups, or a read-only
  // `git log`) can't leave a mutation the probe would miss, so a failed probe
  // must NOT manufacture a verdict: otherwise the Auditor evaluates the prose
  // answer and appends a spurious "[Evaluation: …]" line — the residual coder
  // behavior reported against the lead. ---
  const committedSinceStart = Boolean(
    postCoderHead && preCoderHead && postCoderHead !== preCoderHead,
  );
  const preUntracked = new Set(preCoderUntrackedFiles ?? []);
  const addedUntrackedFile = postUntrackedFiles
    ? [...postUntrackedFiles].some((path) => !preUntracked.has(path))
    : false;
  const confirmedChange = Boolean(lastTaskDiff) || committedSinceStart || addedUntrackedFile;
  // Scope the failed-probe fallback to tools that actually touch the sandbox
  // workspace (`sandbox`-source mutators: sandbox_exec, file writes,
  // commit/push/branch). The lead also advertises non-read-only tools that
  // never touch the sandbox — `ask_user`, `create_artifact`, GitHub writes
  // (`pr_create` etc.) — so keying off `!isReadOnlyToolName` alone would
  // re-audit prose on a clarification- or artifact-only turn whose probe
  // happened to fail (Codex P2 on #972). Classify by tool NAME via the
  // registry: `event.toolSource` is the executing lane (e.g. 'coder'), not the
  // registry source.
  const touchedSandboxWorkspace = capturedToolEvents.some(
    (event) =>
      getToolSourceFromName(event.toolName) === 'sandbox' && !isReadOnlyToolName(event.toolName),
  );
  const workspaceChanged = confirmedChange || (touchedSandboxWorkspace && !diffProbed);
  if (!workspaceChanged) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'inline_auditor_skipped',
        mode: 'inline',
        chatId,
        runId: args.runId,
        reason: 'no_workspace_change',
      }),
    );
  } else {
    // Wake the workspace-mutation consumers at inline-run completion: auto-back /
    // checkpoint capture and the hub diff view. The per-tool mutation signals fire
    // DURING the run — when the coordinator can be gated (sandbox busy) or the
    // WebView is backgrounded and timers are throttled — so on the inline lane
    // they may never arm the debounce. Re-firing here (run done, sandbox ready)
    // is the deterministic trigger; redundant signals are cheap no-ops (auto-back
    // tree/HEAD dedup). Device finding 2026-06-22 — see
    // docs/decisions/Native Checkpoint Store.md.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'inline_workspace_mutation_signaled',
        mode: 'inline',
        chatId,
        runId: args.runId,
        sandboxId,
      }),
    );
    notifyWorkspaceMutation(sandboxId);
  }

  // --- Verification gate (delegated-arc parity). The delegated Coder ran the
  // verification policy's command rules as acceptance criteria, feeding the
  // Auditor (`criteriaResults`) and verification memory (`verificationCommandsById`).
  // The inline lane dropped both (an empty map, no criteria). Run them here,
  // gated on a *confirmed* edit — not the conservative `workspaceChanged`, which
  // also fires when the diff probe failed (no reliable place to run checks).
  // Conversational turns skip this entirely, so "what changed recently?" never
  // pays for a typecheck/test run. ---
  const turnEdited = confirmedChange;
  const verification = turnEdited
    ? await runInlineVerificationCriteria(
        sandboxId,
        verificationPolicy,
        ctx.abortControllerRef.current?.signal,
      )
    : {
        criteriaResults: [],
        verificationCommandsById: new Map<string, string>(),
        summaryLine: '',
      };
  if (verification.criteriaResults.length > 0) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'inline_verification_ran',
        mode: 'inline',
        chatId,
        runId: args.runId,
        criteria: verification.criteriaResults.length,
        passed: verification.criteriaResults.filter((r) => r.passed).length,
      }),
    );
  }
  // Reflect each command result into the chat's VerificationRuntimeState the
  // same way the delegated Coder does (coder-delegation-handler.ts) — otherwise
  // a command rule stays `pending` even though we just ran it, and a later
  // runtime verification gate would block as if the check never happened
  // (Codex P2 on #925).
  for (const r of verification.criteriaResults) {
    const command = verification.verificationCommandsById.get(r.id);
    if (!command) continue;
    ctx.updateVerificationState(chatId, (state) =>
      recordVerificationCommandResult(state, command, {
        exitCode: r.exitCode,
        detail: `${r.id} exited with code ${r.exitCode}.`,
      }),
    );
  }
  const auditorGate = workspaceChanged
    ? await runCoderAuditorGate(
        {
          repoRef: ctx.repoRef,
          branchInfoRef: ctx.branchInfoRef,
          readLatestCoderState: () => readLatestCoderState(ctx),
          appendRunEvent: ctx.appendRunEvent,
          updateAgentStatus: ctx.updateAgentStatus,
          updateVerificationStateForChat: ctx.updateVerificationState,
        },
        {
          chatId,
          baseCorrelation: ctx.runtimeContext.correlation,
          lockedProviderForChat: lockedProvider,
          resolvedModelForChat: resolvedModel || undefined,
          verificationPolicy,
          auditorInput: {
            // `CoderAuditorInput` is multi-task shaped for the delegated arc's
            // per-task loop; an inline turn is always a single task (the user's
            // raw turn), so these arrays are single-element by construction —
            // the shape is satisfied, not the multi-task iteration. The Auditor
            // status it drives is attributed to the shared 'coder' source lane
            // (set inside the handler), same as the delegated path.
            taskList: [args.trimmedText],
            allCards: result.cards,
            summaries: [result.summary],
            // This is the inline conversational lead, not a delegated Coder —
            // so the Evaluator's user-facing verdict says "the assistant".
            leadMode: true,
            allCriteriaResults: [
              ...(result.criteriaResults ?? []),
              ...verification.criteriaResults,
            ],
            totalRounds: result.rounds,
            totalCheckpoints: result.checkpoints,
            lastTaskDiff,
            latestDiffPaths,
            coderMemoryScope: memoryScope,
            verificationCommandsById: verification.verificationCommandsById,
            harnessSettings,
            currentSandboxId: sandboxId,
            originBranch: branchInfo?.currentBranch,
            preCoderHead,
            preCoderUntrackedFiles,
          },
        },
      )
    : null;

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

  // --- Complete the transcript: kernel summary replaces the streamed
  // placeholder. The tool disclosure was spliced live as each tool completed
  // (interleaved with the round narration); here we only fold the result
  // cards into the last synthetic call message so they render inside the
  // collapsible, like the old Orchestrator path. When no tools ran (pure
  // conversational turn), cards stay on the final message. ---
  const hasToolDisclosure = capturedToolEvents.length > 0;
  const lastToolCallId = lastLiveToolCallId;
  if (hasToolDisclosure && lastToolCallId) {
    attachCardsToInlineToolCall(ctx, lastToolCallId, result.cards);
  }
  // The completion verdict renders as a structured card, not appended prose —
  // matching the delegated arc, which routes the same verdict through the
  // delegation-result card and strips the `[Evaluation: …]` text from the
  // user-facing summary. Only `incomplete` surfaces a card: the gaps are the
  // actionable signal, while a `complete` verdict is a self-grade the user
  // doesn't need on a successful answer. Unlike the delegated arc (which keeps
  // the verdict model-side via `summaries` for the Orchestrator's next
  // decision), the inline lead is human-in-the-loop — the next turn is driven
  // by the user reading the card — so we deliberately don't replay the verdict
  // into model context.
  const evaluationCard: ChatCard | null =
    auditorGate?.evalResult && auditorGate.evalResult.verdict === 'incomplete'
      ? {
          type: 'evaluation',
          data: {
            verdict: auditorGate.evalResult.verdict,
            summary: auditorGate.evalResult.summary,
            gaps: auditorGate.evalResult.gaps,
            confidence: auditorGate.evalResult.confidence,
          },
        }
      : null;
  // Verification block joins the kernel summary the same way the delegated arc
  // appended its in-kernel acceptance-criteria block.
  const summaryWithVerification = `${result.summary}${verification.summaryLine}`;
  // The evaluation card always rides the final (visible) message so an
  // incomplete verdict isn't buried in the collapsed tool disclosure. Result
  // cards still fold into the disclosure when tools ran.
  const finalCards: ChatCard[] = [
    ...(hasToolDisclosure ? [] : result.cards),
    ...(evaluationCard ? [evaluationCard] : []),
  ];
  completeAssistantMessage(
    ctx,
    {
      content: summaryWithVerification,
      ...(finalCards.length > 0 ? { cards: finalCards } : {}),
    },
    placeholderId,
  );
  ctx.updateAgentStatus({ active: false, phase: '' });

  // --- Workspace-patch capture (durability parity). The Orchestrator loop
  // captured the uncommitted diff as a replayable `workspace-patch` card off a
  // `subagent.completed{coder}` round event, so edits survived a sandbox
  // restart. A kernel-led inline turn emits no such event, so the capture
  // never fired. Drive it directly when the turn left uncommitted changes
  // (committed work lives in git and needs no replay card), anchoring the card
  // to the last synthetic tool-call message. Best-effort, fire-and-forget at
  // the round-end seam like the loop.
  //
  // Gate on `lastTaskDiff || addedUntrackedFile`, not `lastTaskDiff` alone:
  // `lastTaskDiff` is `git diff HEAD` (tracked only), but the capture's own
  // `fetchSandboxDiffWithMeta` also emits a `--no-index` diff for untracked
  // files — so an untracked-only turn (new files, empty `git diff HEAD`) has a
  // real patch to persist and must not be skipped (Codex P2 on #925). ---
  if (
    (lastTaskDiff || addedUntrackedFile) &&
    lastToolCallId &&
    ctx.captureWorkspacePatchAtRoundEnd
  ) {
    await ctx.captureWorkspacePatchAtRoundEnd({
      chatId,
      round: result.rounds,
      outcome: 'completed',
      roundEvents: [],
      workspaceMutated: true,
      assistantToolCallMessageId: lastToolCallId,
    });
  }

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
