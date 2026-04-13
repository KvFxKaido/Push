import type { ChatMessage, WorkspaceContext } from '@/types';
import { formatVerificationPolicyBlock } from './verification-policy';
import { TOOL_PROTOCOL } from './github-tools';
import { getSandboxToolProtocol } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { recordContextMetric } from './context-metrics';
import type { SummarizationCause } from './context-metrics';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import { buildUserIdentityBlock } from '@push/lib/user-identity';
import { buildContextSummaryBlock, compactChatMessage } from './context-compaction';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
import { getToolPublicName, getToolPublicNames } from './tool-registry';
import { buildModelCapabilityAwarenessBlock } from './model-capabilities';
import { getApprovalMode, buildApprovalModeBlock } from './approval-mode';
import { buildSessionCapabilityBlock } from './workspace-context';
import {
  SystemPromptBuilder,
  diffSnapshots,
  formatSnapshotDiff,
  type PromptSnapshot,
} from './system-prompt-builder';
import {
  SHARED_SAFETY_SECTION,
  SHARED_OPERATIONAL_CONSTRAINTS,
  ORCHESTRATOR_SIGNAL_EFFICIENCY,
} from './system-prompt-sections';
import {
  getPushTracer,
  injectTraceHeaders,
  recordSpanError,
  setSpanAttributes,
  SpanKind,
  SpanStatusCode,
} from './tracing';
// --- Re-exports from orchestrator-streaming (break circular dependency) ---
export {
  parseProviderError,
  hasFinishReason,
  type StreamProviderConfig,
  type StreamUsage,
  type ChunkMetadata,
} from './orchestrator-streaming';

import type { StreamProviderConfig, StreamUsage, ChunkMetadata } from './orchestrator-streaming';
import type { ActiveProvider } from './orchestrator-provider-routing';

// --- Imports from extracted modules ---
import {
  getContextMode,
  getContextBudget,
  DEFAULT_CONTEXT_BUDGET,
  estimateMessageTokens,
  estimateContextTokens,
  type ContextBudget,
} from './orchestrator-context';

// --- Barrel re-exports (preserve existing consumer import paths) ---
export {
  getContextMode,
  setContextMode,
  getContextBudget,
  estimateContextTokens,
  type ContextMode,
  type ContextBudget,
} from './orchestrator-context';

export {
  type ActiveProvider,
  getActiveProvider,
  isProviderAvailable,
  getProviderStreamFn,
  streamChat,
  streamOllamaChat,
  streamOpenRouterChat,
  streamZenChat,
  streamNvidiaChat,
  streamBlackboxChat,
  streamKilocodeChat,
  streamOpenAdapterChat,
  streamAzureChat,
  streamBedrockChat,
  streamVertexChat,
} from './orchestrator-provider-routing';

// Smart Context Management — summarize instead of drop, pin first message
// ---------------------------------------------------------------------------

function buildContextDigest(removed: ChatMessage[]): string {
  return buildContextSummaryBlock(removed, {
    header: '[CONTEXT DIGEST]',
    intro: 'Earlier messages were condensed to fit the context budget.',
    footerLines: ['[/CONTEXT DIGEST]'],
  });
}

/**
 * Classify what caused summarization pressure: tool output, long messages, or a mix.
 */
function classifySummarizationCause(
  messages: ChatMessage[],
  recentBoundary: number,
): SummarizationCause {
  let toolResults = 0;
  let longMessages = 0;

  for (let i = 0; i < recentBoundary && i < messages.length; i++) {
    const msg = messages[i];
    if (msg.isToolResult && msg.content.length > 800) toolResults++;
    else if (!msg.isToolResult && msg.content.length > 800) longMessages++;
  }

  if (toolResults > 0 && longMessages === 0) return 'tool_output';
  if (longMessages > 0 && toolResults === 0) return 'long_message';
  return 'mixed';
}

/**
 * Manage context window: summarize old messages instead of dropping them.
 *
 * Strategy:
 * 1. Always keep the first user message verbatim (the original task)
 * 2. Keep recent messages verbatim (they're most relevant)
 * 3. Summarize old tool results (biggest token consumers)
 * 4. If still over budget, start dropping oldest summarized pairs
 */
