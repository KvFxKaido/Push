/**
 * Context trimming for CLI sessions.
 *
 * Ports the web app's multi-phase strategy (orchestrator.ts) for the CLI's
 * simpler message format ({ role, content } with [TOOL_RESULT] markers).
 *
 * Three phases:
 *   1. Summarize — compress old tool results and verbose messages
 *   2. Remove pairs — drop oldest assistant + tool-result pairs, insert digest
 *   3. Hard fallback — splice from index 1 until under maxTokens
 *
 * The input array is never mutated; trimContext returns a fresh copy.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface Message {
  role: string;
  content: string;
}

export interface TrimResult {
  messages: Message[];
  trimmed: boolean;
  beforeTokens: number;
  afterTokens: number;
  removedCount: number;
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

export interface ContextBudget {
  targetTokens: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Token estimation (same heuristic as web app — orchestrator.ts:187-213)
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: ~3.5 chars per token for English/code.
 * Intentionally conservative (slightly over-estimates).
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 3.5);
}

function toContentString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function estimateMessageTokens(msg: Message): number {
  return estimateTokens(toContentString(msg.content)) + 4; // 4-token per-message overhead
}

export function estimateContextTokens(messages: Message[]): number {
  let total: number = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Budget resolution
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET: ContextBudget = { targetTokens: 88_000, maxTokens: 100_000 };
// Gemini models (1M context window) — Ollama, OpenRouter, and Zen with Gemini models
const GEMINI_BUDGET: ContextBudget = { targetTokens: 900_000, maxTokens: 950_000 };

export function getContextBudget(providerId: string, model: string): ContextBudget {
  // Ollama, OpenRouter, or Zen running a Gemini model — full 1M budget
  const normalized: string = (model || '').trim().toLowerCase();
  if (
    (providerId === 'ollama' || providerId === 'openrouter' || providerId === 'zen') &&
    normalized.includes('gemini')
  ) {
    return { ...GEMINI_BUDGET };
  }

  return { ...DEFAULT_BUDGET };
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

function isFirstUserMessage(msg: Message): boolean {
  return msg.role === 'user' && !isToolResultMessage(msg) && !isParseErrorMessage(msg);
}

// ---------------------------------------------------------------------------
// Phase 1 — Summarize old tool results and verbose messages
// ---------------------------------------------------------------------------

function summarizeToolResult(msg: Message): Message {
  const lines: string[] = toContentString(msg.content).split('\n');

  // Keep [TOOL_RESULT] header + first 2 non-empty content lines
  const headerLine: string = lines.find(l => l.includes('[TOOL_RESULT]')) || lines[0] || '';
  const statLines: string[] = [];
  for (const line of lines.slice(1)) {
    if (statLines.length >= 2) break;
    const trimmed: string = line.trim();
    if (trimmed && trimmed !== '[/TOOL_RESULT]') {
      statLines.push(trimmed.length > 180 ? trimmed.slice(0, 180) + '...' : trimmed);
    }
  }

  const summary: string = [headerLine, ...statLines, '[...summarized]', '[/TOOL_RESULT]'].join('\n');
  return { ...msg, content: summary };
}

function summarizeVerboseMessage(msg: Message): Message {
  const content: string = toContentString(msg.content);
  if (content.length < 800) return msg;

  const lines: string[] = content.split('\n').map(l => l.trim()).filter(Boolean);
  const preview: string[] = lines.slice(0, 2).map(l => (l.length > 180 ? l.slice(0, 180) + '...' : l));
  const summary: string = [...preview, '[...summarized]'].join('\n');
  return { ...msg, content: summary };
}

// ---------------------------------------------------------------------------
// Phase 2 — Build context digest from removed messages
// ---------------------------------------------------------------------------

function buildContextDigest(removed: Message[]): string {
  const points: string[] = [];

  for (const msg of removed) {
    if (points.length >= 18) break;

    if (isToolResultMessage(msg)) {
      // Extract tool name from JSON payload if possible
      const toolMatch: RegExpMatchArray | null = toContentString(msg.content).match(/"tool"\s*:\s*"([^"]+)"/);
      const toolName: string = toolMatch ? toolMatch[1] : 'unknown';
      points.push(`- Tool result: ${toolName}`);
      continue;
    }

    if (isParseErrorMessage(msg)) {
      points.push('- Parse error feedback for malformed tool call');
      continue;
    }

    const firstLine: string = toContentString(msg.content).split('\n').map(l => l.trim()).find(Boolean) || '';
    if (!firstLine) continue;
    const snippet: string = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
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

// ---------------------------------------------------------------------------
// Phase 2 helpers — pair detection for CLI format
//
// In the CLI, an assistant message that triggers tool calls is followed by
// one or more user messages containing [TOOL_RESULT]. We remove assistant +
// its adjacent tool-result messages as a group.
// ---------------------------------------------------------------------------

function isAssistantWithToolFollowUp(messages: Message[], idx: number): boolean {
  if (messages[idx].role !== 'assistant') return false;
  return idx + 1 < messages.length && isToolResultMessage(messages[idx + 1]);
}

// Keep system prompt and at least one additional message when hard-splicing.
const HARD_FALLBACK_MIN_MESSAGES: number = 2;

function applyHardFallback(messages: Message[], maxTokens: number): Message[] {
  const hardResult: Message[] = [...messages];
  while (estimateContextTokens(hardResult) > maxTokens && hardResult.length > HARD_FALLBACK_MIN_MESSAGES) {
    hardResult.splice(1, 1);
  }
  return hardResult;
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
export function compactContext(messages: Message[], options: { preserveTurns?: number } = {}): CompactResult {
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
 */
