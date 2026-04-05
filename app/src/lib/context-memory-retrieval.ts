/**
 * context-memory-retrieval.ts
 *
 * Deterministic scorer + retriever for `MemoryRecord`s.
 *
 * Phase 2 is intentionally non-semantic: no embeddings, no vector DB.
 * Scoring uses explicit signals — branch match, task-graph lineage, task text,
 * file overlap, symbol overlap, same role family, recency, and freshness.
 *
 * The scorer returns a component breakdown per record so callers (and
 * tests) can reason about why a record ranked where it did.
 */

import type {
  MemoryQuery,
  MemoryRecord,
  MemoryRetrievalResult,
  MemoryScoreBreakdown,
  ScoredMemoryRecord,
} from '@/types';
import type { ContextMemoryStore } from './context-memory-store';

// --- Weights -----------------------------------------------------------------
// Tuned to satisfy the design doc's priority ordering:
//   branch ≈ task lineage ≈ file overlap > symbol overlap > role family ≈ recency.
// Concrete numbers matter less than relative ordering; adjust alongside
// retrieval tests if you rebalance.

const W_BRANCH = 3;
const W_TASK_GRAPH = 3;
const W_TASK_ID = 3;
const W_TASK_TEXT_PER_HIT = 1.5;
const W_TASK_TEXT_CAP = 6;
const W_FILE_OVERLAP_PER_HIT = 2;
const W_FILE_OVERLAP_CAP = 6;
const W_SYMBOL_OVERLAP_PER_HIT = 2;
const W_SYMBOL_OVERLAP_CAP = 4;
const W_ROLE_FAMILY = 1;
const W_RECENCY_MAX = 2;
const STALE_PENALTY = -5;

/** 24h recency window. Records older than this get 0 recency score. */
const RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Which agent roles are "in the same family" as the query role. */
const ROLE_FAMILIES: Record<MemoryQuery['role'], Set<string>> = {
  orchestrator: new Set(['orchestrator', 'planner']),
  explorer: new Set(['explorer']),
  coder: new Set(['coder', 'planner']),
  reviewer: new Set(['reviewer']),
  auditor: new Set(['auditor']),
};

function countOverlap(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const normA = new Set(a.map(normalizePath));
  let hits = 0;
  for (const item of b) {
    if (normA.has(normalizePath(item))) hits++;
  }
  return hits;
}

function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/^\/workspace\//i, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

const TASK_TOKEN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'bug',
  'change',
  'code',
  'file',
  'files',
  'fix',
  'for',
  'from',
  'implement',
  'in',
  'into',
  'of',
  'on',
  'refactor',
  'task',
  'the',
  'to',
  'trace',
  'update',
  'with',
]);

function tokenizeTaskText(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !TASK_TOKEN_STOP_WORDS.has(token));
}

function countTaskTokenOverlap(record: MemoryRecord, query: MemoryQuery): number {
  const queryTokens = tokenizeTaskText(query.taskText);
  if (queryTokens.length === 0) return 0;

  const haystack = [
    record.summary,
    record.detail,
    ...(record.tags ?? []),
    record.source.label,
    ...(record.relatedFiles ?? []),
    ...(record.relatedSymbols ?? []),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ')
    .toLowerCase();

  if (!haystack) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits++;
  }
  return hits;
}

/**
 * Score a single record against a query. Returns null when the record is
 * disqualified (wrong repo, or `expired`, or `stale` and not requested).
 */
