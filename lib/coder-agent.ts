/**
 * Coder Agent — headless implementation kernel for Push.
 *
 * Runs the Coder's autonomous tool loop: reads files, writes files, runs
 * commands, tracks working memory, and halts when the task is complete (or a
 * policy guard fires). Moved from `app/src/lib/coder-agent.ts` in Phase 5D
 * step 2, following the Phase 5D step 1 Explorer template.
 *
 * Shared-kernel form: generic over `TCall` (tool-call discriminated union)
 * and `TCard` (card shape), with nine injection points. Eight are inherited
 * from the Phase 5D step 1 Explorer template (userProfile, taskPreamble,
 * symbolSummary, toolExec, detectAllToolCalls, detectAnyToolCall,
 * webSearchToolProtocol, evaluateAfterModel). The new slot is
 * `verificationPolicyBlock`, a pre-built string emitted by the Web shim via
 * `formatVerificationPolicyBlock`, following the same "string in, not
 * builder" pattern as `webSearchToolProtocol`.
 *
 * The `toolExec` signature is enhanced for Coder: it takes a second argument
 * `{ round, phase }` and returns either `{ kind: 'executed', resultText,
 * card?, policyPost? }` or `{ kind: 'denied', reason }`. The Web shim's
 * closure internally runs `evaluateBeforeTool` → real executor + capability
 * ledger + tracing → `evaluateAfterTool`, and translates the result into the
 * flattened shape the lib kernel understands. This keeps `TurnPolicyRegistry`,
 * `withActiveSpan`, `CapabilityLedger`, and `sandboxStatus` out of lib.
 *
 * `evaluateAfterModel` mirrors Explorer: it returns primitives
 * ({action,content} | {action,summary} | null) so the lib kernel never sees
 * `AfterModelResult`, `ChatMessage`, or `TurnContext`.
 *
 * Two extra DI slots Coder adds beyond Explorer's inheritance:
 *   - `verificationPolicyBlock: string` (new; pre-built by the shim).
 *   - `approvalModeBlock: string | null` (new; pre-built by the shim via
 *     `buildApprovalModeBlock(getApprovalMode())`). Spec allows folding this
 *     into `taskPreamble` or carrying it as a separate string slot — Lane B
 *     chose the latter because the original Web kernel set it on the
 *     `user_context` system-prompt slot, distinct from the initial user
 *     message, and preserving that placement avoids a subtle prompt shift.
 *
 * Total injection surface: 10 slots (Explorer's 8 + verificationPolicyBlock +
 * approvalModeBlock). Budget cap per spec is 12.
 *
 * The shared prompt-section constants (SHARED_SAFETY_SECTION,
 * SHARED_OPERATIONAL_CONSTRAINTS, CODER_CODE_DISCIPLINE) are already in
 * `lib/system-prompt-sections.ts` and imported directly — no pre-built
 * string slot needed for them.
 */

import type {
  AIProviderType,
  LlmContentPart,
  LlmMessage,
  NativeToolCall,
  LlmToolResultBlock,
  LlmToolUseBlock,
  PushStream,
  ToolFunctionSchema,
} from './provider-contract.js';
import type { AcceptanceCriterion, MemoryRecord, RunEventInput } from './runtime-contract.js';
import type { EditDiff } from './edit-diff.js';
import type { ToolCard } from './tool-cards.js';
import type { SessionDigest } from './session-digest.js';
import { createId } from './id-utils.js';
import { buildToolResultBlock, buildToolUseBlock, createToolUseBlockId } from './tool-blocks.js';
import { buildMalformedToolCallEvents, summarizeToolResultPreview } from './run-events.js';
import { startElapsedMs } from './monotonic-elapsed.js';
import { getProviderDisplayName } from './provider-definition.js';
import { buildUserIdentityBlock, type UserProfile } from './user-identity.js';
import { iteratePushStreamText, asRecord } from './stream-utils.js';
import { REASONING_HEAVY_FIRST_TOKEN_GRACE_MS } from './reasoning-models.js';
import { createRunTokenLedger } from './run-cost-budget.js';
import { estimateTokens } from './context-budget.js';
import { detectToolFromText } from './tool-call-parsing.js';
import { extractToolProse } from './tool-prose.js';
import { SIZE_BUDGETS } from './size-budgets.js';
import { formatProjectInstructionsBlock } from './project-instructions.js';
import {
  buildToolCallParseErrorBlock,
  buildValidationFailedHint,
  composeToolResultBody,
  formatToolResultEnvelope,
  MAX_REASONING_TOOL_CALL_NUDGES,
  promoteReasoningAnswer,
} from './tool-call-recovery.js';
import {
  buildLoopSteeringText,
  createSimilarityLoopDetector,
  evaluateLoopState,
  EXACT_REPEAT_LIMIT,
  isSimilarityLoopDetectionEnabled,
  writeTargetOf,
} from './loop-detection.js';
import { createMutationFailureTracker, getToolInvocationKey } from './agent-loop-utils.js';
import { recordLoopVerdict } from './loop-metrics.js';
import { SystemPromptBuilder } from './system-prompt-builder.js';
import {
  SHARED_SAFETY_SECTION,
  SHARED_OPERATIONAL_CONSTRAINTS,
  CODER_CODE_DISCIPLINE,
  CANONICAL_DOCS_GUIDANCE,
  TOOL_CALL_PLACEMENT_SECTION,
} from './system-prompt-sections.js';
import {
  getToolPublicName,
  TOOL_REGISTRY_SCHEMA_VERSION,
  TOOL_SCHEMA_VERSION_PREFIX,
} from './tool-registry.js';
import { getToolTargetDetail } from './tool-target-detail.js';
import type { DetectedToolCalls } from './deep-reviewer-agent.js';
import { buildContextSummaryBlock, normalizeTrimmedRoleAlternation } from './coder-context-trim.js';
import {
  clearMutationFailure,
  extractMutatedPaths,
  formatMutationHardFailure,
  recordMutationFailure,
  type MutationFailureEntry,
} from './coder-mutation-results.js';

// Re-export the structural detector shape so the Web shim only needs one
// import path. Same canonical definition as deep-reviewer / explorer.
export type { DetectedToolCalls } from './deep-reviewer-agent.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODER_ROUND_TIMEOUT_MS = 60_000; // 60s of inactivity (activity-based — resets on each token)
// Wall-clock backstop per round. The activity timer above resets on every
// `text_delta`, so a model streaming content continuously without terminating
// never trips it and the round's `for await` hangs forever. Background coder
// jobs run unattended, so bound each round by wall-clock too. Mirrors
// EXPLORER_ROUND_WALL_CLOCK_MS / DEEP_REVIEW_ROUND_WALL_CLOCK_MS.
const CODER_ROUND_WALL_CLOCK_MS = 180_000;
// First-token grace for the activity timer. The canonical value lives once in
// the reasoning-model registry (REASONING_HEAVY_FIRST_TOKEN_GRACE_MS) — both
// here and `reasoningHeavyStreamOpts` size the same window, so it shouldn't be
// re-stated as a bare literal. Workers AI models (kimi/glm) routinely have a
// 20–30s time-to-first-token and a heavy reasoner's preamble runs longer still;
// the 60s activity window above is tight enough that a slow-to-START round
// (cold/queued upstream) trips it and surfaces as "model may be unresponsive"
// before the model has emitted anything. The Coder applies this grace to EVERY
// model — slow-TTFT is not exclusive to registry-matched reasoners — then falls
// back to CODER_ROUND_TIMEOUT_MS for inter-token gaps. The wall-clock cap still
// bounds the round overall.
const CODER_FIRST_TOKEN_GRACE_MS = REASONING_HEAVY_FIRST_TOKEN_GRACE_MS;
const MAX_CODER_ROUNDS = 30; // Circuit breaker — prevent runaway delegation
// The inline lead is a *watched* foreground run — the user sees every round and
// can Stop it — so it doesn't get the 30-round wall a delegated Coder does.
// This is a high, effectively-invisible backstop: it exists only to bound a
// runaway loop once the run goes silent and is adopted/detached (no human left
// to stop it; the kernel has no other runaway guard). A productive watched turn
// never reaches it. Used when leadMode is set and no explicit cap was passed.
const LEAD_MAX_ROUNDS = 150;
const MAX_CHECKPOINTS = 3; // Max interactive checkpoint pauses per task
const CHECKPOINT_ANSWER_TIMEOUT_MS = 30_000; // 30s for Orchestrator checkpoint response
// Cadence (in rounds) for durable resume checkpoints — the host snapshots the
// workspace + persists the serialized loop state so a sandbox death can be
// recovered. Distinct from the interactive checkpoints above. Fires at the top
// of a round (a quiescent point: prior rounds' tool calls are applied and no
// new ones have started), so the filesystem and the captured state are
// consistent for a clean rollback on resume.
const CODER_CHECKPOINT_CADENCE_ROUNDS = 5;

// Size limits to prevent 413 errors from provider APIs
const MAX_TOOL_RESULT_SIZE = SIZE_BUDGETS.toolResultCoder; // tool result cap, ~400 lines/read
const MAX_AGENTS_MD_SIZE = SIZE_BUDGETS.projectInstructions; // AGENTS.md cap (rationale: lib/size-budgets.ts)
const MAX_TOTAL_CONTEXT_SIZE = 120_000; // Rough limit for total message content
const CODER_STATE_REINJECTION_PRESSURE_PCT = 60;
const CODER_STATE_REINJECTION_CADENCE_ROUNDS = 6;

// --- Mutation failure guardrails ---
const MAX_CONSECUTIVE_MUTATION_FAILURES = 3; // Hard failure threshold for same tool+file
// Consecutive SANDBOX_UNREACHABLE tool results that signal the container is
// genuinely gone (not a one-off blip). At/above this the loop throws
// SandboxUnreachableError so the host can restore a checkpoint and resume,
// rather than burning rounds against a dead sandbox.
const SANDBOX_LOSS_THRESHOLD = 2;

/**
 * Thrown by the Coder loop when the sandbox is confirmed unreachable across
 * `SANDBOX_LOSS_THRESHOLD` consecutive tool calls. The host (coder-job DO)
 * catches it to drive seamless resume: restore the latest checkpoint into a
 * fresh sandbox and re-run the loop seeded with the checkpoint's state. Distinct
 * class so the host can tell it apart from ordinary run failures.
 */
export class SandboxUnreachableError extends Error {
  readonly code = 'SANDBOX_UNREACHABLE' as const;
  constructor(message = 'Sandbox is unreachable') {
    super(message);
    this.name = 'SandboxUnreachableError';
  }
}

/**
 * Typed payload the kernel hands the host when a run durably suspends. Mirrors
 * the "suspend context" half of Mastra's suspend/resume: `question` + `context`
 * are what the run needs answered, and `resumeSchema` declares the shape of the
 * data the host must supply to `/resume`. Kept deliberately small — a single
 * free-text `answer` field by default — but structured so a future checkpoint
 * call that declares richer fields can widen it without a wire change.
 */
export interface CoderSuspendPayload {
  /** What the run is blocked on — surfaced to the human who will resume it. */
  question: string;
  /** Supporting detail the run attached to the question (may be empty). */
  context: string;
  /**
   * The contract the resume caller must satisfy. `required` names the fields
   * `resumeData` must carry; `fields` maps each to its primitive type. Defaults
   * to a single required `answer: string`, matching the free-text guidance the
   * synchronous checkpoint path injects today.
   */
  resumeSchema: { required: string[]; fields: Record<string, 'string'> };
}

/** Default resume contract: one required free-text `answer`. */
export const DEFAULT_CODER_RESUME_SCHEMA: CoderSuspendPayload['resumeSchema'] = {
  required: ['answer'],
  fields: { answer: 'string' },
};

/**
 * Thrown by the Coder loop when it emits a guidance/checkpoint call while the
 * host has opted into `durableSuspension` (the background AgentJob DO, where the
 * counterparty is a human who may answer minutes or hours later and no
 * in-memory `await` can survive a DO eviction). The host catches it to park the
 * run: snapshot the workspace, persist `state` + `payload`, and flip the job to
 * `suspended` until a typed `/resume` revives it. Distinct class — like
 * `SandboxUnreachableError` — so the host tells a durable suspend apart from an
 * ordinary failure or a sandbox-death resume.
 *
 * `state.round` is already advanced past the asking round, so a resume that
 * appends the human's answer as the next user message re-enters the loop at the
 * following round — identical to the synchronous path's post-answer `continue`.
 */
export class CoderSuspendedError<TCard extends ToolCard = ToolCard> extends Error {
  readonly code = 'CODER_SUSPENDED' as const;
  readonly payload: CoderSuspendPayload;
  readonly state: CoderCheckpointState<TCard>;
  constructor(payload: CoderSuspendPayload, state: CoderCheckpointState<TCard>) {
    super(`Coder run suspended awaiting guidance: ${payload.question}`);
    this.name = 'CoderSuspendedError';
    this.payload = payload;
    this.state = state;
  }
}

// ---------------------------------------------------------------------------
// Message shape — structural subset of Web `ChatMessage` used by the loop.
// Lib kernel uses `LlmMessage & { isToolResult?, isToolCall? }` so the trim
// helper and context-summary logic can read tool-result markers without
// depending on Web's `ChatMessage` type.
// ---------------------------------------------------------------------------

export interface CoderLoopMessage extends LlmMessage {
  isToolResult?: boolean;
  isToolCall?: boolean;
  toolUses?: LlmToolUseBlock[];
  toolResults?: LlmToolResultBlock[];
}

function getKernelToolCallFields(call: unknown): {
  tool: string;
  args?: unknown;
  thoughtSignature?: string;
} {
  const source = call as {
    call?: { tool?: unknown; args?: unknown; thoughtSignature?: unknown };
    thoughtSignature?: unknown;
  } | null;
  const raw = source?.call;
  // `thoughtSignature` sits top-level on the web call shape (AnyToolCall) but
  // nested under `.call` on the CLI shape (CliKernelCall, re-wrapped from the
  // shared dispatcher's inner call). Read both so Gemini signatures round-trip
  // on either surface.
  const thoughtSignature =
    typeof source?.thoughtSignature === 'string'
      ? source.thoughtSignature
      : typeof raw?.thoughtSignature === 'string'
        ? raw.thoughtSignature
        : undefined;
  return {
    tool: typeof raw?.tool === 'string' ? raw.tool : 'unknown',
    args: raw?.args,
    thoughtSignature,
  };
}

function createToolUseSidecars<TCall>(calls: readonly TCall[]): {
  toolUses: LlmToolUseBlock[];
  toolUseIdByCall: Map<TCall, string>;
} {
  const toolUseIdByCall = new Map<TCall, string>();
  const toolUses = calls.map((call) => {
    const { tool, args, thoughtSignature } = getKernelToolCallFields(call);
    const id = createToolUseBlockId(createId());
    toolUseIdByCall.set(call, id);
    return buildToolUseBlock({ id, name: tool, input: args, thoughtSignature });
  });
  return { toolUses, toolUseIdByCall };
}

function markLatestAssistantToolUse(
  messages: CoderLoopMessage[],
  round: number,
  toolUses: LlmToolUseBlock[],
): void {
  if (toolUses.length === 0) return;
  const latest = messages[messages.length - 1];
  if (!latest || latest.id !== `coder-response-${round}` || latest.role !== 'assistant') return;
  messages[messages.length - 1] = {
    ...latest,
    isToolCall: true,
    toolUses,
  };
}

