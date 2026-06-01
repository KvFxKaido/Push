/**
 * Shared executor for the model-facing memory tools (`memory_grep` /
 * `memory_expand`). Both surfaces (web `web-tool-execution-runtime.ts` and CLI
 * `cli/tools.ts`) route through this one module so the tool's behavior, output
 * format, validation, and structured logs are defined once.
 *
 * Security: the scope (repo / branch / chat) is supplied by the caller from the
 * session context — never from model args — so a model cannot grep another
 * repo's memory. Model-controlled args are only the search `pattern`, optional
 * `kinds` / `limit`, and the `ids` to expand.
 *
 * Structured logs follow the repo's symmetric-log convention: every branch that
 * changes observable behavior emits a paired event
 * (`memory_grep_hit` ↔ `memory_grep_empty`, `memory_expand_hit` ↔ `memory_expand_miss`).
 */

import { grepMemory, expandMemoryRecords } from './context-memory.js';
import type { ContextMemoryStore } from './context-memory-store.js';
import type { ExpandedMemoryRecord, MemoryGrepMatch } from './context-memory-expand.js';
import type { MemoryRecordKind } from './runtime-contract.js';

export interface MemoryToolScope {
  repoFullName: string;
  branch?: string;
  chatId?: string;
}

export interface MemoryToolResult {
  text: string;
  meta: Record<string, unknown>;
}

export interface MemoryToolContext {
  scope: MemoryToolScope;
  store?: ContextMemoryStore;
}

const VALID_KINDS: ReadonlySet<string> = new Set<MemoryRecordKind>([
  'fact',
  'finding',
  'decision',
  'task_outcome',
  'verification_result',
  'file_change',
  'symbol_trace',
  'dependency_trace',
]);

const GREP_DETAIL_SNIPPET_CAP = 400;
const EXPAND_DETAIL_CAP = 2000;
const DEFAULT_GREP_LIMIT = 10;
const MAX_GREP_LIMIT = 25;
const MAX_EXPAND_IDS = 20;

function indentDetail(detail: string, cap: number): string {
  const trimmed = detail.trim();
  const capped =
    trimmed.length <= cap ? trimmed : `${trimmed.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
  return capped
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function log(event: string, ctx: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...ctx }));
}

function errorResult(tool: string, message: string): MemoryToolResult {
  return {
    text: `[Tool Error — ${tool}] ${message}`,
    meta: { error: message },
  };
}

function normalizeKinds(raw: unknown): { kinds?: MemoryRecordKind[]; rejected: string[] } {
  if (raw === undefined || raw === null) return { rejected: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const kinds: MemoryRecordKind[] = [];
  const rejected: string[] = [];
  for (const item of list) {
    if (typeof item === 'string' && VALID_KINDS.has(item)) {
      kinds.push(item as MemoryRecordKind);
    } else {
      rejected.push(String(item));
    }
  }
  return { kinds: kinds.length > 0 ? kinds : undefined, rejected };
}

function formatGrepMatch(match: MemoryGrepMatch, index: number): string {
  const { record, matchedFields } = match;
  const lines = [
    `${index + 1}. [${record.id}] (${record.kind} | ${record.source.kind}) matched in: ${matchedFields.join(', ')}`,
    `    ${record.summary.replace(/\s+/g, ' ').trim()}`,
  ];
  if (record.detail) {
    lines.push(indentDetail(record.detail, GREP_DETAIL_SNIPPET_CAP));
  }
  return lines.join('\n');
}

export async function runMemoryGrep(
  args: { pattern?: unknown; kinds?: unknown; limit?: unknown },
  ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
  const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
  if (!pattern) {
    return errorResult('memory_grep', 'pattern must be a non-empty string');
  }

  const { kinds } = normalizeKinds(args.kinds);
  let limit = DEFAULT_GREP_LIMIT;
  if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
    limit = Math.max(1, Math.min(MAX_GREP_LIMIT, Math.floor(args.limit)));
  }

  const result = await grepMemory({
    repoFullName: ctx.scope.repoFullName,
    branch: ctx.scope.branch,
    chatId: ctx.scope.chatId,
    pattern,
    kinds,
    limit,
    store: ctx.store,
  });

  const logCtx = {
    repoFullName: ctx.scope.repoFullName,
    branch: ctx.scope.branch ?? null,
    matches: result.matches.length,
    scanned: result.scanned,
    truncated: result.truncated,
  };
  const meta = { pattern, ...logCtx, kinds: kinds ?? null, limit };

  if (result.matches.length === 0) {
    log('memory_grep_empty', logCtx);
    return {
      text: `[Tool Result — memory_grep]\nNo memory records match "${pattern}" (scanned ${result.scanned}).`,
      meta,
    };
  }

  log('memory_grep_hit', logCtx);
  const body = result.matches.map(formatGrepMatch).join('\n\n');
  const footer = result.truncated
    ? `\n\n(More matches exist — showing the first ${result.matches.length}. Refine the pattern or raise limit.)`
    : '';
  return {
    text:
      `[Tool Result — memory_grep]\n` +
      `Pattern: "${pattern}" — ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} (scanned ${result.scanned}):\n\n` +
      `${body}${footer}`,
    meta,
  };
}

function formatExpandedRecord(record: ExpandedMemoryRecord): string {
  const lines = [
    `[${record.id}] (${record.kind} | ${record.source.kind}, ${record.freshness})`,
    `  summary: ${record.summary.replace(/\s+/g, ' ').trim()}`,
  ];
  if (record.detail) {
    lines.push('  detail:');
    lines.push(indentDetail(record.detail, EXPAND_DETAIL_CAP));
  }
  return lines.join('\n');
}

export async function runMemoryExpand(
  args: { ids?: unknown },
  ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
  const rawIds = Array.isArray(args.ids) ? args.ids : args.ids === undefined ? [] : [args.ids];
  const ids = rawIds
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim())
    .slice(0, MAX_EXPAND_IDS);

  if (ids.length === 0) {
    return errorResult('memory_expand', 'ids must be a non-empty array of record ids');
  }

  const result = await expandMemoryRecords({
    ids,
    scope: {
      repoFullName: ctx.scope.repoFullName,
      branch: ctx.scope.branch,
      chatId: ctx.scope.chatId,
    },
    store: ctx.store,
  });

  const logCtx = {
    repoFullName: ctx.scope.repoFullName,
    branch: ctx.scope.branch ?? null,
    requested: ids.length,
    found: result.found.length,
    missing: result.missing.length,
  };
  const meta = { ...logCtx, missingIds: result.missing };

  if (result.found.length === 0) {
    log('memory_expand_miss', logCtx);
    return {
      text: `[Tool Result — memory_expand]\nNo records found for: ${ids.join(', ')}. The ids may be out of scope, expired, or invalid — use memory_grep to find current ids.`,
      meta,
    };
  }

  log('memory_expand_hit', logCtx);
  const body = result.found.map(formatExpandedRecord).join('\n\n');
  const footer = result.missing.length > 0 ? `\n\nNot found: ${result.missing.join(', ')}` : '';
  return {
    text:
      `[Tool Result — memory_expand]\n` +
      `Recalled ${result.found.length} of ${ids.length} record${ids.length === 1 ? '' : 's'}:\n\n` +
      `${body}${footer}`,
    meta,
  };
}