function manageContext(
  messages: ChatMessage[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
  provider?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): ChatMessage[] {
  if (getContextMode() === 'none') {
    return messages;
  }

  const totalTokens = estimateContextTokens(messages);

  // Use the lower summarizeTokens threshold to decide when to compress old
  // tool results.  This keeps working context lean even for large-context
  // models (e.g. Gemini 1M) where targetTokens is much higher.
  const summarizeThreshold = budget.summarizeTokens;
  const adaptiveRecentBoundary = totalTokens > summarizeThreshold * 0.8 ? 6 : 14;

  // Under summarize threshold — keep everything as-is
  if (totalTokens <= summarizeThreshold) {
    return messages;
  }

  // Fire PreCompact event before any compaction begins
  onPreCompact?.({
    totalTokens,
    budgetThreshold: summarizeThreshold,
    messageCount: messages.length,
  });

  // Find first user message index (to pin it)
  const firstUserIdx = messages.findIndex((m) => m.role === 'user' && !m.isToolResult);

  // Phase 1: Summarize old verbose content (walk from oldest to newest, skip recent tail)
  const result = [...messages];
  const recentBoundary = Math.max(0, result.length - adaptiveRecentBoundary);
  let currentTokens = totalTokens;

  for (let i = 0; i < recentBoundary && currentTokens > summarizeThreshold; i++) {
    const msg = result[i];
    const before = estimateMessageTokens(msg);
    const summarized = compactChatMessage(msg);
    const after = estimateMessageTokens(summarized);
    result[i] = summarized;
    currentTokens -= before - after;
  }

  // Phase 2: Remove oldest non-pinned messages with a digest fallback.
  // Only drop messages when over the (potentially much higher) targetTokens —
  // for Gemini this means we summarize at 88K but only drop at 800K.
  if (currentTokens <= budget.targetTokens) {
    const cause = classifySummarizationCause(messages, recentBoundary);
    recordContextMetric({
      phase: 'summarization',
      beforeTokens: totalTokens,
      afterTokens: currentTokens,
      provider,
      cause,
    });
    console.log(
      `[Push] Context managed via summarization: ${totalTokens} → ${currentTokens} tokens`,
    );
    return result;
  }

  const tailStart = Math.max(0, result.length - adaptiveRecentBoundary);
  const protectedIdx = new Set<number>();
  if (firstUserIdx >= 0) protectedIdx.add(firstUserIdx);
  for (let i = tailStart; i < result.length; i++) protectedIdx.add(i);

  const toRemove = new Set<number>();
  const removed: ChatMessage[] = [];

  for (let i = 0; i < result.length && currentTokens > budget.targetTokens; i++) {
    if (protectedIdx.has(i) || toRemove.has(i)) continue;

    // Keep tool call/result paired for coherence.
    if (
      result[i].isToolCall &&
      i + 1 < result.length &&
      result[i + 1]?.isToolResult &&
      !protectedIdx.has(i + 1)
    ) {
      toRemove.add(i);
      toRemove.add(i + 1);
      removed.push(result[i], result[i + 1]);
      currentTokens -= estimateMessageTokens(result[i]) + estimateMessageTokens(result[i + 1]);
      i++;
      continue;
    }
    if (result[i].isToolResult && i > 0 && result[i - 1]?.isToolCall && !protectedIdx.has(i - 1)) {
      // Let the pair be removed when the call index is processed.
      continue;
    }

    toRemove.add(i);
    removed.push(result[i]);
    currentTokens -= estimateMessageTokens(result[i]);
  }

  if (toRemove.size === 0) {
    return result;
  }

  const digestMessage: ChatMessage = {
    id: `context-digest-${Date.now()}`,
    role: 'user',
    content: buildContextDigest(removed),
    timestamp: 0,
    status: 'done',
    isToolResult: true, // hidden in UI, still sent to model
  };

  const kept: ChatMessage[] = [];
  let digestInserted = false;
  for (let i = 0; i < result.length; i++) {
    if (toRemove.has(i)) continue;

    if (!digestInserted) {
      if (firstUserIdx >= 0 && i === firstUserIdx + 1) {
        kept.push(digestMessage);
        digestInserted = true;
      } else if (firstUserIdx < 0 && i === 0) {
        kept.push(digestMessage);
        digestInserted = true;
      }
    }

    kept.push(result[i]);
  }
  if (!digestInserted) kept.unshift(digestMessage);

  if (estimateContextTokens(kept) > budget.maxTokens) {
    // Last resort hard trim from oldest non-protected while keeping digest and recent tail.
    const hardResult = [...kept];
    while (estimateContextTokens(hardResult) > budget.maxTokens && hardResult.length > 16) {
      hardResult.splice(1, 1);
    }
    const hardAfter = estimateContextTokens(hardResult);
    recordContextMetric({
      phase: 'hard_trim',
      beforeTokens: totalTokens,
      afterTokens: hardAfter,
      provider,
      messagesDropped: messages.length - hardResult.length,
    });
    console.log(`[Push] Context managed (hard fallback): ${totalTokens} → ${hardAfter} tokens`);
    return hardResult;
  }

  const keptTokens = estimateContextTokens(kept);
  recordContextMetric({
    phase: 'digest_drop',
    beforeTokens: totalTokens,
    afterTokens: keptTokens,
    provider,
    messagesDropped: toRemove.size,
  });
  console.log(
    `[Push] Context managed with digest: ${totalTokens} → ${keptTokens} tokens (${messages.length} → ${kept.length} messages)`,
  );
  return kept;
}

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orchestrator system prompt — sectioned constants
// ---------------------------------------------------------------------------

const ORCHESTRATOR_IDENTITY = `Push is a mobile AI coding agent with direct GitHub repo access. You are its conversational interface — helping developers review PRs, understand codebases, and ship changes from their phone.`;

const ORCHESTRATOR_VOICE = `Voice:
- Concise but warm. Short paragraphs, clear structure — this is mobile.
- Explain your reasoning briefly. Don't just state conclusions.
- Light personality is fine. You're helpful, not robotic.
- Use markdown for code snippets. Keep responses scannable.
- Vary your openings. Never start with "I".

Boundaries:
- If you don't know something, say so. Don't guess.
- You only know about the active repo. Never mention other repos — the user controls that via UI.
- All questions about "the repo", PRs, or changes refer to the active repo. Period.
- Branch creation is UI-owned. If the user wants a new branch, tell them to use the Create branch action in Home or the branch menu. Do not try to create or switch branches yourself.`;

function buildOrchestratorGuidelines(): string {
  return `## Default Workflow

Use this operating loop unless the request clearly calls for something else:
1. Decide whether the request is read-only, implementation, or current-info lookup, and whether the current model can actually inspect the provided inputs.
2. Pick the cheapest reliable tool path first: list/search/symbol tools before broad reads; reads before mutations.
3. Prefer direct handling when the task is already well-scoped. Delegate only when the sub-agent adds real leverage.
4. Distill what you already know before handing work off — don't make another role rediscover validated facts.
5. Verify outcomes with tool results before you claim success or summarize a conclusion.

## Clarifications and Assumptions

- First try to resolve ambiguity from the chat, repo context, and available inspection tools.
- If a genuine ambiguity remains and it would materially change the approach, risk wasted/incorrect work, or depend on user preference, use ${getToolPublicName('ask_user')} with 2–4 concrete options. But check your Approval Mode first — in Autonomous or Full Auto mode, prefer making reasonable assumptions over asking.
- If the ambiguity is minor or reversible, make the best reasonable assumption, state it briefly, and continue.`;
}

function buildOrchestratorToolInstructions(): string {
  return `## Tool Execution Model

You can emit multiple tool calls in one response. The runtime splits them into parallel reads and an optional trailing mutation:
- Read-only calls (${[
    ...getToolPublicNames({ source: 'github', readOnly: true }),
    ...getToolPublicNames({ source: 'sandbox', readOnly: true }),
    getToolPublicName('web_search'),
    getToolPublicName('read_scratchpad'),
  ].join(', ')}) execute in parallel.
- If you include a mutating call (edit, write, exec, commit, push, coder, explorer, ask, etc.), place it LAST — it runs after all reads complete.
- Maximum 6 parallel read-only calls per turn. If you need more, split across turns.

## Tool Routing

- Use **sandbox tools** for local operations: reading/editing code, running commands, tests, type checks, diffs, commits.
- Use **GitHub tools** for remote repo metadata: PRs, branches, CI checks, cross-repo search, workflow dispatch.
- Prefer ${getToolPublicName('sandbox_search')} over ${getToolPublicName('search_files')} for code in the active repo — it's faster and reflects local edits.
- Prefer ${getToolPublicName('sandbox_read_file')} over ${getToolPublicName('read_file')} when the sandbox is active — it reflects uncommitted changes.

## Error Handling

Tool results may include structured error fields: error_type and retryable.

Error types and how to respond:
- FILE_NOT_FOUND → Check the path. Use ${getToolPublicName('sandbox_list_dir')} or ${getToolPublicName('list_directory')} to verify it exists.
- EXEC_TIMEOUT → Simplify the command or break it into smaller steps.
- EXEC_NON_ZERO_EXIT → Read the error output, fix the issue, retry.
- EDIT_HASH_MISMATCH → File changed since you read it. Re-read, then re-edit.
- EDIT_CONTENT_NOT_FOUND → The ref hash doesn't match any line. Re-read the file to get current hashes.
- STALE_FILE → Re-read the file to get the current version, then retry.
- AUTH_FAILURE → Inform the user; don't retry.
- RATE_LIMITED (retryable: true) → Wait briefly, then retry once.
- SANDBOX_UNREACHABLE → Inform the user the sandbox may have expired.
- GIT_GUARD_BLOCKED → Direct git commit/push/merge/rebase in ${getToolPublicName('sandbox_exec')} is blocked. Use ${getToolPublicName('sandbox_prepare_commit')} + ${getToolPublicName('sandbox_push')}. If the standard flow fails, use ${getToolPublicName('ask_user')} to explain and request permission. Only with explicit user approval, retry with "allowDirectGit": true.

General rules:
- If retryable: false, pivot to a different approach — don't repeat the same call.
- If retryable: true, retry silently up to 3 times with corrected arguments. Do not ask the user before retrying — errors in the sandbox are cheap.
- Never claim a task is complete unless a tool result confirms success.
- If a sandbox command fails, check the error message and adjust (wrong path, missing dependency, etc.). Fix and retry instead of asking the user for help.`;
}

function buildOrchestratorDelegation(): string {
  return `## Efficient Delegation and Handoffs

When delegating coding or exploration tasks via ${getToolPublicName('delegate_coder')} or ${getToolPublicName('delegate_explorer')}, significantly improve efficiency by passing the right brief, not just a bare task:

1. Scan conversation history for your previous tool calls (${getToolPublicName('read_file')}, ${getToolPublicName('grep_file')}, ${getToolPublicName('search_files')}, ${getToolPublicName('list_directory')}).
2. Identify file paths from arguments and include them in "files".
3. Add "knownContext" with short validated facts you already learned.
4. Add "deliverable" when the expected output or end state is specific.
5. Add "acceptanceCriteria" for ${getToolPublicName('delegate_coder')} when success can be checked by commands.

Example:
If you read "src/auth.ts", use:
{"tool": "${getToolPublicName('delegate_coder')}", "args": { "task": "...", "files": ["src/auth.ts"], "knownContext": ["Session refresh already appears to be triggered from src/auth.ts"], "deliverable": "Ship the fix with passing auth tests" }}

Rules:
- Only include files actually read in this conversation.
- Only include "knownContext" items you have actually validated.
- Don't guess. If unsure, omit the field.
- Prioritize correctness over optimization.
- Coder and Explorer inherit the current chat-locked provider/model by default. Delegation does not grant capabilities the current model lacks.
- After Explorer returns, either answer directly or hand off to Coder with the distilled findings in "knownContext" instead of sending the Coder back through the same discovery loop.

## Explorer Task Template

When delegating to the Explorer, structure your "task" argument to be extremely precise and evidence-based. Use the following format:

Objective: [clear goal]
Look at: [target paths]
Search for: [exact keywords/regex]
Report: [explicit output requirements like file paths and line numbers]

Example:
{"tool": "${getToolPublicName('delegate_explorer')}", "args": { "task": "Objective: Trace the auth flow and summarize where session refresh happens\\nLook at: src/auth.ts, src/middleware.ts\\nSearch for: 'refresh_token', 'session_expires'\\nReport: File paths, line numbers, and the exact conditions triggering the refresh.", "files": ["src/auth.ts"], "deliverable": "Return the trigger path with evidence and the next recommended actor" }}

## Multi-Task Delegation

For multiple independent coding tasks in a single request, use the "tasks" array instead of "task":
{"tool": "${getToolPublicName('delegate_coder')}", "args": { "tasks": ["add dark mode toggle to SettingsPage", "refactor logger utility to support log levels"], "files": ["src/settings.tsx", "src/lib/logger.ts"], "deliverable": "Complete both changes with verification notes", "knownContext": ["The settings page and logger are independent areas"] }}

Rules for multi-task delegation:
- Each task must be independently completable — no task should depend on another task's output. If tasks have dependencies, use separate sequential ${getToolPublicName('delegate_coder')} calls instead.
- All multiple tasks execute sequentially in the main sandbox, sharing the same active file state.
- Acceptance criteria (if provided) run against every task independently.
- All tasks share the same "files", "intent", and "constraints" context.

## Task Graph Orchestration

For complex goals requiring multiple dependent steps across Explorer and Coder agents, use \`${getToolPublicName('plan_tasks')}\` to define a dependency-aware task graph. The runtime executes tasks in parallel where safe and propagates results between dependent tasks automatically.

{"tool": "${getToolPublicName('plan_tasks')}", "args": {"tasks": [
  {"id": "explore-auth", "agent": "explorer", "task": "Trace the auth flow in src/auth.ts and src/middleware.ts. Report file paths, functions, and the refresh trigger.", "files": ["src/auth.ts", "src/middleware.ts"], "dependsOn": []},
  {"id": "explore-tests", "agent": "explorer", "task": "Find existing test patterns and identify coverage gaps for auth.", "files": ["tests/"], "dependsOn": []},
  {"id": "fix-auth", "agent": "coder", "task": "Refactor the auth module based on findings.", "dependsOn": ["explore-auth"], "deliverable": "Auth flow simplified, existing tests pass"},
  {"id": "add-tests", "agent": "coder", "task": "Add missing test coverage for auth.", "dependsOn": ["explore-tests", "fix-auth"], "deliverable": "New tests pass with improved coverage"}
]}}

In this example: both Explorer tasks run in parallel, then "fix-auth" starts once "explore-auth" completes, and "add-tests" waits for both "explore-tests" and "fix-auth".

Rules for task graphs:
- Each task needs a unique "id", an "agent" ("explorer" or "coder"), and a "task" description.
- "dependsOn" lists task IDs that must complete first. Omit or use [] for root tasks.
- Explorer tasks are read-only and run in parallel (up to 3 concurrent).
- Coder tasks run one at a time (sequential) to avoid sandbox conflicts.
- Results from completed dependencies are automatically injected as knownContext.
- If a task fails, all tasks that depend on it (transitively) are cancelled.
- Use task graphs when the goal requires 3+ steps with dependencies. For simpler goals, use direct ${getToolPublicName('delegate_coder')} or ${getToolPublicName('delegate_explorer')}.

## When to Delegate vs Handle Directly

Delegate to the Coder when the task requires:
- Multiple files are involved
- New abstractions are introduced or structural refactors (e.g., extracting functions, modifying interfaces) are required
- Running commands — tests, type checks, builds, installs
- An iterative read → edit → verify loop
- Exploratory changes where the full scope is unclear upfront

Delegate to the Explorer when the task requires:
- Tracing a flow across multiple files
- Understanding architecture before implementation
- Finding where behavior lives, what depends on a symbol, or what changed recently
- Repo investigation that should stay strictly read-only

Handle directly (no delegation) when:
- The request is read-only: explaining code, reviewing a PR diff, or answering structure questions.
- The change is straightforward (e.g., adding to a list, updating config, localized refactor) even if it spans 2-3 files, provided you have the context and don't need to run complex commands.
- The task can be completed in a single turn using \`${getToolPublicName('sandbox_apply_patchset')}\` or a few targeted edits.
- You only need one or two tool calls and have the relevant content in context. Avoid delegating simple "add X to Y" tasks to the Coder; handle them yourself to keep the conversation fast.`;
}

/**
 * Return a SystemPromptBuilder preconfigured with the base Orchestrator
 * sections. Shared by `buildOrchestratorBasePrompt()` and `toLLMMessages()`
 * to avoid drift when updating the base prompt wiring.
 */
function buildOrchestratorBaseBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder()
    .set('identity', ORCHESTRATOR_IDENTITY)
    .set('voice', ORCHESTRATOR_VOICE)
    .set('safety', SHARED_SAFETY_SECTION)
    .set('guidelines', buildOrchestratorGuidelines())
    .append('guidelines', SHARED_OPERATIONAL_CONSTRAINTS)
    .append('guidelines', ORCHESTRATOR_SIGNAL_EFFICIENCY)
    .set('tool_instructions', buildOrchestratorToolInstructions())
    .set('delegation', buildOrchestratorDelegation());
}

