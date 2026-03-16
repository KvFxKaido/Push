import type { AIProviderType, ChatMessage, WorkspaceContext } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';
import { getSandboxToolProtocol } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { openRouterModelSupportsReasoning, getReasoningEffort } from './model-catalog';
import { recordContextMetric } from './context-metrics';
import type { SummarizationCause } from './context-metrics';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getNvidiaKey } from '@/hooks/useNvidiaConfig';
import {
  getAzureBaseUrl,
  getAzureKey,
  getAzureModelName,
  getBedrockBaseUrl,
  getBedrockKey,
  getBedrockModelName,
} from '@/hooks/useExperimentalProviderConfig';
import {
  getVertexKey,
  getVertexModelName,
  getVertexBaseUrl,
  getVertexMode,
  getVertexRegion,
} from '@/hooks/useVertexConfig';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import {
  getOllamaModelName,
  getPreferredProvider,
  getOpenRouterModelName,
  getZenModelName,
  getNvidiaModelName,
  PROVIDER_URLS,
} from './providers';
import type { PreferredProvider } from './providers';
import { buildExperimentalProxyHeaders, normalizeExperimentalBaseUrl } from './experimental-providers';
import { extractProviderErrorDetail } from './provider-error-utils';
import { encodeVertexServiceAccountHeader, normalizeVertexRegion } from './vertex-provider';
import { buildContextSummaryBlock, compactChatMessage } from './context-compaction';
import { REQUEST_ID_HEADER, createRequestId } from './request-id';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ChunkMetadata {
  chunkIndex: number;
}

import { asRecord } from './utils';

function parseProviderError(parsed: unknown, fallback: string, includeTopLevelMessage = false): string {
  return extractProviderErrorDetail(parsed, fallback, includeTopLevelMessage);
}

function hasFinishReason(choice: unknown, reasons: string[]): boolean {
  const record = asRecord(choice);
  const finishReason = record?.finish_reason;
  return typeof finishReason === 'string' && reasons.includes(finishReason);
}


// Provider chat URLs are now centralised in PROVIDER_URLS (providers.ts).


// Context mode config (runtime toggle from Settings)
const CONTEXT_MODE_STORAGE_KEY = 'push_context_mode';
export type ContextMode = 'graceful' | 'none';

// Rolling window config — token-based context management
const DEFAULT_CONTEXT_MAX_TOKENS = 100_000; // Hard cap
const DEFAULT_CONTEXT_TARGET_TOKENS = 88_000; // Soft target leaves room for system prompt + response
// Gemini models (1M context window) — Google, Ollama, OpenRouter, and Zen with Gemini models
// Keep a ~20% margin below the 1,048,576 API limit because estimateTokens (len/3.5) can
// undercount on code-dense or CJK-heavy conversations.
const GEMINI_CONTEXT_MAX_TOKENS = 850_000;
const GEMINI_CONTEXT_TARGET_TOKENS = 800_000;
// GPT-5.4 models expose a large context window, but we keep a more conservative
// target than Grok because long prompts are materially more expensive.
const GPT5_PRO_CONTEXT_MAX_TOKENS = 850_000;
const GPT5_PRO_CONTEXT_TARGET_TOKENS = 725_000;
const GPT5_PRO_CONTEXT_SUMMARIZE_TOKENS = 160_000;
// Grok models on OpenRouter can expose ~2M context. Keep a larger margin than
// Gemini because token estimation is rough and our tool/system prompt overhead is
// substantial on long-running sessions.
const GROK_CONTEXT_MAX_TOKENS = 1_500_000;
const GROK_CONTEXT_TARGET_TOKENS = 1_350_000;
const GROK_CONTEXT_SUMMARIZE_TOKENS = 180_000;

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
  /** Threshold at which old tool results get summarized. Decoupled from
   *  targetTokens so large-context models (Gemini) still get lean working
   *  context without premature message dropping. */
  summarizeTokens: number;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS, // same as target for non-Gemini
};

const GEMINI_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GEMINI_CONTEXT_MAX_TOKENS,
  targetTokens: GEMINI_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS, // summarize early like other providers
};

const CLAUDE_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GEMINI_CONTEXT_MAX_TOKENS,
  targetTokens: GEMINI_CONTEXT_TARGET_TOKENS,
  summarizeTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

const GPT5_PRO_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GPT5_PRO_CONTEXT_MAX_TOKENS,
  targetTokens: GPT5_PRO_CONTEXT_TARGET_TOKENS,
  summarizeTokens: GPT5_PRO_CONTEXT_SUMMARIZE_TOKENS,
};

const GROK_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GROK_CONTEXT_MAX_TOKENS,
  targetTokens: GROK_CONTEXT_TARGET_TOKENS,
  summarizeTokens: GROK_CONTEXT_SUMMARIZE_TOKENS,
};

function normalizeModelName(model?: string): string {
  return (model || '').trim().toLowerCase();
}

