/**
 * Verbatim retrieval ("expand") kernel for typed artifact memory.
 *
 * Push's existing retrieval path (`context-memory-retrieval.ts`) ranks records
 * and `context-memory-packing.ts` formats them into bounded prompt sections that
 * only ever surface a 220-char slice of each record's `summary` — never the
 * stored `detail`. That is the lossy view the model sees.
 *
 * This module is the lossless escape hatch: given a record id (or a substring
 * pattern), return the record's *verbatim* stored `summary` + `detail` exactly
 * as written, bypassing the packer's truncation. It is the deterministic kernel
 * an eventual model-facing `memory_expand` / `memory_grep` tool would call, kept
 * in `lib/` so both surfaces share one definition (new-feature checklist #1).
 *
 * The kernel is intentionally pure and side-effect-free, mirroring
 * `context-memory-retrieval.ts`. Structured logging belongs at the integration
 * call-site (the tool dispatch layer), not here, so unit tests and the packer
 * stay quiet — see the decision doc for the symmetric-log requirement on the
 * tool-exposure phase.
 *
 * Pattern matching is plain case-insensitive substring, deliberately not regex:
 * the pattern is model-supplied and a regex would open a ReDoS seam.
 */

import type {
  MemoryFreshness,
  MemoryRecord,
  MemoryRecordKind,
  MemorySource,
} from './runtime-contract.js';
import { getDefaultMemoryStore, type ContextMemoryStore } from './context-memory-store.js';

/** A record returned with its full stored text, free of packer truncation. */
export interface ExpandedMemoryRecord {
  id: string;
  kind: MemoryRecordKind;
  /** Verbatim stored summary (capped at write time to 400 chars, not the packer's 220). */
  summary: string;
  /** Verbatim stored detail (capped at write time to 2000 chars), if any. */
  detail?: string;
  freshness: MemoryFreshness;
  source: MemorySource;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  tags?: string[];
  derivedFrom?: string[];
}

function toExpanded(record: MemoryRecord): ExpandedMemoryRecord {
  return {
    id: record.id,
    kind: record.kind,
    summary: record.summary,
    detail: record.detail,
    freshness: record.freshness,
    source: record.source,
    relatedFiles: record.relatedFiles,
    relatedSymbols: record.relatedSymbols,
    tags: record.tags,
    derivedFrom: record.derivedFrom,
  };
}

/** Optional scope guard so a caller can refuse cross-repo / cross-branch reads. */
export interface MemoryScopeGuard {
  repoFullName?: string;
  branch?: string;
  chatId?: string;
}

/**
 * Returns true when `record` is visible under `guard`. Mirrors the soft-match
 * semantics of `scoreRecord`: a dimension only excludes when *both* sides name
 * it and they differ (an unscoped record stays visible).
 */
function withinScope(record: MemoryRecord, guard?: MemoryScopeGuard): boolean {
  if (!guard) return true;
  if (guard.repoFullName && record.scope.repoFullName !== guard.repoFullName) return false;
  if (guard.branch && record.scope.branch && record.scope.branch !== guard.branch) return false;
  if (guard.chatId && record.scope.chatId && record.scope.chatId !== guard.chatId) return false;
  return true;
}

export interface MemoryExpandInput {
  ids: string[];
  store?: ContextMemoryStore;
  scope?: MemoryScopeGuard;
  /** Expired records are excluded by default; set true to retrieve them anyway. */
  includeExpired?: boolean;
}

export interface MemoryExpandResult {
  /** Records found and visible, in the order their ids were requested (de-duplicated). */
  found: ExpandedMemoryRecord[];
  /** Requested ids that did not resolve to a visible record (absent, out of scope, or expired). */
  missing: string[];
}

/**
 * Expand specific records to their verbatim stored form. The model gets back the
 * exact `detail` text of a decision/finding it only saw as a 220-char summary in
 * the packed prompt — the LCM "recall the original" move.
 */
