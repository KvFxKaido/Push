import type { ChatMessage } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';
import { SANDBOX_TOOL_PROTOCOL } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import { getMoonshotKey } from '@/hooks/useMoonshotKey';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getMistralKey } from '@/hooks/useMistralConfig';
import { getZaiKey } from '@/hooks/useZaiConfig';
import { getUserProfile } from '@/hooks/useUserProfile';
import type { UserProfile } from '@/types';
import { getOllamaModelName, getMistralModelName, getPreferredProvider, getZaiModelName } from './providers';
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


// ---------------------------------------------------------------------------
// Kimi For Coding config
// ---------------------------------------------------------------------------

// Dev: Vite proxy avoids CORS. Prod: Cloudflare Worker proxy at /api/kimi/chat.
const KIMI_API_URL = import.meta.env.DEV
  ? '/kimi/coding/v1/chat/completions'
  : '/api/kimi/chat';
const KIMI_MODEL = 'k2p5';

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

const ZAI_API_URL = import.meta.env.DEV
  ? '/zai/api/paas/v4/chat/completions'
  : '/api/zai/chat';

// Mistral Agents API — enables native web search via agent with web_search tool.
// Dev: Vite proxy rewrites /mistral/ → https://api.mistral.ai/.
// Prod: Worker routes /api/mistral/agents* → api.mistral.ai/v1/agents*.
const MISTRAL_AGENTS_CREATE_URL = import.meta.env.DEV
  ? '/mistral/v1/agents'
  : '/api/mistral/agents';
const MISTRAL_AGENTS_COMPLETIONS_URL = import.meta.env.DEV
  ? '/mistral/v1/agents/completions'
  : '/api/mistral/agents/chat';

// Cached Mistral agent — created once per model, reused across requests
let mistralAgentId: string | null = null;
let mistralAgentModel: string | null = null;

/**
 * Ensure a Mistral agent exists with web_search enabled.
 * Returns the cached agent_id, or creates one if needed.
 */
async function ensureMistralAgent(apiKey: string, model: string): Promise<string> {
  // Return cached agent if model hasn't changed
  if (mistralAgentId && mistralAgentModel === model) {
    return mistralAgentId;
  }

  const response = await fetch(MISTRAL_AGENTS_CREATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      name: 'push-orchestrator',
      tools: [{ type: 'web_search' }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    console.error('[Push] Mistral agent creation failed:', response.status, errBody.slice(0, 200));
    throw new Error(`Failed to create Mistral agent: ${response.status}`);
  }

  const data = (await response.json()) as { id: string };
  mistralAgentId = data.id;
  mistralAgentModel = model;
  console.log(`[Push] Created Mistral agent: ${mistralAgentId} (model: ${model})`);
  return mistralAgentId;
}

/** Clear cached Mistral agent (call when user changes model in Settings). */
export function resetMistralAgent(): void {
  mistralAgentId = null;
  mistralAgentModel = null;
}

// Context mode config (runtime toggle from Settings)
const CONTEXT_MODE_STORAGE_KEY = 'push_context_mode';
export type ContextMode = 'graceful' | 'none';

// Rolling window config — token-based context management
const DEFAULT_CONTEXT_MAX_TOKENS = 100_000; // Hard cap
const DEFAULT_CONTEXT_TARGET_TOKENS = 88_000; // Soft target leaves room for system prompt + response
const KIMI_CONTEXT_MAX_TOKENS = 180_000;
const KIMI_CONTEXT_TARGET_TOKENS = 156_000;
const GEMINI3_FLASH_CONTEXT_MAX_TOKENS = 128_000;
const GEMINI3_FLASH_CONTEXT_TARGET_TOKENS = 112_000;

export interface ContextBudget {
  maxTokens: number;
  targetTokens: number;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: DEFAULT_CONTEXT_MAX_TOKENS,
  targetTokens: DEFAULT_CONTEXT_TARGET_TOKENS,
};

const KIMI_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: KIMI_CONTEXT_MAX_TOKENS,
  targetTokens: KIMI_CONTEXT_TARGET_TOKENS,
};