export function distillContext(messages: Message[], options: { tailSize?: number } = {}): Message[] {
  if (!messages || messages.length === 0) return [];

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

  // Return preserved messages in original order
  return Array.from(preservedIndices)
    .sort((a, b) => a - b)
    .map((idx) => normalized[idx]);
}

/**
 * Trim messages to fit within the provider's context budget.
 *
 * Returns a TrimResult with the trimmed messages and stats.
 * The returned `messages` is always a new array — `state.messages` is never mutated.
 */
export function trimContext(messages: Message[], providerId: string, model: string): TrimResult {
  if (!messages || messages.length === 0) {
    return { messages: [], trimmed: false, beforeTokens: 0, afterTokens: 0, removedCount: 0 };
  }

  const normalizedMessages: Message[] = normalizeMessages(messages);

  const budget: ContextBudget = getContextBudget(providerId, model);
  const beforeTokens: number = estimateContextTokens(normalizedMessages);

  // Under target — return a shallow copy, no trimming needed
  if (beforeTokens <= budget.targetTokens) {
    return { messages: [...normalizedMessages], trimmed: false, beforeTokens, afterTokens: beforeTokens, removedCount: 0 };
  }

  // Find first real user message (not a tool result or parse error)
  const firstUserIdx: number = normalizedMessages.findIndex((m: Message) => isFirstUserMessage(m));

  // ---------------------------------------------------------------------------
  // Phase 1: Summarize old verbose content (skip last 14 messages)
  // ---------------------------------------------------------------------------
  const result: Message[] = normalizedMessages.map((m: Message) => ({ ...m })); // shallow copy each message
  const recentBoundary: number = Math.max(0, result.length - 14);
  let currentTokens: number = beforeTokens;

  for (let i = 0; i < recentBoundary && currentTokens > budget.targetTokens; i++) {
    // Never summarize the system prompt or the first real user message
    if (i === 0 && result[i].role === 'system') continue;
    if (i === firstUserIdx) continue;

    const msg: Message = result[i];
    const before: number = estimateMessageTokens(msg);
    const summarized: Message = isToolResultMessage(msg) ? summarizeToolResult(msg) : summarizeVerboseMessage(msg);
    const after: number = estimateMessageTokens(summarized);
    result[i] = summarized;
    currentTokens -= (before - after);
  }

  if (currentTokens <= budget.targetTokens) {
    const afterTokens: number = estimateContextTokens(result);
    return { messages: result, trimmed: true, beforeTokens, afterTokens, removedCount: 0 };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Remove oldest non-protected messages, keep pairs together
  // ---------------------------------------------------------------------------
  const tailStart: number = Math.max(0, result.length - 14);
  const protectedIdx: Set<number> = new Set();
  if (result[0]?.role === 'system') protectedIdx.add(0); // system prompt
  if (firstUserIdx >= 0) protectedIdx.add(firstUserIdx); // first real user msg
  for (let i = tailStart; i < result.length; i++) protectedIdx.add(i); // recent tail

  const toRemove: Set<number> = new Set();
  const removed: Message[] = [];

  for (let i = 0; i < result.length && currentTokens > budget.targetTokens; i++) {
    if (protectedIdx.has(i) || toRemove.has(i)) continue;

    // Assistant + following tool-result(s) — remove as a group
    if (isAssistantWithToolFollowUp(result, i)) {
      toRemove.add(i);
      removed.push(result[i]);
      currentTokens -= estimateMessageTokens(result[i]);

      // Remove all consecutive tool results after this assistant message
      let j: number = i + 1;
      while (j < result.length && isToolResultMessage(result[j]) && !protectedIdx.has(j)) {
        toRemove.add(j);
        removed.push(result[j]);
        currentTokens -= estimateMessageTokens(result[j]);
        j++;
      }
      i = j - 1; // skip past the group
      continue;
    }

    // Standalone tool result without preceding assistant — skip (will be orphaned)
    if (isToolResultMessage(result[i])) continue;

    // Other messages — remove individually
    toRemove.add(i);
    removed.push(result[i]);
    currentTokens -= estimateMessageTokens(result[i]);
  }

  if (toRemove.size === 0) {
    const hardResult: Message[] = applyHardFallback(result, budget.maxTokens);
    const afterTokens: number = estimateContextTokens(hardResult);
    return {
      messages: hardResult,
      trimmed: true,
      beforeTokens,
      afterTokens,
      removedCount: result.length - hardResult.length,
    };
  }

  // Build the kept array with digest inserted after first user message
  const digestMessage: Message = { role: 'user', content: buildContextDigest(removed) };

  const kept: Message[] = [];
  let digestInserted: boolean = false;
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
  if (!digestInserted) kept.push(digestMessage);

  // ---------------------------------------------------------------------------
  // Phase 3: Hard fallback — splice from index 1 if still over maxTokens
  // ---------------------------------------------------------------------------
  const finalMessages: Message[] = applyHardFallback(kept, budget.maxTokens);
  const afterTokens: number = estimateContextTokens(finalMessages);
  return {
    messages: finalMessages,
    trimmed: true,
    beforeTokens,
    afterTokens,
    removedCount: normalizedMessages.length - finalMessages.length,
  };
}
