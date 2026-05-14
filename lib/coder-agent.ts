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

import type { AIProviderType, LlmMessage, PushStream } from './provider-contract.js';
import type { AcceptanceCriterion, RunEventInput } from './runtime-contract.js';
import { buildUserIdentityBlock, type UserProfile } from './user-identity.js';
import { iteratePushStreamText, asRecord } from './stream-utils.js';
import { detectToolFromText } from './tool-call-parsing.js';
import {
  truncateAgentContent,
  MAX_TOOL_RESULT_SIZE as LIB_MAX_TOOL_RESULT_SIZE,
} from './agent-loop-utils.js';
import { formatToolResultEnvelope } from './tool-call-recovery.js';
import { SystemPromptBuilder } from './system-prompt-builder.js';
import {
  SHARED_SAFETY_SECTION,
  SHARED_OPERATIONAL_CONSTRAINTS,
  CODER_CODE_DISCIPLINE,
} from './system-prompt-sections.js';
import { getToolPublicName } from './tool-registry.js';
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
const MAX_CODER_ROUNDS = 30; // Circuit breaker — prevent runaway delegation
const MAX_CHECKPOINTS = 3; // Max interactive checkpoint pauses per task
const CHECKPOINT_ANSWER_TIMEOUT_MS = 30_000; // 30s for Orchestrator checkpoint response

// Size limits to prevent 413 errors from provider APIs
const MAX_TOOL_RESULT_SIZE = 24_000; // Max chars per tool result (~400 lines visible per read)
const MAX_AGENTS_MD_SIZE = 4000; // Max chars for AGENTS.md
const MAX_TOTAL_CONTEXT_SIZE = 120_000; // Rough limit for total message content
const CODER_STATE_REINJECTION_PRESSURE_PCT = 60;
const CODER_STATE_REINJECTION_CADENCE_ROUNDS = 6;

// --- Mutation failure guardrails ---
const MAX_CONSECUTIVE_MUTATION_FAILURES = 3; // Hard failure threshold for same tool+file

// Silence lint on the unused re-export alias when tree-shaken in some builds.
void LIB_MAX_TOOL_RESULT_SIZE;

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

/**
 * Build the Coder guidelines section. `getToolPublicName` lives in lib so
 * the kernel resolves canonical tool names inline without taking a DI slot
 * for each one.
 */
