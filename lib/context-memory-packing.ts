/**
 * Compact formatting for retrieved `MemoryRecord`s.
 */

import type { MemoryRecord, ScoredMemoryRecord } from './runtime-contract.js';

export const MEMORY_PACK_SECTION_ORDER = ['facts', 'taskMemory', 'verification', 'stale'] as const;

export type MemoryPackSectionKey = (typeof MEMORY_PACK_SECTION_ORDER)[number];

export interface MemoryPackSectionBudgets {
  facts: number;
  taskMemory: number;
  verification: number;
  stale: number;
}

const SECTION_TAGS: Record<MemoryPackSectionKey, { open: string; close: string }> = {
  facts: { open: '[RETRIEVED_FACTS]', close: '[/RETRIEVED_FACTS]' },
  taskMemory: { open: '[RETRIEVED_TASK_MEMORY]', close: '[/RETRIEVED_TASK_MEMORY]' },
  verification: { open: '[RETRIEVED_VERIFICATION]', close: '[/RETRIEVED_VERIFICATION]' },
  stale: { open: '[STALE_CONTEXT]', close: '[/STALE_CONTEXT]' },
};

export const DEFAULT_MEMORY_PACK_SECTION_BUDGETS: MemoryPackSectionBudgets = {
  facts: 1500,
  taskMemory: 1500,
  verification: 1000,
  stale: 500,
};

export const DEFAULT_MEMORY_PACK_BUDGET_CHARS = Object.values(
  DEFAULT_MEMORY_PACK_SECTION_BUDGETS,
).reduce((sum, value) => sum + value, 0);

const PER_RECORD_SUMMARY_CAP = 220;
const PER_RECORD_DETAIL_CAP = 600;

export interface MemoryPackOptions {
  budgetChars?: number;
  sectionBudgets?: Partial<MemoryPackSectionBudgets>;
  includeHints?: boolean;
  /**
   * When set, the top-ranked record in each section may carry its verbatim
   * `detail` (truncated to `detailCap`) inline, provided the record still fits
   * the section budget with it. If detail would overflow, the record falls back
   * to summary-only rather than being dropped. Off by default — opt-in so the
   * existing delegation-brief size stays unchanged until a caller asks for it.
   * This is the packer half of the LCM "recall the original" path.
   */
  includeTopDetail?: boolean;
  /** Max chars of `detail` surfaced per record when `includeTopDetail` is on. Defaults to 600. */
  detailCap?: number;
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
  block: string;
  sections: Record<MemoryPackSectionKey, MemoryPackSectionResult>;
  packed: ScoredMemoryRecord[];
  dropped: ScoredMemoryRecord[];
  charsUsed: number;
}

function truncateSummary(summary: string, cap = PER_RECORD_SUMMARY_CAP): string {
  const trimmed = summary.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

/**
 * Cap `detail` without normalizing internal whitespace. Unlike `truncateSummary`,
 * this preserves newlines and indentation so command output, diffs, and stack
 * traces stay structurally readable when surfaced verbatim via `includeTopDetail`.
 */
function truncateDetail(detail: string, cap: number): string {
  const trimmed = detail.trim();
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
    taskMemory: normalizeBudget(
      overrides?.taskMemory,
      DEFAULT_MEMORY_PACK_SECTION_BUDGETS.taskMemory,
    ),
    verification: normalizeBudget(
      overrides?.verification,
      DEFAULT_MEMORY_PACK_SECTION_BUDGETS.verification,
    ),
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

function formatRecordLines(
  scored: ScoredMemoryRecord,
  includeHints: boolean,
  detailCap = 0,
): string[] {
  const { record } = scored;
  // Lead with the record id so the model can `memory_expand` it straight from
  // the packed block (the LCM recall path) without first grepping for it.
  const header = `- [${record.id}] [${record.kind} | ${record.source.kind}] ${truncateSummary(record.summary)}`;
  const lines = [header];
  if (includeHints) {
    const hints = formatHints(record.relatedFiles, record.relatedSymbols);
    if (hints) lines.push(`    ${hints}`);
  }
  if (detailCap > 0 && record.detail) {
    const detail = truncateDetail(record.detail, detailCap);
    if (detail) {
      // Emit each physical line as its own array element so budget accounting
      // (line.length + 1 per element) matches the final newline-join exactly,
      // while preserving the detail's original line structure.
      const [first, ...rest] = detail.split('\n');
      lines.push(`    detail: ${first}`);
      for (const line of rest) lines.push(`    ${line}`);
    }
  }
  return lines;
}

function packSection(
  key: MemoryPackSectionKey,
  ranked: ScoredMemoryRecord[],
  budgetChars: number,
  includeHints: boolean,
  detailCap = 0,
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

  const tagOverhead = openTag.length + closeTag.length + 2;
  if (budget < tagOverhead + 16) {
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

  for (let i = 0; i < ranked.length; i++) {
    const scored = ranked[i];
    // Detail is reserved strictly for the section's single highest-ranked record
    // (rank index 0). If that record lacks detail or doesn't fit, no lower-ranked
    // record inherits the slot — keeping the "top-ranked" contract unambiguous.
    const wantDetail = detailCap > 0 && i === 0 && Boolean(scored.record.detail);
    let lines = formatRecordLines(scored, includeHints, wantDetail ? detailCap : 0);
    let cost = lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (wantDetail && usedChars + cost > budget) {
      // Detail would overflow — fall back to summary-only rather than dropping.
      lines = formatRecordLines(scored, includeHints, 0);
      cost = lines.reduce((sum, line) => sum + line.length + 1, 0);
    }
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

export function packRetrievedMemory(
  ranked: ScoredMemoryRecord[],
  options: MemoryPackOptions = {},
): MemoryPackResult {
  const includeHints = options.includeHints ?? true;
  const detailCap = options.includeTopDetail
    ? normalizeBudget(options.detailCap, PER_RECORD_DETAIL_CAP)
    : 0;
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
    MEMORY_PACK_SECTION_ORDER.map((key) => [
      key,
      createEmptySectionResult(key, sectionBudgets[key]),
    ]),
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
    const sectionResult = packSection(key, buckets[key], effectiveBudget, includeHints, detailCap);
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