export async function expandMemoryRecords(input: MemoryExpandInput): Promise<MemoryExpandResult> {
  const store = input.store ?? getDefaultMemoryStore();
  const found: ExpandedMemoryRecord[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const id of input.ids) {
    if (seen.has(id)) continue;
    seen.add(id);

    const record = await store.get(id);
    if (
      !record ||
      !withinScope(record, input.scope) ||
      (record.freshness === 'expired' && !input.includeExpired)
    ) {
      missing.push(id);
      continue;
    }
    found.push(toExpanded(record));
  }

  return { found, missing };
}

export interface MemoryGrepInput {
  repoFullName: string;
  /** Case-insensitive substring matched against summary, detail, tags, label, files, symbols. */
  pattern: string;
  branch?: string;
  chatId?: string;
  kinds?: MemoryRecordKind[];
  /** Stale records are included by default (recent-but-superseded decisions are often what you want). */
  includeStale?: boolean;
  /** Expired records are excluded by default. */
  includeExpired?: boolean;
  /** Max matches returned. Defaults to 10. */
  limit?: number;
  store?: ContextMemoryStore;
}

export type MemoryGrepField =
  | 'summary'
  | 'detail'
  | 'tags'
  | 'label'
  | 'relatedFiles'
  | 'relatedSymbols';

export interface MemoryGrepMatch {
  record: ExpandedMemoryRecord;
  /** Which field(s) of the record contained the pattern. */
  matchedFields: MemoryGrepField[];
}

export interface MemoryGrepResult {
  matches: MemoryGrepMatch[];
  /** Total in-scope records examined (pre-limit). */
  scanned: number;
  /** True when more matches existed than `limit` returned. */
  truncated: boolean;
}

const DEFAULT_GREP_LIMIT = 10;

function matchedFieldsFor(record: MemoryRecord, needle: string): MemoryGrepField[] {
  const fields: MemoryGrepField[] = [];
  if (record.summary.toLowerCase().includes(needle)) fields.push('summary');
  if (record.detail?.toLowerCase().includes(needle)) fields.push('detail');
  if (record.tags?.some((tag) => tag.toLowerCase().includes(needle))) fields.push('tags');
  if (record.source.label.toLowerCase().includes(needle)) fields.push('label');
  if (record.relatedFiles?.some((file) => file.toLowerCase().includes(needle))) {
    fields.push('relatedFiles');
  }
  if (record.relatedSymbols?.some((sym) => sym.toLowerCase().includes(needle))) {
    fields.push('relatedSymbols');
  }
  return fields;
}

/**
 * Search stored records by substring and return the matches with verbatim text.
 * The deterministic, model-callable counterpart to the orchestrator-only ranked
 * retrieval — lets an agent find the exact record id to then `expand`, or read
 * the full detail inline.
 */
export async function grepMemory(input: MemoryGrepInput): Promise<MemoryGrepResult> {
  const store = input.store ?? getDefaultMemoryStore();
  const limit = Math.max(0, input.limit ?? DEFAULT_GREP_LIMIT);
  const needle = input.pattern.trim().toLowerCase();
  const kinds = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;

  if (!needle) {
    return { matches: [], scanned: 0, truncated: false };
  }

  const inScope = await store.list((record) => {
    if (record.scope.repoFullName !== input.repoFullName) return false;
    if (input.branch && record.scope.branch && record.scope.branch !== input.branch) return false;
    if (input.chatId && record.scope.chatId && record.scope.chatId !== input.chatId) return false;
    if (record.freshness === 'expired' && !input.includeExpired) return false;
    if (record.freshness === 'stale' && input.includeStale === false) return false;
    if (kinds && !kinds.has(record.kind)) return false;
    return true;
  });

  const hits: MemoryGrepMatch[] = [];
  for (const record of inScope) {
    const matchedFields = matchedFieldsFor(record, needle);
    if (matchedFields.length === 0) continue;
    hits.push({ record: toExpanded(record), matchedFields });
  }

  hits.sort((a, b) => {
    const ageDelta = b.record.source.createdAt - a.record.source.createdAt;
    if (ageDelta !== 0) return ageDelta;
    return a.record.id.localeCompare(b.record.id);
  });

  return {
    matches: hits.slice(0, limit),
    scanned: inScope.length,
    truncated: hits.length > limit,
  };
}