export function scoreRecord(
  record: MemoryRecord,
  query: MemoryQuery,
  now: number = Date.now(),
): { score: number; breakdown: MemoryScoreBreakdown } | null {
  // Hard gate: same repo is required.
  if (record.scope.repoFullName !== query.repoFullName) return null;

  // Hard gate: when the caller is chat-scoped, don't bleed memory across chats.
  if (query.chatId && record.scope.chatId && record.scope.chatId !== query.chatId) return null;

  // Hard gate: branch-scoped records should not leak across branches. Records
  // without a branch remain eligible as repo-scoped memory.
  if (query.branch && record.scope.branch && record.scope.branch !== query.branch) return null;

  // Hard gate: expired records are never injected.
  if (record.freshness === 'expired') return null;

  const stale = record.freshness === 'stale';
  if (stale && !query.includeStale) return null;

  const breakdown: MemoryScoreBreakdown = {
    branch: 0,
    taskLineage: 0,
    taskText: 0,
    fileOverlap: 0,
    symbolOverlap: 0,
    roleFamily: 0,
    recency: 0,
    freshness: 0,
    total: 0,
  };

  // Branch match
  if (query.branch && record.scope.branch === query.branch) {
    breakdown.branch = W_BRANCH;
  }

  // Task lineage: same graph and/or same task id
  if (query.taskGraphId && record.scope.taskGraphId === query.taskGraphId) {
    breakdown.taskLineage += W_TASK_GRAPH;
  }
  if (query.taskId && record.scope.taskId === query.taskId) {
    breakdown.taskLineage += W_TASK_ID;
  }

  // Task text overlap
  const taskTextHits = countTaskTokenOverlap(record, query);
  breakdown.taskText = Math.min(taskTextHits * W_TASK_TEXT_PER_HIT, W_TASK_TEXT_CAP);

  // File overlap
  const fileHits = countOverlap(record.relatedFiles, query.fileHints);
  breakdown.fileOverlap = Math.min(fileHits * W_FILE_OVERLAP_PER_HIT, W_FILE_OVERLAP_CAP);

  // Symbol overlap
  const symbolHits = countOverlap(record.relatedSymbols, query.symbolHints);
  breakdown.symbolOverlap = Math.min(symbolHits * W_SYMBOL_OVERLAP_PER_HIT, W_SYMBOL_OVERLAP_CAP);

  // Role family
  if (record.scope.role && ROLE_FAMILIES[query.role].has(record.scope.role)) {
    breakdown.roleFamily = W_ROLE_FAMILY;
  }

  // Recency: linear decay over RECENCY_WINDOW_MS
  const ageMs = Math.max(0, now - record.source.createdAt);
  if (ageMs < RECENCY_WINDOW_MS) {
    breakdown.recency = (1 - ageMs / RECENCY_WINDOW_MS) * W_RECENCY_MAX;
  }

  // Freshness modifier (stale is demoted heavily when the caller opted in)
  if (stale) {
    breakdown.freshness = STALE_PENALTY;
  }

  breakdown.total =
    breakdown.branch
    + breakdown.taskLineage
    + breakdown.taskText
    + breakdown.fileOverlap
    + breakdown.symbolOverlap
    + breakdown.roleFamily
    + breakdown.recency
    + breakdown.freshness;

  // Require at least one task-specific signal so branch/role/recency alone do
  // not inject unrelated memory into the prompt.
  const hasSpecificMatch =
    breakdown.taskLineage > 0
    || breakdown.taskText > 0
    || breakdown.fileOverlap > 0
    || breakdown.symbolOverlap > 0;
  if (!hasSpecificMatch) return null;

  return { score: breakdown.total, breakdown };
}

/**
 * Retrieve the top-N records for a query, sorted by descending score.
 *
 * Ties are broken by newer records first, then by id for total determinism.
 */
export function retrieveRecords(
  store: ContextMemoryStore,
  query: MemoryQuery,
  now: number = Date.now(),
): MemoryRetrievalResult {
  const scored: ScoredMemoryRecord[] = [];
  let candidateCount = 0;
  let expiredExcluded = 0;
  let staleDropped = 0;

  const inScope = store.list((record) => {
    if (record.scope.repoFullName !== query.repoFullName) return false;
    if (query.chatId && record.scope.chatId && record.scope.chatId !== query.chatId) return false;
    if (query.branch && record.scope.branch && record.scope.branch !== query.branch) return false;
    return true;
  });
  for (const record of inScope) {
    candidateCount++;
    if (record.freshness === 'expired') {
      expiredExcluded++;
      continue;
    }
    if (record.freshness === 'stale' && !query.includeStale) {
      staleDropped++;
      continue;
    }
    const result = scoreRecord(record, query, now);
    if (!result) continue;
    // Drop zero-score records — they share nothing with the query beyond repo.
    if (result.score <= 0) continue;
    scored.push({ record, score: result.score, breakdown: result.breakdown });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ageDelta = b.record.source.createdAt - a.record.source.createdAt;
    if (ageDelta !== 0) return ageDelta;
    return a.record.id.localeCompare(b.record.id);
  });

  const capped = scored.slice(0, Math.max(0, query.maxRecords));

  return {
    records: capped,
    candidateCount,
    expiredExcluded,
    staleDropped,
  };
}
