/**
 * Context helpers for CLI sessions (operates on the CLI's `{ role, content }`
 * message shape with `[TOOL_RESULT]` markers).
 *
 * - `compactContext` — the user-triggered `/compact [turns]`: keep the last N
 *   turns verbatim, condense the rest into a `[CONTEXT DIGEST]` block.
 * - `distillContext` — keep a head + recent tail, drop the middle; bound into
 *   the shared pre-LLM transform (`lib/context-transformer.ts`) as the CLI's
 *   live automatic-trim stage.
 * - Budget + token-estimation re-exports from the shared `lib/context-budget`
 *   runtime so the CLI stays in lockstep with web.
 *
 * The automatic two-budget summarize→drop→hard-trim ladder once lived here as
 * `trimContext` but was a vestigial port (never wired into a live path) and was
 * removed; the live automatic path is `distillContext` + `lead-compaction`. See
 * Agent Runtime Decisions §14. Inputs are never mutated — callers get fresh arrays.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

import {
  type ContextBudget,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTokens,
  getContextBudget,
} from '../lib/context-budget.ts';
import type {
  LlmToolResultBlock,
  LlmToolUseBlock,
  ReasoningBlock,
  ResponsesReasoningItem,
  UrlCitation,
} from '../lib/provider-contract.ts';
import type { DistillResult } from '../lib/context-transformer.ts';

export interface Message {
  role: string;
  content: string;
  /** Plain unsigned assistant reasoning replayed by OpenAI-compatible thinking
   *  routes (`reasoning_content`). Persisted with the visible assistant turn so
   *  a resumed CLI session can reconstruct the provider-authored message. */
  reasoningContent?: string;
  /** Structured signed-reasoning blocks captured from a provider that
   *  returns them (Anthropic). Round-tripped verbatim on the next request
   *  to that provider. Currently no CLI provider exposes signed thinking
   *  end-to-end (OpenRouter does not pass through Anthropic's
   *  `thinking`/`redacted_thinking` blocks today), so this field stays
   *  unused on the CLI hot path; it exists so persistence + adapter
   *  upgrades don't drop data the moment a provider starts surfacing it.
   *  See `ReasoningBlock` in `lib/provider-contract.ts`. */
  reasoningBlocks?: ReasoningBlock[];
  /** Encrypted Responses reasoning items persisted for stateless replay. */
  responsesReasoningItems?: ResponsesReasoningItem[];
  /** Web-search sources surfaced by a provider's native search (OpenRouter's
   *  `openrouter:web_search`). Display-only — rendered as a "Sources" footer
   *  in the terminal, never sent back to the model. Deduped by url. */
  citations?: UrlCitation[];
  /** Structured tool-call sidecar (CLI peer of the web `ChatMessage.toolUses`):
   *  the `tool_use` blocks parsed from this assistant turn, carried alongside the
   *  fenced-JSON text in `content`. Additive + optional; Slice 1 writes this
   *  producer sidecar and Slice 2 consumes it. The web + CLI transcripts MUST
   *  gain this in lockstep so the Anthropic path doesn't regress to text-only
   *  re-parsing on one surface. See
   *  `docs/decisions/Structured Tool-Call Sourcing.md`. */
  toolUses?: LlmToolUseBlock[];
  /** Structured tool-result sidecar — `tool_result` blocks linked to their calls
   *  via `tool_use_id`. Plural for batched calls. Same contract as {@link toolUses}. */
  toolResults?: LlmToolResultBlock[];
}