const GEMINI3_FLASH_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: GEMINI3_FLASH_CONTEXT_MAX_TOKENS,
  targetTokens: GEMINI3_FLASH_CONTEXT_TARGET_TOKENS,
};

function normalizeModelName(model?: string): string {
  return (model || '').trim().toLowerCase();
}

export function getContextBudget(
  provider?: 'moonshot' | 'ollama' | 'mistral' | 'zai' | 'demo',
  model?: string,
): ContextBudget {
  const normalizedModel = normalizeModelName(model);

  if (
    provider === 'moonshot' ||
    normalizedModel === 'k2p5' ||
    normalizedModel === 'k2.5' ||
    normalizedModel.includes('kimi')
  ) {
    return KIMI_CONTEXT_BUDGET;
  }

  if (
    provider === 'ollama' &&
    (normalizedModel === 'gemini-3-flash-preview' || normalizedModel.includes('gemini-3-flash'))
  ) {
    return GEMINI3_FLASH_CONTEXT_BUDGET;
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

Error recovery:
- If a tool result contains an error, diagnose it and retry with corrected arguments — don't just report the error.
- Never claim a task is complete unless a tool result confirms success.
- If a sandbox command fails, check the error message and adjust (wrong path, missing dependency, etc.).`;

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
  providerType?: 'moonshot' | 'ollama' | 'mistral' | 'zai',
  providerModel?: string,
): LLMMessage[] {
  // Build system prompt: base + user identity + workspace context + tool protocol + optional sandbox tools + scratchpad
  let systemContent = systemPromptOverride || ORCHESTRATOR_SYSTEM_PROMPT;

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

  // Always include scratchpad context and tools (even if empty)
  systemContent += '\n' + SCRATCHPAD_TOOL_PROTOCOL;
  if (scratchpadContent !== undefined) {
    systemContent += '\n\n' + buildScratchpadContext(scratchpadContent);
  }

  // Web search tool — prompt-engineered for providers that need client-side dispatch.
  // Ollama: model outputs JSON → we execute via Ollama's search REST API.
  // Kimi (moonshot): model outputs JSON → we execute via free DuckDuckGo SERP.
  // Mistral: handles search natively via Agents API (no prompt needed here).
  if (providerType === 'ollama' || providerType === 'moonshot' || providerType === 'zai') {
    systemContent += '\n' + WEB_SEARCH_TOOL_PROTOCOL;
  }

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: systemContent },
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
  providerType?: 'moonshot' | 'ollama' | 'mistral' | 'zai';
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

          // Handle native tool calls (Ollama may route these separately even when
          // tools array is not sent in the request)
          const toolCalls = choice.delta?.tool_calls;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const fnCall = tc.function;
              if (fnCall?.name || fnCall?.arguments) {
                // Convert back to text so Push's text-based tool protocol can parse it
                const text = fnCall.arguments || '';
                if (text) parser.push(text);
              }
            }
            if (stallTimeoutMs) resetStallTimer();
          }

          if (checkFinishReason(choice)) {
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
// Kimi For Coding streaming (SSE — OpenAI-compatible)
// ---------------------------------------------------------------------------

}

export async function streamMoonshotChat(
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
  const apiKey = getMoonshotKey();
  if (!apiKey) {
    onError(new Error('Moonshot API key not configured'));
    return;
  }

  return streamSSEChat(
    {
      name: 'Moonshot',
      apiUrl: KIMI_API_URL,
      apiKey,
      model: modelOverride || KIMI_MODEL,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
      errorMessages: {
        keyMissing: 'Moonshot API key not configured',
        connect: (s) => `Kimi API didn't respond within ${s}s — server may be down.`,
        idle: (s) => `Kimi API stream stalled — no data for ${s}s.`,
        network: 'Cannot reach Moonshot — network error. Check your connection.',
      },
      parseError: (p, f) => parseProviderError(p, f),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'end_turn', 'tool_calls']),
      providerType: 'moonshot',
    },
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    systemPromptOverride,
    scratchpadContent,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Ollama Cloud streaming (SSE — OpenAI-compatible)