export function getContextBudget(
  provider?: AIProviderType,
  model?: string,
): ContextBudget {
  const normalizedModel = normalizeModelName(model);
  // GPT-5.4 models get a large-context profile, but with a conservative target
  // to avoid turning long sessions into runaway expensive prompts.
  if (normalizedModel.includes('gpt-5.4')) {
    return GPT5_PRO_CONTEXT_BUDGET;
  }

  // Non-Haiku Claude models get the larger 1M-class profile.
  if (normalizedModel.includes('claude') && !normalizedModel.includes('haiku')) {
    return CLAUDE_CONTEXT_BUDGET;
  }

  // OpenRouter or other providers running a Grok model — larger long-term
  // history, but still summarize well before the hard cap.
  if (normalizedModel.includes('grok')) {
    return GROK_CONTEXT_BUDGET;
  }

  // Ollama, OpenRouter, or Zen running a Gemini model — full 1M budget
  if (
    (provider === 'ollama'
      || provider === 'openrouter'
      || provider === 'zen'
      || provider === 'vertex') &&
    normalizedModel.includes('gemini')
  ) {
    return GEMINI_CONTEXT_BUDGET;
  }

  return DEFAULT_CONTEXT_BUDGET;
}

export function getContextMode(): ContextMode {
  try {
    const stored = localStorage.getItem(CONTEXT_MODE_STORAGE_KEY);
    if (stored === 'none') return 'none';
  } catch {
    // ignore storage errors
  }
  return 'graceful';
}