export interface CompactResult {
  messages: Message[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  removedCount: number;
  compactedCount: number;
  preserveTurns: number;
  totalTurns: number;
}

// Budget + token estimation re-exported from the shared runtime so the CLI
// stays in lockstep with web on context-window heuristics. Local logic below
// (trim/compact/distill) operates on the CLI's `Message` shape, which is
// structurally compatible with `lib/context-budget`'s `TokenEstimationMessage`.
export type { ContextBudget };
export { estimateTokens, estimateMessageTokens, estimateContextTokens, getContextBudget };

function toContentString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Message detection helpers
// ---------------------------------------------------------------------------

export function isToolResultMessage(msg: Message): boolean {
  return msg.role === 'user' && toContentString(msg.content).includes('[TOOL_RESULT]');
}

export function isParseErrorMessage(msg: Message): boolean {
  return msg.role === 'user' && toContentString(msg.content).includes('[TOOL_CALL_PARSE_ERROR]');
}

export function isFirstUserMessage(msg: Message): boolean {
  return msg.role === 'user' && !isToolResultMessage(msg) && !isParseErrorMessage(msg);
}

// ---------------------------------------------------------------------------
// Build context digest from removed messages (manual /compact)
// ---------------------------------------------------------------------------

function buildContextDigest(removed: Message[]): string {
  // Guard: empty case returns simple message (like the old implementation)
  if (removed.length === 0) {
    return [
      '[CONTEXT DIGEST]',
      'Earlier context trimmed for token budget.',
      '[/CONTEXT DIGEST]',
    ].join('\n');
  }

  // Limit to recent 20 messages to avoid unbounded digest growth
  const recent = removed.slice(-20);

  // Build points: normalize whitespace and extract first semantic line only
  const points: string[] = recent.map((msg) => {
    // Get full content and normalize: replace newlines with spaces
    const fullContent = toContentString(msg.content)
      .replace(/[\r\n]+/g, ' ')
      .trim();
    // Extract first ~200 chars as snippet
    const snippet = fullContent.length > 200 ? fullContent.slice(0, 200) + '...' : fullContent;
    return `- ${msg.role === 'user' ? 'User' : 'Assistant'}: ${snippet}`;
  });

  return [
    '[CONTEXT DIGEST]',
    'Earlier messages were condensed to fit the context budget:',
    ...points,
    '[/CONTEXT DIGEST]',
  ].join('\n');
}

function normalizeMessages(messages: Message[]): Message[] {
  return messages.map((msg: Message) => ({
    ...msg,
    content: toContentString(msg.content),
  }));
}

/**
 * User-triggered compaction: replace older messages with a single digest while
 * preserving the system prompt, the first real user message, and the last N
 * real user turns (plus everything after the earliest preserved turn).
 *
 * Returns a CompactResult with messages, stats, and metadata.
 */
export function compactContext(
  messages: Message[],
  options: { preserveTurns?: number } = {},
): CompactResult {
  if (!messages || messages.length === 0) {
    return {
      messages: [],
      compacted: false,
      beforeTokens: 0,
      afterTokens: 0,
      removedCount: 0,
      compactedCount: 0,
      preserveTurns: 0,
      totalTurns: 0,
    };
  }

  const requestedTurns: number = Number.isInteger(options.preserveTurns)
    ? options.preserveTurns!
    : Number.parseInt(String(options.preserveTurns ?? '6'), 10);
  const preserveTurns: number = Number.isFinite(requestedTurns)
    ? Math.max(1, Math.min(64, requestedTurns))
    : 6;

  const normalizedMessages: Message[] = normalizeMessages(messages);
  const beforeTokens: number = estimateContextTokens(normalizedMessages);

  const firstUserIdx: number = normalizedMessages.findIndex((m: Message) => isFirstUserMessage(m));
  const realUserIndices: number[] = [];
  for (let i = 0; i < normalizedMessages.length; i++) {
    if (isFirstUserMessage(normalizedMessages[i])) realUserIndices.push(i);
  }
  const totalTurns: number = realUserIndices.length;

  if (totalTurns <= preserveTurns) {
    return {
      messages: [...normalizedMessages],
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      removedCount: 0,
      compactedCount: 0,
      preserveTurns,
      totalTurns,
    };
  }

  const tailTurnIdx: number = realUserIndices[Math.max(0, totalTurns - preserveTurns)];
  const protectedIdx: Set<number> = new Set();
  if (normalizedMessages[0]?.role === 'system') protectedIdx.add(0);
  if (firstUserIdx >= 0) protectedIdx.add(firstUserIdx);
  for (let i = tailTurnIdx; i < normalizedMessages.length; i++) protectedIdx.add(i);

  const removed: Message[] = [];
  for (let i = 0; i < normalizedMessages.length; i++) {
    if (!protectedIdx.has(i)) removed.push(normalizedMessages[i]);
  }

  if (removed.length === 0) {
    return {
      messages: [...normalizedMessages],
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      removedCount: 0,
      compactedCount: 0,
      preserveTurns,
      totalTurns,
    };
  }

  const digestMessage: Message = { role: 'user', content: buildContextDigest(removed) };
  const kept: Message[] = [];
  let digestInserted: boolean = false;
  for (let i = 0; i < normalizedMessages.length; i++) {
    if (protectedIdx.has(i)) {
      kept.push(normalizedMessages[i]);
      if (!digestInserted && firstUserIdx >= 0 && i === firstUserIdx) {
        kept.push(digestMessage);
        digestInserted = true;
      }
      continue;
    }

    if (!digestInserted && firstUserIdx < 0 && i === 0) {
      kept.push(digestMessage);
      digestInserted = true;
    }
  }
  if (!digestInserted) kept.splice(Math.min(1, kept.length), 0, digestMessage);

  const afterTokens: number = estimateContextTokens(kept);
  return {
    messages: kept,
    compacted: true,
    beforeTokens,
    afterTokens,
    removedCount: normalizedMessages.length - kept.length,
    compactedCount: removed.length,
    preserveTurns,
    totalTurns,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Surgical contextual filtering for agent handoffs.
 * Preserves system prompt, first user message, latest working memory, and tail context.
 *
 * Returns a DistillResult so callers can bind this directly to the
 * `distill` option of `transformContextBeforeLLM`. `distilled` is true
 * when the preserved subset strictly omits messages (length < input).
 */
export function distillContext(
  messages: Message[],
  options: { tailSize?: number } = {},
): DistillResult<Message> {
  if (!messages || messages.length === 0) return { messages: [], distilled: false };

  const tailSize: number = typeof options.tailSize === 'number' ? options.tailSize : 10;
  const normalized: Message[] = normalizeMessages(messages);

  const preservedIndices: Set<number> = new Set();

  // 1. System Prompt
  if (normalized[0]?.role === 'system') {
    preservedIndices.add(0);
  }

  // 2. First User Message (The original request)
  const firstUserIdx = normalized.findIndex((m) => isFirstUserMessage(m));
  if (firstUserIdx >= 0) {
    preservedIndices.add(firstUserIdx);
  }

  // 3. Latest Working Memory update (from coder_update_state)
  let latestMemoryIdx = -1;
  for (let i = normalized.length - 1; i >= 0; i--) {
    if (toContentString(normalized[i].content).includes('"tool": "coder_update_state"')) {
      latestMemoryIdx = i;
      break;
    }
  }
  if (latestMemoryIdx >= 0) {
    preservedIndices.add(latestMemoryIdx);
  }

  // 4. Conversation tail (recent context)
  const tailStart = Math.max(0, normalized.length - tailSize);
  for (let i = tailStart; i < normalized.length; i++) {
    preservedIndices.add(i);
  }

  const preservedMessages: Message[] = Array.from(preservedIndices)
    .sort((a, b) => a - b)
    .map((idx) => normalized[idx]);

  return {
    messages: preservedMessages,
    distilled: preservedMessages.length !== messages.length,
  };
}
