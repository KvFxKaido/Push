/**
 * context-memory-packing.ts
 *
 * Compact formatting for retrieved `MemoryRecord`s.
 *
 * Design goals:
 *   - multiple short records beat one giant blob
 *   - stay readable when printed into a delegation brief's `knownContext`
 *   - enforce hard per-section char budgets so one record family cannot eat
 *     the entire prompt under pressure
 *   - remain debuggable: each record line names its kind + source so
 *     looking at the packed output tells you where the evidence came from
 */

import type { MemoryRecord, ScoredMemoryRecord } from '@/types';

export const MEMORY_PACK_SECTION_ORDER = [
  'facts',
  'taskMemory',
  'verification',
  'stale',
] as const;

export type MemoryPackSectionKey = (typeof MEMORY_PACK_SECTION_ORDER)[number];

export interface MemoryPackSectionBudgets {
  facts: number;
  taskMemory: number;
  verification: number;
  stale: number;
}

const SECTION_TAGS: Record<MemoryPackSectionKey, { open: string; close: string }> = {
  facts: {
    open: '[RETRIEVED_FACTS]',
    close: '[/RETRIEVED_FACTS]',
  },
  taskMemory: {
    open: '[RETRIEVED_TASK_MEMORY]',
    close: '[/RETRIEVED_TASK_MEMORY]',
  },
  verification: {
    open: '[RETRIEVED_VERIFICATION]',
    close: '[/RETRIEVED_VERIFICATION]',
  },
  stale: {
    open: '[STALE_CONTEXT]',
    close: '[/STALE_CONTEXT]',
  },
};

/** Default per-section budgets in characters. Keep bounded. */
export const DEFAULT_MEMORY_PACK_SECTION_BUDGETS: MemoryPackSectionBudgets = {
  facts: 1500,
  taskMemory: 1500,
  verification: 1000,
  stale: 500,
};

/**
 * Backward-compatible aggregate cap across the combined packed output.
 * Sections still retain their own hard maxima.
 */
export const DEFAULT_MEMORY_PACK_BUDGET_CHARS = Object.values(DEFAULT_MEMORY_PACK_SECTION_BUDGETS)
  .reduce((sum, value) => sum + value, 0);

/** Hard per-record summary cap. Longer summaries get a trailing ellipsis. */
const PER_RECORD_SUMMARY_CAP = 220;

export interface MemoryPackOptions {
  /**
   * Max characters across the combined packed output. Section budgets still
   * apply; this adds an optional total cap for callers/tests that want one.
   */
  budgetChars?: number;
  /** Optional per-section budget overrides. */
  sectionBudgets?: Partial<MemoryPackSectionBudgets>;
  /** Whether to include a short evidence tail (files/symbols) per record. */
  includeHints?: boolean;
}

export interface MemoryPackSectionResult {
  key: MemoryPackSectionKey;
  openTag: string;
  closeTag: string;
  block: string;
  packed: ScoredMemoryRecord[];
  dropped: ScoredMemoryRecord[];
  charsUsed: number;
  recordCount: number;
  budgetChars: number;
}