// ---------------------------------------------------------------------------

export async function streamOllamaChat(
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
  const apiKey = getOllamaKey();
  if (!apiKey) {
    onError(new Error('Ollama Cloud API key not configured'));
    return;
  }

  return streamSSEChat(
    {
      name: 'Ollama Cloud',
      apiUrl: OLLAMA_API_URL,
      apiKey,
      model: modelOverride || getOllamaModelName(),
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 45_000,
      stallTimeoutMs: 30_000,
      totalTimeoutMs: 180_000,
      errorMessages: {
        keyMissing: 'Ollama Cloud API key not configured',
        connect: (s) => `Ollama Cloud didn't respond within ${s}s — server may be cold-starting.`,
        idle: (s) => `Ollama Cloud stream stalled — no data for ${s}s.`,
        stall: (s) => `Ollama Cloud stream stalled — receiving data but no content for ${s}s. The model may be stuck.`,
        total: (s) => `Ollama Cloud response exceeded ${s}s total time limit.`,
        network: 'Cannot reach Ollama Cloud — network error. Check your connection.',
      },
      parseError: (p, f) => parseProviderError(p, f),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'end_turn', 'length']),
      shouldResetStallOnReasoning: true,
      providerType: 'ollama',
    },
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    systemPromptOverride,
    scratchpadContent,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Mistral Vibe streaming (SSE — OpenAI-compatible)
// ---------------------------------------------------------------------------

export async function streamMistralChat(
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
  const apiKey = getMistralKey();
  if (!apiKey) {
    onError(new Error('Mistral API key not configured'));
    return;
  }

  const model = modelOverride || getMistralModelName();

  // Try to create/reuse a Mistral agent with web_search for native search.
  // On failure, fall back to regular chat completions (no search but chat works).
  let agentApiUrl: string | undefined;
  let agentBodyTransform: ((body: Record<string, unknown>) => Record<string, unknown>) | undefined;

  try {
    const agentId = await ensureMistralAgent(apiKey, model);
    agentApiUrl = MISTRAL_AGENTS_COMPLETIONS_URL;
    agentBodyTransform = (body) => ({
      agent_id: agentId,
      messages: body.messages,
      stream: true,
    });
  } catch (err) {
    console.warn('[Push] Mistral agent creation failed, falling back to chat completions:', err);
  }

  return streamSSEChat(
    {
      name: 'Mistral',
      apiUrl: MISTRAL_API_URL,
      apiKey,
      model,
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
      stallTimeoutMs: 30_000,
      totalTimeoutMs: 180_000,
      errorMessages: {
        keyMissing: 'Mistral API key not configured',
        connect: (s) => `Mistral API didn't respond within ${s}s — server may be down.`,
        idle: (s) => `Mistral API stream stalled — no data for ${s}s.`,
        stall: (s) => `Mistral API stream stalled — receiving data but no content for ${s}s. The model may be stuck.`,
        total: (s) => `Mistral API response exceeded ${s}s total time limit.`,
        network: 'Cannot reach Mistral — network error. Check your connection.',
      },
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'end_turn', 'length']),
      providerType: 'mistral',
      apiUrlOverride: agentApiUrl,
      bodyTransform: agentBodyTransform,
    },
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    systemPromptOverride,
    scratchpadContent,
    signal,
  );
}



/**
 * Generate a JWT for the Z.ai (ZhipuAI) API from an API key in `{id}.{secret}` format.
 * Z.ai requires HMAC-SHA256 signed JWTs instead of raw Bearer tokens.
 */