/**
 * Build the Orchestrator system prompt from named sections.
 *
 * This builds the base prompt; workspace/tool/sandbox protocol sections and
 * runtime context blocks (e.g. user_context, capabilities, environment,
 * custom, last_instructions) are layered on in `toLLMMessages()` using
 * `SystemPromptBuilder.set()` and, where appropriate, `append()`.
 */
function buildOrchestratorBasePrompt(): string {
  return buildOrchestratorBaseBuilder().build();
}

/**
 * Exported for backwards compatibility (tests reference this).
 * Now built from composable sections instead of a single template literal.
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = buildOrchestratorBasePrompt();

/**
 * Dev-only: previous prompt snapshots for diffing between turns.
 * Keyed by a conversation-ish snapshot key so multi-chat sessions do not
 * compare unrelated prompts against each other in the console.
 * Only read/written inside `import.meta.env.DEV` guards.
 */
const _lastPromptSnapshots = new Map<string, PromptSnapshot>();

function getPromptSnapshotKey(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
): string {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && !message.isToolResult,
  );
  if (firstUserMessage) {
    return `user:${firstUserMessage.id}`;
  }
  if (workspaceContext) {
    return `workspace:${workspaceContext.mode}:${workspaceContext.description}`;
  }
  return 'global';
}