export interface MemoryPackResult {
  /** The formatted combined block(s), empty string when nothing is packed. */
  block: string;
  /** Section-level packing details for debuggability and cost inspection. */
  sections: Record<MemoryPackSectionKey, MemoryPackSectionResult>;
  /** The records that actually made it into the packed output. */
  packed: ScoredMemoryRecord[];
  /** Records evicted because their section/global budget was exhausted. */
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

function normalizeBudget(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function resolveSectionBudgets(
  overrides?: Partial<MemoryPackSectionBudgets>,
): MemoryPackSectionBudgets {
  return {
    facts: normalizeBudget(overrides?.facts, DEFAULT_MEMORY_PACK_SECTION_BUDGETS.facts),
    taskMemory: normalizeBudget(overrides?.taskMemory, DEFAULT_MEMORY_PACK_SECTION_BUDGETS.taskMemory),
    verification: normalizeBudget(overrides?.verification, DEFAULT_MEMORY_PACK_SECTION_BUDGETS.verification),
    stale: normalizeBudget(overrides?.stale, DEFAULT_MEMORY_PACK_SECTION_BUDGETS.stale),
  };
}

export function classifyRetrievedMemorySection(
  record: Pick<MemoryRecord, 'kind' | 'freshness'>,
): MemoryPackSectionKey {
  if (record.freshness === 'stale') return 'stale';

  switch (record.kind) {
    case 'verification_result':
      return 'verification';
    case 'decision':
    case 'task_outcome':
    case 'file_change':
      return 'taskMemory';
    case 'fact':
    case 'finding':
    case 'symbol_trace':
    case 'dependency_trace':
    default:
      return 'facts';
  }
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
 * Pack ranked records for one section bounded by `budgetChars`.
 */
function packSection(
  key: MemoryPackSectionKey,
  ranked: ScoredMemoryRecord[],
  budgetChars: number,
  includeHints: boolean,
): MemoryPackSectionResult {
  const { open: openTag, close: closeTag } = SECTION_TAGS[key];
  const budget = Math.max(0, budgetChars);

  if (ranked.length === 0 || budget <= 0) {
    return {
      key,
      openTag,
      closeTag,
      block: '',
      packed: [],
      dropped: ranked,
      charsUsed: 0,
      recordCount: 0,
      budgetChars: budget,
    };
  }

  const tagOverhead = openTag.length + closeTag.length + 2; // two newlines
  if (budget < tagOverhead + 16) {
    // Not enough room for even a single line — skip the block entirely.
    return {
      key,
      openTag,
      closeTag,
      block: '',
      packed: [],
      dropped: ranked,
      charsUsed: 0,
      recordCount: 0,
      budgetChars: budget,
    };
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
    return {
      key,
      openTag,
      closeTag,
      block: '',
      packed: [],
      dropped,
      charsUsed: 0,
      recordCount: 0,
      budgetChars: budget,
    };
  }

  const block = [openTag, ...recordLines, closeTag].join('\n');
  return {
    key,
    openTag,
    closeTag,
    block,
    packed,
    dropped,
    charsUsed: block.length,
    recordCount: packed.length,
    budgetChars: budget,
  };
}

function createEmptySectionResult(
  key: MemoryPackSectionKey,
  budgetChars: number,
): MemoryPackSectionResult {
  const { open: openTag, close: closeTag } = SECTION_TAGS[key];
  return {
    key,
    openTag,
    closeTag,
    block: '',
    packed: [],
    dropped: [],
    charsUsed: 0,
    recordCount: 0,
    budgetChars,
  };
}

/**
 * Pack ranked records into bounded retrieved-memory sections. Records are
 * assumed to be pre-sorted by relevance.
 */
export function packRetrievedMemory(
  ranked: ScoredMemoryRecord[],
  options: MemoryPackOptions = {},
): MemoryPackResult {
  const includeHints = options.includeHints ?? true;
  const sectionBudgets = resolveSectionBudgets(options.sectionBudgets);
  const totalBudget = normalizeBudget(
    options.budgetChars,
    Object.values(sectionBudgets).reduce((sum, value) => sum + value, 0),
  );

  const buckets: Record<MemoryPackSectionKey, ScoredMemoryRecord[]> = {
    facts: [],
    taskMemory: [],
    verification: [],
    stale: [],
  };
  for (const scored of ranked) {
    buckets[classifyRetrievedMemorySection(scored.record)].push(scored);
  }

  const sections = Object.fromEntries(
    MEMORY_PACK_SECTION_ORDER.map((key) => [key, createEmptySectionResult(key, sectionBudgets[key])]),
  ) as Record<MemoryPackSectionKey, MemoryPackSectionResult>;

  const blocks: string[] = [];
  const packed: ScoredMemoryRecord[] = [];
  const dropped: ScoredMemoryRecord[] = [];
  let remainingBudget = totalBudget;

  for (const key of MEMORY_PACK_SECTION_ORDER) {
    const separatorCost = blocks.length > 0 ? 2 : 0;
    const effectiveBudget = Math.max(
      0,
      Math.min(sectionBudgets[key], Math.max(0, remainingBudget - separatorCost)),
    );
    const sectionResult = packSection(key, buckets[key], effectiveBudget, includeHints);
    sections[key] = sectionResult;
    packed.push(...sectionResult.packed);
    dropped.push(...sectionResult.dropped);

    if (!sectionResult.block) continue;
    if (separatorCost > 0) remainingBudget -= separatorCost;
    blocks.push(sectionResult.block);
    remainingBudget -= sectionResult.charsUsed;
  }

  const block = blocks.join('\n\n');
  return {
    block,
    sections,
    packed,
    dropped,
    charsUsed: block.length,
  };
}
