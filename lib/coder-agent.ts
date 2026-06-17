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
  PushStream,
  ToolFunctionSchema,
} from './provider-contract.js';
import type { AcceptanceCriterion, RunEventInput } from './runtime-contract.js';
import { createId } from './id-utils.js';
import { summarizeToolResultPreview } from './run-events.js';
import { buildUserIdentityBlock, type UserProfile } from './user-identity.js';
import { iteratePushStreamText, asRecord } from './stream-utils.js';
import { detectToolFromText } from './tool-call-parsing.js';
import { SIZE_BUDGETS } from './size-budgets.js';
import { formatProjectInstructionsBlock } from './project-instructions.js';
import {
  buildToolCallParseErrorBlock,
  buildValidationFailedHint,
  formatToolResultEnvelope,
} from './tool-call-recovery.js';
import {
  buildLoopSteeringText,
  createSimilarityLoopDetector,
  evaluateLoopState,
  isSimilarityLoopDetectionEnabled,
  writeTargetOf,
} from './loop-detection.js';
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
const MAX_AGENTS_MD_SIZE = SIZE_BUDGETS.agentsMdCoder; // AGENTS.md cap (rationale: lib/size-budgets.ts)
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

// ---------------------------------------------------------------------------
// Message shape — structural subset of Web `ChatMessage` used by the loop.
// Lib kernel uses `LlmMessage & { isToolResult?, isToolCall? }` so the trim
// helper and context-summary logic can read tool-result markers without
// depending on Web's `ChatMessage` type.
// ---------------------------------------------------------------------------

export interface CoderLoopMessage extends LlmMessage {
  isToolResult?: boolean;
  isToolCall?: boolean;
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
const LEAD_IDENTITY = `You are Push, a mobile-first AI coding assistant. You are the lead in this chat: you talk with the user directly and do the hands-on work yourself — reading the repo, thinking things through out loud, answering their questions, and making code changes when they ask. You're someone they build alongside, not a service that hands back results — so talk like it.`;

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
  const prepareCommit = getToolPublicName('sandbox_prepare_commit');
  const push = getToolPublicName('sandbox_push');
  return `## Tool Routing

- Use **sandbox tools** for local work: reading/editing code, running commands (${sandboxExec}), tests, type checks, diffs, and commits (via ${prepareCommit}, which runs the Auditor gate — not a raw git commit).
- Use **GitHub tools** for remote repo metadata: PRs, branches, CI checks, commit history, cross-repo search, workflow dispatch.
- Prefer ${sandboxSearch} over ${searchFiles} and ${sandboxReadFile} over ${readFile} for the active repo — they're faster and reflect uncommitted edits.

## Error Handling

Tool results may carry structured error fields (error_type, retryable). Respond to the type:
- FILE_NOT_FOUND → verify the path (${listDir}).
- EDIT_HASH_MISMATCH / STALE_FILE → re-read the file to get current hashes, then re-edit.
- EXEC_NON_ZERO_EXIT → read the output, fix the issue, retry.
- RATE_LIMITED (retryable) → wait briefly, then retry once.
- SANDBOX_UNREACHABLE → the sandbox likely expired; tell the user.
- GIT_GUARD_BLOCKED → direct git commit/push/merge/rebase in ${sandboxExec} is blocked; use ${prepareCommit} + ${push}.

General rules: if retryable is false, pivot to a different approach — don't repeat the same call. If retryable is true, retry silently up to 3 times with corrected arguments. Never claim success unless a tool result confirms it.`;
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
  const prepareCommitToolName = getToolPublicName('sandbox_prepare_commit');
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
- When you DO change code: keep changes minimal and focused, fix failing tests before reporting success, then use ${diffToolName} to show what you changed and ${prepareCommitToolName} to propose a commit.
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
- The sandbox expires after 30 minutes. Use ${saveDraftName} only when you explicitly want a remote WIP checkpoint (e.g. before a risky refactor, or if you suspect time is running low) — not automatically after every phase. It switches branches and pushes unaudited; use it intentionally.
- If you hit SANDBOX_UNREACHABLE mid-task, the session likely expired. Note this in your reply so the user knows.

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
- When done, use ${diffToolName} to show what you changed, then ${prepareCommitToolName} to propose a commit
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
- The sandbox expires after 30 minutes. Use ${saveDraftName} only when you explicitly want a remote WIP checkpoint (e.g. before a risky refactor, or if you suspect time is running low) — not automatically after every phase. It switches branches and pushes unaudited; use it intentionally.
- If you hit SANDBOX_UNREACHABLE mid-task, the session likely expired. Note this in your summary so the Orchestrator can inform the user.

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
export interface CoderCheckpointState<TCard = unknown> {
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

export interface CoderAgentCallbacks<TCard = unknown> {
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
  | { action: 'inject'; content: string }
  | { action: 'halt'; summary: string }
  | null;

/**
 * Enhanced tool-exec result for Coder. The Web shim's closure bakes the
 * TurnPolicy pre/post hooks, CapabilityLedger enforcement, span tracing, and
 * sandbox health probe into this flattened shape so the lib kernel stays
 * ignorant of all of them.
 */
export type CoderToolExecResult<TCard> =
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
      policyPost?: { kind: 'inject'; content: string } | { kind: 'halt'; summary: string };
    }
  | { kind: 'denied'; reason: string };

/**
 * CoderAgentOptions — lib-side options.
 *
 * `TCall` is the shell's tool-call discriminated union; `TCard` is the
 * shell's card shape. The kernel never inspects either type internally —
 * it only forwards calls to `toolExec` and collects the returned cards.
 */
export interface CoderAgentOptions<TCall, TCard> {
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
   * Rich multipart representation of the initial user turn. Shells build this
   * from their local attachment types; the shared kernel only carries provider
   * content parts. Ignored when resuming from a checkpoint.
   */
  initialUserContentParts?: LlmContentPart[];

