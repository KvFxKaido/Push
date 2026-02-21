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
// Token estimation (same heuristic as web app — orchestrator.ts:187-213)
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: ~3.5 chars per token for English/code.
 * Intentionally conservative (slightly over-estimates).
 */
export function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(msg) {
  return estimateTokens(msg.content) + 4; // 4-token per-message overhead
}

export function estimateContextTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Budget resolution
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET = { targetTokens: 88_000, maxTokens: 100_000 };
const GEMINI3_FLASH_BUDGET = { targetTokens: 112_000, maxTokens: 128_000 };

export function getContextBudget(providerId, model) {
  const normalized = (model || '').trim().toLowerCase();

  if (
    providerId === 'ollama' &&
    (normalized === 'gemini-3-flash-preview' || normalized.includes('gemini-3-flash'))
  ) {
    return { ...GEMINI3_FLASH_BUDGET };
  }

  return { ...DEFAULT_BUDGET };
}

// ---------------------------------------------------------------------------
// Message detection helpers
// ---------------------------------------------------------------------------

export function isToolResultMessage(msg) {
  return msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('[TOOL_RESULT]');
}

export function isParseErrorMessage(msg) {
  return msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('[TOOL_CALL_PARSE_ERROR]');
}

function isFirstUserMessage(msg) {
  return msg.role === 'user' && !isToolResultMessage(msg) && !isParseErrorMessage(msg);
}

// ---------------------------------------------------------------------------
// Phase 1 — Summarize old tool results and verbose messages
// ---------------------------------------------------------------------------

function summarizeToolResult(msg) {
  const lines = msg.content.split('\n');

  // Keep [TOOL_RESULT] header + first 4 non-empty content lines
  const headerLine = lines.find(l => l.includes('[TOOL_RESULT]')) || lines[0] || '';
  const statLines = [];
  for (const line of lines.slice(1)) {
    if (statLines.length >= 4) break;
    const trimmed = line.trim();
    if (trimmed && trimmed !== '[/TOOL_RESULT]') {
      statLines.push(trimmed);
    }
  }

  const summary = [headerLine, ...statLines, '[...summarized]', '[/TOOL_RESULT]'].join('\n');
  return { ...msg, content: summary };
}

function summarizeVerboseMessage(msg) {
  if (typeof msg.content !== 'string' || msg.content.length < 1200) return msg;

  const lines = msg.content.split('\n').map(l => l.trim()).filter(Boolean);
  const preview = lines.slice(0, 4).map(l => (l.length > 180 ? l.slice(0, 180) + '...' : l));
  const summary = [...preview, '[...summarized]'].join('\n');
  return { ...msg, content: summary };
}

// ---------------------------------------------------------------------------
// Phase 2 — Build context digest from removed messages
// ---------------------------------------------------------------------------