function buildCoderGuidelines(): string {
  const diffToolName = getToolPublicName('sandbox_diff');
  const prepareCommitToolName = getToolPublicName('sandbox_prepare_commit');
  const delegateCoderName = getToolPublicName('delegate_coder');
  const delegateExplorerName = getToolPublicName('delegate_explorer');
  const createPrName = getToolPublicName('create_pr');
  const mergePrName = getToolPublicName('merge_pr');
  const saveDraftName = getToolPublicName('sandbox_save_draft');
  const readFileName = getToolPublicName('sandbox_read_file');
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
export interface CoderAgentCallbacks {
  onStatus: (phase: string, detail?: string) => void;
  signal?: AbortSignal;
  onCheckpointRequest?: (question: string, context: string) => Promise<string>;
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
  };
  projectInstructions?: string;
  instructionFilename?: string;

  /** Resolved user-profile snapshot. */
  userProfile: UserProfile | null;

  /** Pre-built delegation brief for the Coder task. Includes any planner brief. */
  taskPreamble: string;

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
  callbacks: CoderAgentCallbacks,
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
    symbolSummary,
    toolExec,
    detectAllToolCalls,
    detectAnyToolCall,
    webSearchToolProtocol,
    sandboxToolProtocol,
    verificationPolicyBlock,
    approvalModeBlock,
    evaluateAfterModel,
    acceptanceCriteria,
    harnessMaxRounds,
    harnessContextResetsEnabled,
  } = options;

  void _allowedRepo; // reserved for future use — lib loop does not need it directly
  void _sandboxId; // reserved for future use — sandbox ops flow through `toolExec`

  const coderModelId = modelId;

  // Build system prompt using the sectioned builder, layering runtime context
  // on top of the base Coder sections.
  const promptBuilder = new SystemPromptBuilder()
    .set('identity', CODER_IDENTITY)
    .set('safety', SHARED_SAFETY_SECTION)
    .set('user_context', approvalModeBlock ?? '')
    .set('guidelines', buildCoderGuidelines())
    .append('guidelines', SHARED_OPERATIONAL_CONSTRAINTS)
    .append('guidelines', CODER_CODE_DISCIPLINE)
    .set('tool_instructions', sandboxToolProtocol);

  // User identity (name, bio)
  const identityBlock = buildUserIdentityBlock(userProfile ?? undefined);
  if (identityBlock) {
    promptBuilder.append('user_context', identityBlock);
  }

  // Project instructions (AGENTS.md etc.)
  if (projectInstructions) {
    const truncatedAgentsMd = truncateAgentContent(
      projectInstructions,
      MAX_AGENTS_MD_SIZE,
      'project instructions',
    );
    let projectContent = `PROJECT INSTRUCTIONS — Repository instructions and built-in app context:\n${truncatedAgentsMd}`;
    if (projectInstructions.length > MAX_AGENTS_MD_SIZE) {
      const filename = instructionFilename || 'AGENTS.md';
      projectContent += `\n\nFull file available at /workspace/${filename} — use ${getToolPublicName('sandbox_read_file')} if you need details not shown above.`;
    }
    promptBuilder.set('project_context', projectContent);
  }

  // Workspace context (branch metadata)
  if (branchContext) {
    promptBuilder.set(
      'environment',
      `[WORKSPACE CONTEXT]\nActive branch: ${branchContext.activeBranch}\nDefault branch: ${branchContext.defaultBranch}\nProtect main: ${branchContext.protectMain ? 'on' : 'off'}`,
    );
  }

  // Web search protocol — stable tool instructions
  promptBuilder.append('tool_instructions', webSearchToolProtocol);

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
    sections: promptBuilder.snapshot() as Record<
      string,
      { hash: number; size: number; volatile: boolean }
    >,
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

  const allCards: TCard[] = [];
  let rounds = 0;
  let checkpointCount = 0;

  // Harness profile — controls scaffolding level
  const maxRounds = harnessMaxRounds ?? MAX_CODER_ROUNDS;
  const contextResetsEnabled = harnessContextResetsEnabled ?? false;

  // Agent-internal working memory — survives context trimming via injection
  const workingMemory: CoderWorkingMemory = {};
  // Track the last injected snapshot so we can emit compact diffs
  let lastInjectedState: CoderWorkingMemory | null = null;
  let lastInjectedStateRound: number | null = null;
  // Track phase for context reset detection
  let lastPhaseForReset: string | undefined;

  // --- Mutation failure guardrail state ---
  const mutationFailures = new Map<string, MutationFailureEntry>();

  // Build initial messages
  const messages: CoderLoopMessage[] = [
    {
      id: 'coder-task',
      role: 'user',
      content: taskPreamble,
      timestamp: Date.now(),
    },
  ];

  const getAwarenessBlock = (prefixNewline = true): string => {
    const awarenessSummary = callbacks.getFileAwarenessSummary?.();
    if (!awarenessSummary) return '';
    return `${prefixNewline ? '\n' : ''}[FILE_AWARENESS] ${awarenessSummary} [/FILE_AWARENESS]`;
  };

  for (let round = 0; ; round++) {
    if (callbacks.signal?.aborted) {
      throw new DOMException('Coder cancelled by user.', 'AbortError');
    }

    // Circuit breaker: prevent runaway delegation loops
    if (round >= maxRounds) {
      callbacks.onStatus('Coder stopped', `Hit ${maxRounds} round limit`);
      // Auto-fetch sandbox state for Orchestrator context
      const sandboxState = (await callbacks.fetchSandboxStateSummary?.()) ?? '';
      return {
        summary: `[Coder stopped after ${maxRounds} rounds — task may be incomplete. Review sandbox state with sandbox_diff.]${sandboxState}`,
        cards: allCards,
        rounds: round,
        checkpoints: checkpointCount,
      };
    }

    rounds = round + 1;
    callbacks.onAdvanceRound?.();
    callbacks.onStatus('Coder working...', `Round ${rounds}`);

    // Stream Coder response via the active provider, with a per-round timeout
    const { error: streamError, text: accumulated } = await iteratePushStreamText(
      cancellableStream,
      {
        provider,
        model: coderModelId ?? '',
        messages,
        systemPromptOverride: systemPrompt,
        hasSandbox: true,
      },
      CODER_ROUND_TIMEOUT_MS,
      `Coder round ${rounds} timed out after ${CODER_ROUND_TIMEOUT_MS / 1000}s — model may be unresponsive.`,
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
    const parallelCalls = detected.readOnly;
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
        parallelCalls.map((call) => toolExec(call, { round, phase: workingMemory.currentPhase })),
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

        const mutResult = await toolExec(mutationCall, {
          round,
          phase: workingMemory.currentPhase,
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
    const result = await toolExec(toolCall, { round, phase: workingMemory.currentPhase });

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