export function setContextMode(mode: ContextMode): void {
  try {
    localStorage.setItem(CONTEXT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Token Estimation — rough heuristic, no tokenizer dependency
// ---------------------------------------------------------------------------

/**
 * Estimate token count from text using content-aware heuristics.
 *
 * Different content types tokenize at different rates:
 * - Dense code (brackets, operators, short names): ~3.0 chars/token
 * - Mixed code/prose (tool results, diffs): ~3.5 chars/token
 * - English prose: ~4.0 chars/token
 * - CJK / non-ASCII text: ~1.5 chars/token (each char is typically its own token)
 *
 * We sample the text to pick an appropriate ratio instead of using a single
 * fixed divisor.  Still conservative (slightly over-estimates) to avoid
 * blowing past real limits.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;

  // For short text, the overhead of sampling isn't worth it
  if (len < 200) return Math.ceil(len / 3.2);

  // Sample up to 500 chars from the middle of the text to classify content
  const sampleStart = Math.max(0, Math.floor(len / 2) - 250);
  const sample = text.slice(sampleStart, sampleStart + 500);

  // Count content signals
  const nonAsciiCount = (sample.match(/[^\u0020-\u007E\n\r\t]/g) || []).length;
  const codeSymbolCount = (sample.match(/[{}()[\];=<>|&!+\-*/^~@#$%]/g) || []).length;
  const sampleLen = sample.length;

  // High non-ASCII ratio → CJK/emoji-heavy, each char ≈ 1 token
  if (nonAsciiCount / sampleLen > 0.3) {
    // Blend: non-ASCII chars at 1.5, ASCII chars at 3.5
    const nonAsciiRatio = nonAsciiCount / sampleLen;
    const blendedRate = nonAsciiRatio * 1.5 + (1 - nonAsciiRatio) * 3.5;
    return Math.ceil(len / blendedRate);
  }

  // High code-symbol density → dense code, tighter tokenization
  if (codeSymbolCount / sampleLen > 0.12) {
    return Math.ceil(len / 3.0);
  }

  // Default: mixed content
  return Math.ceil(len / 3.5);
}

function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = estimateTokens(msg.content) + 4; // 4 tokens overhead per message
  if (msg.thinking) tokens += estimateTokens(msg.thinking);
  if (msg.attachments) {
    for (const att of msg.attachments) {
      if (att.type === 'image') tokens += 1000; // rough estimate for vision
      else tokens += estimateTokens(att.content);
    }
  }
  return tokens;
}

/**
 * Estimate total tokens for an array of chat messages.
 * Exported so useChat can expose context usage to the UI.
 */
export function estimateContextTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
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
function classifySummarizationCause(messages: ChatMessage[], recentBoundary: number): SummarizationCause {
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
  const firstUserIdx = messages.findIndex(m => m.role === 'user' && !m.isToolResult);

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
    currentTokens -= (before - after);
  }

  // Phase 2: Remove oldest non-pinned messages with a digest fallback.
  // Only drop messages when over the (potentially much higher) targetTokens —
  // for Gemini this means we summarize at 88K but only drop at 800K.
  if (currentTokens <= budget.targetTokens) {
    const cause = classifySummarizationCause(messages, recentBoundary);
    recordContextMetric({ phase: 'summarization', beforeTokens: totalTokens, afterTokens: currentTokens, provider, cause });
    console.log(`[Push] Context managed via summarization: ${totalTokens} → ${currentTokens} tokens`);
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
    if (result[i].isToolCall && i + 1 < result.length && result[i + 1]?.isToolResult && !protectedIdx.has(i + 1)) {
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
    recordContextMetric({ phase: 'hard_trim', beforeTokens: totalTokens, afterTokens: hardAfter, provider, messagesDropped: messages.length - hardResult.length });
    console.log(`[Push] Context managed (hard fallback): ${totalTokens} → ${hardAfter} tokens`);
    return hardResult;
  }

  const keptTokens = estimateContextTokens(kept);
  recordContextMetric({ phase: 'digest_drop', beforeTokens: totalTokens, afterTokens: keptTokens, provider, messagesDropped: toRemove.size });
  console.log(`[Push] Context managed with digest: ${totalTokens} → ${keptTokens} tokens (${messages.length} → ${kept.length} messages)`);
  return kept;
}

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SYSTEM_PROMPT = `Push is a mobile AI coding agent with direct GitHub repo access. You are its conversational interface — helping developers review PRs, understand codebases, and ship changes from their phone.

Voice:
- Concise but warm. Short paragraphs, clear structure — this is mobile.
- Explain your reasoning briefly. Don't just state conclusions.
- Light personality is fine. You're helpful, not robotic.
- Use markdown for code snippets. Keep responses scannable.
- Vary your openings. Never start with "I".

Boundaries:
- If you don't know something, say so. Don't guess.
- You only know about the active repo. Never mention other repos — the user controls that via UI.
- All questions about "the repo", PRs, or changes refer to the active repo. Period.
- Branch creation is UI-owned. If the user wants a new branch, tell them to use the Create branch action in Home or the branch menu. Do not try to create or switch branches yourself.

## Tool Execution Model

You can emit multiple tool calls in one response. The runtime splits them into parallel reads and an optional trailing mutation:
- Read-only calls (read_file, sandbox_read_file, sandbox_search, list_directory, sandbox_list_dir, sandbox_diff, fetch_pr, list_prs, list_commits, search_files, list_commit_files, fetch_checks, list_branches, get_workflow_runs, get_workflow_logs, check_pr_mergeable, find_existing_pr) execute in parallel.
- If you include a mutating call (edit, write, exec, commit, push, delegate, ask_user, etc.), place it LAST — it runs after all reads complete.
- Maximum 6 parallel read-only calls per turn. If you need more, split across turns.

## Tool Routing

- Use **sandbox tools** for local operations: reading/editing code, running commands, tests, type checks, diffs, commits.
- Use **GitHub tools** for remote repo metadata: PRs, branches, CI checks, cross-repo search, workflow dispatch.
- Prefer sandbox_search over search_files for code in the active repo — it's faster and reflects local edits.
- Prefer sandbox_read_file over read_file when the sandbox is active — it reflects uncommitted changes.

## Error Handling

Tool results may include structured error fields: error_type and retryable.

Error types and how to respond:
- FILE_NOT_FOUND → Check the path. Use sandbox_list_dir or list_directory to verify it exists.
- EXEC_TIMEOUT → Simplify the command or break it into smaller steps.
- EXEC_NON_ZERO_EXIT → Read the error output, fix the issue, retry.
- EDIT_HASH_MISMATCH → File changed since you read it. Re-read, then re-edit.
- EDIT_CONTENT_NOT_FOUND → The ref hash doesn't match any line. Re-read the file to get current hashes.
- STALE_FILE → Re-read the file to get the current version, then retry.
- AUTH_FAILURE → Inform the user; don't retry.
- RATE_LIMITED (retryable: true) → Wait briefly, then retry once.
- SANDBOX_UNREACHABLE → Inform the user the sandbox may have expired.

General rules:
- If retryable: false, pivot to a different approach — don't repeat the same call.
- If retryable: true, you may retry 1–2 times with corrected arguments.
- Never claim a task is complete unless a tool result confirms success.
- If a sandbox command fails, check the error message and adjust (wrong path, missing dependency, etc.).

## Efficient Delegation with File Context

When delegating coding tasks to the Coder via delegate_coder, significantly improve efficiency by passing relevant file context:

1. Scan conversation history for your previous tool calls (read_file, grep_file, search_files, list_directory).
2. Identify file paths from arguments.
3. Include them in the delegate_coder "files" array.

Example:
If you read "src/auth.ts", use:
{"tool": "delegate_coder", "args": { "task": "...", "files": ["src/auth.ts"] }}

Rules:
- Only include files actually read in this conversation.
- Don't guess. If unsure, omit the files field.
- Prioritize correctness over optimization.

## Multi-Task Delegation

For multiple independent coding tasks in a single request, use the "tasks" array instead of "task":
{"tool": "delegate_coder", "args": { "tasks": ["add dark mode toggle to SettingsPage", "refactor logger utility to support log levels"], "files": ["src/settings.tsx", "src/lib/logger.ts"] }}

Rules for multi-task delegation:
- Each task must be independently completable — no task should depend on another task's output. If tasks have dependencies, use separate sequential delegate_coder calls instead.
- Up to 3 tasks run in parallel in isolated worker sandboxes (snapshot-based). More than 3 tasks fall back to sequential execution in the main sandbox.
- Parallel results are NOT auto-merged — the user will see a note about this.
- If parallel setup fails (e.g. sandbox quota), the system falls back to sequential execution automatically.
- Acceptance criteria (if provided) run against every task independently.
- All tasks share the same "files", "intent", and "constraints" context.

## When to Delegate vs Handle Directly

Delegate to the Coder when the task requires:
- Multiple files are involved
- New abstractions are introduced or structural refactors (e.g., extracting functions, modifying interfaces) are required
- Running commands — tests, type checks, builds, installs
- An iterative read → edit → verify loop
- Exploratory changes where the full scope is unclear upfront

Handle directly (no delegation) when:
- The request is read-only: explaining code, reviewing a PR diff, answering structure questions
- The change is confined to a single file, stays self-contained, and is a small adjustment (roughly under ~20 lines) that does not require new architecture, multi-step verification, or command execution
- You only need one or two tool calls and have the relevant content in context`;

const DEMO_WELCOME = `Welcome to **Push** — your AI coding agent with direct repo access.

Here's what I can help with:

- **Review PRs** — paste a GitHub PR link and I'll analyze it
- **Explore repos** — ask about any repo's structure, recent changes, or open issues
- **Ship changes** — describe what you want changed and I'll draft the code
- **Monitor pipelines** — check CI/CD status and deployment health

Connect your GitHub account in settings to get started, or just ask me anything about code.`;

// Multimodal content types (OpenAI-compatible)
interface LLMMessageContentText {
  type: 'text';
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface LLMMessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

type LLMMessageContent = LLMMessageContentText | LLMMessageContentImage;

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMMessageContent[];
}

function isNonEmptyContent(content: string | LLMMessageContent[]): boolean {
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content.trim().length > 0;
}

/**
 * Build a compact identity block for the system prompt.
 * Returns empty string when no identity fields are set.
 */
export function buildUserIdentityBlock(profile?: UserProfile): string {
  const hasName = Boolean(profile?.displayName?.trim());
  const hasGitHub = Boolean(profile?.githubLogin?.trim());
  const hasBio = Boolean(profile?.bio?.trim());
  if (!profile || (!hasName && !hasGitHub && !hasBio)) return '';

  const lines = ['## User Identity'];
  if (hasName) {
    lines.push(`Name: ${profile.displayName.trim()}`);
  }
  if (hasGitHub) {
    lines.push(`GitHub: @${profile.githubLogin}`);
  }
  if (hasBio) {
    // Escape delimiter-breaking attempts (same pattern as scratchpad)
    const escaped = profile.bio.trim()
      .replace(/\[USER IDENTITY\]/gi, '[USER IDENTITY\u200B]')
      .replace(/\[\/USER IDENTITY\]/gi, '[/USER IDENTITY\u200B]');
    lines.push(`Context: ${escaped}`);
  }
  return lines.join('\n');
}

function toLLMMessages(
  messages: ChatMessage[],
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  providerType?: 'ollama' | 'openrouter' | 'zen' | 'nvidia' | 'azure' | 'bedrock' | 'vertex',
  providerModel?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): LLMMessage[] {
  // When a systemPromptOverride is provided (Auditor, Coder), the caller has already
  // composed a complete system prompt — don't append Orchestrator-specific protocols.
  let systemContent: string;

  if (systemPromptOverride) {
    systemContent = systemPromptOverride;
  } else {
    systemContent = ORCHESTRATOR_SYSTEM_PROMPT;

    // --- Prompt-size telemetry (dev only) ---
    const _promptSizes: Record<string, number> = import.meta.env.DEV
      ? { base: ORCHESTRATOR_SYSTEM_PROMPT.length }
      : {};

    // Inject user identity (name, bio) when configured
    const identityBlock = buildUserIdentityBlock(getUserProfile());
    if (identityBlock) {
      systemContent += '\n\n' + identityBlock;
      if (import.meta.env.DEV) _promptSizes.identity = identityBlock.length;
    }

    // Workspace description (always present for active workspaces)
    if (workspaceContext) {
      systemContent += '\n\n' + workspaceContext.description;
      if (import.meta.env.DEV) _promptSizes.workspace = workspaceContext.description.length;

      // GitHub tools only when workspace has repo context
      if (workspaceContext.includeGitHubTools) {
        systemContent += '\n' + TOOL_PROTOCOL;
        if (import.meta.env.DEV) _promptSizes.tools = TOOL_PROTOCOL.length;
      }
    }

    // Sandbox tools (always included when a sandbox is active)
    if (hasSandbox) {
      const sandboxProto = getSandboxToolProtocol();
      systemContent += '\n' + sandboxProto;
      if (import.meta.env.DEV) _promptSizes.sandbox = sandboxProto.length;
    }

    // Scratchpad context and tools
    systemContent += '\n' + SCRATCHPAD_TOOL_PROTOCOL;
    if (import.meta.env.DEV) _promptSizes.scratchpad = SCRATCHPAD_TOOL_PROTOCOL.length;
    if (scratchpadContent !== undefined) {
      const scratchpadCtx = buildScratchpadContext(scratchpadContent);
      systemContent += '\n\n' + scratchpadCtx;
      if (import.meta.env.DEV) _promptSizes.scratchpad = (_promptSizes.scratchpad || 0) + scratchpadCtx.length;
    }

    // Web search tool — prompt-engineered, all providers use client-side dispatch
    systemContent += '\n' + WEB_SEARCH_TOOL_PROTOCOL;
    if (import.meta.env.DEV) _promptSizes.websearch = WEB_SEARCH_TOOL_PROTOCOL.length;

    // Ask-user tool — structured questions with tap-friendly options
    systemContent += '\n' + ASK_USER_TOOL_PROTOCOL;
    if (import.meta.env.DEV) _promptSizes.askuser = ASK_USER_TOOL_PROTOCOL.length;

    // --- Log prompt-size breakdown (dev only) ---
    if (import.meta.env.DEV) {
      const fmt = (n: number) => n.toLocaleString();
      const parts = Object.entries(_promptSizes)
        .map(([k, v]) => `${k}=${fmt(v)}`)
        .join(' ');
      console.log(`[Context Budget] System prompt: ${fmt(systemContent.length)} chars (${parts})`);
    }
  }

  // Prompt caching: wrap the system message as a content-array with cache_control
  // for providers that support it (currently OpenRouter/Anthropic). Other
  // providers harmlessly ignore the extra field.
  const cacheable = providerType === 'openrouter';
  const llmMessages: LLMMessage[] = [
    cacheable
      ? { role: "system", content: [{ type: "text", text: systemContent, cache_control: { type: "ephemeral" } }] as LLMMessageContent[] }
      : { role: "system", content: systemContent },
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
      if (llmMessages[i].role === "user") {
        const lastMsg = llmMessages[i];
        if (typeof lastMsg.content === "string") {
          lastMsg.content = [{ type: "text", text: lastMsg.content, cache_control: { type: "ephemeral" } }];
        } else if (Array.isArray(lastMsg.content)) {
          // Already an array (e.g. from attachments), tag the last part
          const lastPart = lastMsg.content[lastMsg.content.length - 1];
          if (lastPart.type === "text") {
            lastPart.cache_control = { type: "ephemeral" };
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
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 4;  // Min chars before emitting
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

interface StreamProviderConfig {
  name: string;
  apiUrl: string;
  apiKey: string;
  authHeader?: string | null;
  model: string;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
  errorMessages: {
    keyMissing: string;
    connect: (seconds: number) => string;
    idle: (seconds: number) => string;
    stall?: (seconds: number) => string;
    total?: (seconds: number) => string;
    network: string;
  };
  parseError: (parsed: unknown, fallback: string) => string;
  checkFinishReason: (choice: unknown) => boolean;
  shouldResetStallOnReasoning?: boolean;
  /** Provider identity — used to conditionally inject provider-specific tool protocols */
  providerType?: 'ollama' | 'openrouter' | 'zen' | 'nvidia' | 'azure' | 'bedrock' | 'vertex';
  /** Override the fetch URL (e.g., for providers with alternate endpoints) */
  apiUrlOverride?: string;
  /** Transform the request body before sending (e.g., swap model for agent_id) */
  bodyTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Extra headers required by proxy adapters. */
  extraHeaders?: Record<string, string>;
}

interface AutoRetryConfig {
  maxAttempts?: number;
  backoffMs?: number;
}


async function streamSSEChat(
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
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await streamSSEChatOnce(
        config, messages, onToken, onDone, onError, onThinkingToken,
        workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent, signal, onPreCompact,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      // Don't retry on auth errors or user aborts
      if (lastError.message.includes('key') || lastError.message.includes('auth') || 
          lastError.message.includes('Unauthorized') || signal?.aborted) {
        throw lastError;
      }
      
      // Check if this is a timeout error worth retrying
      const isTimeout = lastError.message.includes('timeout') || 
                        lastError.message.includes('stall') ||
                        lastError.message.includes('no data');
      
      if (attempt < maxAttempts && isTimeout) {
        console.log(`[Push] Retry attempt ${attempt}/${maxAttempts} after ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs * attempt));
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

  try {
    const requestUrl = apiUrlOverride || apiUrl;
    const requestId = createRequestId('chat');
    console.log(`[Push] POST ${requestUrl} (model: ${model}, request: ${requestId})`);

    let requestBody: Record<string, unknown> = {
      model,
      messages: toLLMMessages(messages, workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent, providerType, model, onPreCompact),
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
            parser.push(`\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: parsedArgs })}\n\`\`\`\n`);
          } catch {
            // If arguments are malformed/incomplete, still emit a tool shell so
            // malformed-call diagnostics can guide the model to retry.
            parser.push(`\n\`\`\`json\n${JSON.stringify({ tool: tc.name, args: {} })}\n\`\`\`\n`);
          }
        } else if (tc.args) {
          // No function name — never push raw args directly to the parser.
          // That leaks unformatted API data into the chat output.
          console.warn('[Push] Native tool call with no function name — args dropped:', tc.args.slice(0, 200));
        }
      }
      pendingNativeToolCalls.clear();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
              console.log(`[Push] cache — write: ${cacheWrite ?? 0} tokens, read: ${cacheRead ?? 0} tokens`);
            }
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const reasoningToken = choice.delta?.reasoning_content;
          if (reasoningToken) {
            onThinkingToken?.(reasoningToken);
            if (shouldResetStallOnReasoning) resetStallTimer();
          }

          const rawToken = choice.delta?.content;
          if (rawToken) {
            // Strip model chat-template control tokens (e.g. <|start|>, <|im_end|>,
            // <|call|>) that some models leak into the content stream.
            const token = rawToken.replace(/<\|[a-z_]+\|>/gi, '');
            if (token) parser.push(token);
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
                console.log(`[Push] Native tool call delta detected (idx=${idx}, name=${fnCall.name || '(none)'})`);
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
    onDone(usage);
  } catch (err) {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);

    if (err instanceof DOMException && err.name === 'AbortError') {
      if (abortReason === 'user') {
        onDone();
        return;
      }
      let timeoutMsg: string;
      if (abortReason === 'connect') {
        timeoutMsg = errorMessages.connect(Math.round(connectTimeoutMs / 1000));
      } else if (abortReason === 'stall') {
        timeoutMsg = errorMessages.stall?.(Math.round(stallTimeoutMs! / 1000)) ?? errorMessages.idle(Math.round(idleTimeoutMs / 1000));
      } else if (abortReason === 'total') {
        timeoutMsg = errorMessages.total?.(Math.round(totalTimeoutMs! / 1000)) ?? errorMessages.idle(Math.round(idleTimeoutMs / 1000));
      } else {
        timeoutMsg = errorMessages.idle(Math.round(idleTimeoutMs / 1000));
      }
      console.error(`[Push] ${name} timeout (${abortReason}):`, timeoutMsg);
      onError(new Error(timeoutMsg));
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
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
  }


// ---------------------------------------------------------------------------
// Provider streaming — consolidated via registry + factory
// ---------------------------------------------------------------------------

}

/** Build a standard set of timeout error messages for a provider. */
function buildErrorMessages(name: string, connectHint = 'server may be down.'): StreamProviderConfig['errorMessages'] {
  return {
    keyMissing: `${name} API key not configured`,
    connect: (s) => `${name} API didn't respond within ${s}s — ${connectHint}`,
    idle: (s) => `${name} API stream stalled — no data for ${s}s.`,
    stall: (s) => `${name} API stream stalled — receiving data but no content for ${s}s. The model may be stuck.`,
    total: (s) => `${name} API response exceeded ${s}s total time limit.`,
    network: `Cannot reach ${name} — network error. Check your connection.`,
  };
}

/** Standard timeout config used by most providers. */
const STANDARD_TIMEOUTS = { connectTimeoutMs: 30_000, idleTimeoutMs: 60_000, stallTimeoutMs: 60_000, totalTimeoutMs: 180_000 } as const;

interface ProviderStreamEntry {
  getKey: () => string | null;
  buildConfig: (apiKey: string, modelOverride?: string) => Promise<StreamProviderConfig> | StreamProviderConfig;
}

function buildExperimentalStreamConfig(
  provider: 'azure' | 'bedrock' | 'vertex',
  name: string,
  apiKey: string,
  baseUrl: string,
  model: string,
): StreamProviderConfig {
  const headers = buildExperimentalProxyHeaders(provider, baseUrl);
  if (!headers['X-Push-Upstream-Base']) {
    throw new Error(`${name} base URL is missing or invalid`);
  }

  return {
    name,
    apiUrl: PROVIDER_URLS[provider].chat,
    apiKey,
    model,
    ...STANDARD_TIMEOUTS,
    errorMessages: buildErrorMessages(name),
    parseError: (p, f) => parseProviderError(p, f, true),
    checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
    providerType: provider,
    extraHeaders: headers,
    shouldResetStallOnReasoning: true,
  };
}

function buildVertexStreamConfig(modelOverride?: string): StreamProviderConfig {
  const mode = getVertexMode();
  const model = modelOverride || getVertexModelName();

  if (mode === 'legacy') {
    const legacyKey = getVertexKey();
    if (!legacyKey) {
      throw new Error('Google Vertex credentials are missing');
    }
    return buildExperimentalStreamConfig(
      'vertex',
      'Google Vertex',
      legacyKey,
      getVertexBaseUrl(),
      model,
    );
  }

  const serviceAccount = getVertexKey();
  if (!serviceAccount) {
    throw new Error('Google Vertex service account is missing');
  }
  const encodedServiceAccount = encodeVertexServiceAccountHeader(serviceAccount);
  if (!encodedServiceAccount) {
    throw new Error('Google Vertex service account is invalid');
  }

  const region = getVertexRegion();
  const normalizedRegion = normalizeVertexRegion(region);
  if (!normalizedRegion.ok) {
    throw new Error(normalizedRegion.error);
  }

  return {
    name: 'Google Vertex',
    apiUrl: PROVIDER_URLS.vertex.chat,
    apiKey: '',
    authHeader: null,
    model,
    ...STANDARD_TIMEOUTS,
    errorMessages: buildErrorMessages('Google Vertex'),
    parseError: (p, f) => parseProviderError(p, f, true),
    checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
    providerType: 'vertex',
    extraHeaders: {
      'X-Push-Vertex-Service-Account': encodedServiceAccount,
      'X-Push-Vertex-Region': normalizedRegion.normalized,
    },
  };
}

const PROVIDER_STREAM_CONFIGS: Record<string, ProviderStreamEntry> = {
  ollama: {
    getKey: getOllamaKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Ollama Cloud',
      apiUrl: PROVIDER_URLS.ollama.chat,
      apiKey,
      model: modelOverride || getOllamaModelName(),
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      stallTimeoutMs: 60_000,
      totalTimeoutMs: 180_000,
      errorMessages: buildErrorMessages('Ollama Cloud', 'server may be cold-starting.'),
      parseError: (p, f) => parseProviderError(p, f),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'end_turn', 'length', 'tool_calls', 'function_call']),
      shouldResetStallOnReasoning: true,
      providerType: 'ollama',
    }),
  },
  openrouter: {
    getKey: getOpenRouterKey,
    buildConfig: (apiKey, modelOverride) => {
      const model = modelOverride || getOpenRouterModelName();
      const supportsReasoning = openRouterModelSupportsReasoning(model);
      const effort = getReasoningEffort('openrouter');
      const useReasoning = supportsReasoning && effort !== 'off';
      return {
        name: 'OpenRouter',
        apiUrl: PROVIDER_URLS.openrouter.chat,
        apiKey,
        model,
        ...STANDARD_TIMEOUTS,
        errorMessages: buildErrorMessages('OpenRouter'),
        parseError: (p, f) => parseProviderError(p, f, true),
        checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
        providerType: 'openrouter',
        shouldResetStallOnReasoning: useReasoning,
        bodyTransform: useReasoning
          ? (body) => ({ ...body, reasoning: { effort } })
          : undefined,
      };
    },
  },
  zen: {
    getKey: getZenKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'OpenCode Zen',
      apiUrl: PROVIDER_URLS.zen.chat,
      apiKey,
      model: modelOverride || getZenModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('OpenCode Zen'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'zen',
    }),
  },
  nvidia: {
    getKey: getNvidiaKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Nvidia NIM',
      apiUrl: PROVIDER_URLS.nvidia.chat,
      apiKey,
      model: modelOverride || getNvidiaModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Nvidia NIM'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'nvidia',
    }),
  },
  azure: {
    getKey: getAzureKey,
    buildConfig: (apiKey, modelOverride) => buildExperimentalStreamConfig(
      'azure',
      'Azure OpenAI',
      apiKey,
      getAzureBaseUrl(),
      modelOverride || getAzureModelName(),
    ),
  },
  bedrock: {
    getKey: getBedrockKey,
    buildConfig: (apiKey, modelOverride) => buildExperimentalStreamConfig(
      'bedrock',
      'AWS Bedrock',
      apiKey,
      getBedrockBaseUrl(),
      modelOverride || getBedrockModelName(),
    ),
  },
  vertex: {
    getKey: getVertexKey,
    buildConfig: (_apiKey, modelOverride) => buildVertexStreamConfig(modelOverride),
  },
};

