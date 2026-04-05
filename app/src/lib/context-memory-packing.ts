/**
 * context-memory-packing.ts
 *
 * Compact formatting for retrieved `MemoryRecord`s.
 *
 * Design goals:
 *   - multiple short records beat one giant blob
 *   - stay readable when printed into a delegation brief's `knownContext`
 *   - enforce a hard char budget so retrieved memory never eats the prompt
 *   - remain debuggable: each record line names its kind + source so
 *     looking at the packed output tells you where the evidence came from
 */

import type { ScoredMemoryRecord } from '@/types';

/** Default per-block budget in characters. Keep bounded. */
export const DEFAULT_MEMORY_PACK_BUDGET_CHARS = 1500;

/** Hard per-record summary cap. Longer summaries get a trailing ellipsis. */
const PER_RECORD_SUMMARY_CAP = 220;

export interface MemoryPackOptions {
  /** Max characters across the entire packed block. Default: 1500. */
  budgetChars?: number;
  /** Whether to include a short evidence tail (files/symbols) per record. */
  includeHints?: boolean;
}

export interface MemoryPackResult {
  /** The formatted block, empty string when nothing is packed. */
  block: string;
  /** The records that actually made it into the block. */
  packed: ScoredMemoryRecord[];
  /** Records evicted because the budget was exhausted. */
  dropped: ScoredMemoryRecord[];
  charsUsed: number;
}

function truncateSummary(summary: string, cap = PER_RECORD_SUMMARY_CAP): string {
  const trimmed = summary.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

function formatHints(files?: string[], symbols?: string[]): string | null {
  const parts: string[] = [];
  if (files && files.length > 0) {
    parts.push(`files: ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`);
  }
  if (symbols && symbols.length > 0) {
    parts.push(`symbols: ${symbols.slice(0, 3).join(', ')}${symbols.length > 3 ? '…' : ''}`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

/**
 * Format a single record as one short line (plus optional hint sub-line).
 *
 * Example:
 *   - [finding | explorer] Auth refresh guarded in useAuth.ts:42
 *       files: app/src/useAuth.ts
 */
function formatRecordLines(scored: ScoredMemoryRecord, includeHints: boolean): string[] {
  const { record } = scored;
  const header = `- [${record.kind} | ${record.source.kind}] ${truncateSummary(record.summary)}`;
  const lines = [header];
  if (includeHints) {
    const hints = formatHints(record.relatedFiles, record.relatedSymbols);
    if (hints) lines.push(`    ${hints}`);
  }
  return lines;
}

/**
 * Pack ranked records into a single `[RETRIEVED_MEMORY]` block bounded by
 * `budgetChars`. Records are assumed to be pre-sorted by relevance.
 */
export function packRetrievedMemory(
  ranked: ScoredMemoryRecord[],
  options: MemoryPackOptions = {},
): MemoryPackResult {
  const budget = options.budgetChars ?? DEFAULT_MEMORY_PACK_BUDGET_CHARS;
  const includeHints = options.includeHints ?? true;

  if (ranked.length === 0 || budget <= 0) {
    return { block: '', packed: [], dropped: ranked, charsUsed: 0 };
  }

  const openTag = '[RETRIEVED_MEMORY]';
  const closeTag = '[/RETRIEVED_MEMORY]';
  const tagOverhead = openTag.length + closeTag.length + 2; // two newlines
  if (budget < tagOverhead + 16) {
    // Not enough room for even a single line — skip the block entirely.
    return { block: '', packed: [], dropped: ranked, charsUsed: 0 };
  }

  const packed: ScoredMemoryRecord[] = [];
  const dropped: ScoredMemoryRecord[] = [];
  const recordLines: string[] = [];
  let usedChars = tagOverhead;

  for (const scored of ranked) {
    const lines = formatRecordLines(scored, includeHints);
    // +1 per line for newline separator
    const cost = lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (usedChars + cost > budget) {
      dropped.push(scored);
      continue;
    }
    recordLines.push(...lines);
    usedChars += cost;
    packed.push(scored);
  }

  if (packed.length === 0) {
    return { block: '', packed: [], dropped, charsUsed: 0 };
  }

  const block = [openTag, ...recordLines, closeTag].join('\n');
  return { block, packed, dropped, charsUsed: block.length };
}