function buildContextDigest(removed) {
  const points = [];

  for (const msg of removed) {
    if (points.length >= 18) break;

    if (isToolResultMessage(msg)) {
      // Extract tool name from JSON payload if possible
      const toolMatch = msg.content.match(/"tool"\s*:\s*"([^"]+)"/);
      const toolName = toolMatch ? toolMatch[1] : 'unknown';
      points.push(`- Tool result: ${toolName}`);
      continue;
    }

    if (isParseErrorMessage(msg)) {
      points.push('- Parse error feedback for malformed tool call');
      continue;
    }

    const firstLine = msg.content.split('\n').map(l => l.trim()).find(Boolean) || '';
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

// ---------------------------------------------------------------------------
// Phase 2 helpers — pair detection for CLI format
//
// In the CLI, an assistant message that triggers tool calls is followed by
// one or more user messages containing [TOOL_RESULT]. We remove assistant +
// its adjacent tool-result messages as a group.
// ---------------------------------------------------------------------------

function isAssistantWithToolFollowUp(messages, idx) {
  if (messages[idx].role !== 'assistant') return false;
  return idx + 1 < messages.length && isToolResultMessage(messages[idx + 1]);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Trim messages to fit within the provider's context budget.
 *
 * Returns { messages, trimmed, beforeTokens, afterTokens, removedCount }.
 * The returned `messages` is always a new array — `state.messages` is never mutated.
 */
export function trimContext(messages, providerId, model) {
  if (!messages || messages.length === 0) {
    return { messages: [], trimmed: false, beforeTokens: 0, afterTokens: 0, removedCount: 0 };
  }

  const budget = getContextBudget(providerId, model);
  const beforeTokens = estimateContextTokens(messages);

  // Under target — return a shallow copy, no trimming needed
  if (beforeTokens <= budget.targetTokens) {
    return { messages: [...messages], trimmed: false, beforeTokens, afterTokens: beforeTokens, removedCount: 0 };
  }

  // Find first real user message (not a tool result or parse error)
  const firstUserIdx = messages.findIndex(m => isFirstUserMessage(m));

  // ---------------------------------------------------------------------------
  // Phase 1: Summarize old verbose content (skip last 14 messages)
  // ---------------------------------------------------------------------------
  const result = messages.map(m => ({ ...m })); // shallow copy each message
  const recentBoundary = Math.max(0, result.length - 14);
  let currentTokens = beforeTokens;

  for (let i = 0; i < recentBoundary && currentTokens > budget.targetTokens; i++) {
    // Never summarize the system prompt or the first real user message
    if (i === 0 && result[i].role === 'system') continue;
    if (i === firstUserIdx) continue;

    const msg = result[i];
    const before = estimateMessageTokens(msg);
    const summarized = isToolResultMessage(msg) ? summarizeToolResult(msg) : summarizeVerboseMessage(msg);
    const after = estimateMessageTokens(summarized);
    result[i] = summarized;
    currentTokens -= (before - after);
  }

  if (currentTokens <= budget.targetTokens) {
    const afterTokens = estimateContextTokens(result);
    return { messages: result, trimmed: true, beforeTokens, afterTokens, removedCount: 0 };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Remove oldest non-protected messages, keep pairs together
  // ---------------------------------------------------------------------------
  const tailStart = Math.max(0, result.length - 14);
  const protectedIdx = new Set();
  if (result[0]?.role === 'system') protectedIdx.add(0); // system prompt
  if (firstUserIdx >= 0) protectedIdx.add(firstUserIdx); // first real user msg
  for (let i = tailStart; i < result.length; i++) protectedIdx.add(i); // recent tail

  const toRemove = new Set();
  const removed = [];

  for (let i = 0; i < result.length && currentTokens > budget.targetTokens; i++) {
    if (protectedIdx.has(i) || toRemove.has(i)) continue;

    // Assistant + following tool-result(s) — remove as a group
    if (isAssistantWithToolFollowUp(result, i)) {
      toRemove.add(i);
      removed.push(result[i]);
      currentTokens -= estimateMessageTokens(result[i]);

      // Remove all consecutive tool results after this assistant message
      let j = i + 1;
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
    const afterTokens = estimateContextTokens(result);
    return { messages: result, trimmed: true, beforeTokens, afterTokens, removedCount: 0 };
  }

  // Build the kept array with digest inserted after first user message
  const digestMessage = { role: 'user', content: buildContextDigest(removed) };

  const kept = [];
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
  if (!digestInserted) kept.push(digestMessage);

  // ---------------------------------------------------------------------------
  // Phase 3: Hard fallback — splice from index 1 if still over maxTokens
  // ---------------------------------------------------------------------------
  if (estimateContextTokens(kept) > budget.maxTokens) {
    while (estimateContextTokens(kept) > budget.maxTokens && kept.length > 16) {
      kept.splice(1, 1);
    }
  }

  const afterTokens = estimateContextTokens(kept);
  return {
    messages: kept,
    trimmed: true,
    beforeTokens,
    afterTokens,
    removedCount: messages.length - kept.length + 1, // +1 for the digest we inserted
  };
}