/** Core streaming function — looks up provider config and delegates to streamSSEChat. */
async function streamProviderChat(
  providerType: string,
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): Promise<void> {
  const entry = PROVIDER_STREAM_CONFIGS[providerType];
  if (!entry) {
    onError(new Error(`Unknown provider: ${providerType}`));
    return;
  }

  const apiKey = entry.getKey();
  if (!apiKey) {
    onError(new Error(`${providerType.charAt(0).toUpperCase() + providerType.slice(1)} API key not configured`));
    return;
  }

  let config: StreamProviderConfig;
  try {
    config = await entry.buildConfig(apiKey, modelOverride);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  return streamSSEChat(
    config, messages, onToken, onDone, onError, onThinkingToken,
    workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent, signal, undefined, onPreCompact,
  );
}

// --- Thin wrappers preserving existing exports ---

type StreamChatFn = (
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
) => Promise<void>;

export const streamOllamaChat: StreamChatFn = (...args) => streamProviderChat('ollama', ...args);
export const streamOpenRouterChat: StreamChatFn = (...args) => streamProviderChat('openrouter', ...args);
export const streamZenChat: StreamChatFn = (...args) => streamProviderChat('zen', ...args);
export const streamNvidiaChat: StreamChatFn = (...args) => streamProviderChat('nvidia', ...args);
export const streamAzureChat: StreamChatFn = (...args) => streamProviderChat('azure', ...args);
export const streamBedrockChat: StreamChatFn = (...args) => streamProviderChat('bedrock', ...args);
export const streamVertexChat: StreamChatFn = (...args) => streamProviderChat('vertex', ...args);

// ---------------------------------------------------------------------------
// Active provider detection
// ---------------------------------------------------------------------------

export type ActiveProvider =
  | 'ollama'
  | 'openrouter'
  | 'zen'
  | 'nvidia'
  | 'azure'
  | 'bedrock'
  | 'vertex'
  | 'demo';

const PROVIDER_READY_CHECKS: Record<PreferredProvider, () => boolean> = {
  ollama: () => Boolean(getOllamaKey()),
  openrouter: () => Boolean(getOpenRouterKey()),
  zen: () => Boolean(getZenKey()),
  nvidia: () => Boolean(getNvidiaKey()),
  azure: () => Boolean(getAzureKey() && normalizeExperimentalBaseUrl('azure', getAzureBaseUrl()).ok && getAzureModelName()),
  bedrock: () => Boolean(getBedrockKey() && normalizeExperimentalBaseUrl('bedrock', getBedrockBaseUrl()).ok && getBedrockModelName()),
  vertex: () => {
    const mode = getVertexMode();
    if (mode === 'native') {
      return Boolean(getVertexKey() && normalizeVertexRegion(getVertexRegion()).ok && getVertexModelName());
    }
    return Boolean(getVertexKey() && normalizeExperimentalBaseUrl('vertex', getVertexBaseUrl()).ok && getVertexModelName());
  },
};

/**
 * Fallback order when no preference is set (or the preferred key is gone).
 */
const PROVIDER_FALLBACK_ORDER: PreferredProvider[] = [
  'zen', 'ollama', 'openrouter', 'nvidia',
];

/**
 * Determine which provider is active.
 *
 * 1. If the user set a preference AND that provider has a key → use it.
 * 2. Otherwise, use whichever provider has a key (first available wins).
 * 3. No keys → demo.
 */
export function getActiveProvider(): ActiveProvider {
  const preferred = getPreferredProvider();

  // Honour explicit preference when the provider is fully configured.
  if (preferred && PROVIDER_READY_CHECKS[preferred]()) return preferred;

  // No preference (or preferred key was removed) — first available
  for (const p of PROVIDER_FALLBACK_ORDER) {
    if (PROVIDER_READY_CHECKS[p]()) return p;
  }
  return 'demo';
}

/**
 * Map an active provider to its stream function and provider type.
 * Centralises the provider → function routing used by Coder / Auditor agents.
 */
export function getProviderStreamFn(provider: ActiveProvider) {
  switch (provider) {
    case 'ollama':  return { providerType: 'ollama' as const,  streamFn: streamOllamaChat };
    case 'openrouter': return { providerType: 'openrouter' as const, streamFn: streamOpenRouterChat };
    case 'zen': return { providerType: 'zen' as const, streamFn: streamZenChat };
    case 'nvidia': return { providerType: 'nvidia' as const, streamFn: streamNvidiaChat };
    case 'azure': return { providerType: 'azure' as const, streamFn: streamAzureChat };
    case 'bedrock': return { providerType: 'bedrock' as const, streamFn: streamBedrockChat };
    case 'vertex': return { providerType: 'vertex' as const, streamFn: streamVertexChat };
    default:        return { providerType: 'ollama' as const, streamFn: streamOllamaChat };
  }
}

// ---------------------------------------------------------------------------
// Public router — picks the right provider at runtime
// ---------------------------------------------------------------------------

export async function streamChat(
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: WorkspaceContext,
  hasSandbox?: boolean,
  scratchpadContent?: string,
  signal?: AbortSignal,
  providerOverride?: ActiveProvider,
  modelOverride?: string,
  onPreCompact?: (event: import('@/types').PreCompactEvent) => void,
): Promise<void> {
  const provider = providerOverride || getActiveProvider();

  // Demo mode: no API keys in dev → show welcome message
  if (provider === 'demo' && import.meta.env.DEV) {
    const words = DEMO_WELCOME.split(' ');
    let chunkIndex = 0;
    for (let i = 0; i < words.length; i++) {
      chunkIndex++;
      await new Promise((r) => setTimeout(r, 12));
      onToken(words[i] + (i < words.length - 1 ? ' ' : ''), { chunkIndex });
    }
    onDone();
    return;
  }

  if (provider === 'ollama') {
    return streamOllamaChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  if (provider === 'openrouter') {
    return streamOpenRouterChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  if (provider === 'zen') {
    return streamZenChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  if (provider === 'nvidia') {
    return streamNvidiaChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  if (provider === 'azure') {
    return streamAzureChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  if (provider === 'bedrock') {
    return streamBedrockChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  if (provider === 'vertex') {
    return streamVertexChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
  }

  return streamOllamaChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal, onPreCompact);
}