// Multimodal content types (OpenAI-compatible)
interface LLMMessageContentText {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface LLMMessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

type LLMMessageContent = LLMMessageContentText | LLMMessageContentImage;

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMMessageContent[];
  intentHint?: string | null;
}

function isNonEmptyContent(content: string | LLMMessageContent[]): boolean {
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content.trim().length > 0;
}

/**
 * Build a chat instructions block for the system prompt.
 * Only used in chat mode — workspace mode uses project instructions (AGENTS.md) instead.
 */
export function buildChatInstructionsBlock(profile?: UserProfile): string {
  const instructions = profile?.chatInstructions?.trim();
  if (!instructions) return '';
  const escaped = instructions
    .replace(/\[CHAT INSTRUCTIONS\]/gi, '[CHAT INSTRUCTIONS\u200B]')
    .replace(/\[\/CHAT INSTRUCTIONS\]/gi, '[/CHAT INSTRUCTIONS\u200B]');
  return `## Chat Instructions\n${escaped}`;
}

export { buildUserIdentityBlock };

function toLLMMessages(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  providerType?: Exclude<ActiveProvider, 'demo'>,
  providerModel?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
  intentHint?: string | null,
): LLMMessage[] {
  // When a systemPromptOverride is provided (Auditor, Coder), the caller has already
  // composed a complete system prompt — don't append Orchestrator-specific protocols.
  let systemContent: string;
  const promptSnapshotKey = getPromptSnapshotKey(messages, workspaceContext);

  if (systemPromptOverride) {
    systemContent = systemPromptOverride;
    _lastPromptSnapshots.delete(promptSnapshotKey);
  } else {
    // Build the full orchestrator prompt using the sectioned builder.
    // Start from the shared base and layer in runtime-dependent blocks.
    const builder = buildOrchestratorBaseBuilder();

    // Chat mode — strip orchestrator tool instructions and delegation (plain
    // conversation). Web search is layered back in below so chat can still
    // ground answers on fresh information.
    if (workspaceContext?.mode === 'chat') {
      builder.set('tool_instructions', null);
      builder.set('delegation', null);
    }

    // User identity (name, bio) when configured
    const profile = getUserProfile();
    const identityBlock = buildUserIdentityBlock(profile);
    const approvalBlock = buildApprovalModeBlock(getApprovalMode());
    const chatInstructionsBlock =
      workspaceContext?.mode === 'chat' ? buildChatInstructionsBlock(profile) : '';
    builder.set(
      'user_context',
      [identityBlock, chatInstructionsBlock, approvalBlock].filter(Boolean).join('\n\n'),
    );

    // Model capability awareness
    if (providerType && providerModel) {
      const hasImageAttachments = messages.some((message) =>
        Boolean(message.attachments?.some((attachment) => attachment.type === 'image')),
      );
      builder.set(
        'capabilities',
        buildModelCapabilityAwarenessBlock(providerType, providerModel, {
          hasImageAttachments,
        }),
      );
    }

    // Workspace description + GitHub tool protocol
    if (workspaceContext) {
      let envContent = workspaceContext.description;
      const capabilityBlock = buildSessionCapabilityBlock(workspaceContext, hasSandbox);
      if (capabilityBlock) {
        envContent += '\n\n' + capabilityBlock;
      }
      if (workspaceContext.includeGitHubTools) {
        envContent += '\n' + TOOL_PROTOCOL;
      }
      builder.set('environment', envContent);
    }

    // Session-level verification policy (from workspace context)
    const verificationPolicyBlock = formatVerificationPolicyBlock(
      workspaceContext?.verificationPolicy,
    );
    if (verificationPolicyBlock) {
      builder.append('guidelines', verificationPolicyBlock);
    }

    // Tool protocols — session-stable instructions about how to use tools.
    // Chat mode gets only the web_search protocol — no sandbox, delegation,
    // scratchpad, or ask_user — so it stays a plain conversation that can
    // still look things up on the web when the user asks.
    // Use set() to replace the base tool_instructions with the full set,
    // avoiding duplication if this code path runs more than once.
    if (workspaceContext?.mode === 'chat') {
      builder.set('tool_instructions', WEB_SEARCH_TOOL_PROTOCOL);
    } else {
      const baseToolInstructions = builder.get('tool_instructions') ?? '';
      const toolProtocols: string[] = [];
      if (hasSandbox) {
        toolProtocols.push(getSandboxToolProtocol());
      }
      toolProtocols.push(SCRATCHPAD_TOOL_PROTOCOL);
      toolProtocols.push(WEB_SEARCH_TOOL_PROTOCOL);
      toolProtocols.push(ASK_USER_TOOL_PROTOCOL);
      builder.set('tool_instructions', baseToolInstructions + '\n' + toolProtocols.join('\n'));

      // Scratchpad content — volatile memory that changes between turns.
      if (scratchpadContent !== undefined) {
        builder.set('memory', buildScratchpadContext(scratchpadContent));
      }
    }

    // Intent hint (last so it overrides)
    builder.set('last_instructions', intentHint);

    systemContent = builder.build();

    // --- Log prompt-size breakdown and section diffs (dev only) ---
    if (import.meta.env.DEV) {
      const fmt = (n: number) => n.toLocaleString();
      const sizes = builder.sizes();
      const parts = Object.entries(sizes)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(' ');
      console.log(`[Context Budget] System prompt: ${fmt(systemContent.length)} chars (${parts})`);

      const currentSnap = builder.snapshot();
      const previousSnap = _lastPromptSnapshots.get(promptSnapshotKey);
      if (previousSnap) {
        const diff = diffSnapshots(previousSnap, currentSnap);
        const diffStr = formatSnapshotDiff(diff);
        if (diffStr) console.log(diffStr);
      }
      _lastPromptSnapshots.set(promptSnapshotKey, currentSnap);
    }
  }

  // Prompt caching: wrap the system message as a content-array with cache_control
  // for providers that support it (currently OpenRouter/Anthropic). Other
  // providers harmlessly ignore the extra field.
  const cacheable = providerType === 'openrouter';
  const llmMessages: LLMMessage[] = [
    cacheable
      ? {
          role: 'system',
          content: [
            { type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } },
          ] as LLMMessageContent[],
        }
      : { role: 'system', content: systemContent },
  ];

  // Smart context management — summarize old messages instead of dropping
  const contextBudget = getContextBudget(providerType, providerModel);
  const windowedMessages = manageContext(messages, contextBudget, providerType, onPreCompact);

  for (const msg of windowedMessages) {
    // Check for attachments (multimodal message)
    if (msg.attachments && msg.attachments.length > 0) {
      const contentParts: LLMMessageContent[] = [];

      // Add text first (if any)
      if (msg.content) {
        contentParts.push({ type: 'text', text: msg.content });
      }

      // Add attachments
      for (const att of msg.attachments) {
        if (att.type === 'image') {
          // Image: use image_url format with base64 data URL
          contentParts.push({
            type: 'image_url',
            image_url: { url: att.content },
          });
        } else {
          // Code/document: embed as text block
          contentParts.push({
            type: 'text',
            text: `[Attached file: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
          });
        }
      }

      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentParts,
      });
    } else {
      // Simple text message (existing behavior)
      // Guard against provider-side validation errors:
      // some OpenAI-compatible backends reject empty assistant turns.
      if (msg.role === 'assistant' && !msg.content.trim()) {
        continue;
      }
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
  }

  // Prompt Caching: cache the entire prefix up to the last user message.
  // Active for providers that support cache_control (OpenRouter, Mistral).
  if (cacheable && llmMessages.length > 0) {
    for (let i = llmMessages.length - 1; i >= 0; i--) {
      if (llmMessages[i].role === 'user') {
        const lastMsg = llmMessages[i];
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = [
            { type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } },
          ];
        } else if (Array.isArray(lastMsg.content)) {
          // Already an array (e.g. from attachments), tag the last part
          const lastPart = lastMsg.content[lastMsg.content.length - 1];
          if (lastPart.type === 'text') {
            lastPart.cache_control = { type: 'ephemeral' };
          }
        }
        break;
      }
    }
  }

  // Final sanitize pass: never send empty assistant messages.
  return llmMessages.filter((msg) => {
    if (msg.role !== 'assistant') return true;
    return isNonEmptyContent(msg.content);
  });
}

// ---------------------------------------------------------------------------
// Shared: <think> tag parser
// ---------------------------------------------------------------------------

interface ThinkTokenParser {
  push(token: string): void;
  flush(): void;
}

function createThinkTokenParser(
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onThinkingToken?: (token: string | null) => void,
): ThinkTokenParser {
  let insideThink = false;
  let tagBuffer = '';

  return {
    push(token: string) {
      tagBuffer += token;

      // Detect <think> opening
      if (!insideThink && tagBuffer.includes('<think>')) {
        const before = tagBuffer.split('<think>')[0];
        if (before) onToken(before);
        insideThink = true;
        tagBuffer = '';
        return;
      }

      // Inside thinking — emit thinking tokens, watch for </think>
      if (insideThink) {
        if (tagBuffer.includes('</think>')) {
          const thinkContent = tagBuffer.split('</think>')[0];
          if (thinkContent) onThinkingToken?.(thinkContent);
          onThinkingToken?.(null); // signal thinking done

          const after = tagBuffer.split('</think>').slice(1).join('</think>');
          insideThink = false;
          tagBuffer = '';
          const cleaned = after.replace(/^\s+/, '');
          if (cleaned) onToken(cleaned);
        } else {
          // Emit thinking tokens as they arrive, keep tail for tag detection
          const safe = tagBuffer.slice(0, -10);
          if (safe) onThinkingToken?.(safe);
          tagBuffer = tagBuffer.slice(-10);
        }
        return;
      }

      // Normal content — emit when we're sure there's no partial <think
      if (tagBuffer.length > 50 || !tagBuffer.includes('<')) {
        onToken(tagBuffer);
        tagBuffer = '';
      }
    },

    flush() {
      if (tagBuffer && !insideThink) {
        onToken(tagBuffer);
      }
      tagBuffer = '';
    },
  };
}

// ---------------------------------------------------------------------------
// Smart Chunking — reduces UI updates on mobile by batching tokens
// ---------------------------------------------------------------------------

interface ChunkedEmitter {
  push(token: string): void;
  flush(): void;
}

/**
 * Creates a chunked emitter that batches tokens for smoother mobile UI.
 *
 * Tokens are buffered and emitted when:
 * 1. A word boundary (space/newline) is encountered
 * 2. Buffer reaches MIN_CHUNK_SIZE characters
 * 3. FLUSH_INTERVAL_MS passes without emission
 *
 * This reduces React setState calls from per-character to per-word,
 * dramatically improving performance on slower mobile devices.
 */
function createChunkedEmitter(
  emit: (chunk: string, meta?: ChunkMetadata) => void,
  options?: { minChunkSize?: number; flushIntervalMs?: number },
): ChunkedEmitter {
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 4; // Min chars before emitting
  const FLUSH_INTERVAL_MS = options?.flushIntervalMs ?? 50; // Max time to hold tokens

  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chunkIndex = 0;

  const doEmit = () => {
    if (buffer) {
      chunkIndex++;
      emit(buffer, { chunkIndex });
      buffer = '';
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(doEmit, FLUSH_INTERVAL_MS);
    }
  };

  return {
    push(token: string) {
      buffer += token;

      // Emit on word boundaries (space, newline) if we have enough content
      const hasWordBoundary = /[\s\n]/.test(token);
      if (hasWordBoundary && buffer.length >= MIN_CHUNK_SIZE) {
        doEmit();
        return;
      }

      // Emit if buffer is getting large (long word without spaces)
      if (buffer.length >= MIN_CHUNK_SIZE * 4) {
        doEmit();
        return;
      }

      // Otherwise, schedule a flush to ensure tokens don't get stuck
      scheduleFlush();
    },

    flush() {
      doEmit();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared: generic SSE streaming with timeouts
// ---------------------------------------------------------------------------

interface AutoRetryConfig {
  maxAttempts?: number;
  backoffMs?: number;
}

export async function streamSSEChat(
  config: StreamProviderConfig,
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  autoRetry?: AutoRetryConfig,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): Promise<void> {
  const maxAttempts = autoRetry?.maxAttempts ?? 1;
  const backoffMs = autoRetry?.backoffMs ?? 1000;

  let lastError: Error | undefined;
  let tokensEmitted = false;

  // Wrap onToken to track whether any content reached the UI
  const trackedOnToken: typeof onToken = (token, meta) => {
    tokensEmitted = true;
    onToken(token, meta);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    tokensEmitted = false;
    try {
      return await streamSSEChatOnce(
        config,
        messages,
        trackedOnToken,
        onDone,
        onError,
        onThinkingToken,
        workspaceContext,
        hasSandbox,
        systemPromptOverride,
        scratchpadContent,
        signal,
        onPreCompact,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on auth errors or user aborts
      if (
        lastError.message.includes('key') ||
        lastError.message.includes('auth') ||
        lastError.message.includes('Unauthorized') ||
        signal?.aborted
      ) {
        throw lastError;
      }

      // Don't retry if tokens already reached the UI — retrying would
      // produce duplicate or interleaved content in the response.
      if (tokensEmitted) {
        throw lastError;
      }

      // Check if this is a timeout error worth retrying
      const isTimeout =
        lastError.message.includes('timeout') ||
        lastError.message.includes('stall') ||
        lastError.message.includes('no data');

      if (attempt < maxAttempts && isTimeout) {
        console.log(`[Push] Retry attempt ${attempt}/${maxAttempts} after ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }

      throw lastError;
    }
  }
}

async function streamSSEChatOnce(
  config: StreamProviderConfig,
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): Promise<void> {
  const {
    name,
    apiUrl,
    apiKey,
    authHeader,
    model,
    connectTimeoutMs,
    idleTimeoutMs,
    stallTimeoutMs,
    totalTimeoutMs,
    errorMessages,
    parseError,
    checkFinishReason,
    shouldResetStallOnReasoning = false,
    providerType,
    apiUrlOverride,
    bodyTransform,
    extraHeaders,
  } = config;

  const tracer = getPushTracer('push.model');
  return tracer.startActiveSpan(
    'model.stream',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'push.provider': providerType || 'unknown',
        'push.model': model,
        'push.message_count': messages.length,
        'push.has_sandbox': Boolean(hasSandbox),
        'push.workspace_mode': workspaceContext?.mode || 'unknown',
      },
    },
    async (span) => {
      const controller = new AbortController();
      type AbortReason = 'connect' | 'idle' | 'user' | 'stall' | 'total' | null;
      let abortReason: AbortReason = null;

      const onExternalAbort = () => {
        abortReason = 'user';
        controller.abort();
      };
      signal?.addEventListener('abort', onExternalAbort);

      // Timers
      let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        abortReason = 'connect';
        controller.abort();
      }, connectTimeoutMs);

      let totalTimer: ReturnType<typeof setTimeout> | undefined;
      if (totalTimeoutMs) {
        totalTimer = setTimeout(() => {
          abortReason = 'total';
          controller.abort();
        }, totalTimeoutMs);
      }

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          abortReason = 'idle';
          controller.abort();
        }, idleTimeoutMs);
      };

      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const resetStallTimer = () => {
        if (!stallTimeoutMs) return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          abortReason = 'stall';
          controller.abort();
        }, stallTimeoutMs);
      };

      let chunkCount = 0;
      let contentChars = 0;
      let thinkingChars = 0;
      let nativeToolCallCount = 0;

      const finishSuccess = (spanUsage?: StreamUsage) => {
        setSpanAttributes(span, {
          'push.abort_reason': abortReason || undefined,
          'push.stream.chunk_count': chunkCount,
          'push.stream.content_chars': contentChars,
          'push.stream.thinking_chars': thinkingChars,
          'push.stream.native_tool_call_count': nativeToolCallCount,
          'push.usage.input_tokens': spanUsage?.inputTokens,
          'push.usage.output_tokens': spanUsage?.outputTokens,
          'push.usage.total_tokens': spanUsage?.totalTokens,
        });
        span.setStatus({ code: SpanStatusCode.OK });
      };

      try {
        const requestUrl = apiUrlOverride || apiUrl;
        const requestId = createRequestId('chat');
        setSpanAttributes(span, {
          'push.request_id': requestId,
          'push.request_url': requestUrl,
        });
        console.log(`[Push] POST ${requestUrl} (model: ${model}, request: ${requestId})`);

        let requestBody: Record<string, unknown> = {
          model,
          messages: toLLMMessages(
            messages,
            workspaceContext,
            hasSandbox,
            systemPromptOverride,
            scratchpadContent,
            providerType,
            model,
            onPreCompact,
          ),
          stream: true,
        };

        if (bodyTransform) {
          requestBody = bodyTransform(requestBody);
        }

        const requestHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          [REQUEST_ID_HEADER]: requestId,
          ...(extraHeaders ?? {}),
        };
        if (authHeader !== null) {
          requestHeaders.Authorization = authHeader ?? `Bearer ${apiKey}`;
        }
        injectTraceHeaders(requestHeaders);

        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });

        clearTimeout(connectTimer);
        connectTimer = undefined;
        resetIdleTimer();
        if (stallTimeoutMs) resetStallTimer();

        if (!response.ok) {
          span.setAttribute('http.response.status_code', response.status);
          const body = await response.text().catch(() => '');
          let detail = '';
          try {
            const parsed = JSON.parse(body);
            detail = parseError(parsed, body.slice(0, 200));
          } catch {
            detail = body ? body.slice(0, 200) : 'empty body';
          }
          // Strip HTML error pages (e.g. Cloudflare 403/503 pages) — show a clean message instead
          if (/<\s*html[\s>]/i.test(detail) || /<\s*!doctype/i.test(detail)) {
            detail = `HTTP ${response.status} (the server returned an HTML error page instead of JSON)`;
          }
          console.error(`[Push] ${name} error: ${response.status}`, detail);
          const alreadyPrefixed = detail.toLowerCase().startsWith(name.toLowerCase());
          throw new Error(alreadyPrefixed ? detail : `${name} ${response.status}: ${detail}`);
        }

        span.setAttribute('http.response.status_code', response.status);

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const chunker = createChunkedEmitter(onToken);
        const parser = createThinkTokenParser((token) => chunker.push(token), onThinkingToken);
        let usage: StreamUsage | undefined;

        // Compatibility bridge: some providers may emit OpenAI-style `delta.tool_calls`
        // even when we are not sending `tools[]` (prompt-engineered mode). Accumulate
        // those deltas and re-emit them as our fenced JSON tool blocks so the existing
        // text-based tool dispatch path still works.
        // Only tool names in KNOWN_TOOL_NAMES are converted — anything else (e.g.
        // Google Gemini's internal "node_source") is silently dropped to prevent
        // leaking raw API data into the chat.

        const pendingNativeToolCalls = new Map<number, { name: string; args: string }>();
        const flushNativeToolCalls = () => {
          if (pendingNativeToolCalls.size === 0) return;
          for (const [, tc] of pendingNativeToolCalls) {
            if (!tc.name && !tc.args) continue;
            if (tc.name) {
              // Only convert tool calls that match our prompt-engineered tool
              // protocol.  Unknown names (e.g. Gemini's "node_source") are
              // internal model machinery — drop them regardless of payload size.
              if (!KNOWN_TOOL_NAMES.has(tc.name)) {
                console.warn(`[Push] Native tool call "${tc.name}" is not a known tool — dropped`);
                continue;
              }
              try {
                const parsedArgs = tc.args ? JSON.parse(tc.args) : {};
                parser.push(
                  `\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: parsedArgs })}\n\`\`\`\n`,
                );
              } catch {
                // If arguments are malformed/incomplete, still emit a tool shell so
                // malformed-call diagnostics can guide the model to retry.
                parser.push(
                  `\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: {} })}\n\`\`\`\n`,
                );
              }
            } else if (tc.args) {
              // No function name — never push raw args directly to the parser.
              // That leaks unformatted API data into the chat output.
              console.warn(
                '[Push] Native tool call with no function name — args dropped:',
                tc.args.slice(0, 200),
              );
            }
          }
          pendingNativeToolCalls.clear();
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunkCount++;
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
              flushNativeToolCalls();
              parser.flush();
              chunker.flush();
              finishSuccess(usage);
              onDone(usage);
              return;
            }

            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed[5] === ' ' ? trimmed.slice(6) : trimmed.slice(5);

            try {
              const parsed = JSON.parse(jsonStr);

              if (parsed.usage) {
                usage = {
                  inputTokens: parsed.usage.prompt_tokens || 0,
                  outputTokens: parsed.usage.completion_tokens || 0,
                  totalTokens: parsed.usage.total_tokens || 0,
                };
                const cacheWrite = parsed.usage.cache_creation_input_tokens;
                const cacheRead = parsed.usage.cache_read_input_tokens;
                if (cacheWrite || cacheRead) {
                  console.log(
                    `[Push] cache — write: ${cacheWrite ?? 0} tokens, read: ${cacheRead ?? 0} tokens`,
                  );
                }
              }

              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const reasoningToken = choice.delta?.reasoning_content;
              if (reasoningToken) {
                thinkingChars += reasoningToken.length;
                onThinkingToken?.(reasoningToken);
                if (shouldResetStallOnReasoning) resetStallTimer();
              }

              const rawToken = choice.delta?.content;
              if (rawToken) {
                // Strip model chat-template control tokens (e.g. <|start|>, <|im_end|>,
                // <|call|>) that some models leak into the content stream.
                const token = rawToken.replace(/<\|[a-z_]+\|>/gi, '');
                if (token) {
                  contentChars += token.length;
                  parser.push(token);
                }
                if (stallTimeoutMs) resetStallTimer();
              }

              // Some providers may emit native tool call deltas even in prompt-engineered mode.
              const toolCalls = choice.delta?.tool_calls;
              if (toolCalls) {
                for (const tc of toolCalls) {
                  const idx = typeof tc.index === 'number' ? tc.index : 0;
                  const fnCall = tc.function;
                  if (!fnCall) continue;
                  if (!pendingNativeToolCalls.has(idx)) {
                    pendingNativeToolCalls.set(idx, { name: '', args: '' });
                    nativeToolCallCount++;
                    console.log(
                      `[Push] Native tool call delta detected (idx=${idx}, name=${fnCall.name || '(none)'})`,
                    );
                  }
                  const entry = pendingNativeToolCalls.get(idx)!;
                  if (typeof fnCall.name === 'string') entry.name = fnCall.name;
                  if (typeof fnCall.arguments === 'string') entry.args += fnCall.arguments;
                }
                if (stallTimeoutMs) resetStallTimer();
              }

              if (checkFinishReason(choice)) {
                flushNativeToolCalls();
                parser.flush();
                chunker.flush();
                finishSuccess(usage);
                onDone(usage);
                return;
              }
            } catch {
              // Skip malformed SSE data
            }
          }
        }

        flushNativeToolCalls();
        parser.flush();
        chunker.flush();
        finishSuccess(usage);
        onDone(usage);
      } catch (err) {
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener('abort', onExternalAbort);

        if (err instanceof DOMException && err.name === 'AbortError') {
          if (abortReason === 'user') {
            setSpanAttributes(span, {
              'push.abort_reason': abortReason,
              'push.cancelled': true,
            });
            onDone();
            return;
          }
          let timeoutMsg: string;
          if (abortReason === 'connect') {
            timeoutMsg = errorMessages.connect(Math.round(connectTimeoutMs / 1000));
          } else if (abortReason === 'stall') {
            timeoutMsg =
              errorMessages.stall?.(Math.round(stallTimeoutMs! / 1000)) ??
              errorMessages.idle(Math.round(idleTimeoutMs / 1000));
          } else if (abortReason === 'total') {
            timeoutMsg =
              errorMessages.total?.(Math.round(totalTimeoutMs! / 1000)) ??
              errorMessages.idle(Math.round(idleTimeoutMs / 1000));
          } else {
            timeoutMsg = errorMessages.idle(Math.round(idleTimeoutMs / 1000));
          }
          recordSpanError(span, new Error(timeoutMsg), {
            'push.abort_reason': abortReason || undefined,
            'push.stream.chunk_count': chunkCount,
            'push.stream.content_chars': contentChars,
            'push.stream.thinking_chars': thinkingChars,
            'push.stream.native_tool_call_count': nativeToolCallCount,
          });
          console.error(`[Push] ${name} timeout (${abortReason}):`, timeoutMsg);
          onError(new Error(timeoutMsg));
          return;
        }

        const msg = err instanceof Error ? err.message : String(err);
        recordSpanError(span, err, {
          'push.abort_reason': abortReason || undefined,
          'push.stream.chunk_count': chunkCount,
          'push.stream.content_chars': contentChars,
          'push.stream.thinking_chars': thinkingChars,
          'push.stream.native_tool_call_count': nativeToolCallCount,
        });
        console.error(`[Push] ${name} chat error:`, msg);
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
          onError(new Error(errorMessages.network));
        } else {
          onError(err instanceof Error ? err : new Error(msg));
        }
      } finally {
        clearTimeout(connectTimer);
        clearTimeout(idleTimer);
        clearTimeout(stallTimer);
        clearTimeout(totalTimer);
        signal?.removeEventListener('abort', onExternalAbort);
        span.end();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Provider streaming — consolidated via registry + factory
  // ---------------------------------------------------------------------------
}