async function generateZaiJWT(apiKey: string): Promise<string> {
  const normalized = apiKey.trim().replace(/^Bearer\s+/i, '');
  const segments = normalized.split('.');

  if (segments.length === 3) {
    // Already a JWT
    return normalized;
  }

  const dotIndex = normalized.indexOf('.');
  if (dotIndex === -1) {
    // Not in id.secret format — return as-is
    return normalized;
  }

  const id = normalized.slice(0, dotIndex);
  const secret = normalized.slice(dotIndex + 1);
  const now = Date.now();

  const encodeBase64Url = (str: string): string =>
    btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const header = JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' });
  const payload = JSON.stringify({ api_key: id, exp: now + 3_600_000, timestamp: now });
  const signingInput = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput)));
  const encodedSig = encodeBase64Url(Array.from(sig, (b) => String.fromCharCode(b)).join(''));

  return `${signingInput}.${encodedSig}`;
}

export async function streamZaiChat(
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
  const apiKey = getZaiKey();
  if (!apiKey) {
    onError(new Error('Z.ai API key not configured'));
    return;
  }

  // Z.ai requires JWT auth — generate from the {id}.{secret} API key
  const jwt = await generateZaiJWT(apiKey);

  return streamSSEChat(
    {
      name: 'Z.ai',
      apiUrl: ZAI_API_URL,
      apiKey: jwt,
      model: modelOverride || getZaiModelName(),
      connectTimeoutMs: 30_000,
      idleTimeoutMs: 60_000,
      stallTimeoutMs: 30_000,
      totalTimeoutMs: 180_000,
      errorMessages: {
        keyMissing: 'Z.ai API key not configured',
        connect: (s) => `Z.ai API didn't respond within ${s}s — server may be down.`,
        idle: (s) => `Z.ai API stream stalled — no data for ${s}s.`,
        stall: (s) => `Z.ai API stream stalled — receiving data but no content for ${s}s. The model may be stuck.`,
        total: (s) => `Z.ai API response exceeded ${s}s total time limit.`,
        network: 'Cannot reach Z.ai — network error. Check your connection.',
      },
      parseError: (p, f) => parseProviderError(p, f, true),
      checkFinishReason: (c) => hasFinishReason(c, ['stop', 'length']),
      providerType: 'zai',
    },
    messages,
    onToken,
    onDone,
    onError,
    onThinkingToken,
    workspaceContext,
    hasSandbox,
    systemPromptOverride,
    scratchpadContent,
    signal,
  );
}

// ---------------------------------------------------------------------------
// Active provider detection
// ---------------------------------------------------------------------------

export type ActiveProvider = 'moonshot' | 'ollama' | 'mistral' | 'zai' | 'demo';

/**
 * Determine which provider is active.
 *
 * 1. If the user set a preference AND that provider has a key → use it.
 * 2. Otherwise, use whichever provider has a key (Kimi checked first for
 *    backwards compat — existing users already have a Kimi key).
 * 3. No keys → demo.
 */
export function getActiveProvider(): ActiveProvider {
  const preferred = getPreferredProvider();
  const hasOllama = Boolean(getOllamaKey());
  const hasKimi = Boolean(getMoonshotKey());
  const hasMistral = Boolean(getMistralKey());
  const hasZai = Boolean(getZaiKey());

  // Honour explicit preference when the key is available
  if (preferred === 'ollama' && hasOllama) return 'ollama';
  if (preferred === 'moonshot' && hasKimi) return 'moonshot';
  if (preferred === 'mistral' && hasMistral) return 'mistral';
  if (preferred === 'zai' && hasZai) return 'zai';

  // No preference (or preferred key was removed) — first available
  if (hasKimi) return 'moonshot';
  if (hasOllama) return 'ollama';
  if (hasMistral) return 'mistral';
  if (hasZai) return 'zai';
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
    case 'zai': return { providerType: 'zai' as const, streamFn: streamZaiChat };
    default:        return { providerType: 'moonshot' as const, streamFn: streamMoonshotChat };
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

  if (provider === 'zai') {
    return streamZaiChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
  }

  return streamMoonshotChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, modelOverride, undefined, scratchpadContent, signal);
}
