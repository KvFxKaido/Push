import type { ChatMessage } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';
import { SANDBOX_TOOL_PROTOCOL } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { KNOWN_TOOL_NAMES } from './tool-dispatch';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getMistralKey } from '@/hooks/useMistralConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getMinimaxKey } from '@/hooks/useMinimaxConfig';
import { getZaiKey } from '@/hooks/useZaiConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import {
  getOllamaModelName,
  getMistralModelName,
  getPreferredProvider,
  getOpenRouterModelName,
  getMinimaxModelName,
  getZaiModelName,
  getGoogleModelName,
  getZenModelName,
} from './providers';
import type { PreferredProvider } from './providers';
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
  const record = asRecord(parsed);
  if (!record) return fallback;
  const errorValue = record.error;
  if (typeof errorValue === 'string') return errorValue;
  const errorRecord = asRecord(errorValue);
  if (typeof errorRecord?.message === 'string') return errorRecord.message;
  if (includeTopLevelMessage && typeof record.message === 'string') return record.message;
  return fallback;
}

function hasFinishReason(choice: unknown, reasons: string[]): boolean {
  const record = asRecord(choice);
  const finishReason = record?.finish_reason;
  return typeof finishReason === 'string' && reasons.includes(finishReason);
}


// Ollama Cloud: OpenAI-compatible endpoint.
// Dev: Vite proxy avoids CORS. Prod: Cloudflare Worker proxy at /api/ollama/chat.
const OLLAMA_API_URL = import.meta.env.DEV
  ? '/ollama/v1/chat/completions'
  : '/api/ollama/chat';

// Mistral Vibe: OpenAI-compatible endpoint (Devstral models).
// Dev: Vite proxy avoids CORS. Prod: Cloudflare Worker proxy at /api/mistral/chat.
const MISTRAL_API_URL = import.meta.env.DEV
  ? '/mistral/v1/chat/completions'
  : '/api/mistral/chat';

// Z.AI coding endpoint (OpenAI-compatible).
const ZAI_API_URL = import.meta.env.DEV
  ? '/zai/api/coding/paas/v4/chat/completions'
  : '/api/zai/chat';

// MiniMax OpenAI-compatible endpoint.
const MINIMAX_API_URL = import.meta.env.DEV
  ? '/minimax/v1/chat/completions'
  : '/api/minimax/chat';

// Google Gemini OpenAI-compatible endpoint.
const GOOGLE_API_URL = import.meta.env.DEV
  ? '/google/v1beta/openai/chat/completions'
  : '/api/google/chat';

// OpenCode Zen OpenAI-compatible endpoint.
const ZEN_API_URL = import.meta.env.DEV
  ? '/opencode/zen/v1/chat/completions'
  : '/api/zen/chat';

/** Reset hook retained for compatibility with providers.ts model setter callback. */
export function resetMistralAgent(): void {
  // Native function-calling path no longer uses Mistral Agents API state.
}

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

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

const GEMINI_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GEMINI_CONTEXT_MAX_TOKENS,
  targetTokens: GEMINI_CONTEXT_TARGET_TOKENS,
};

function normalizeModelName(model?: string): string {
  return (model || '').trim().toLowerCase();
}