  /** Pre-read symbol-cache summary string, or null when the cache is empty. */
  symbolSummary: string | null;

  /** Execute a detected tool call. See `CoderToolExecResult` for the flattened shape. */
  toolExec: (
    call: TCall,
    execCtx: { round: number; phase?: string },
  ) => Promise<CoderToolExecResult<TCard>>;

  /** Multi-call detector (reads + optional trailing mutation). */
  detectAllToolCalls: (text: string) => DetectedToolCalls<TCall>;

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

  /** After-model policy callback (identical shape to Explorer). */
  evaluateAfterModel: (response: string, round: number) => Promise<CoderAfterModelResult>;

  /** Optional per-task overrides — envelope harness + acceptance criteria. */
  acceptanceCriteria?: AcceptanceCriterion[];
  harnessMaxRounds?: number;
  harnessContextResetsEnabled?: boolean;

  /**
   * Seed the loop from a prior checkpoint instead of starting fresh — used by
   * the host's resume path after a sandbox death. When set, the loop begins
   * with these messages/working memory/cards and re-enters at `round`, against
   * a freshly-restored sandbox whose filesystem matches this state.
   */
  resumeState?: CoderCheckpointState<TCard>;

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
   * prompt-described tool protocol — native `tool_calls` are normalized back
   * into fenced JSON by `openai-sse-pump`, so the dispatch path is unchanged.
   * Omitted ⇒ text-dispatch only (today's behavior for every other model).
   */
  nativeToolSchemas?: ToolFunctionSchema[];
}

/**
 * Lib-side Coder run result. Mirrors the Web `CoderResult` shape minus
 * `capabilitySnapshot`, which the Web shim attaches at the boundary from its
 * own `CapabilityLedger`.
 */
export interface CoderAgentResult<TCard> {
  summary: string;
  cards: TCard[];
  rounds: number;
  checkpoints: number;
  /** Why the run stopped *abnormally* (vs. completing the task): the round
   *  cap (`max_rounds`) or a repeated-tool-call loop (`loop`). Unset on a
   *  normal completion. Lets a caller surface a non-success outcome instead
   *  of treating the graceful stop summary as success — headless `push run`
   *  relies on this for its exit code / `--json` outcome. */
  stopReason?: 'max_rounds' | 'loop';
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

export async function runCoderAgent<TCall, TCard>(
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
    initialUserContentParts,
    symbolSummary,
    toolExec: rawToolExec,
    detectAllToolCalls,
    detectAnyToolCall,
    webSearchToolProtocol,
    sandboxToolProtocol,
    memoryToolProtocol,
    extraToolProtocols,
    verificationPolicyBlock,
    approvalModeBlock,
    evaluateAfterModel,
    acceptanceCriteria,
    harnessMaxRounds,
    harnessContextResetsEnabled,
    persona,
    leadToolGuidance = false,
    leadToolScope = 'full',
    nativeToolSchemas,
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
    .set('identity', leadMode ? LEAD_IDENTITY : CODER_IDENTITY)
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
  const maxRounds = harnessMaxRounds ?? (leadMode ? LEAD_MAX_ROUNDS : MAX_CODER_ROUNDS);
  const contextResetsEnabled = harnessContextResetsEnabled ?? false;
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

  // --- Loop-detection state (shared lib/loop-detection oracle) ---
  // The autonomous Coder loop is the highest-value site for near-duplicate
  // *rewrites*, so it runs the near-duplicate (similarity) ladder from the
  // shared oracle. Scoped to the similarity signal only — the Coder keeps its
  // existing mutation-failure breaker (`mutationFailures` above) and the
  // orchestrator's delegation circuit breaker; it deliberately does NOT take
  // the always-on exact-repeat abort the CLI/web round loops carry, because the
  // Coder legitimately re-reads the same files across many rounds and an
  // always-on exact-batch abort would cut those runs short. Dark unless
  // PUSH_LOOP_DETECTION=1; windows + counters are per-run (reset on resume).
  const loopDetector = createSimilarityLoopDetector();
  let loopBlocksIssued = 0;
  let loopCompactsIssued = 0;

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

  for (let round = resumeState?.round ?? 0; ; round++) {
    if (callbacks.signal?.aborted) {
      throw new DOMException('Coder cancelled by user.', 'AbortError');
    }

    // Circuit breaker: prevent runaway delegation loops
    if (round >= maxRounds) {
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

    rounds = round + 1;
    callbacks.onAdvanceRound?.();
    callbacks.onStatus('Coder working...', `Round ${rounds}`);

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

    // Stream Coder response via the active provider, with a per-round timeout
    const { error: streamError, text: accumulated } = await iteratePushStreamText(
      cancellableStream,
      {
        provider,
        model: coderModelId ?? '',
        messages,
        systemPromptOverride: systemPrompt,
        hasSandbox: true,
        ...(nativeToolSchemas && nativeToolSchemas.length > 0 ? { tools: nativeToolSchemas } : {}),
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
      { reasoningResetsActivityTimer: true },
    );

    if (streamError) {
      if (callbacks.signal?.aborted) {
        throw new DOMException('Coder cancelled by user.', 'AbortError');
      }
      throw streamError;
    }

    // Add Coder response to messages
    messages.push({
      id: `coder-response-${round}`,
      role: 'assistant',
      content: accumulated,
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

    // --- Turn policy: evaluate on every response ---
    const policyResult = await evaluateAfterModel(accumulated, round);
    if (policyResult) {
      if (policyResult.action === 'halt') {
        callbacks.onStatus('Coder stopped', 'Cognitive drift — halted');
        const sandboxState = (await callbacks.fetchSandboxStateSummary?.()) ?? '';
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
        continue;
      }
    }

    // Check for multiple tool calls (parallel reads + file-mutation batch + optional trailing side-effect)
    const detected = detectAllToolCalls(accumulated);

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

      const loopVerdict = evaluateLoopState({
        similarity: worstSimilarity,
        blocksIssued: loopBlocksIssued,
        compactsIssued: loopCompactsIssued,
        similarityEnforced: isSimilarityLoopDetectionEnabled(),
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

    if (batchTotal >= 2) {
      if (callbacks.signal?.aborted)
        throw new DOMException('Coder cancelled by user.', 'AbortError');

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
          const pStartMs = Date.now();
          const pToolName = (call as unknown as { call: { tool: string } }).call.tool;
          const entry = await toolExec(call, { round, phase: workingMemory.currentPhase });
          callbacks.onRunEvent?.({
            type: 'tool.execution_complete',
            round,
            executionId: pExecId,
            toolName: pToolName,
            toolSource: 'coder',
            durationMs: Date.now() - pStartMs,
            isError: entry.kind === 'executed' ? Boolean(entry.errorType) : false,
            preview: entry.kind === 'executed' ? summarizeToolResultPreview(entry.resultText) : '',
          });
          return entry;
        }),
      );

      // Inject read results
      const awarenessBlock = getAwarenessBlock();

      for (const entry of parallelResults) {
        if (entry.kind === 'denied') {
          messages.push({
            id: `coder-parallel-denied-${round}-${messages.length}`,
            role: 'user',
            content: `[TOOL_DENIED] ${entry.reason} [/TOOL_DENIED]`,
            timestamp: Date.now(),
            isToolResult: true,
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
        messages.push({
          id: `coder-parallel-result-${round}-${messages.length}`,
          role: 'user',
          content: wrappedResult,
          timestamp: Date.now(),
          isToolResult: true,
        });
      }

      // Execute the mutation queue sequentially after reads complete.
      // The queue is: [file mutations batch..., optional trailing side-effect].
      // A hard-failure in any step breaks out of the queue so the model
      // sees a consistent snapshot and gets the next round to correct.
      let batchHardFailed = false;
      for (let mqIdx = 0; mqIdx < mutationQueue.length; mqIdx++) {
        if (callbacks.signal?.aborted) {
          throw new DOMException('Coder cancelled by user.', 'AbortError');
        }
        const mutationCall = mutationQueue[mqIdx];
        const isLastInQueue = mqIdx === mutationQueue.length - 1;

        const mqExecId = createId();
        const mqStartMs = Date.now();
        const mqToolName = (mutationCall as unknown as { call: { tool: string } }).call.tool;
        const mutResult = await toolExec(mutationCall, {
          round,
          phase: workingMemory.currentPhase,
        });
        callbacks.onRunEvent?.({
          type: 'tool.execution_complete',
          round,
          executionId: mqExecId,
          toolName: mqToolName,
          toolSource: 'coder',
          durationMs: Date.now() - mqStartMs,
          isError: mutResult.kind === 'executed' ? Boolean(mutResult.errorType) : false,
          preview:
            mutResult.kind === 'executed' ? summarizeToolResultPreview(mutResult.resultText) : '',
        });
        if (mutResult.kind === 'denied') {
          messages.push({
            id: `coder-mut-denied-${round}-${mqIdx}`,
            role: 'user',
            content: `[TOOL_DENIED] ${mutResult.reason} [/TOOL_DENIED]`,
            timestamp: Date.now(),
            isToolResult: true,
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
        messages.push({
          id: `coder-mutation-result-${round}-${mqIdx}`,
          role: 'user',
          content: wrappedMut,
          timestamp: Date.now(),
          isToolResult: true,
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
      const otherToolCall = detectAnyToolCall(accumulated);
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
          continue;
        }
      }
    }

    // Check for single tool call (sandbox or web search)
    const toolCall = detectAnyToolCall(accumulated);

    if (!toolCall) {
      // Check for interactive checkpoint (Coder asking Orchestrator for guidance)
      const checkpoint = detectCheckpointCall(accumulated);
      if (checkpoint) {
        if (callbacks.signal?.aborted) {
          throw new DOMException('Coder cancelled by user.', 'AbortError');
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
            continue;
          } catch (cpErr) {
            // Propagate AbortError to allow proper task cancellation
            const isAbort = cpErr instanceof DOMException && cpErr.name === 'AbortError';
            if (isAbort || callbacks.signal?.aborted) {
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
            continue;
          }
        } else if (checkpointCount >= MAX_CHECKPOINTS) {
          messages.push({
            id: `coder-checkpoint-limit-${round}`,
            role: 'user',
            content: `[CHECKPOINT RESPONSE]\nCheckpoint limit reached (${MAX_CHECKPOINTS} max). Complete the task with what you have, or summarize what's blocking you.\n[/CHECKPOINT RESPONSE]`,
            timestamp: Date.now(),
          });
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
      throw new DOMException('Coder cancelled by user.', 'AbortError');
    }

    const singleCall = toolCall as unknown as {
      call: { tool: string; args: Record<string, unknown> };
    };
    callbacks.onStatus('Coder executing...', singleCall.call.tool);
    const singleExecId = createId();
    const singleStartMs = Date.now();
    const result = await toolExec(toolCall, { round, phase: workingMemory.currentPhase });
    callbacks.onRunEvent?.({
      type: 'tool.execution_complete',
      round,
      executionId: singleExecId,
      toolName: singleCall.call.tool,
      toolSource: 'coder',
      durationMs: Date.now() - singleStartMs,
      isError: result.kind === 'executed' ? Boolean(result.errorType) : false,
      preview: result.kind === 'executed' ? summarizeToolResultPreview(result.resultText) : '',
    });

    if (result.kind === 'denied') {
      messages.push({
        id: `coder-tool-denied-${round}`,
        role: 'user',
        content: `[TOOL_DENIED] ${result.reason} [/TOOL_DENIED]`,
        timestamp: Date.now(),
        isToolResult: true,
      });
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
    messages.push({
      id: `coder-tool-result-${round}`,
      role: 'user',
      content: wrappedResult,
      timestamp: Date.now(),
      isToolResult: true,
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
  }
}