function toolResultSidecar(
  toolUseIdByCall: Map<unknown, string>,
  call: unknown,
  content: string,
  isError = false,
): { toolResults: LlmToolResultBlock[] } | {} {
  const toolUseId = toolUseIdByCall.get(call);
  if (!toolUseId) return {};
  return {
    toolResults: [
      buildToolResultBlock({
        toolUseId,
        content,
        isError,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Working memory types — single source in `./working-memory.ts`.
//
// We re-export rather than redefine so the shape stays canonical across
// surfaces (lib/auditor-agent.ts, the engine, and the cli session state all
// converge on one definition). The function bodies in this file still
// differ from working-memory.ts (notably `shouldInjectCoderStateOnToolResult`
// uses CLI-internal constants), so full function consolidation is a future
// refactor — but a shared type prevents field drift.
//
// `app/src/types/index.ts` keeps a parallel copy for the web bundle today;
// folding that one in is its own follow-up.
// ---------------------------------------------------------------------------

import type {
  CoderObservation,
  CoderWorkingMemory,
  CoderObservationUpdate,
  CoderWorkingMemoryUpdate,
} from './working-memory.js';
import {
  applyObservationUpdates,
  detectUpdateStateCall,
  formatCoderState,
  formatCoderStateDiff,
  hasCoderState,
  invalidateObservationDependencies,
  shouldInjectCoderStateOnToolResult as shouldInjectCoderStateFromWorkingMemory,
} from './working-memory.js';

export type {
  CoderObservation,
  CoderWorkingMemory,
  CoderObservationUpdate,
  CoderWorkingMemoryUpdate,
};

/** Truncate content with a marker if it exceeds max length. */
function truncateContent(content: string, maxLen: number, label = 'content'): string {
  if (content.length <= maxLen) return content;
  const truncated = content.slice(0, maxLen);
  return `${truncated}\n\n[${label} truncated — ${content.length - maxLen} chars omitted]`;
}

/** Estimate total size of messages array (rough character count). */
function estimateMessagesSize(messages: CoderLoopMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

// ---------------------------------------------------------------------------
// Interactive Checkpoint support
// ---------------------------------------------------------------------------

type CoderCheckpointCall = {
  tool: 'coder_checkpoint';
  args: { question: string; context?: string };
};

/**
 * Detect a coder_checkpoint tool call in the Coder's response text.
 * Uses the same fenced-JSON + bare-JSON fallback pattern as other tools.
 */
function detectCheckpointCall(text: string): CoderCheckpointCall | null {
  return detectToolFromText<CoderCheckpointCall>(text, (parsed) => {
    const obj = asRecord(parsed);
    if (obj?.tool === 'coder_checkpoint') {
      const args = asRecord(obj.args);
      if (args && typeof args.question === 'string' && args.question.trim()) {
        return {
          tool: 'coder_checkpoint',
          args: {
            question: (args.question as string).trim(),
            context: typeof args.context === 'string' ? args.context : undefined,
          },
        };
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Working memory helpers
// ---------------------------------------------------------------------------

export function shouldInjectCoderStateOnToolResult(
  current: CoderWorkingMemory,
  previous: CoderWorkingMemory | null,
  currentRound: number,
  contextChars: number,
  lastInjectionRound: number | null,
): boolean {
  return shouldInjectCoderStateFromWorkingMemory(
    current,
    previous,
    currentRound,
    contextChars,
    MAX_TOTAL_CONTEXT_SIZE,
    lastInjectionRound,
    CODER_STATE_REINJECTION_PRESSURE_PCT,
    CODER_STATE_REINJECTION_CADENCE_ROUNDS,
  );
}

export function summarizeCoderStateForHandoff(mem: CoderWorkingMemory | null | undefined): string {
  if (!mem) return '';

  const lines: string[] = [];
  if (mem.plan) lines.push(`Plan: ${mem.plan}`);
  if (mem.currentPhase) lines.push(`Current phase: ${mem.currentPhase}`);
  if (mem.openTasks?.length) lines.push(`Open tasks: ${mem.openTasks.join('; ')}`);
  if (mem.filesTouched?.length) lines.push(`Files touched: ${mem.filesTouched.join(', ')}`);
  if (mem.errorsEncountered?.length)
    lines.push(`Recent errors: ${mem.errorsEncountered.join('; ')}`);

  const observations = (mem.observations || [])
    .filter((observation) => !observation.stale)
    .slice(-3);
  if (observations.length > 0) {
    lines.push('Key observations:');
    lines.push(...observations.map((observation) => `- ${observation.text}`));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Checkpoint answer — pure LLM call that the Web shim can re-export for
// Orchestrator-side callbacks. Does not touch the tool loop.
// ---------------------------------------------------------------------------

/**
 * Generate a checkpoint answer from the Orchestrator's perspective.
 * Makes a focused LLM call using the supplied provider/stream function
 * to answer the Coder's question, incorporating recent chat history for
 * user intent context.
 */
export async function generateCheckpointAnswer(
  question: string,
  coderContext: string,
  opts: {
    /**
     * PushStream the Orchestrator iterates directly. Phase 6 of the
     * PushStream gateway migration moved checkpoint answers off the 12-arg
     * `ProviderStreamFn` callback — callers now pass either a native
     * PushStream or a legacy `ProviderStreamFn` wrapped with
     * `providerStreamFnToPushStream`.
     */
    stream: PushStream<LlmMessage>;
    provider: AIProviderType;
    modelId?: string;
    recentChatHistory?: CoderLoopMessage[];
    signal?: AbortSignal;
  },
): Promise<string> {
  const { stream, provider, modelId, recentChatHistory, signal } = opts;

  const checkpointSystemPrompt = `You are the Orchestrator agent for Push, answering a question from the Coder agent who has paused mid-task.

Goal:
- Unblock the Coder quickly with the smallest high-confidence decision or next step.

Rules:
- Give a direct, actionable answer grounded in the user's request and the Coder's context.
- Prefer telling the Coder what to do next over restating the problem.
- If the Coder is stuck on an error, suggest concrete debugging steps or a safer fallback.
- If the task is ambiguous, resolve the ambiguity from chat context when possible; if not possible, say exactly what remains ambiguous.
- Keep your response under 220 words.
- Do NOT emit tool calls — your response goes directly back to the Coder as text.

Respond using this compact structure:
Decision: [the call the Coder should make]
Why: [1-2 sentences]
Next steps:
- [step 1]
- [step 2]
Avoid:
- [common mistake or dead end to skip]

If the answer is genuinely uncertain, say so plainly in Decision and give the safest next step.`;

  const messages: LlmMessage[] = [];

  // Include recent chat history for user intent context (trimmed)
  if (recentChatHistory) {
    for (const msg of recentChatHistory.slice(-6)) {
      messages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content.slice(0, 2000),
        timestamp: msg.timestamp,
      });
    }
  }

  // Add the checkpoint question
  messages.push({
    id: 'checkpoint-question',
    role: 'user',
    content: `The Coder agent has paused and is asking for your guidance:\n\nQuestion: ${question}${coderContext ? `\n\nCoder's context: ${coderContext}` : ''}`,
    timestamp: Date.now(),
  });

  // Compose the caller's signal with iteratePushStreamText's own activity
  // controller so user-initiated cancellation aborts the upstream call.
  const cancellableStream: PushStream<LlmMessage> = signal
    ? (req) =>
        stream({
          ...req,
          signal: req.signal ? AbortSignal.any([req.signal, signal]) : signal,
        })
    : stream;

  const { error: streamError, text: accumulated } = await iteratePushStreamText(
    cancellableStream,
    {
      provider,
      model: modelId ?? '',
      messages,
      systemPromptOverride: checkpointSystemPrompt,
      hasSandbox: false,
    },
    CHECKPOINT_ANSWER_TIMEOUT_MS,
    'Checkpoint response timed out',
  );

  if (streamError || !accumulated.trim()) {
    return 'The Orchestrator could not generate a response. Try a different approach or simplify your current step.';
  }

  // Truncate checkpoint answers like tool results to prevent context bloat
  const MAX_CHECKPOINT_ANSWER_SIZE = 4000;
  return truncateContent(accumulated.trim(), MAX_CHECKPOINT_ANSWER_SIZE, 'checkpoint answer');
}

// ---------------------------------------------------------------------------
// Coder system prompt — sectioned constants
// ---------------------------------------------------------------------------

const CODER_IDENTITY = `You are the Coder agent for Push, a mobile AI coding assistant. Your job is to implement coding tasks.`;

// Inline Foreground Lane: the Coder runs as the conversational lead — no
// brief, no Orchestrator, talking to the user directly.
/**
 * The lead's identity line. Honest to the routing Push controls: the model is
 * told what it is running AS (the locked provider/model for this session), then
 * the role framing. Models can't reliably self-identify — Push, the authority
 * on what's serving the turn, tells them. It must NOT be told it IS "Push" (a
 * persona name deliberately dropped from the old Orchestrator loop and silently
 * reintroduced in b76ae241); the guard in cli/tests/lead-identity.test.mjs stops
 * that recurring. Falls back to a nameless lead framing when the model is unknown.
 */
export function buildLeadIdentity(
  modelId: string | undefined,
  provider: AIProviderType | string | undefined,
): string {
  const providerLabel = provider ? getProviderDisplayName(provider) : '';
  const who = modelId
    ? `You are \`${modelId}\`${providerLabel ? `, served via ${providerLabel}` : ''}, working as the lead in this chat`
    : `You are the lead in this chat`;
  return `${who}: you talk with the user directly and do the hands-on work yourself — reading the repo, thinking things through out loud, answering their questions, and making code changes when they ask. You're someone they build alongside, not a service that hands back results — so talk like it. If they ask which model you are, tell them plainly.`;
}

// Voice + boundaries for the conversational lead. Ported from the old
// Orchestrator prompt (`ORCHESTRATOR_VOICE`) — the inline lead IS the
// conversational interface that guidance was written for. The Orchestrator's
// "branch creation is UI-owned" line is intentionally dropped: branch ops are
// typed tools (`create_branch` / `switch_branch`) the lead can call.
const LEAD_VOICE = `Voice:
- Talk like a sharp colleague, not a ticket-closer. Warmth and a little dry wit are welcome — you have a point of view, and you share it.
- Be genuinely conversational: react to what they actually said, think out loud, and give the "why" — don't just hand back a conclusion.
- Concise is not the same as clipped. Keep it scannable for mobile, but a real sentence beats a terse fragment; short paragraphs, not bullet-point telegrams.
- Have opinions about taste, and push back when something seems off — disagreement is a form of care, not a detour.
- Use markdown for code snippets. Vary your openings so replies never feel templated.

Boundaries:
- If you don't know something, say so plainly. Don't guess, and don't perform certainty you don't have.
- You only know about the active repo. Never mention other repos — the user controls that via the UI.
- All questions about "the repo", PRs, or changes refer to the active repo. Period.`;

/**
 * Tool-routing + error-handling guidance for the inline lead. Condensed from
 * the Orchestrator prompt for a single-agent, cloud-sandbox lead: it wields
 * both the sandbox and GitHub surfaces directly (no delegation), so it needs
 * the routing split and the structured-error retry policy the delegated Coder
 * never carried.
 */
function buildLeadToolGuidance(): string {
  const sandboxExec = getToolPublicName('sandbox_exec');
  const sandboxSearch = getToolPublicName('sandbox_search');
  const searchFiles = getToolPublicName('search_files');
  const sandboxReadFile = getToolPublicName('sandbox_read_file');
  const readFile = getToolPublicName('read_file');
  const listDir = getToolPublicName('sandbox_list_dir');
  const commit = getToolPublicName('sandbox_commit');
  const preparePush = getToolPublicName('prepare_push');
  return `## Tool Routing

- Use **sandbox tools** for local work: reading/editing code, running commands (${sandboxExec}), tests, type checks, diffs, and local commits (via ${commit} — a silent local commit, not a raw git commit; the Auditor gate runs later at ${preparePush}).
- Use **GitHub tools** for remote repo metadata: PRs, branches, CI checks, commit history, cross-repo search, workflow dispatch.
- Prefer ${sandboxSearch} over ${searchFiles} and ${sandboxReadFile} over ${readFile} for the active repo — they're faster and reflect uncommitted edits.

## Error Handling

Tool results may carry structured error fields (error_type, retryable). Respond to the type:
- FILE_NOT_FOUND → verify the path (${listDir}).
- EDIT_HASH_MISMATCH / STALE_FILE → re-read the file to get current hashes, then re-edit.
- EXEC_NON_ZERO_EXIT → read the output, fix the issue, retry.
- RATE_LIMITED (retryable) → wait briefly, then retry once.
- SANDBOX_UNREACHABLE → treat sandbox loss as recoverable substrate churn. Let the runtime recover when it can; retry only safe read/probe calls automatically. Before any further mutation, inspect the current tree (git status / relevant files). Mention it only if recovery failed or work is incomplete.
- GIT_GUARD_BLOCKED → direct git commit/push/merge/rebase in ${sandboxExec} is blocked; use ${commit} to commit and ${preparePush} to ship (the Auditor runs at push).

General rules: if retryable is false, pivot to a different approach — don't repeat the same call. If retryable is true, retry silently up to 3 times with corrected arguments. For sandbox mutations whose effects may have dispatched, recover first and inspect current state instead of blindly repeating the mutation. Never claim success unless a tool result confirms it.`;
}

/**
 * Build the Coder guidelines section. `getToolPublicName` lives in lib so
 * the kernel resolves canonical tool names inline without taking a DI slot
 * for each one.
 */
/**
 * Which lead tool families the current surface actually wires, so lead
 * guidance never instructs the model to use tools that aren't executable
 * here. `'full'` is the web inline lead (sandbox + GitHub PR/CI + ask-user +
 * artifacts); `'sandbox'` is a sandbox + web-search surface only (the
 * background CoderJob DO main-chat lead), where PR / merge / promote, artifact
 * creation, and ask-user tools are NOT wired. Keep this a named scope, not a
 * pile of per-tool booleans — surfaces declare their profile, the guidance
 * derives from it.
 */
export type LeadToolScope = 'full' | 'sandbox';

/**
 * Resolve the kernel's lead-vs-delegated round + scope options from a surface's
 * intent. The same decision was being made independently by the foreground
 * inline lane (`inline-coder-run.ts`) and the background CoderJob DO
 * (`coder-job-do.ts`); centralizing it here keeps the two lanes in lockstep
 * (CLAUDE.md: promote a per-surface helper into `lib/` once a second surface
 * needs it).
 *
 * - **Lead** (the conversational lead's own turn): no explicit cap, so the
 *   kernel applies the high invisible backstop (`LEAD_MAX_ROUNDS`), and the
 *   surface's tool scope drives lead guidance (`'full'` web inline, `'sandbox'`
 *   background DO).
 * - **Delegated** (a sub-Coder): keep the configured `maxCoderRounds`; tool
 *   scope is irrelevant (the delegated guidelines don't reference it).
 */
export function resolveLeadRoundOptions(input: {
  isLead: boolean;
  /** The harness profile's Coder round cap, if configured. */
  maxCoderRounds?: number;
  /** The lead's tool scope for this surface. Only applied when `isLead`;
   *  defaults to `'full'`. */
  surface?: LeadToolScope;
}): {
  persona: 'lead' | 'coder';
  harnessMaxRounds: number | undefined;
  leadToolScope?: LeadToolScope;
} {
  if (input.isLead) {
    return {
      persona: 'lead',
      harnessMaxRounds: undefined,
      leadToolScope: input.surface ?? 'full',
    };
  }
  return { persona: 'coder', harnessMaxRounds: input.maxCoderRounds, leadToolScope: undefined };
}

function buildCoderGuidelines(leadMode = false, leadToolScope: LeadToolScope = 'full'): string {
  const diffToolName = getToolPublicName('sandbox_diff');
  const commitToolName = getToolPublicName('sandbox_commit');
  const preparePushToolName = getToolPublicName('prepare_push');
  const delegateCoderName = getToolPublicName('delegate_coder');
  const delegateExplorerName = getToolPublicName('delegate_explorer');
  const createPrName = getToolPublicName('create_pr');
  const mergePrName = getToolPublicName('merge_pr');
  const saveDraftName = getToolPublicName('sandbox_save_draft');
  const readFileName = getToolPublicName('sandbox_read_file');
  if (leadMode) {
    // Surface-aware tool references: the 'sandbox' scope keeps the planning /
    // inspection behavior but drops the GitHub PR/CI, PR-open/merge/promote,
    // artifact, and ask-user instructions for tools it can't execute (the
    // background DO is sandbox + web-search only). Repo-activity questions are
    // answered from the sandbox (git log / status via sandbox_exec) instead.
    const sandboxOnly = leadToolScope === 'sandbox';
    const investigateLine = sandboxOnly
      ? '- Investigate before answering when the question needs it — use the sandbox tools to read files, search the codebase, and run commands. Answer repo-activity questions ("what changed recently?") from the sandbox via git (e.g. `git log` / `git status` through sandbox_exec); GitHub PR/CI tools are not available on this surface.'
      : '- Investigate before answering when the question needs it — use the sandbox and GitHub tools to read files, search the codebase, and inspect PRs / commits / CI.';
    const noDelegateLine = sandboxOnly
      ? `- Do NOT call ${delegateCoderName} or ${delegateExplorerName}; you are the single lead and do the work yourself. This surface cannot open or merge PRs, promote to GitHub, create artifacts, or prompt the user with a tool — do the work in the sandbox and put any question to the user directly in your reply.`
      : `- Do NOT call ${delegateCoderName}; you are the single lead and do your own coding. You MAY call ${delegateExplorerName} to offload read-only investigation when a question spans many files or you want to trace a flow without spending your own context — keep the brief precise (task, files, knownContext, deliverable). You can fan out up to two ${delegateExplorerName} calls in one turn (emit them together) when two independent threads are worth exploring in parallel; do the editing yourself once they report back. Avoid ${createPrName} / ${mergePrName} unless the user explicitly asks to open or merge a PR.`;
    const discoverStep = sandboxOnly
      ? '2. Discover cheaply first: use list/search/symbol tools before broad file reads; answer repo-activity questions from the sandbox (git log / status), since GitHub PR/CI tools are not wired here.'
      : '2. Discover cheaply first: use list/search/symbol tools before broad file reads, and inspect PRs/commits/CI when the question is about repo activity.';
    return `Rules:
- You are speaking directly to the user in this chat. Lead with the answer and keep it conversational.
${investigateLine}
- Change code ONLY when the user asks you to change something. For questions ("what changed recently?", "how does X work?"), answer in prose — do not edit files, and do not propose a commit.
- When you DO change code: keep changes minimal and focused, fix failing tests before reporting success, then use ${diffToolName} to show what you changed, ${commitToolName} to commit locally (silent — the Auditor runs at push), and ${preparePushToolName} to ship it (runs the Auditor gate and returns a review card for approval).
- Match your closing to the work. After a code change, end with this summary:
  **Done:** [one sentence]
  **Changed:** [brief scope summary, not a file-by-file transcript]
  **Verified:** [brief tests/types/build result, or "not run"]
  **Open:** [anything incomplete or needing the user's attention, or "nothing"]
  For a question or a read-only investigation, just give the answer directly — do NOT use that Done/Changed/Verified/Open template.
${noDelegateLine}

Approach:
1. Read the user's request carefully — what are they actually asking for?
${discoverStep}
3. For a question: gather just enough to answer accurately, then respond directly.
4. For a change: read only the files/sections you need, make the smallest change that satisfies the request, then verify with the narrowest useful tests/types/build checks.
5. Keep working memory current so your plan and findings survive context trimming.

When you are stuck or need a decision:
- Prefer putting the question to the user directly in your reply — you are talking to them. Ask a real question rather than guessing.
- coder_checkpoint(question, context?) is also available to pause and reconsider after repeated errors (2+ on the same issue), missing files, or ambiguous requirements. Don't spin endlessly on the same error.

Sandbox Lifecycle:
- Make durable local progress: after a meaningful verified edit, before long verification/delegation, or before a risky refactor, prefer ${commitToolName} to create a silent local commit. The Auditor still runs later at ${preparePushToolName}.
- Use ${saveDraftName} only when you explicitly want a remote WIP checkpoint (for example, before unusually risky work or when local commits are not enough). It switches branches and pushes unaudited; use it intentionally.
- If you hit SANDBOX_UNREACHABLE mid-task, treat it as recoverable substrate churn. The runtime may restart/restore the sandbox; inspect git status and relevant files before continuing, and mention it only if recovery failed or work is incomplete.

Working Memory:
- Use coder_update_state to save your plan and track progress. Your state is injected into every tool result so it survives context trimming.
- Format: {"tool": "coder_update_state", "args": {"plan": "...", "openTasks": ["..."], "filesTouched": ["..."], "assumptions": ["..."], "errorsEncountered": ["..."], "currentPhase": "...", "completedPhases": ["..."]}}
- observations: [{"id": "name", "text": "conclusion", "dependsOn": ["src/foo.ts"]}] — Track conclusions about the codebase. The harness automatically flags observations as stale when their dependent files are modified. Use unique ids to update/remove entries.
- All fields are optional — only include what changed. Call it early (after reading files) and update as you go.
  Note: ${readFileName} remains available for detailed follow-up reads.`;
  }
  return `Rules:
- You receive a task description and work autonomously to complete it
- Use sandbox tools to read files, make changes, run tests, and verify your work
- Be methodical: read first, plan, implement, test
- Keep changes minimal and focused on the task
- If tests fail, fix them before reporting success
- When done, use ${diffToolName} to show what you changed, then ${commitToolName} to commit your work locally (silent commit; the lead ships it via ${preparePushToolName}, where the Auditor gate runs)
- Do NOT call ${delegateCoderName}, ${delegateExplorerName}, ${createPrName}, ${mergePrName}, or other GitHub tools. You are the Coder; your job is to implement, not delegate or manage PRs.
- End with a completion summary in this exact format:
  **Done:** [one sentence]
  **Changed:** [brief scope summary, not a full file-by-file transcript]
  **Verified:** [brief tests/types/build result, or "not run"]
  **Open:** [anything incomplete or requiring user attention, or "nothing"]

Execution loop:
1. Read the delegation brief carefully. Lock onto the task, deliverable, known context, and constraints before acting.
2. Discover cheaply first: use list/search/symbol tools before broad file reads whenever possible.
3. Read only the files/sections needed to make a safe change. If known context points to a location, verify it before editing.
4. Update working memory after discovery so your current plan, files touched, and open risks stay visible across context trimming.
5. Make the smallest change that satisfies the deliverable, then verify with the narrowest useful tests/types/build checks.
6. Before finishing, check your diff, summarize what is done, and say exactly what remains if anything is still open.

Handoff discipline:
- Treat "Known context" as a head start, not as proof. Confirm it in code before relying on it for edits.
- Treat "Deliverable" as the success target. If the deliverable changes, say so explicitly in **Open**.
- If you use a checkpoint, state what you tried, what blocked you, and what decision you need from the Orchestrator.

Sandbox Lifecycle:
- Make durable local progress: after a meaningful verified edit, before long verification, or before a risky refactor, prefer ${commitToolName} to create a silent local commit. The lead ships later via ${preparePushToolName}, where the Auditor gate runs.
- Use ${saveDraftName} only when you explicitly want a remote WIP checkpoint (for example, before unusually risky work or when local commits are not enough). It switches branches and pushes unaudited; use it intentionally.
- If you hit SANDBOX_UNREACHABLE mid-task, treat it as recoverable substrate churn. The runtime may restart/restore the sandbox; inspect git status and relevant files before continuing, and mention it only if recovery failed or work is incomplete.

Interactive Checkpoints:
- You have access to coder_checkpoint(question, context?) to pause and ask the Orchestrator for guidance
- Use it when you're stuck: repeated errors (2+ times for the same issue), missing files, ambiguous requirements, or uncertain about the right approach
- Do NOT spin endlessly on the same error — checkpoint early to save rounds
- Format: {"tool": "coder_checkpoint", "args": {"question": "your question here", "context": "optional details about what you've tried"}}
- The Orchestrator sees the user's full chat history and can provide context you don't have
- You get up to ${MAX_CHECKPOINTS} checkpoints per task — use them wisely

Working Memory:
- Use coder_update_state to save your plan and track progress. Your state is injected into every tool result so it survives context trimming.
- Format: {"tool": "coder_update_state", "args": {"plan": "...", "openTasks": ["..."], "filesTouched": ["..."], "assumptions": ["..."], "errorsEncountered": ["..."], "currentPhase": "...", "completedPhases": ["..."]}}
- observations: [{"id": "name", "text": "conclusion", "dependsOn": ["src/foo.ts"]}] — Track conclusions about the codebase. The harness automatically flags observations as stale when their dependent files are modified. Use unique ids to update/remove entries.
- All fields are optional — only include what changed. Call it early (after reading files) and update as you go.
- Phase tracking is optional and retroactive — you discover phases as you work and declare them. Example: "currentPhase":"Analyzing requirements", "completedPhases":["File discovery"]
  Note: ${readFileName} remains available for detailed follow-up reads.`;
}

// ---------------------------------------------------------------------------
// Options + callbacks
// ---------------------------------------------------------------------------

/**
 * Per-run callbacks. Richer than Explorer's because Coder has to plumb
 * checkpoint, working-memory, and ledger-advance callbacks back to the
 * Orchestrator without coupling the lib kernel to them.
 */
/**
 * Consistent point-in-time snapshot of the loop's resumable state, handed to
 * the host's `onCheckpoint` so it can be persisted alongside a filesystem
 * snapshot. On a sandbox death the host restores the workspace and rolls the
 * loop back to this `round`, so the two never diverge.
 *
 * `messages` and `workingMemory` are live loop references. The loop awaits
 * `onCheckpoint`, so they stay stable for the whole call — the host just must
 * serialize/copy them within the callback rather than retaining the live
 * references for later use.
 */
export interface CoderCheckpointState<TCard extends ToolCard = ToolCard> {
  /**
   * The loop's 0-based `round` index at the top of which this checkpoint was
   * taken — before that round's model call and tool execution. (Note this is
   * the raw loop counter, distinct from the 1-based `rounds = round + 1` used
   * for status/limits.) A resume re-enters the loop at this index: prior
   * rounds' tool results are already in `messages`, and this round has not run.
   */
  round: number;
  /** Full chat history through the prior round. */
  messages: CoderLoopMessage[];
  /** Agent working memory (plan, tasks, observations, phase). */
  workingMemory: CoderWorkingMemory;
  /** UI cards emitted so far, so a resumed run doesn't re-emit them. */
  cards: TCard[];
}

export interface CoderAgentCallbacks<TCard extends ToolCard = ToolCard> {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  onCheckpointRequest?: (question: string, context: string) => Promise<string>;
  /**
   * Durable resume checkpoint hook. Called at the top of every
   * `CODER_CHECKPOINT_CADENCE_ROUNDS`th round with a consistent snapshot of the
   * loop state; the host pairs it with a filesystem snapshot. Best-effort — the
   * loop swallows errors so a failed checkpoint never breaks the run.
   */
  onCheckpoint?: (state: CoderCheckpointState<TCard>) => Promise<void>;
  onWorkingMemoryUpdate?: (state: CoderWorkingMemory) => void;
  /** Called once per loop round so the Web shim can advance `fileLedger`. */
  onAdvanceRound?: () => void;
  /** Called whenever the kernel wants the latest file-awareness summary. */
  getFileAwarenessSummary?: () => string | null;
  /** Optional acceptance-criteria runner, invoked when the Coder reports done. */
  runAcceptanceCriterion?: (criterion: AcceptanceCriterion) => Promise<{
    exitCode: number;
    output: string;
  }>;
  /**
   * Optional auto-fetch sandbox diff summary. Invoked when the kernel halts
   * so the Orchestrator has a compact hint of what changed.
   */
  fetchSandboxStateSummary?: () => Promise<string>;
  /**
   * Optional run-event sink. When set, the kernel emits an
   * `assistant.prompt_snapshot` event once after the system prompt is
   * built so a debug surface can answer "what went to the Coder on
   * this delegation?" without re-running the build. The event is
   * tagged with `round: 0` because the prompt is built once per
   * delegation and reused across the inner loop's rounds.
   */
  onRunEvent?: (event: RunEventInput) => void;
}

/**
 * Flattened after-model callback result. Mirrors the Explorer shape 1:1 so
 * the lib kernel only sees primitives, never `AfterModelResult` or
 * `ChatMessage`.
 */
export type CoderAfterModelResult =
  | {
      action: 'inject';
      content: string;
      /**
       * Set when this inject is the "announced an action but emitted no tool
       * call" nudge (`ANNOUNCED_NO_ACTION_POLICY_MARKER`). A text-only
       * re-prompt can't stop a model from repeating the same
       * announce-without-act pattern, so the round loop forces the NEXT
       * round's request to `tool_choice: 'required'` — closing the loophole
       * at the API level instead of hoping the model complies. One-shot:
       * consumed and cleared before the round after next.
       */
      forceToolChoiceNextRound?: boolean;
    }
  | { action: 'halt'; summary: string }
  | null;

/**
 * Enhanced tool-exec result for Coder. The Web shim's closure bakes the
 * TurnPolicy pre/post hooks, CapabilityLedger enforcement, span tracing, and
 * sandbox health probe into this flattened shape so the lib kernel stays
 * ignorant of all of them.
 */
export type CoderToolExecResult<TCard extends ToolCard = ToolCard> =
  | {
      kind: 'executed';
      resultText: string;
      card?: TCard;
      /**
       * Errored so that the kernel can run its mutation-failure tracker.
       * Set to the `StructuredToolError` type key (e.g. "SANDBOX_UNREACHABLE")
       * or undefined for success. Kept as an opaque string so lib does not
       * lift Web's `ToolErrorType` union.
       */
      errorType?: string;
      /**
       * Marks a result as definitively (not transiently) unrecoverable on
       * the same sandbox. When true, the kernel's sandbox-loss tracker
       * throws `SandboxUnreachableError` on this single call rather than
       * waiting for `SANDBOX_LOSS_THRESHOLD` consecutive failures. Set by
       * the executor adapter when the worker returns `code: 'NOT_FOUND'`
       * (auth gate confirmed the container is gone). Optional and omitted
       * by default — transient SDK blips don't carry it and still respect
       * the threshold-of-2 behavior. Propagated from
       * `SandboxToolExecResult.structuredError.fatal`.
       */
      fatal?: boolean;
      /**
       * Structured line diff produced by file-mutation tools (edit_file /
       * write_file). Forwarded verbatim onto the `tool.execution_complete`
       * run event as `diff` so transcript surfaces can render the edit;
       * never enters the model-visible tool result. See lib/edit-diff.ts.
       */
      editDiff?: EditDiff;
      policyPost?: { kind: 'inject'; content: string } | { kind: 'halt'; summary: string };
    }
  | { kind: 'denied'; reason: string };

/**
 * Per-execution metadata minted by the shared kernel before it invokes the
 * host executor. The same execution id is emitted on the terminal
 * `tool.execution_complete` event, so a host that emits the corresponding
 * start event can produce a genuinely paired lifecycle even when identical
 * tools run concurrently.
 */
export interface CoderToolExecContext {
  round: number;
  phase?: string;
  executionId: string;
}

/**
 * CoderAgentOptions — lib-side options.
 *
 * `TCall` is the shell's tool-call discriminated union; `TCard` is the
 * shell's card shape. The kernel never inspects either type internally —
 * it only forwards calls to `toolExec` and collects the returned cards.
 */
export interface CoderAgentOptions<TCall, TCard extends ToolCard = ToolCard> {
  provider: AIProviderType;
  /**
   * PushStream the Coder iterates directly. Phase 6 of the PushStream
   * gateway migration moved the Coder off the 12-arg `ProviderStreamFn`
   * callback — callers now pass either a native PushStream or a legacy
   * `ProviderStreamFn` wrapped with `providerStreamFnToPushStream`.
   */
  stream: PushStream<LlmMessage>;
  /** Resolved model id the caller wants the Coder to use. */
  modelId: string | undefined;
  sandboxId: string;
  allowedRepo: string;
  branchContext?: {
    activeBranch: string;
    defaultBranch: string;
    protectMain: boolean;
    /**
     * `owner/repo` for the active repo. Rendered into the workspace block so
     * a lead wielding GitHub tools (Inline Foreground Lane) knows the `repo`
     * arg to pass — the GitHub executor rejects calls whose repo doesn't
     * match the allowed repo. Optional: the delegated Coder doesn't carry
     * the GitHub surface, so it leaves this unset.
     */
    repoFullName?: string;
  };
  projectInstructions?: string;
  instructionFilename?: string;

  /** Resolved user-profile snapshot. */
  userProfile: UserProfile | null;

  /** Pre-built delegation brief for the Coder task. Includes any planner brief. */
  taskPreamble: string;

  /**
   * Full initial loop transcript. Lead conversational turns use this to seed
   * the kernel with managed chat history instead of collapsing history into a
   * synthetic task preamble. Omitted keeps the task-shaped single-user-message
   * startup used by delegated Coders and inline coding turns.
   */
  initialMessages?: CoderLoopMessage[];

  /**
   * Rich multipart representation of the initial user turn. Shells build this
   * from their local attachment types; the shared kernel only carries provider
   * content parts. Ignored when resuming from a checkpoint.
   */
  initialUserContentParts?: LlmContentPart[];

  /** Pre-read symbol-cache summary string, or null when the cache is empty. */
  symbolSummary: string | null;

  /** Execute a detected tool call. See `CoderToolExecResult` for the flattened shape. */
  toolExec: (call: TCall, execCtx: CoderToolExecContext) => Promise<CoderToolExecResult<TCard>>;

  /** Multi-call detector (reads + optional trailing mutation). */
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCall>;

  /** Structured provider-native tool-call detector. Omitted keeps text dispatch only. */
  detectNativeToolCalls?: (calls: readonly NativeToolCall[]) => DetectedToolCalls<TCall>;

  /** Single-call detector. */
  detectAnyToolCall: (text: string) => TCall | null;

  /** Web search tool protocol prompt block. */
  webSearchToolProtocol: string;

  /** Sandbox tool protocol prompt block — pre-built by the shim. */
  sandboxToolProtocol: string;

  /**
   * Memory tool protocol prompt block (`memory_grep`/`memory_expand`), or
   * undefined when memory tools aren't wired for this run. Only set it when the
   * caller also threads `executeMemory` into the bindings, so advertising
   * matches executor support (no advertised-but-denied tools — LCM).
   */
  memoryToolProtocol?: string;

  /**
   * Additional tool-protocol prompt blocks to advertise beyond the
   * sandbox/web-search/memory surface. The Inline Foreground Lane threads the
   * GitHub, ask_user, and create_artifact protocols here so the collapsed
   * single lead matches the Orchestrator's tool surface; the delegated Coder
   * leaves it undefined and keeps its narrow surface. Each entry is appended
   * to `tool_instructions`. Advertise a block only when the matching executor
   * source is wired (`extraToolSources` + `executeExtraToolCall` in the
   * bindings) so advertising stays aligned with executor support.
   */
  extraToolProtocols?: string[];

  /** Pre-built verification-policy block, or null when no policy applies. */
  verificationPolicyBlock: string | null;

  /** Pre-built approval-mode block (Web shim calls `buildApprovalModeBlock(getApprovalMode())`). */
  approvalModeBlock: string | null;

  /** User-linked library text, already rendered by the web shell. */
  linkedLibraryContent?: string;

  /**
   * Session-digest inputs forwarded to the provider stream's `toLLMMessages`
   * context transform (the inline conversational lead threads these so history
   * management — compaction / USER_GOAL / session digest — happens once,
   * stream-side, over the raw seed). Undefined for delegated Coders and coding
   * turns, which carry a single task message that needs no digest. The kernel
   * does not interpret these; it forwards them verbatim on each round's request.
   */
  sessionDigestRecords?: ReadonlyArray<MemoryRecord>;
  priorSessionDigest?: SessionDigest;
  onSessionDigestEmitted?: (digest: SessionDigest | null) => void;

  /** After-model policy callback (identical shape to Explorer). */
  evaluateAfterModel: (response: string, round: number) => Promise<CoderAfterModelResult>;

  /** Optional per-task overrides — envelope harness + acceptance criteria. */
  acceptanceCriteria?: AcceptanceCriterion[];
  harnessMaxRounds?: number;
  /**
   * Optional adaptive-harness hook. Called at the top of every round with the
   * current round index and the cap in force; returns the (possibly adjusted)
   * cap — grown on healthy progress, shrunk on degraded signals. Absent → the
   * cap is fixed for the whole run (the web/cloud default today). Kept as an
   * injected dependency so the CLI can back it with `cli/harness-adaptation.ts`
   * without `lib/` importing a CLI module (ground rule 1; the
   * `lib/detached-exec-runner.ts` injection shape). Must be cheap and pure —
   * it runs every round.
   */
  adaptMaxRounds?: (ctx: { round: number; currentMaxRounds: number }) => number;
  /**
   * Per-run token budget (a circuit breaker on consumption, complementing the
   * round cap). When the run's accumulated token usage reaches this many
   * tokens, the loop halts with `stopReason: 'budget_exceeded'`. Resolved
   * cross-surface via `lib/run-cost-budget.ts` (env > explicit > off); the
   * host passes the already-resolved explicit value here, env is folded in by
   * the kernel. `undefined`/`null` ⇒ uncapped.
   */
  harnessTokenBudget?: number | null;
  harnessContextResetsEnabled?: boolean;

  /**
   * Seed the loop from a prior checkpoint instead of starting fresh — used by
   * the host's resume path after a sandbox death. When set, the loop begins
   * with these messages/working memory/cards and re-enters at `round`, against
   * a freshly-restored sandbox whose filesystem matches this state.
   */
  resumeState?: CoderCheckpointState<TCard>;

  /**
   * Opt into durable suspension: when set, a guidance/checkpoint call the Coder
   * emits throws `CoderSuspendedError` (host parks the run and revives it via a
   * typed `/resume`) instead of the volatile in-memory `onCheckpointRequest`
   * await. Only the background AgentJob DO sets this — its counterparty is a
   * human who may answer long after the DO isolate that asked has been evicted,
   * so the pause must be durable, not a held promise. Unset elsewhere: the web
   * foreground lane keeps the synchronous `onCheckpointRequest` round-trip, and
   * a delegated sub-Coder (no human to answer) keeps the fall-through-to-done.
   */
  durableSuspension?: boolean;

  /**
   * How often (in rounds) `callbacks.onCheckpoint` fires. Defaults to the
   * kernel's `CODER_CHECKPOINT_CADENCE_ROUNDS` (background-job cadence). The
   * adopted-run host sets 1 so every round persists — server-side progress
   * has no client mirror, so the durable checkpoint is the only copy.
   */
  checkpointCadenceRounds?: number;
  /**
   * Persona: which agent identity this kernel run wears. `'lead'` is the
   * conversational lead (Inline Foreground Lane / CLI lead) — no brief, no
   * Orchestrator above it, talks to the user directly; lead identity + voice +
   * guidelines + high round backstop. `'coder'` is the delegated implementer —
   * narrow surface, implementer prompt, configured round cap. Required and
   * explicit (no default): every caller declares its persona, so neither
   * identity is a privileged fall-through. The persona-flip PR restructures the
   * prompt branches to treat `'lead'` as the base and `'coder'` as a restriction.
   */
  persona: 'lead' | 'coder';
  /**
   * Append the lead's tool-routing + structured-error guidance
   * (`buildLeadToolGuidance`). That block names the **canonical web sandbox /
   * GitHub tools** (`read`/`search`/`exec`/`prepare_commit`/`push`) and the
   * web shipping flow, so it's only correct on the web surface. The CLI lead
   * (`cli/lead-turn.ts`) runs `leadMode` with its own `TOOL_PROTOCOL`
   * (`read_file`/`git_commit`/…) and leaves this off, so it isn't steered
   * toward names it can't dispatch (Codex P2 on #927). Only meaningful with
   * `leadMode`. The name-free Tool-Call-Placement boundary is always included
   * in lead mode regardless of this flag.
   */
  leadToolGuidance?: boolean;
  /**
   * Which lead tool families the caller's surface actually wires. Drives lead
   * guidance so it never instructs the model to use tools that aren't
   * executable here. Defaults to `'full'` (the web inline lead + CLI lead,
   * which keep their existing guidance). The background CoderJob DO main-chat
   * lead passes `'sandbox'` — sandbox + web-search only, no PR / merge /
   * promote / artifact / ask-user tools. Only meaningful with `leadMode`.
   */
  leadToolScope?: LeadToolScope;
  /**
   * Native function-calling tool schemas to attach to each round's request
   * (the OpenAI `tools` array). Set by the caller only for models that support
   * native tool calling; the provider adapter serializes it. Additive to the
   * prompt-described tool protocol — native `tool_calls` are dispatched from
   * structured stream events, while text-dispatch models keep using fenced JSON.
   * Omitted ⇒ text-dispatch only (today's behavior for every other model).
   */
  nativeToolSchemas?: ToolFunctionSchema[];
  /**
   * Read-only tools whose correct usage includes re-calling with identical
   * args, so they must be EXEMPT from the lead exact-repeat breaker. Polling a
   * quiet long-running command (`exec_poll` returns `<no new output>` with an
   * unchanged `next_seq`, so the right next call is the same `{session_id,
   * from_seq}`) is the canonical case — without the exemption a slow command
   * that doesn't emit output every round trips the breaker on its 4th poll.
   * Surface-declared because the kernel can't know which tool names carry
   * wait-by-repeat semantics; the CLI lead passes its poll tools, the web
   * inline lead has none (its exec is the side-effecting `sandbox_exec`).
   * Only consulted in lead mode. Defaults to empty.
   */
  repeatExemptTools?: ReadonlySet<string>;
}

/**
 * Lib-side Coder run result. Mirrors the Web `CoderResult` shape minus
 * `capabilitySnapshot`, which the Web shim attaches at the boundary from its
 * own `CapabilityLedger`.
 */
export interface CoderAgentResult<TCard extends ToolCard = ToolCard> {
  summary: string;
  cards: TCard[];
  rounds: number;
  checkpoints: number;
  /** Why the run stopped *abnormally* (vs. completing the task): the round
   *  cap (`max_rounds`) or a repeated-tool-call loop (`loop`). Unset on a
   *  normal completion. Lets a caller surface a non-success outcome instead
   *  of treating the graceful stop summary as success — headless `push run`
   *  relies on this for its exit code / `--json` outcome. */
  stopReason?: 'max_rounds' | 'loop' | 'budget_exceeded';
  criteriaResults?: Array<{
    id: string;
    passed: boolean;
    exitCode: number;
    output: string;
  }>;
}

// ---------------------------------------------------------------------------
// Main Coder agent loop
// ---------------------------------------------------------------------------

export async function runCoderAgent<TCall, TCard extends ToolCard = ToolCard>(
  options: CoderAgentOptions<TCall, TCard>,
  callbacks: CoderAgentCallbacks<TCard>,
): Promise<CoderAgentResult<TCard>> {
  const {
    provider,
    stream,
    modelId,
    sandboxId: _sandboxId,
    allowedRepo: _allowedRepo,
    branchContext,
    projectInstructions,
    instructionFilename,
    userProfile,
    taskPreamble,
    initialMessages,
    initialUserContentParts,
    symbolSummary,
    toolExec: rawToolExec,
    detectAllToolCalls,
    detectNativeToolCalls,
    detectAnyToolCall,
    webSearchToolProtocol,
    sandboxToolProtocol,
    memoryToolProtocol,
    extraToolProtocols,
    verificationPolicyBlock,
    approvalModeBlock,
    linkedLibraryContent,
    sessionDigestRecords,
    priorSessionDigest,
    onSessionDigestEmitted,
    evaluateAfterModel,
    acceptanceCriteria,
    harnessMaxRounds,
    adaptMaxRounds,
    harnessTokenBudget,
    harnessContextResetsEnabled,
    persona,
    leadToolGuidance = false,
    leadToolScope = 'full',
    nativeToolSchemas,
    repeatExemptTools,
  } = options;

  // Derive the legacy boolean once for the body's prompt-section + round-cap
  // branches. `persona` is the contract; `leadMode` stays a local readability
  // alias until the persona-flip PR restructures these branches around the
  // 'lead'-as-base / 'coder'-as-restriction model.
  const leadMode = persona === 'lead';
  if (persona !== 'lead' && persona !== 'coder') {
    // `persona` is a required contract, but `@ts-nocheck` daemon callers (and
    // any untyped path) bypass the compiler. Fail loud rather than silently
    // falling through to coder behavior — a silent fallback is exactly the
    // privileged default this seam exists to remove.
    throw new Error(
      `runCoderAgent: invalid persona ${JSON.stringify(persona)} (expected 'lead' | 'coder')`,
    );
  }

  void _allowedRepo; // reserved for future use — lib loop does not need it directly
  void _sandboxId; // reserved for future use — sandbox ops flow through `toolExec`

  const coderModelId = modelId;

  // Build system prompt using the sectioned builder, layering runtime context
  // on top of the base Coder sections.
  const promptBuilder = new SystemPromptBuilder()
    .set('identity', leadMode ? buildLeadIdentity(modelId, provider) : CODER_IDENTITY)
    // Voice + boundaries — lead only (the conversational interface). '' deletes
    // the section, so the delegated Coder keeps no voice block.
    .set('voice', leadMode ? LEAD_VOICE : '')
    .set('safety', SHARED_SAFETY_SECTION)
    .set('user_context', approvalModeBlock ?? '')
    .set('guidelines', buildCoderGuidelines(leadMode, leadToolScope))
    .append('guidelines', SHARED_OPERATIONAL_CONSTRAINTS)
    .append('guidelines', CODER_CODE_DISCIPLINE)
    .append('guidelines', CANONICAL_DOCS_GUIDANCE)
    .set(
      'tool_instructions',
      // Idempotent prepend: when the caller-supplied protocol already
      // begins with a schema-version marker (the CLI daemon path feeds
      // in `TOOL_PROTOCOL` from `cli/tools.ts`, which carries its own
      // CLI-derived marker), don't double-stamp. GH Actions on PR #544.
      sandboxToolProtocol.startsWith(TOOL_SCHEMA_VERSION_PREFIX)
        ? sandboxToolProtocol
        : `[Tool schema version: ${TOOL_REGISTRY_SCHEMA_VERSION}]\n\n${sandboxToolProtocol}`,
    );

  // User identity (name, bio)
  const identityBlock = buildUserIdentityBlock(userProfile ?? undefined);
  if (identityBlock) {
    promptBuilder.append('user_context', identityBlock);
  }

  // Project instructions (AGENTS.md etc.) — canonical sanitized envelope shared
  // with the orchestrators and the other delegated agents.
  if (projectInstructions) {
    let projectContent = formatProjectInstructionsBlock(projectInstructions, {
      source: instructionFilename || 'AGENTS.md',
      maxSize: MAX_AGENTS_MD_SIZE,
    });
    if (projectInstructions.length > MAX_AGENTS_MD_SIZE) {
      const filename = instructionFilename || 'AGENTS.md';
      projectContent += `\n\nFull file available at /workspace/${filename} — use ${getToolPublicName('sandbox_read_file')} if you need details not shown above.`;
    }
    promptBuilder.set('project_context', projectContent);
  }

  if (linkedLibraryContent) {
    promptBuilder.set('library_context', linkedLibraryContent);
  }

  // Workspace context (branch metadata; repo name when a GitHub-tool lead
  // needs the `repo` arg — see branchContext.repoFullName).
  if (branchContext) {
    const repoLine = branchContext.repoFullName
      ? `Repository: ${branchContext.repoFullName}\n`
      : '';
    promptBuilder.set(
      'environment',
      `[WORKSPACE CONTEXT]\n${repoLine}Active branch: ${branchContext.activeBranch}\nDefault branch: ${branchContext.defaultBranch}\nProtect main: ${branchContext.protectMain ? 'on' : 'off'}`,
    );
  }

  // Web search protocol — stable tool instructions
  promptBuilder.append('tool_instructions', webSearchToolProtocol);

  // Memory tool protocol — only present when memory tools are wired for this
  // run (caller gates it on `executeMemory`), keeping advertising aligned with
  // executor support (LCM).
  if (memoryToolProtocol) {
    promptBuilder.append('tool_instructions', memoryToolProtocol);
  }

  // Extra lead-surface protocols (Inline Foreground Lane: github, ask_user,
  // create_artifact). Advertised only when the caller wired the matching
  // executor sources into the bindings, so there are no advertised-but-denied
  // tools.
  if (extraToolProtocols) {
    for (const block of extraToolProtocols) {
      if (block && block.trim()) {
        promptBuilder.append('tool_instructions', block);
      }
    }
  }

  // Lead-only operational guidance ported from the Orchestrator prompt.
  if (leadMode) {
    // The reasoning-channel placement boundary is name-free, so it's correct
    // on every lead surface (web + CLI both dispatch from the content channel).
    promptBuilder.append('tool_instructions', TOOL_CALL_PLACEMENT_SECTION);
    // Tool-routing + structured-error guidance names the canonical web sandbox /
    // GitHub tools, so it ships only when the caller is on that surface (the web
    // inline lane). The CLI lead opts out — see `leadToolGuidance`.
    if (leadToolGuidance) {
      promptBuilder.append('tool_instructions', buildLeadToolGuidance());
    }
  }

  // Symbol cache — volatile memory derived from workspace
  if (symbolSummary) {
    promptBuilder.set(
      'memory',
      `[SYMBOL_CACHE]\n${symbolSummary}\nUse sandbox_read_symbols on cached files to get instant results (no sandbox round-trip).\n[/SYMBOL_CACHE]`,
    );
  }

  // Session-level verification policy
  if (verificationPolicyBlock) {
    promptBuilder.append('guidelines', verificationPolicyBlock);
  }

  const systemPrompt = promptBuilder.build();

  // Emit the per-delegation prompt snapshot so a debug surface can
  // reconstruct what went to the Coder for this delegation. Hashes +
  // sizes only — section content is never on the event. Tagged with
  // `round: 0` because the Coder builds its prompt once and reuses it
  // across the inner loop; per-round granularity belongs to the
  // orchestrator surface where the prompt rebuilds each turn.
  callbacks.onRunEvent?.({
    type: 'assistant.prompt_snapshot',
    round: 0,
    role: 'coder',
    totalChars: systemPrompt.length,
    sections: promptBuilder.snapshot(),
  });

  // Compose the agent-level cancellation signal with iteratePushStreamText's
  // own activity-timeout controller. Mirrors how the legacy callback path
  // forwarded `callbacks.signal` as the 11th positional arg into `streamFn`.
  const externalSignal = callbacks.signal;
  const cancellableStream: PushStream<LlmMessage> = externalSignal
    ? (req) =>
        stream({
          ...req,
          signal: req.signal ? AbortSignal.any([req.signal, externalSignal]) : externalSignal,
        })
    : stream;

  // Resume seed: when present, the loop continues a checkpointed run against a
  // freshly-restored sandbox instead of starting fresh. Copies are taken so we
  // never alias the caller's persisted state.
  const resumeState = options.resumeState;

  const allCards: TCard[] = resumeState ? [...resumeState.cards] : [];
  let rounds = 0;
  let checkpointCount = 0;

  // Harness profile — controls scaffolding level. An explicit cap wins; absent
  // one, the lead gets the high invisible backstop and the delegated Coder the
  // 30-round wall.
  let maxRounds = harnessMaxRounds ?? (leadMode ? LEAD_MAX_ROUNDS : MAX_CODER_ROUNDS);
  const contextResetsEnabled = harnessContextResetsEnabled ?? false;

  // Per-run token budget (consumption circuit breaker). The host resolves the
  // effective cap (env > explicit > off via `lib/run-cost-budget.ts`) at its
  // surface boundary and passes the result — the kernel stays runtime-agnostic
  // (it also runs in the Worker, which has no `process.env`). Normalize to a
  // positive cap or null.
  const tokenBudget =
    typeof harnessTokenBudget === 'number' &&
    Number.isFinite(harnessTokenBudget) &&
    harnessTokenBudget > 0
      ? Math.floor(harnessTokenBudget)
      : null;
  const tokenLedger = createRunTokenLedger();
  // Run-cost receipt: emit the ledger's final tally on EVERY run termination,
  // not only on the budget cap-hit (`coder_budget_exceeded`). With the budget
  // off — the default — the ledger was otherwise write-only, so a run's spend
  // was never observable. This is an after-the-fact ops receipt (structured
  // log, no UI, nothing to watch): grep `coder_run_cost` to answer "what did
  // this run spend, and was it capped." Idempotent — the first terminal exit
  // wins and the guard blocks any double-emit. `console.log` matches the sibling
  // run-loop telemetry in this kernel (`coder_budget_exceeded`,
  // `coder_tool_choice_forced`), which is the generalization this receipt
  // subsumes; the daemon treats kernel stdout as its structured channel.
  let runCostReceiptEmitted = false;
  const emitRunCostReceipt = (stopReason: string, finalRound: number): void => {
    if (runCostReceiptEmitted) return;
    runCostReceiptEmitted = true;
    const snap = tokenLedger.snapshot();
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'coder_run_cost',
        stopReason,
        round: finalRound,
        leadMode,
        model: coderModelId ?? '',
        // The active cap (null when uncapped) — pairs the spend with the ceiling
        // it ran under so a receipt is self-describing without a separate join.
        limitTokens: tokenBudget,
        usedTokens: snap.usedTokens,
        // reported vs estimated splits the trustworthy total from the
        // fail-closed fallback rounds (adapters that never report usage).
        reportedRounds: snap.reportedRounds,
        estimatedRounds: snap.estimatedRounds,
      }),
    );
  };
  // Warn fires once on the crossing into `warn`, not every round past it.
  let tokenBudgetWarned = false;
  // Fail-closed estimate for the rare adapter that never reports usage. Input
  // recurs every round (the whole transcript is re-sent), so summing the
  // message text per round is the correct cumulative cost proxy, not a leak.
  const estimateRoundTokens = (
    transcript: ReadonlyArray<{ content?: unknown }>,
    output: string,
    reasoning: string,
  ): number => {
    let total = estimateTokens(output) + estimateTokens(reasoning);
    for (const msg of transcript) {
      const content = msg?.content;
      total += estimateTokens(
        typeof content === 'string' ? content : JSON.stringify(content ?? ''),
      );
    }
    return total;
  };
  const checkpointCadenceRounds =
    options.checkpointCadenceRounds ?? CODER_CHECKPOINT_CADENCE_ROUNDS;

  // Agent-internal working memory — survives context trimming via injection
  const workingMemory: CoderWorkingMemory = resumeState ? { ...resumeState.workingMemory } : {};
  // Track the last injected snapshot so we can emit compact diffs
  let lastInjectedState: CoderWorkingMemory | null = null;
  let lastInjectedStateRound: number | null = null;
  // Track phase for context reset detection
  let lastPhaseForReset: string | undefined;

  // --- Mutation failure guardrail state ---
  const mutationFailures = new Map<string, MutationFailureEntry>();
  let reasoningToolCallNudges = 0;

  // --- Loop-detection state (shared lib/loop-detection oracle) ---
  // The autonomous Coder loop is the highest-value site for near-duplicate
  // *rewrites*, so it runs the near-duplicate (similarity) ladder from the
  // shared oracle. Scoped to the similarity signal only — the Coder keeps its
  // existing mutation-failure breaker (`mutationFailures` above) and the
  // orchestrator's delegation circuit breaker; it deliberately does NOT take
  // the always-on exact-repeat abort the web orchestrator round loop carries,
  // because the Coder legitimately re-reads the same files across many rounds
  // and an always-on exact-batch abort would cut those runs short.
  //
  // Enforcement split: the delegated Coder keeps the near-duplicate ladder
  // DARK unless PUSH_LOOP_DETECTION=1 and takes no exact-repeat abort (it
  // legitimately re-reads the same files across rounds). The conversational
  // lead (`persona: 'lead'`) gets both guards — the lead lane (CLI
  // `cli/lead-turn.ts`, web inline) has no Orchestrator round loop above it,
  // so without these its only backstop was the round budget:
  //   1. the similarity ladder, enforced unconditionally (see
  //      `similarityEnforced` on the verdict call below); and
  //   2. the consecutive-identical-call breaker (`leadCallTracker` below) that
  //      the web orchestrator round loop carries but the lead lane never had.
  //      It feeds the oracle's always-enforced `exactBreakers` input, so it
  //      catches repeated *reads* the similarity ladder (writes-only) misses.
  //      The streak resets when a different call intervenes, so lead re-reads
  //      with work between rounds don't trip it.
  // Windows + counters are per-run (reset on resume).
  const loopDetector = createSimilarityLoopDetector();
  let loopBlocksIssued = 0;
  let loopCompactsIssued = 0;
  // Consecutive-identical-call tracker, lead-only (see split above). Mirrors
  // the web orchestrator's signal collection (`getToolInvocationKey` +
  // `isRepeatedCall`) so both surfaces key the breaker identically.
  const leadCallTracker = createMutationFailureTracker();

  // Wrap the host toolExec so a genuinely-gone sandbox — SANDBOX_UNREACHABLE
  // across SANDBOX_LOSS_THRESHOLD consecutive calls — throws
  // SandboxUnreachableError. The host catches it to restore a checkpoint and
  // re-run with `resumeState`, instead of burning rounds against a dead box. A
  // single transient blip (one loss then a success) resets the counter.
  //
  // The threshold-of-2 design exists for transient SDK blips, where ONE bad
  // call is followed by recovery. But some failure modes are unambiguously
  // terminal — the auth gate returning `NOT_FOUND` after `/api/sandbox-cf/cleanup`
  // tells us the container is gone; no amount of waiting will fix it. Those
  // results carry `fatal: true` (set by the executor adapter, see
  // `coder-job-executor-adapter.ts`) and bypass the threshold — without this
  // bypass, a model that gracefully summarizes after the FIRST tool error
  // (kimi-k2.6 on Workers AI does exactly that) never makes the second
  // failing call the counter needs, so the resume path silently doesn't fire.
  let consecutiveSandboxLoss = 0;
  const toolExec: typeof rawToolExec = async (call, execCtx) => {
    const result = await rawToolExec(call, execCtx);
    if (result.kind === 'executed' && result.errorType === 'SANDBOX_UNREACHABLE') {
      if (result.fatal) {
        throw new SandboxUnreachableError();
      }
      consecutiveSandboxLoss += 1;
      if (consecutiveSandboxLoss >= SANDBOX_LOSS_THRESHOLD) {
        throw new SandboxUnreachableError();
      }
    } else if (result.kind === 'executed') {
      consecutiveSandboxLoss = 0;
    }
    return result;
  };

  // Build initial messages (or restore them from the resume seed).
  const messages: CoderLoopMessage[] = resumeState
    ? resumeState.messages.map((m) => ({ ...m }))
    : initialMessages
      ? initialMessages.map((m) => ({ ...m }))
      : [
          {
            id: 'coder-task',
            role: 'user',
            content: taskPreamble,
            ...(initialUserContentParts && initialUserContentParts.length > 0
              ? { contentParts: initialUserContentParts }
              : {}),
            timestamp: Date.now(),
          },
        ];

  const getAwarenessBlock = (prefixNewline = true): string => {
    const awarenessSummary = callbacks.getFileAwarenessSummary?.();
    if (!awarenessSummary) return '';
    return `${prefixNewline ? '\n' : ''}[FILE_AWARENESS] ${awarenessSummary} [/FILE_AWARENESS]`;
  };

  // One-shot escalation: set when `evaluateAfterModel` returns the
  // "announced an action but emitted no tool call" nudge, consumed by the
  // NEXT round's `iteratePushStreamText` call (forces `tool_choice:
  // 'required'` instead of hoping the model complies with the text nudge
  // alone), then cleared before that round's own policy evaluation.
  let forceToolChoiceNextRound = false;

  for (let round = resumeState?.round ?? 0; ; round++) {
    if (callbacks.signal?.aborted) {
      throw new DOMException('Coder cancelled by user.', 'AbortError');
    }

    // Adaptive harness: re-derive the effective cap each round (grow on healthy
    // progress, shrink on degraded signals). No-op when the host injects no
    // hook — the cap stays fixed. Advisory: a garbage return (NaN/≤0) or a
    // throwing hook must never abort the run, so we keep the last-good cap.
    if (adaptMaxRounds) {
      try {
        const next = adaptMaxRounds({ round, currentMaxRounds: maxRounds });
        if (Number.isFinite(next) && next > 0) {
          maxRounds = next;
        }
      } catch {
        /* adaptation is best-effort; fall back to the fixed cap */
      }
    }

    // Circuit breaker: prevent runaway delegation loops
    if (round >= maxRounds) {
      // Emit the receipt before the host `onStatus` callback (a throwing
      // callback must not swallow it) and before `finishRound` is even defined
      // this iteration — this top-of-loop guard returns directly.
      emitRunCostReceipt('max_rounds', round);
      callbacks.onStatus('Coder stopped', `Hit ${maxRounds} round limit`);
      // Append a compact summary of what changed (for the reader / next turn).
      const sandboxState = (await callbacks.fetchSandboxStateSummary?.()) ?? '';
      // The lead is user-facing: close gracefully in its own voice, with no
      // round count, no "Coder", and no raw tool name (the delegated wall
      // leaked all three). Only tack on "here's where things stand" when there
      // actually IS a state summary — a lead caller without a
      // `fetchSandboxStateSummary` (e.g. the CLI lead) would otherwise end on a
      // dangling "stands:" (Codex P2 on #928). The delegated Coder keeps its
      // Orchestrator-facing marker.
      const leadClose =
        "I've spent a while on this without landing it cleanly, so I'm stopping here rather than looping further.";
      return {
        summary: leadMode
          ? sandboxState
            ? `${leadClose} Here's where things stand:${sandboxState}`
            : leadClose
          : `[Coder stopped after ${maxRounds} rounds — task may be incomplete. Review sandbox state with sandbox_diff.]${sandboxState}`,
        cards: allCards,
        rounds: round,
        checkpoints: checkpointCount,
        stopReason: 'max_rounds',
      };
    }

    // Circuit breaker: per-run token budget. Checked top-of-round on the total
    // accumulated by *prior* rounds (round 0 always runs — the ledger is empty)
    // so we halt before spending more once over budget, mirroring the round
    // cap above. Off when `tokenBudget` is null.
    if (tokenBudget !== null) {
      const verdict = tokenLedger.check(tokenBudget);
      if (verdict.state === 'exceeded') {
        // Symmetric structured log — the cap-hit branch, greppable against a
        // normal completion (which never emits this) and against the warn line.
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'coder_budget_exceeded',
            round,
            limitTokens: verdict.limitTokens,
            ...tokenLedger.snapshot(),
            model: coderModelId ?? '',
          }),
        );
        // Emit the unified run-cost receipt before the host `onStatus` /
        // `fetchSandboxStateSummary` callbacks (a throwing callback must not
        // swallow it) and before `finishRound` is defined this iteration — this
        // guard returns directly. The `coder_budget_exceeded` line above stays
        // as the cap-hit-specific signal; `coder_run_cost` is the always-on
        // receipt every terminal path shares.
        emitRunCostReceipt('budget_exceeded', round);
        callbacks.onStatus(
          'Coder stopped',
          `Hit ${tokenBudget.toLocaleString()}-token budget (used ~${verdict.usedTokens.toLocaleString()})`,
        );
        const sandboxState = (await callbacks.fetchSandboxStateSummary?.()) ?? '';
        const leadClose =
          "I've used up the token budget for this task, so I'm stopping here rather than spending further.";
        return {
          summary: leadMode
            ? sandboxState
              ? `${leadClose} Here's where things stand:${sandboxState}`
              : leadClose
            : `[Coder stopped after reaching the ${tokenBudget}-token run budget — task may be incomplete. Review sandbox state with sandbox_diff.]${sandboxState}`,
          cards: allCards,
          rounds: round,
          checkpoints: checkpointCount,
          stopReason: 'budget_exceeded',
        };
      }
      if (verdict.state === 'warn' && !tokenBudgetWarned) {
        tokenBudgetWarned = true;
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'coder_budget_warning',
            round,
            usedTokens: verdict.usedTokens,
            limitTokens: verdict.limitTokens,
            remainingTokens: verdict.remainingTokens,
            model: coderModelId ?? '',
          }),
        );
      }
    }

    rounds = round + 1;
    callbacks.onAdvanceRound?.();
    callbacks.onStatus('Coder working...', `Round ${rounds}`);
    let roundEnded = false;
    const finishRound = (outcome: 'completed' | 'continued' | 'error' | 'aborted' | 'steered') => {
      if (roundEnded) return;
      roundEnded = true;
      // Emit the run-cost receipt BEFORE the host `onRunEvent` callback below: a
      // throwing host callback must not swallow the receipt (the "every terminal
      // path leaves a receipt" guarantee has to survive a misbehaving host).
      // `completed` / `error` / `aborted` are the run-terminal outcomes (each is
      // immediately followed by a return or throw); `continued` / `steered` keep
      // the loop going. This backstops the normal-completion and stream
      // error/abort exits (where `finishRound` is the first thing called). The
      // paths that run a host callback *before* `finishRound` — the two
      // top-of-loop guards and the loop/drift halts — emit the receipt
      // explicitly with a precise reason (idempotent, so this call no-ops), so a
      // loop halt doesn't read here as a generic `completed`.
      if (outcome === 'completed' || outcome === 'error' || outcome === 'aborted') {
        emitRunCostReceipt(outcome, round);
      }
      callbacks.onRunEvent?.({ type: 'assistant.turn_end', round, outcome });
    };

    callbacks.onRunEvent?.({ type: 'assistant.turn_start', round });

    // Durable resume checkpoint. Top-of-round is quiescent: prior rounds' tool
    // calls are applied to the workspace and none are in flight, so the
    // filesystem the host snapshots matches the state captured here. Awaited so
    // nothing mutates `messages`/`workingMemory` mid-snapshot; best-effort so a
    // checkpoint failure never aborts the run.
    if (callbacks.onCheckpoint && round > 0 && round % checkpointCadenceRounds === 0) {
      try {
        await callbacks.onCheckpoint({ round, messages, workingMemory, cards: allCards });
      } catch (err) {
        callbacks.onStatus('Checkpoint skipped', err instanceof Error ? err.message : String(err));
      }
    }

    // One-shot escalation consumed here: only meaningful when native tool
    // schemas are actually attached (nothing to force otherwise). Cleared
    // immediately so a round whose response doesn't re-trigger the nudge
    // doesn't keep forcing tool_choice forever.
    const applyForcedToolChoice =
      forceToolChoiceNextRound && nativeToolSchemas && nativeToolSchemas.length > 0;
    if (applyForcedToolChoice) {
      // Symmetric structured log — greppable confirmation that a prior
      // announced-no-action nudge actually escalated to tool_choice:
      // 'required' rather than hoping the model complies with text alone.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'coder_tool_choice_forced',
          round,
          model: coderModelId ?? '',
        }),
      );
    }
    forceToolChoiceNextRound = false;

    // Stream Coder response via the active provider, with a per-round timeout
    const {
      error: streamError,
      text: rawModelText,
      reasoningText,
      reasoningBlocks,
      nativeToolCalls,
      usage: roundUsage,
    } = await iteratePushStreamText(
      cancellableStream,
      {
        provider,
        model: coderModelId ?? '',
        messages,
        systemPromptOverride: systemPrompt,
        hasSandbox: true,
        // Conversational lead turns thread digest inputs so the stream's
        // `toLLMMessages` runs the single context transform over the raw seed.
        // Undefined elsewhere (a single task message needs no digest).
        ...(sessionDigestRecords ? { sessionDigestRecords } : {}),
        ...(priorSessionDigest ? { priorSessionDigest } : {}),
        ...(onSessionDigestEmitted ? { onSessionDigestEmitted } : {}),
        ...(nativeToolSchemas && nativeToolSchemas.length > 0 ? { tools: nativeToolSchemas } : {}),
        ...(applyForcedToolChoice ? { toolChoice: 'required' as const } : {}),
      },
      CODER_ROUND_TIMEOUT_MS,
      `Coder round ${rounds} timed out after ${CODER_ROUND_TIMEOUT_MS / 1000}s — model may be unresponsive.`,
      CODER_ROUND_WALL_CLOCK_MS,
      `Coder round ${rounds} exceeded ${CODER_ROUND_WALL_CLOCK_MS / 1000}s wall-clock cap — model is verbose but unproductive.`,
      // Heavy reasoners (glm-5.x) legitimately stream reasoning for >60s before
      // the first text token on large-transcript rounds — without this opt-in
      // the activity timer (which only resets on `text_delta`) kills an
      // actively-thinking round, surfaced as "model may be unresponsive" even
      // though it's making progress. Thinking IS progress here; the wall-clock
      // cap above bounds a model that reasons forever. Mirrors deep-reviewer
      // (PR #907).
      { reasoningResetsActivityTimer: true, firstTokenGraceMs: CODER_FIRST_TOKEN_GRACE_MS },
    );

    if (streamError) {
      if (callbacks.signal?.aborted) {
        finishRound('aborted');
        throw new DOMException('Coder cancelled by user.', 'AbortError');
      }
      finishRound('error');
      throw streamError;
    }

    // Account this round's usage UNCONDITIONALLY. The ledger feeds two
    // consumers now: the per-run budget circuit-breaker (only when a budget is
    // set) AND the always-on `coder_run_cost` receipt (every run). Gating the
    // record on `tokenBudget !== null` — as it used to — left the receipt
    // reporting `usedTokens: 0` in exactly the uncapped default case it exists
    // to expose (Codex P2 on this PR). Prefer the provider's reported usage;
    // estimate from the transcript only when usage is absent, so the common
    // reported-usage path still pays no estimate cost regardless of budget.
    const reportedTotal =
      (roundUsage?.totalTokens ?? 0) +
      (roundUsage?.inputTokens ?? 0) +
      (roundUsage?.outputTokens ?? 0);
    const estimatedTokens =
      reportedTotal > 0 ? 0 : estimateRoundTokens(messages, rawModelText, reasoningText);
    tokenLedger.record({ usage: roundUsage, estimatedTokens });

    // --- Answer stranded in the reasoning channel ---
    // Distinct from the buried *tool-call* recovery below (which re-prompts a
    // model that placed a tool call in reasoning and never executes it): here
    // the model emitted a complete *answer* into `reasoning_content`, left the
    // response content empty, and finished with no tool call anywhere. The
    // natural-completion return below is `summary: accumulated + ...`, and the
    // web materializer drops empty assistant turns, so that answer silently
    // vanishes — observed on Kimi-k2.7 (Workers AI) conversational wrap-up
    // turns, where a heavy reasoner occasionally never transitions out of the
    // reasoning channel. Promote the reasoning into the response so the turn is
    // delivered. `null` (the common case: content present, or a tool call in
    // reasoning) is a no-op.
    let accumulated = rawModelText;
    // `detectAnyToolCall` deliberately excludes the Coder-internal calls
    // (`update_state` / `checkpoint`) — the kernel detects those separately
    // downstream (`detectUpdateStateCall` / `detectCheckpointCall`) and EXECUTES
    // them, mutating working memory or pausing the run. If the guard ignored
    // them, a reasoning-only internal call would be promoted into `accumulated`
    // and then run from the untrusted reasoning channel — exactly what this
    // salvage must not do. Fold the internal detectors into the guard so an
    // internal call in reasoning blocks promotion. Such a call is then
    // suppressed (not promoted, hence never executed) rather than nudged — the
    // buried-call recovery below also keys on `detectAnyToolCall`, so it omits
    // these internal tools; suppression (the call simply doesn't run) is the
    // property we need. An ordinary reasoning-channel tool call still routes to
    // that recovery's re-emit nudge as before. (Codex P2 on #962.)
    const reasoningHasToolCall = Boolean(
      detectAnyToolCall(reasoningText) ||
        detectUpdateStateCall(reasoningText) ||
        detectCheckpointCall(reasoningText) ||
        nativeToolCalls.length > 0,
    );
    const promotedReasoningAnswer = promoteReasoningAnswer(
      rawModelText,
      reasoningText,
      reasoningHasToolCall,
    );
    if (promotedReasoningAnswer !== null) {
      accumulated = promotedReasoningAnswer;
      // Symmetric structured log: the drop is otherwise invisible to ops — the
      // turn ends 200 / finish=stop and nothing distinguishes it from a healthy
      // completion until you read the response body. Greppable counterpart to a
      // normal completion (which never emits this event).
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'coder_reasoning_answer_promoted',
          round,
          model: coderModelId ?? '',
          reasoningChars: accumulated.length,
        }),
      );
      callbacks.onStatus(
        'Recovered answer',
        'Model placed its reply in the reasoning channel — promoted to the response.',
      );
    }

    // Add Coder response to messages, carrying the round's reasoning onto the
    // tool-call turn (`markLatestAssistantToolUse` spreads this message) so the
    // tool-result continuation replays it — DeepSeek thinking mode 400s otherwise
    // ("the ... in the thinking mode must be passed back to the API").
    //   - `reasoningBlocks`: signed `thinking` blocks from the Anthropic transport
    //     (DeepSeek on api.deepseek.com/anthropic) — serialized to `content[].thinking`
    //     when the route carries reasoning blocks (`emitReasoningBlocks`).
    //   - `reasoningContent`: plain unsigned reasoning from OpenAI-compat thinking
    //     routes (e.g. DeepSeek via Zen Go/OpenRouter) — serialized to
    //     `reasoning_content`.
    // Both are carried; `toLLMMessages` emits whichever the locked route requires.
    // The orchestrator lane carries this via `markLastAssistantToolCall`; the kernel
    // lane (web-inline default + CLI) had no equivalent until now. Guarded so a
    // no-reasoning round emits no empty field.
    messages.push({
      id: `coder-response-${round}`,
      role: 'assistant',
      content: accumulated,
      ...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
      ...(reasoningText.trim().length > 0 ? { reasoningContent: reasoningText } : {}),
      timestamp: Date.now(),
    });

    // Reasoning Sync: surface a snippet of the Coder's reasoning in the status bar
    const reasoningLines = accumulated.split('\n').filter((l) => {
      const trimmed = l.trim();
      return (
        trimmed &&
        !trimmed.startsWith('{') &&
        !trimmed.startsWith('```') &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('#')
      );
    });
    const reasoningSnippet = reasoningLines.slice(0, 2).join(' ').slice(0, 150).trim();
    if (reasoningSnippet) {
      callbacks.onStatus('Coder reasoning', reasoningSnippet);
    }

    const buriedReasoningCall =
      reasoningToolCallNudges < MAX_REASONING_TOOL_CALL_NUDGES &&
      reasoningText.trim().length > 0 &&
      nativeToolCalls.length === 0 &&
      !detectAnyToolCall(accumulated)
        ? detectAnyToolCall(reasoningText)
        : null;
    if (buriedReasoningCall) {
      // A reasoning-only response (`accumulated === ''`, the tool call lived in
      // the reasoning channel) just pushed an EMPTY assistant turn above. The
      // web materializer drops empty assistant turns, but the CLI/daemon path
      // forwards `content` verbatim and empty assistant content is rejected by
      // some providers (e.g. Anthropic) — which would break the very recovery
      // round this nudge sets up. Replace the empty turn with a factual marker
      // so it stays non-empty and role alternation holds across surfaces
      // (popping it instead would leave two consecutive user turns).
      if (
        accumulated.trim() === '' &&
        messages[messages.length - 1]?.id === `coder-response-${round}`
      ) {
        messages[messages.length - 1] = {
          ...messages[messages.length - 1],
          content: '[No response content — the tool call was emitted in the reasoning channel.]',
        };
      }
      const buriedToolName = (buriedReasoningCall as unknown as { call?: { tool?: string } }).call
        ?.tool;
      callbacks.onRunEvent?.({
        type: 'tool.call_malformed',
        round,
        reason: 'tool_call_in_reasoning',
        ...(buriedToolName ? { toolName: buriedToolName } : {}),
        preview: summarizeToolResultPreview(
          'A tool call was emitted in the reasoning channel, which the runtime never executes. The model was nudged to re-emit it in response content.',
        ),
      });
      messages.push({
        id: `coder-reasoning-tool-nudge-${round}`,
        role: 'user',
        content: [
          '[POLICY: TOOL_CALL_IN_REASONING]',
          'You emitted a tool call inside your reasoning/thinking channel. The runtime only executes tool calls placed in your response content, so nothing ran and no results came back — any answer you give now is ungrounded.',
          'Re-emit the tool call as a JSON block in your response content now. If you did not actually intend to call a tool, answer directly from information you already have.',
          '[/POLICY]',
        ].join('\n'),
        timestamp: Date.now(),
      });
      reasoningToolCallNudges += 1;
      finishRound('continued');
      continue;
    }

    // --- Turn policy: evaluate on every response ---
    const policyResult = await evaluateAfterModel(accumulated, round);
    if (policyResult) {
      if (policyResult.action === 'halt') {
        // Explicit early receipt: an after-model policy halt is a defensive stop,
        // not a clean natural completion, and it runs host callbacks before
        // `finishRound`. Emit first (idempotent) so the reason is labeled
        // `policy_halt` and a throwing callback can't swallow the receipt.
        emitRunCostReceipt('policy_halt', round);
        callbacks.onStatus('Coder stopped', 'Cognitive drift — halted');
        const sandboxState = (await callbacks.fetchSandboxStateSummary?.()) ?? '';
        finishRound('completed');
        return {
          summary: policyResult.summary + sandboxState,
          cards: allCards,
          rounds,
          checkpoints: checkpointCount,
        };
      }
      if (policyResult.action === 'inject') {
        const content = policyResult.content;
        const statusLabel = /DRIFT_DETECTED/.test(content)
          ? 'Drift detected'
          : /INCOMPLETE_COMPLETION/.test(content)
            ? 'Needs more detail'
            : 'Policy intervention';
        callbacks.onStatus(statusLabel, content.replace(/\[POLICY:.*?\]\n?/g, '').slice(0, 80));
        messages.push({
          id: `coder-policy-inject-${round}`,
          role: 'user',
          content,
          timestamp: Date.now(),
        });
        forceToolChoiceNextRound = policyResult.forceToolChoiceNextRound === true;
        finishRound('continued');
        continue;
      }
    }

    // Check for multiple tool calls (parallel reads + file-mutation batch + optional trailing side-effect)
    const detected =
      nativeToolCalls.length > 0 && detectNativeToolCalls
        ? detectNativeToolCalls(nativeToolCalls)
        : detectAllToolCalls(accumulated);

    // --- Dropped-candidate guard: the model emitted one or more
    // `{tool, args}` shapes that no source validated (wrong args,
    // unrecognized tool name). Surface them as a parse error and skip
    // execution of any surviving calls this round — running them would
    // give the model misleading feedback ("the diff is clean, so my
    // edit must have worked") when in fact its primary call was
    // dropped. Symmetric with the chat-send.ts orchestrator path.
    if (detected.droppedCandidates.length > 0) {
      const dropped = detected.droppedCandidates;
      const primary = dropped[0];
      const summary = dropped
        .map((d) =>
          d.resolvedToolName
            ? `${d.rawToolName} (${d.resolvedToolName})`
            : `${d.rawToolName} (unknown)`,
        )
        .join(', ');
      callbacks.onStatus('Coder parse error', summary);
      for (const event of buildMalformedToolCallEvents(
        dropped.map((candidate) => ({
          reason: 'validation_failed',
          sample: candidate.sample,
          rawToolName: candidate.rawToolName,
        })),
        round,
      )) {
        callbacks.onRunEvent?.(event);
      }
      const parseErrorBlock = buildToolCallParseErrorBlock({
        errorType: 'validation_failed',
        detectedTool: primary?.resolvedToolName || primary?.rawToolName || null,
        problem: `Tool call${dropped.length === 1 ? '' : 's'} failed validation and ${dropped.length === 1 ? 'was' : 'were'} not executed: ${summary}. No other calls ran this turn so the next round can correct without partial state.`,
        hint: buildValidationFailedHint(primary?.resolvedToolName || primary?.rawToolName || null),
      });
      messages.push({
        id: `coder-parse-error-${round}`,
        role: 'user',
        content: formatToolResultEnvelope(parseErrorBlock),
        timestamp: Date.now(),
        isToolResult: true,
      });
      finishRound('continued');
      continue;
    }

    // --- Loop detection: near-duplicate (similarity) ladder from the shared
    // oracle. The write calls are read via the same `call.call.{tool,args}`
    // structural cast the mutation path uses below; non-write calls have no
    // `writeTargetOf` and never feed the window (so re-reads can't trip it).
    // `abort` ends the run (only reachable post-compact, under enforcement);
    // warn/block/compact inject a steering note and skip this round's tool
    // batch so the model retries differently. With PUSH_LOOP_DETECTION unset
    // every verdict is `none` — purely dark.
    const loopCalls = [
      ...detected.readOnly,
      ...detected.fileMutations,
      ...(detected.mutating ? [detected.mutating] : []),
    ].map((c) => (c as unknown as { call: { tool: string; args: Record<string, unknown> } }).call);
    if (loopCalls.length > 0) {
      let worstSimilarity: { value: number; streak: number } | undefined;
      for (const call of loopCalls) {
        const target = writeTargetOf(call.args);
        if (!target) continue;
        const obs = loopDetector.observeWrite(target.path, target.content);
        if (!worstSimilarity || obs.streak > worstSimilarity.streak) {
          worstSimilarity = { value: obs.similarity, streak: obs.streak };
        }
      }

      // Lead-only exact-repeat breaker: feed the oracle's always-enforced
      // `exactBreakers` input from the consecutive-identical-call tracker.
      // Check the first call against the prior-round streak BEFORE recording
      // this round's calls, so the limit counts rounds (matching the web
      // orchestrator's signal collection). A multi-call round resets the
      // streak, so only a single identical call repeated across rounds trips.
      const exactBreakers: string[] = [];
      if (leadMode) {
        for (let i = 0; i < loopCalls.length; i++) {
          const call = loopCalls[i];
          const key = getToolInvocationKey(call.tool, call.args);
          // Record every call (so a different intervening call resets the
          // streak) but only break on the FIRST — same per-surface rule the
          // web orchestrator applies, since a repeated lone call is the loop
          // we're catching; a multi-call round is already varied work. Tools
          // that wait by re-calling with identical args (e.g. `exec_poll` on a
          // quiet long-running command) are exempt — repeating them is correct,
          // not a loop.
          if (
            i === 0 &&
            !repeatExemptTools?.has(call.tool) &&
            leadCallTracker.isRepeatedCall(key, EXACT_REPEAT_LIMIT)
          ) {
            exactBreakers.push(
              `consecutive identical call: ${call.tool} (${EXACT_REPEAT_LIMIT}+ rounds in a row)`,
            );
          }
          leadCallTracker.recordCall(key);
        }
      }

      const loopVerdict = evaluateLoopState({
        exactBreakers,
        similarity: worstSimilarity,
        blocksIssued: loopBlocksIssued,
        compactsIssued: loopCompactsIssued,
        // Lead turns enforce the near-duplicate ladder unconditionally; the
        // delegated Coder stays dark unless PUSH_LOOP_DETECTION=1. See the
        // enforcement-split note on the loop-detection state above.
        similarityEnforced: leadMode || isSimilarityLoopDetectionEnabled(),
      });
      recordLoopVerdict({
        surface: 'coder',
        round,
        level: loopVerdict.level,
        action: loopVerdict.action,
        enforced: loopVerdict.enforced,
        reasons: loopVerdict.reasons,
        similarity: loopVerdict.similarity,
      });
      if (loopVerdict.level !== 'none') {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'coder_loop_verdict',
            round,
            verdict: loopVerdict.level,
            action: loopVerdict.action,
            reasons: loopVerdict.reasons,
          }),
        );
      }

      if (loopVerdict.action === 'abort') {
        // Explicit early receipt: a loop halt is a defensive circuit-breaker
        // (returns `stopReason: 'loop'`), not a clean completion, and it runs
        // host callbacks before `finishRound`. Emit first (idempotent) so the
        // reason is labeled `loop` and a throwing callback can't swallow it.
        emitRunCostReceipt('loop', round);
        callbacks.onStatus('Coder stopped', 'Repeated tool-call loop — halted');
        const loopText = `Detected repeated tool call loop (${loopCalls
          .map((c) => c.tool)
          .join(', ')}). Stopping run.`;
        messages.push({
          id: `coder-loop-abort-${round}`,
          role: 'user',
          content: formatToolResultEnvelope(loopText),
          timestamp: Date.now(),
          isToolResult: true,
        });
        const sandboxState = (await callbacks.fetchSandboxStateSummary?.()) ?? '';
        finishRound('completed');
        return {
          summary: loopText + sandboxState,
          cards: allCards,
          rounds,
          checkpoints: checkpointCount,
          stopReason: 'loop',
        };
      }

      if (loopVerdict.action !== 'none') {
        const steeringText = buildLoopSteeringText(loopVerdict);
        if (steeringText) {
          callbacks.onStatus('Coder loop', loopVerdict.action);
          messages.push({
            id: `coder-loop-${loopVerdict.action}-${round}`,
            role: 'user',
            content: formatToolResultEnvelope(steeringText),
            timestamp: Date.now(),
            isToolResult: true,
          });
          if (loopVerdict.action === 'block') {
            loopBlocksIssued += 1;
          }
          if (loopVerdict.action === 'compact') {
            loopCompactsIssued += 1;
            loopDetector.clear();
          }
          finishRound('continued');
          continue;
        }
      }
    }

    // Parallel-safe delegations (concurrent Explorers, Inline Foreground Lane
    // only) ride the same `Promise.all` batch as read-only calls — they don't
    // mutate the workspace. Empty on every surface that doesn't opt into the
    // parallel-delegation bucket, so this is a no-op there.
    const parallelCalls = [...detected.readOnly, ...(detected.parallelDelegations ?? [])];
    const fileMutationBatch = detected.fileMutations;
    const trailingMutation = detected.mutating;
    // Mutation work to run sequentially after parallel reads: the
    // contiguous file-mutation batch followed by the optional trailing
    // side-effect. Failures in the batch short-circuit further work.
    const mutationQueue: TCall[] = [
      ...fileMutationBatch,
      ...(trailingMutation ? [trailingMutation] : []),
    ];
    const batchTotal = parallelCalls.length + mutationQueue.length;

    // The prose prefix belongs to the user's transcript, not the model's
    // history. Emit it once, immediately before this round's tool group, so
    // every shell can preserve prose -> tools ordering without re-parsing the
    // provider stream or injecting a synthetic LlmMessage.
    let toolProseEmitted = false;
    const emitToolProse = (): void => {
      if (toolProseEmitted) return;
      toolProseEmitted = true;
      const toolProse = extractToolProse(accumulated);
      if (toolProse) {
        callbacks.onRunEvent?.({ type: 'assistant.tool_prose', round, text: toolProse });
      }
    };

    if (batchTotal >= 2) {
      if (callbacks.signal?.aborted) {
        finishRound('aborted');
        throw new DOMException('Coder cancelled by user.', 'AbortError');
      }
      emitToolProse();
      const { toolUses, toolUseIdByCall } = createToolUseSidecars([
        ...parallelCalls,
        ...mutationQueue,
      ]);
      let toolUsesAttached = false;
      const attachToolUsesBeforeResult = (): void => {
        if (toolUsesAttached) return;
        markLatestAssistantToolUse(messages, round, toolUses);
        toolUsesAttached = true;
      };

      const mutationLabel =
        mutationQueue.length > 0
          ? ` + ${mutationQueue.length} mutation${mutationQueue.length === 1 ? '' : 's'}`
          : '';
      const statusLabel = `${parallelCalls.length} parallel reads${mutationLabel}`;
      callbacks.onStatus('Coder executing...', statusLabel);

      // Execute read-only calls in parallel
      const parallelResults = await Promise.all(
        parallelCalls.map(async (call) => {
          const pExecId = createId();
          const pElapsed = startElapsedMs();
          const pToolName = (call as unknown as { call: { tool: string } }).call.tool;
          const entry = await toolExec(call, {
            round,
            phase: workingMemory.currentPhase,
            executionId: pExecId,
          });
          callbacks.onRunEvent?.({
            type: 'tool.execution_complete',
            round,
            executionId: pExecId,
            toolName: pToolName,
            toolSource: 'coder',
            durationMs: pElapsed(),
            isError: entry.kind === 'executed' ? Boolean(entry.errorType) : false,
            preview: entry.kind === 'executed' ? summarizeToolResultPreview(entry.resultText) : '',
            target: getToolTargetDetail(
              pToolName,
              (call as unknown as { call: { args?: unknown } }).call.args,
            ),
            ...(entry.kind === 'executed' && entry.editDiff ? { diff: entry.editDiff } : {}),
            ...(entry.kind === 'executed' && entry.card ? { card: entry.card } : {}),
          });
          return { call, entry };
        }),
      );

      // Inject read results
      const awarenessBlock = getAwarenessBlock();

      for (const { call, entry } of parallelResults) {
        if (entry.kind === 'denied') {
          const content = `[TOOL_DENIED] ${entry.reason} [/TOOL_DENIED]`;
          attachToolUsesBeforeResult();
          messages.push({
            id: `coder-parallel-denied-${round}-${messages.length}`,
            role: 'user',
            content,
            timestamp: Date.now(),
            isToolResult: true,
            ...toolResultSidecar(toolUseIdByCall, call, content, true),
          });
          continue;
        }
        if (entry.card) allCards.push(entry.card);
        const truncatedResult = truncateContent(
          entry.resultText,
          MAX_TOOL_RESULT_SIZE,
          'tool result',
        );
        const wrappedResult = formatToolResultEnvelope(truncatedResult, awarenessBlock);
        attachToolUsesBeforeResult();
        messages.push({
          id: `coder-parallel-result-${round}-${messages.length}`,
          role: 'user',
          content: wrappedResult,
          timestamp: Date.now(),
          isToolResult: true,
          ...toolResultSidecar(
            toolUseIdByCall,
            call,
            composeToolResultBody(truncatedResult, awarenessBlock),
            Boolean(entry.errorType),
          ),
        });
      }

      // Execute the mutation queue sequentially after reads complete.
      // The queue is: [file mutations batch..., optional trailing side-effect].
      // A hard-failure in any step breaks out of the queue so the model
      // sees a consistent snapshot and gets the next round to correct.
      let batchHardFailed = false;
      for (let mqIdx = 0; mqIdx < mutationQueue.length; mqIdx++) {
        if (callbacks.signal?.aborted) {
          finishRound('aborted');
          throw new DOMException('Coder cancelled by user.', 'AbortError');
        }
        const mutationCall = mutationQueue[mqIdx];
        const isLastInQueue = mqIdx === mutationQueue.length - 1;

        const mqExecId = createId();
        const mqElapsed = startElapsedMs();
        const mqToolName = (mutationCall as unknown as { call: { tool: string } }).call.tool;
        const mutResult = await toolExec(mutationCall, {
          round,
          phase: workingMemory.currentPhase,
          executionId: mqExecId,
        });
        callbacks.onRunEvent?.({
          type: 'tool.execution_complete',
          round,
          executionId: mqExecId,
          toolName: mqToolName,
          toolSource: 'coder',
          durationMs: mqElapsed(),
          isError: mutResult.kind === 'executed' ? Boolean(mutResult.errorType) : false,
          preview:
            mutResult.kind === 'executed' ? summarizeToolResultPreview(mutResult.resultText) : '',
          target: getToolTargetDetail(
            mqToolName,
            (mutationCall as unknown as { call: { args?: unknown } }).call.args,
          ),
          ...(mutResult.kind === 'executed' && mutResult.editDiff
            ? { diff: mutResult.editDiff }
            : {}),
          ...(mutResult.kind === 'executed' && mutResult.card ? { card: mutResult.card } : {}),
        });
        if (mutResult.kind === 'denied') {
          const content = `[TOOL_DENIED] ${mutResult.reason} [/TOOL_DENIED]`;
          attachToolUsesBeforeResult();
          messages.push({
            id: `coder-mut-denied-${round}-${mqIdx}`,
            role: 'user',
            content,
            timestamp: Date.now(),
            isToolResult: true,
            ...toolResultSidecar(toolUseIdByCall, mutationCall, content, true),
          });
          // A denied call stops further mutation work — the model should
          // reconcile the denial before we keep writing.
          batchHardFailed = true;
          break;
        }
        if (mutResult.card) allCards.push(mutResult.card);

        // --- Extract the mutated path + args from the opaque TCall ---
        // The kernel reads `call.call.{tool,args}` via a structural cast; all
        // real Web `AnyToolCall` entries carry exactly this shape.
        const mutCall = (
          mutationCall as unknown as {
            call: { tool: string; args: Record<string, unknown> };
          }
        ).call;
        const mutArgs = mutCall.args;
        const mutFilePath =
          (typeof mutArgs?.path === 'string' ? mutArgs.path : '') ||
          (typeof mutArgs?.file === 'string' ? mutArgs.file : '');
        const mutFilePaths = extractMutatedPaths(mutCall.tool, mutArgs, mutFilePath);
        if (!mutResult.errorType && mutFilePaths.length > 0) {
          const nextObservations = invalidateObservationDependencies(
            workingMemory.observations,
            mutFilePaths,
            round,
          );
          if (nextObservations !== workingMemory.observations) {
            workingMemory.observations = nextObservations;
            callbacks.onWorkingMemoryUpdate?.(workingMemory);
          }
        }

        // Always inject TOOL_RESULT first so the model sees what happened
        const truncatedMut = truncateContent(
          mutResult.resultText,
          MAX_TOOL_RESULT_SIZE,
          'tool result',
        );
        const coderContextChars = estimateMessagesSize(messages);
        const coderCtxKb = Math.round(coderContextChars / 1024);
        const coderMetaLine = `[meta] round=${round} ctx=${coderCtxKb}kb/${Math.round(MAX_TOTAL_CONTEXT_SIZE / 1024)}kb`;
        // Only inject the state diff once per turn (on the final mutation)
        // to avoid flooding the context with duplicate snapshots.
        const shouldInjectState =
          isLastInQueue &&
          shouldInjectCoderStateOnToolResult(
            workingMemory,
            lastInjectedState,
            round,
            coderContextChars,
            lastInjectedStateRound,
          );
        const stateBlock = shouldInjectState
          ? `\n${formatCoderStateDiff(workingMemory, lastInjectedState, round)}`
          : '';
        const awarenessBlock2 = getAwarenessBlock();
        if (shouldInjectState) {
          lastInjectedState = structuredClone(workingMemory);
          lastInjectedStateRound = round;
        }
        const wrappedMut = formatToolResultEnvelope(
          truncatedMut,
          `${coderMetaLine}${stateBlock}${awarenessBlock2}`,
        );
        attachToolUsesBeforeResult();
        messages.push({
          id: `coder-mutation-result-${round}-${mqIdx}`,
          role: 'user',
          content: wrappedMut,
          timestamp: Date.now(),
          isToolResult: true,
          ...toolResultSidecar(
            toolUseIdByCall,
            mutationCall,
            composeToolResultBody(truncatedMut, `${coderMetaLine}${stateBlock}${awarenessBlock2}`),
            Boolean(mutResult.errorType),
          ),
        });

        // Track mutation failures in parallel path
        if (mutResult.errorType) {
          const entry = recordMutationFailure(
            mutationFailures,
            mutCall.tool,
            mutFilePath,
            mutResult.errorType,
          );

          // Hard Failure Threshold (parallel path)
          if (entry.count >= MAX_CONSECUTIVE_MUTATION_FAILURES) {
            callbacks.onStatus(
              'Coder stopped',
              `${entry.tool} failed ${entry.count}x on ${entry.file || 'unknown'}`,
            );
            messages.push({
              id: `coder-hard-failure-${round}`,
              role: 'user',
              content: formatMutationHardFailure(entry),
              timestamp: Date.now(),
            });
            batchHardFailed = true;
            break; // one final round to summarize
          }

          // Any error stops the batch early so the model can correct
          // before we attempt the trailing side-effect or more writes.
          batchHardFailed = true;
        } else if (mutFilePath) {
          clearMutationFailure(mutationFailures, mutCall.tool, mutFilePath);
        }

        // --- Policy bridge: afterToolExec — flattened via policyPost ---
        if (mutResult.policyPost) {
          if (mutResult.policyPost.kind === 'inject') {
            messages.push({
              id: `coder-policy-post-${round}-${mqIdx}`,
              role: 'user',
              content: mutResult.policyPost.content,
              timestamp: Date.now(),
            });
          } else if (mutResult.policyPost.kind === 'halt') {
            callbacks.onStatus('Coder stopped', 'Policy halt — afterToolExec');
            messages.push({
              id: `coder-policy-halt-${round}`,
              role: 'user',
              content: mutResult.policyPost.summary,
              timestamp: Date.now(),
            });
            // Fall through to continue — model gets one final round to summarize
          }
        }

        if (batchHardFailed) break;
      }

      // Per-turn overflow feedback: calls the grouper rejected (a parallel
      // Explorer delegation past the cap, a second side-effect, or a read after
      // a mutation began) land in `extraMutations`, which the executable batch
      // above never runs. Surface them so the model knows part of its plan
      // didn't execute and can re-issue next turn — otherwise a lead that
      // fanned out three Explorers would get two results with no signal the
      // third was dropped (silent path; CLAUDE.md "silent return paths"). Purely
      // additive: the accepted batch already ran, this only appends the notice.
      if (detected.extraMutations.length > 0) {
        const droppedTools = detected.extraMutations
          .map((c) => (c as unknown as { call: { tool: string } }).call.tool)
          .join(', ');
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'coder_turn_overflow_dropped',
            round,
            count: detected.extraMutations.length,
            tools: droppedTools,
          }),
        );
        messages.push({
          id: `coder-overflow-${round}`,
          role: 'user',
          content: formatToolResultEnvelope(
            `[TOOL_CALLS_NOT_RUN] ${detected.extraMutations.length} tool call(s) exceeded this turn's limits and were NOT executed: ${droppedTools}. A turn runs parallel reads, up to two parallel Explorer delegations, one file-mutation batch, and at most one trailing side-effect; the calls above were over those limits. Re-issue the ones you still need next turn.[/TOOL_CALLS_NOT_RUN]`,
          ),
          timestamp: Date.now(),
          isToolResult: true,
        });
      }

      finishRound('continued');
      continue;
    }

    // Check for coder_update_state (working memory update) — process before tool detection
    const stateUpdate = detectUpdateStateCall(accumulated);
    if (stateUpdate) {
      if (stateUpdate.plan !== undefined) workingMemory.plan = stateUpdate.plan;
      if (stateUpdate.openTasks) workingMemory.openTasks = stateUpdate.openTasks;
      if (stateUpdate.filesTouched)
        workingMemory.filesTouched = [
          ...new Set([...(workingMemory.filesTouched || []), ...stateUpdate.filesTouched]),
        ];
      if (stateUpdate.assumptions) workingMemory.assumptions = stateUpdate.assumptions;
      if (stateUpdate.errorsEncountered)
        workingMemory.errorsEncountered = [
          ...new Set([
            ...(workingMemory.errorsEncountered || []),
            ...stateUpdate.errorsEncountered,
          ]),
        ];
      if (stateUpdate.currentPhase !== undefined) {
        workingMemory.currentPhase = stateUpdate.currentPhase;
      }
      if (stateUpdate.completedPhases) workingMemory.completedPhases = stateUpdate.completedPhases;
      if (stateUpdate.observations) {
        workingMemory.observations = applyObservationUpdates(
          workingMemory.observations,
          stateUpdate.observations,
          round,
        );
      }

      // Notify caller of latest working memory state (for checkpoint capture)
      callbacks.onWorkingMemoryUpdate?.(workingMemory);

      // --- Context Reset on Phase Transition ---
      if (
        contextResetsEnabled &&
        stateUpdate.currentPhase &&
        stateUpdate.currentPhase !== lastPhaseForReset &&
        lastPhaseForReset !== undefined // skip the very first phase assignment
      ) {
        const previousPhase = lastPhaseForReset;
        lastPhaseForReset = stateUpdate.currentPhase;
        callbacks.onStatus('Context reset', `Phase: ${stateUpdate.currentPhase}`);

        // Build a fresh task message with working memory as handoff context
        const resetPreamble = [
          taskPreamble,
          '',
          '[CONTEXT RESET — Phase transition]',
          `Previous phase "${previousPhase}" completed.`,
          `Now starting phase: ${stateUpdate.currentPhase}`,
          '',
          formatCoderState(workingMemory, round),
          '',
          'Continue working on the task from this phase. Your working memory above contains all accumulated context.',
          '[/CONTEXT RESET]',
        ].join('\n');

        // Reset messages to just the new preamble — but do NOT continue here.
        messages.length = 0;
        messages.push({
          id: `coder-reset-task-${round}`,
          role: 'user',
          content: resetPreamble,
          timestamp: Date.now(),
        });
        lastInjectedState = structuredClone(workingMemory);
        lastInjectedStateRound = round;
      }
      // Track current phase for reset detection
      if (stateUpdate.currentPhase) {
        lastPhaseForReset = stateUpdate.currentPhase;
      }

      // If only a state update was emitted (no sandbox tool AND no checkpoint), inject ack and continue
      const otherToolCall =
        nativeToolCalls.length > 0 && detectNativeToolCalls
          ? detected.readOnly[0] ||
            detected.fileMutations[0] ||
            detected.mutating ||
            detected.extraMutations[0] ||
            null
          : detectAnyToolCall(accumulated);
      if (!otherToolCall) {
        const checkpointInSameTurn = detectCheckpointCall(accumulated);
        if (!checkpointInSameTurn) {
          lastInjectedState = structuredClone(workingMemory);
          lastInjectedStateRound = round;
          messages.push({
            id: `coder-state-ack-${round}`,
            role: 'user',
            content: formatToolResultEnvelope(
              `State updated.\n${formatCoderState(workingMemory, round)}`,
            ),
            timestamp: Date.now(),
            isToolResult: true,
          });
          finishRound('continued');
          continue;
        }
      }
    }

    // Check for single tool call (sandbox or web search)
    const singleDetectedCalls = [
      ...detected.readOnly,
      ...(detected.parallelDelegations ?? []),
      ...detected.fileMutations,
      ...(detected.mutating ? [detected.mutating] : []),
    ];
    const toolCall =
      nativeToolCalls.length > 0 && detectNativeToolCalls
        ? singleDetectedCalls.length === 1
          ? singleDetectedCalls[0]
          : null
        : detectAnyToolCall(accumulated);

    if (!toolCall) {
      // Check for interactive checkpoint (Coder asking Orchestrator for guidance)
      const checkpoint = detectCheckpointCall(accumulated);
      if (checkpoint) {
        if (callbacks.signal?.aborted) {
          finishRound('aborted');
          throw new DOMException('Coder cancelled by user.', 'AbortError');
        }

        // Durable suspension (background AgentJob DO): park the run instead of
        // holding an in-memory await no DO eviction could survive. Close the
        // round's event bracket, then throw a typed signal the host catches to
        // snapshot + persist + flip the job to `suspended`. State is advanced to
        // `round + 1` so a resume that appends the human's answer re-enters at
        // the next round — the same position the synchronous path reaches via
        // `continue` below. Takes precedence over `onCheckpointRequest`: the two
        // are mutually exclusive counterparties (durable human vs. in-tab
        // Orchestrator) and the DO never wires the synchronous callback.
        if (options.durableSuspension) {
          finishRound('continued');
          throw new CoderSuspendedError(
            {
              question: checkpoint.args.question,
              context: checkpoint.args.context || '',
              resumeSchema: DEFAULT_CODER_RESUME_SCHEMA,
            },
            { round: round + 1, messages, workingMemory, cards: allCards },
          );
        }

        if (callbacks.onCheckpointRequest && checkpointCount < MAX_CHECKPOINTS) {
          checkpointCount++;
          callbacks.onStatus('Coder checkpoint', checkpoint.args.question);

          try {
            const answer = await callbacks.onCheckpointRequest(
              checkpoint.args.question,
              checkpoint.args.context || '',
            );

            // Inject checkpoint answer into Coder's message history
            const wrappedAnswer = `[CHECKPOINT RESPONSE — guidance from the Orchestrator]\n${answer}\n[/CHECKPOINT RESPONSE]`;
            messages.push({
              id: `coder-checkpoint-answer-${round}`,
              role: 'user',
              content: wrappedAnswer,
              timestamp: Date.now(),
            });

            callbacks.onStatus('Coder resuming...', `After checkpoint ${checkpointCount}`);
            finishRound('continued');
            continue;
          } catch (cpErr) {
            // Propagate AbortError to allow proper task cancellation
            const isAbort = cpErr instanceof DOMException && cpErr.name === 'AbortError';
            if (isAbort || callbacks.signal?.aborted) {
              finishRound('aborted');
              throw new DOMException('Coder cancelled by user.', 'AbortError');
            }
            // For non-abort errors, inject a generic fallback so the Coder can continue
            const errMsg = cpErr instanceof Error ? cpErr.message : 'unknown error';
            messages.push({
              id: `coder-checkpoint-fallback-${round}`,
              role: 'user',
              content: `[CHECKPOINT RESPONSE]\nCould not get guidance from the Orchestrator (${errMsg}). Try a different approach or simplify your current step.\n[/CHECKPOINT RESPONSE]`,
              timestamp: Date.now(),
            });
            finishRound('continued');
            continue;
          }
        } else if (checkpointCount >= MAX_CHECKPOINTS) {
          messages.push({
            id: `coder-checkpoint-limit-${round}`,
            role: 'user',
            content: `[CHECKPOINT RESPONSE]\nCheckpoint limit reached (${MAX_CHECKPOINTS} max). Complete the task with what you have, or summarize what's blocking you.\n[/CHECKPOINT RESPONSE]`,
            timestamp: Date.now(),
          });
          finishRound('continued');
          continue;
        }
        // If no onCheckpointRequest callback, fall through to treat as "done" (backward compatible)
      }

      // No tool call — Coder is done, accumulated is the summary
      // Run acceptance criteria if provided
      let criteriaResults:
        | Array<{ id: string; passed: boolean; exitCode: number; output: string }>
        | undefined;
      if (acceptanceCriteria && acceptanceCriteria.length > 0 && callbacks.runAcceptanceCriterion) {
        callbacks.onStatus('Running acceptance checks...');
        criteriaResults = [];
        for (const criterion of acceptanceCriteria) {
          if (callbacks.signal?.aborted) break;
          callbacks.onStatus('Checking...', criterion.description || criterion.id);
          try {
            const checkResult = await callbacks.runAcceptanceCriterion(criterion);
            const expectedExit = criterion.exitCode ?? 0;
            const passed = checkResult.exitCode === expectedExit;
            criteriaResults.push({
              id: criterion.id,
              passed,
              exitCode: checkResult.exitCode,
              output: truncateContent(checkResult.output.trim(), 2000, 'check output'),
            });
          } catch (checkErr) {
            criteriaResults.push({
              id: criterion.id,
              passed: false,
              exitCode: -1,
              output: checkErr instanceof Error ? checkErr.message : String(checkErr),
            });
          }
        }
      }

      // Append criteria results to summary
      let criteriaBlock = '';
      if (criteriaResults && criteriaResults.length > 0) {
        const passed = criteriaResults.filter((r) => r.passed).length;
        const total = criteriaResults.length;
        criteriaBlock = `\n\n[Acceptance Criteria] ${passed}/${total} passed`;
        for (const r of criteriaResults) {
          criteriaBlock += `\n  ${r.passed ? '✓' : '✗'} ${r.id} (exit=${r.exitCode})${r.passed ? '' : `: ${r.output.slice(0, 200)}`}`;
        }
      }

      finishRound('completed');
      return {
        summary: accumulated + criteriaBlock,
        cards: allCards,
        rounds,
        checkpoints: checkpointCount,
        criteriaResults,
      };
    }

    // Execute single tool call
    if (callbacks.signal?.aborted) {
      finishRound('aborted');
      throw new DOMException('Coder cancelled by user.', 'AbortError');
    }
    emitToolProse();

    const singleCall = toolCall as unknown as {
      call: { tool: string; args: Record<string, unknown> };
    };
    const { toolUses, toolUseIdByCall } = createToolUseSidecars([toolCall]);
    const attachToolUsesBeforeResult = (): void => {
      markLatestAssistantToolUse(messages, round, toolUses);
    };
    callbacks.onStatus('Coder executing...', singleCall.call.tool);
    const singleExecId = createId();
    const singleElapsed = startElapsedMs();
    const result = await toolExec(toolCall, {
      round,
      phase: workingMemory.currentPhase,
      executionId: singleExecId,
    });
    callbacks.onRunEvent?.({
      type: 'tool.execution_complete',
      round,
      executionId: singleExecId,
      toolName: singleCall.call.tool,
      toolSource: 'coder',
      durationMs: singleElapsed(),
      isError: result.kind === 'executed' ? Boolean(result.errorType) : false,
      preview: result.kind === 'executed' ? summarizeToolResultPreview(result.resultText) : '',
      target: getToolTargetDetail(singleCall.call.tool, singleCall.call.args),
      ...(result.kind === 'executed' && result.editDiff ? { diff: result.editDiff } : {}),
      ...(result.kind === 'executed' && result.card ? { card: result.card } : {}),
    });

    if (result.kind === 'denied') {
      const content = `[TOOL_DENIED] ${result.reason} [/TOOL_DENIED]`;
      attachToolUsesBeforeResult();
      messages.push({
        id: `coder-tool-denied-${round}`,
        role: 'user',
        content,
        timestamp: Date.now(),
        isToolResult: true,
        ...toolResultSidecar(toolUseIdByCall, toolCall, content, true),
      });
      finishRound('continued');
      continue;
    }

    // Collect cards
    if (result.card) {
      allCards.push(result.card);
    }

    // --- Guardrail: Mutation Failure Tracking ---
    const toolArgs = singleCall.call.args;
    const toolFilePath =
      (typeof toolArgs?.path === 'string' ? toolArgs.path : '') ||
      (typeof toolArgs?.file === 'string' ? toolArgs.file : '');
    const toolFilePaths = extractMutatedPaths(singleCall.call.tool, toolArgs, toolFilePath);
    if (!result.errorType && toolFilePaths.length > 0) {
      const nextObservations = invalidateObservationDependencies(
        workingMemory.observations,
        toolFilePaths,
        round,
      );
      if (nextObservations !== workingMemory.observations) {
        workingMemory.observations = nextObservations;
        callbacks.onWorkingMemoryUpdate?.(workingMemory);
      }
    }

    // Inject tool result FIRST — model always sees what happened before any guardrail message
    const truncatedResult = truncateContent(result.resultText, MAX_TOOL_RESULT_SIZE, 'tool result');
    const coderContextChars = estimateMessagesSize(messages);
    const coderCtxKb = Math.round(coderContextChars / 1024);
    const coderMetaLine = `[meta] round=${round} ctx=${coderCtxKb}kb/${Math.round(MAX_TOTAL_CONTEXT_SIZE / 1024)}kb`;
    const shouldInjectState = shouldInjectCoderStateOnToolResult(
      workingMemory,
      lastInjectedState,
      round,
      coderContextChars,
      lastInjectedStateRound,
    );
    const stateBlock = shouldInjectState
      ? `\n${formatCoderStateDiff(workingMemory, lastInjectedState, round)}`
      : '';
    const awarenessBlock = getAwarenessBlock();
    if (shouldInjectState) {
      lastInjectedState = structuredClone(workingMemory);
      lastInjectedStateRound = round;
    }
    const wrappedResult = formatToolResultEnvelope(
      truncatedResult,
      `${coderMetaLine}${stateBlock}${awarenessBlock}`,
    );
    attachToolUsesBeforeResult();
    messages.push({
      id: `coder-tool-result-${round}`,
      role: 'user',
      content: wrappedResult,
      timestamp: Date.now(),
      isToolResult: true,
      ...toolResultSidecar(
        toolUseIdByCall,
        toolCall,
        composeToolResultBody(truncatedResult, `${coderMetaLine}${stateBlock}${awarenessBlock}`),
        Boolean(result.errorType),
      ),
    });

    // --- Guardrail: Mutation Failure Tracking ---
    if (result.errorType) {
      const entry = recordMutationFailure(
        mutationFailures,
        singleCall.call.tool,
        toolFilePath,
        result.errorType,
      );

      // --- Guardrail: Hard Failure Threshold ---
      if (entry.count >= MAX_CONSECUTIVE_MUTATION_FAILURES) {
        callbacks.onStatus(
          'Coder stopped',
          `${entry.tool} failed ${entry.count}x on ${entry.file || 'unknown'}`,
        );
        messages.push({
          id: `coder-hard-failure-${round}`,
          role: 'user',
          content: formatMutationHardFailure(entry),
          timestamp: Date.now(),
        });
        // Give the model one final round to produce a summary
        finishRound('continued');
        continue;
      }
    } else if (toolFilePath) {
      // Successful execution — clear failure tracking for this tool+file
      clearMutationFailure(mutationFailures, singleCall.call.tool, toolFilePath);
    }

    // --- Policy bridge: afterToolExec — flattened via policyPost ---
    if (result.policyPost) {
      if (result.policyPost.kind === 'inject') {
        messages.push({
          id: `coder-policy-post-${round}`,
          role: 'user',
          content: result.policyPost.content,
          timestamp: Date.now(),
        });
      } else if (result.policyPost.kind === 'halt') {
        callbacks.onStatus('Coder stopped', 'Policy halt — afterToolExec');
        messages.push({
          id: `coder-policy-halt-${round}`,
          role: 'user',
          content: result.policyPost.summary,
          timestamp: Date.now(),
        });
        finishRound('continued');
        continue; // one final round for the model to summarize
      }
    }

    // Safety check: if context is getting too large, summarize and trim oldest messages.
    // CRITICAL: Always preserve the original task (messages[0]) and working memory so
    // the model never loses its purpose — dropping the task caused aimless tool loops.
    const totalSize = estimateMessagesSize(messages);
    if (totalSize > MAX_TOTAL_CONTEXT_SIZE) {
      // Keep: task message (index 0) + last (keepCount - 1) messages
      const keepTail = Math.min(8, messages.length - 1);
      const dropStart = 1; // never drop index 0 (the task)
      const dropEnd = messages.length - keepTail; // exclusive

      if (dropEnd > dropStart) {
        const dropCount = dropEnd - dropStart;
        const removed = messages.slice(dropStart, dropEnd);

        // Include working memory so the model retains plan/state across trimming.
        const hasState = hasCoderState(workingMemory, round);
        const stateBlockForTrim = hasState ? formatCoderState(workingMemory, round) : '';

        const summaryContent = buildContextSummaryBlock(removed, {
          header: `[Context trimmed — ${dropCount} earlier messages removed to stay within context budget]`,
          intro:
            'Earlier work was condensed. Re-read any files you need before making further edits.',
          maxPoints: 8,
          footerLines: [
            `Current round: ${round + 1}. Re-read any files you need before making further edits.`,
            stateBlockForTrim,
          ],
        });

        // Merge summary into the task message (messages[0]) instead of inserting
        // a separate user message.
        messages.splice(dropStart, dropCount); // remove dropped range
        messages[0] = {
          ...messages[0],
          content: messages[0].content + '\n\n' + summaryContent,
        };

        // Restore role alternation without growing the seed task message.
        normalizeTrimmedRoleAlternation(messages, round);

        // Reset diff baseline — after trimming, the model has lost earlier
        // state injections so the next one must be a full dump.
        lastInjectedState = null;
        lastInjectedStateRound = null;
      }
    }

    // Normal fall-through: a round that executed a single tool call (or trimmed
    // context) without taking an early continue/return loops back here. Emit the
    // matching turn_end so every `assistant.turn_start` above is balanced.
    // Idempotent via the `roundEnded` guard — paths that already finished the
    // round are unaffected.
    finishRound('continued');
  }
}