export function getContextBudget(
  provider?: 'ollama' | 'mistral' | 'openrouter' | 'minimax' | 'zai' | 'google' | 'zen' | 'demo',
  model?: string,
): ContextBudget {
  // Google provider always runs Gemini models — full 1M budget
  if (provider === 'google') {
    return GEMINI_CONTEXT_BUDGET;
  }

  // Ollama, OpenRouter, or Zen running a Gemini model — same 1M budget
  const normalizedModel = normalizeModelName(model);
  if (
    (provider === 'ollama' || provider === 'openrouter' || provider === 'zen') &&
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
 * Estimate token count from text. ~4 chars per token for English/code.
 * This is intentionally conservative (slightly over-estimates) so we
 * don't accidentally blow past the real limit.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
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

/**
 * Compress a tool result message into a compact summary.
 * Keeps the tool name and key stats, drops verbose content (file listings,
 * full code, raw diffs) that consumed the most tokens.
 */
function summarizeToolResult(msg: ChatMessage): ChatMessage {
  const lines = msg.content.split('\n');

  // Extract tool header line like "[Tool Result — sandbox_exec]"
  const headerLine = lines.find(l => l.startsWith('[Tool Result')) || lines[0] || '';

  // Keep first 4 non-empty lines after header (usually contain key stats)
  const statLines: string[] = [];
  for (const line of lines.slice(1)) {
    if (statLines.length >= 4) break;
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('```')) {
      statLines.push(trimmed);
    }
  }

  const summary = [headerLine, ...statLines, '[...summarized]'].join('\n');
  return { ...msg, content: summary };
}

function summarizeVerboseMessage(msg: ChatMessage): ChatMessage {
  if (msg.content.length < 1200) return msg;

  const lines = msg.content.split('\n').map((l) => l.trim()).filter(Boolean);
  const preview = lines.slice(0, 4).map((l) => (l.length > 180 ? l.slice(0, 180) + '...' : l));
  const summary = [...preview, '[...summarized]'].join('\n');
  return { ...msg, content: summary };
}

function buildContextDigest(removed: ChatMessage[]): string {
  const points: string[] = [];

  for (const msg of removed) {
    if (points.length >= 18) break;

    if (msg.isToolResult) {
      const header = msg.content.split('\n').find((l) => l.startsWith('[Tool Result')) || '';
      if (header) points.push(`- ${header}`);
      continue;
    }

    if (msg.isToolCall) {
      points.push('- Tool call executed in earlier context.');
      continue;
    }

    const firstLine = msg.content.split('\n').map((l) => l.trim()).find(Boolean) || '';
    if (!firstLine) continue;
    const snippet = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
    points.push(`- ${msg.role === 'user' ? 'User' : 'Assistant'}: ${snippet}`);
  }

  if (points.length === 0) {
    points.push('- Earlier context trimmed for token budget.');
  }

  return [
    '[CONTEXT DIGEST]',
    'Earlier messages were condensed to fit the context budget.',
    ...points,
    '[/CONTEXT DIGEST]',
  ].join('\n');
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
function manageContext(messages: ChatMessage[], budget: ContextBudget = DEFAULT_CONTEXT_BUDGET): ChatMessage[] {
  if (getContextMode() === 'none') {
    return messages;
  }

  const totalTokens = estimateContextTokens(messages);

  // Under target — keep everything
  if (totalTokens <= budget.targetTokens) {
    return messages;
  }

  // Find first user message index (to pin it)
  const firstUserIdx = messages.findIndex(m => m.role === 'user' && !m.isToolResult);

  // Phase 1: Summarize old verbose content (walk from oldest to newest, skip recent 14)
  const result = [...messages];
  const recentBoundary = Math.max(0, result.length - 14);
  let currentTokens = totalTokens;

  for (let i = 0; i < recentBoundary && currentTokens > budget.targetTokens; i++) {
    const msg = result[i];
    const before = estimateMessageTokens(msg);
    const summarized = msg.isToolResult ? summarizeToolResult(msg) : summarizeVerboseMessage(msg);
    const after = estimateMessageTokens(summarized);
    result[i] = summarized;
    currentTokens -= (before - after);
  }

  if (currentTokens <= budget.targetTokens) {
    console.log(`[Push] Context managed via summarization: ${totalTokens} → ${currentTokens} tokens`);
    return result;
  }

  // Phase 2: Remove oldest non-pinned messages with a digest fallback.
  const tailStart = Math.max(0, result.length - 14);
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
    console.log(`[Push] Context managed (hard fallback): ${totalTokens} → ${estimateContextTokens(hardResult)} tokens`);
    return hardResult;
  }

  console.log(`[Push] Context managed with digest: ${totalTokens} → ${estimateContextTokens(kept)} tokens (${messages.length} → ${kept.length} messages)`);
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
- Branching etiquette: only use create_branch when explicitly asked or as a confirmed part of a user-initiated task. Avoid proactive branching for "safety" unless requested. When you create a branch, inform the user the UI will switch automatically to the new context.

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
- Prioritize correctness over optimization.`;

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
  workspaceContext?: string,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  providerType?: 'ollama' | 'mistral' | 'openrouter' | 'minimax' | 'zai' | 'google' | 'zen',
  providerModel?: string,
): LLMMessage[] {
  // When a systemPromptOverride is provided (Auditor, Coder), the caller has already
  // composed a complete system prompt — don't append Orchestrator-specific protocols.
  let systemContent: string;

  if (systemPromptOverride) {
    systemContent = systemPromptOverride;
  } else {
    systemContent = ORCHESTRATOR_SYSTEM_PROMPT;

    // Inject user identity (name, bio) when configured
    const identityBlock = buildUserIdentityBlock(getUserProfile());
    if (identityBlock) {
      systemContent += '\n\n' + identityBlock;
    }

    if (workspaceContext) {
      systemContent += '\n\n' + workspaceContext + '\n' + TOOL_PROTOCOL;
      if (hasSandbox) {
        systemContent += '\n' + SANDBOX_TOOL_PROTOCOL;
      }
    } else if (hasSandbox) {
      // Sandbox mode (no repo): include sandbox tools with ephemeral preamble, no GitHub tools
      systemContent += '\n\nYou are in **Sandbox Mode** — an ephemeral Linux workspace with no GitHub repo connected.'
        + ' You have full access to the sandbox filesystem and can create, edit, and run files freely.'
        + ' Nothing is saved or committed unless the user explicitly downloads their work.'
        + ' Be a collaborative thinking partner: surface assumptions, propose structure, iterate freely.'
        + '\n' + SANDBOX_TOOL_PROTOCOL;
    }

    // Scratchpad context and tools
    systemContent += '\n' + SCRATCHPAD_TOOL_PROTOCOL;
    if (scratchpadContent !== undefined) {
      systemContent += '\n\n' + buildScratchpadContext(scratchpadContent);
    }

    // Web search tool — prompt-engineered, all providers use client-side dispatch
    systemContent += '\n' + WEB_SEARCH_TOOL_PROTOCOL;

    // Ask-user tool — structured questions with tap-friendly options
    systemContent += '\n' + ASK_USER_TOOL_PROTOCOL;
  }

  const llmMessages: LLMMessage[] = [
    providerType === "openrouter" 
      ? { role: "system", content: [{ type: "text", text: systemContent, cache_control: { type: "ephemeral" } }] as LLMMessageContent[] }
      : { role: "system", content: systemContent },
  ];

  // Smart context management — summarize old messages instead of dropping
  const contextBudget = getContextBudget(providerType, providerModel);
  const windowedMessages = manageContext(messages, contextBudget);

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

  // Prompt Caching for OpenRouter: cache the entire prefix up to the last user message
  if (providerType === "openrouter" && llmMessages.length > 0) {
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
  providerType?: 'ollama' | 'mistral' | 'openrouter' | 'minimax' | 'zai' | 'google' | 'zen';
  /** Override the fetch URL (e.g., Mistral Agents API uses a different endpoint) */
  apiUrlOverride?: string;
  /** Transform the request body before sending (e.g., swap model for agent_id) */
  bodyTransform?: (body: Record<string, unknown>) => Record<string, unknown>;
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
  workspaceContext?: string,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
  autoRetry?: AutoRetryConfig,
): Promise<void> {
  const maxAttempts = autoRetry?.maxAttempts ?? 1;
  const backoffMs = autoRetry?.backoffMs ?? 1000;
  
  let lastError: Error | undefined;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await streamSSEChatOnce(
        config, messages, onToken, onDone, onError, onThinkingToken,
        workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent, signal,
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
  workspaceContext?: string,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
): Promise<void> {
  const {
    name,
    apiUrl,
    apiKey,
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
    console.log(`[Push] POST ${requestUrl} (model: ${model})`);

    let requestBody: Record<string, unknown> = {
      model,
      messages: toLLMMessages(messages, workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent, providerType, model),
      stream: true,
    };

    if (bodyTransform) {
      requestBody = bodyTransform(requestBody);
    }

    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
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
      throw new Error(`${name} ${response.status}: ${detail}`);
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
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const reasoningToken = choice.delta?.reasoning_content;
          if (reasoningToken) {
            onThinkingToken?.(reasoningToken);
            if (shouldResetStallOnReasoning) resetStallTimer();
          }

          const token = choice.delta?.content;
          if (token) {
            parser.push(token);
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
const STANDARD_TIMEOUTS = { connectTimeoutMs: 30_000, idleTimeoutMs: 60_000, stallTimeoutMs: 30_000, totalTimeoutMs: 180_000 } as const;

interface ProviderStreamEntry {
  getKey: () => string | null;
  buildConfig: (apiKey: string, modelOverride?: string) => Promise<StreamProviderConfig> | StreamProviderConfig;
}

const PROVIDER_STREAM_CONFIGS: Record<string, ProviderStreamEntry> = {
  ollama: {
    getKey: getOllamaKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Ollama Cloud',
      apiUrl: OLLAMA_API_URL,
      apiKey,
      model: modelOverride || getOllamaModelName(),
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      stallTimeoutMs: 30_000,
      totalTimeoutMs: 180_000,
      errorMessages: buildErrorMessages('Ollama Cloud', 'server may be cold-starting.'),
      parseError: (p, f) => parseProviderError(p, f),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'end_turn', 'length', 'tool_calls', 'function_call']),
      shouldResetStallOnReasoning: true,
      providerType: 'ollama',
    }),
  },
  mistral: {
    getKey: getMistralKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Mistral',
      apiUrl: MISTRAL_API_URL,
      apiKey,
      model: modelOverride || getMistralModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Mistral'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'end_turn', 'length', 'tool_calls', 'function_call']),
      providerType: 'mistral' as const,
    }),
  },
  openrouter: {
    getKey: getOpenRouterKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'OpenRouter',
      apiUrl: '/api/openrouter/chat',
      apiKey,
      model: modelOverride || getOpenRouterModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('OpenRouter'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'openrouter',
    }),
  },
  minimax: {
    getKey: getMinimaxKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'MiniMax',
      apiUrl: MINIMAX_API_URL,
      apiKey,
      model: modelOverride || getMinimaxModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('MiniMax'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'minimax',
    }),
  },
  zai: {
    getKey: getZaiKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Z.AI',
      apiUrl: ZAI_API_URL,
      apiKey,
      model: modelOverride || getZaiModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Z.AI'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'zai',
    }),
  },
  google: {
    getKey: getGoogleKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'Google',
      apiUrl: GOOGLE_API_URL,
      apiKey,
      model: modelOverride || getGoogleModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('Google'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'google',
    }),
  },
  zen: {
    getKey: getZenKey,
    buildConfig: (apiKey, modelOverride) => ({
      name: 'OpenCode Zen',
      apiUrl: ZEN_API_URL,
      apiKey,
      model: modelOverride || getZenModelName(),
      ...STANDARD_TIMEOUTS,
      errorMessages: buildErrorMessages('OpenCode Zen'),
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length', 'end_turn', 'tool_calls', 'function_call']),
      providerType: 'zen',
    }),
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
  workspaceContext?: string,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
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

  const config = await entry.buildConfig(apiKey, modelOverride);

  return streamSSEChat(
    config, messages, onToken, onDone, onError, onThinkingToken,
    workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent, signal,
  );
}

// --- Thin wrappers preserving existing exports ---

type StreamChatFn = (
  messages: ChatMessage[],
  onToken: (token: string, meta?: ChunkMetadata) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
  signal?: AbortSignal,
) => Promise<void>;

export const streamOllamaChat: StreamChatFn = (...args) => streamProviderChat('ollama', ...args);
export const streamMistralChat: StreamChatFn = (...args) => streamProviderChat('mistral', ...args);
export const streamOpenRouterChat: StreamChatFn = (...args) => streamProviderChat('openrouter', ...args);
export const streamMinimaxChat: StreamChatFn = (...args) => streamProviderChat('minimax', ...args);
export const streamZaiChat: StreamChatFn = (...args) => streamProviderChat('zai', ...args);
export const streamGoogleChat: StreamChatFn = (...args) => streamProviderChat('google', ...args);
export const streamZenChat: StreamChatFn = (...args) => streamProviderChat('zen', ...args);

// ---------------------------------------------------------------------------
// Active provider detection
// ---------------------------------------------------------------------------

export type ActiveProvider = 'ollama' | 'mistral' | 'openrouter' | 'minimax' | 'zai' | 'google' | 'zen' | 'demo';

/** Key getter for each configurable provider. */
const PROVIDER_KEY_GETTERS: Record<PreferredProvider, () => string | null> = {
  ollama:      getOllamaKey,
  mistral:     getMistralKey,
  openrouter:  getOpenRouterKey,
  minimax:     getMinimaxKey,
  zai:         getZaiKey,
  google:      getGoogleKey,
  zen:         getZenKey,
};

/**
 * Fallback order when no preference is set (or the preferred key is gone).
 */
const PROVIDER_FALLBACK_ORDER: PreferredProvider[] = [
  'zen', 'minimax', 'ollama', 'mistral', 'openrouter', 'zai', 'google',
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

  // Honour explicit preference when the key is available
  if (preferred && PROVIDER_KEY_GETTERS[preferred]()) return preferred;

  // No preference (or preferred key was removed) — first available
  for (const p of PROVIDER_FALLBACK_ORDER) {
    if (PROVIDER_KEY_GETTERS[p]()) return p;
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
    case 'mistral': return { providerType: 'mistral' as const, streamFn: streamMistralChat };
    case 'openrouter': return { providerType: 'openrouter' as const, streamFn: streamOpenRouterChat };
    case 'minimax': return { providerType: 'minimax' as const, streamFn: streamMinimaxChat };
    case 'zai': return { providerType: 'zai' as const, streamFn: streamZaiChat };
    case 'google': return { providerType: 'google' as const, streamFn: streamGoogleChat };
    case 'zen': return { providerType: 'zen' as const, streamFn: streamZenChat };
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
  workspaceContext?: string,
  hasSandbox?: boolean,
  scratchpadContent?: string,
  signal?: AbortSignal,
  providerOverride?: ActiveProvider,
  modelOverride?: string,
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
    return streamOllamaChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  if (provider === 'mistral') {
    return streamMistralChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  if (provider === 'openrouter') {
    return streamOpenRouterChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  if (provider === 'minimax') {
    return streamMinimaxChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  if (provider === 'zai') {
    return streamZaiChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  if (provider === 'google') {
    return streamGoogleChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  if (provider === 'zen') {
    return streamZenChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  return streamOllamaChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
}
