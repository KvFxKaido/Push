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
import { getDefaultMemoryStore, type ContextMemoryStore } from './context-memory-store.js';
import type { ExpandedMemoryRecord, MemoryGrepMatch } from './context-memory-expand.js';
import { getDefaultVerbatimLog, type VerbatimLog } from './verbatim-log.js';
import { MEMORY_RECORD_KINDS, type MemoryRecordKind } from './runtime-contract.js';

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
  /** Verbatim log for lossless `memory_expand`. Defaults to the process log. */
  verbatimLog?: VerbatimLog;
}

// Validation whitelist derives from the canonical contract list, so a new kind
// added to `runtime-contract.ts` is automatically accepted here (no manual sync).
const VALID_KINDS: ReadonlySet<string> = new Set<MemoryRecordKind>(MEMORY_RECORD_KINDS);

const GREP_DETAIL_SNIPPET_CAP = 400;
const EXPAND_DETAIL_CAP = 2000;
// Verbatim-resolved detail is the whole point of LCM, so it gets a far larger
// window than the capped stored detail — but still bounded, since the output
// has to fit the model's context. Anything beyond is marked, with the ref, so
// the model knows the full text is retained and can be re-fetched.
const VERBATIM_EXPAND_CAP = 12_000;
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

  const suppliedKinds = args.kinds !== undefined && args.kinds !== null;
  const { kinds, rejected } = normalizeKinds(args.kinds);
  // A non-empty kinds filter whose entries are *all* invalid must not silently
  // widen the search to every kind — reject it so the model can correct itself.
  if (suppliedKinds && !kinds) {
    return errorResult(
      'memory_grep',
      `no valid kinds in [${rejected.join(', ')}]. Valid kinds: ${MEMORY_RECORD_KINDS.join(', ')}`,
    );
  }

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
    rejectedKinds: rejected.length,
  };
  const meta = { pattern, ...logCtx, kinds: kinds ?? null, rejected, limit };

  // Surface partially-rejected kinds so the model learns the vocabulary.
  const kindsNote = kinds ? ` in kinds [${kinds.join(', ')}]` : '';
  const rejectedNote =
    rejected.length > 0 ? `\n\n(Ignored unknown kinds: ${rejected.join(', ')})` : '';

  if (result.matches.length === 0) {
    log('memory_grep_empty', logCtx);
    return {
      text: `[Tool Result — memory_grep]\nNo memory records match "${pattern}"${kindsNote} (scanned ${result.scanned}).${rejectedNote}`,
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
      `Pattern: "${pattern}"${kindsNote} — ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} (scanned ${result.scanned}):\n\n` +
      `${body}${footer}${rejectedNote}`,
    meta,
  };
}

function formatExpandedRecord(record: ExpandedMemoryRecord): string {
  const lines = [
    `[${record.id}] (${record.kind} | ${record.source.kind}, ${record.freshness})`,
    `  summary: ${record.summary.replace(/\s+/g, ' ').trim()}`,
  ];
  if (record.detail) {
    if (record.verbatim) {
      const full = record.detail.trim();
      lines.push('  detail (verbatim):');
      lines.push(indentDetail(full, VERBATIM_EXPAND_CAP));
      if (full.length > VERBATIM_EXPAND_CAP) {
        lines.push(
          `    … (showing ${VERBATIM_EXPAND_CAP} of ${full.length} chars; full text retained at verbatim ref ${record.verbatimRef})`,
        );
      }
    } else {
      lines.push('  detail:');
      lines.push(indentDetail(record.detail, EXPAND_DETAIL_CAP));
    }
  }
  return lines.join('\n');
}

export async function runMemoryExpand(
  args: { ids?: unknown },
  ctx: MemoryToolContext,
): Promise<MemoryToolResult> {
  const rawIds = Array.isArray(args.ids) ? args.ids : args.ids === undefined ? [] : [args.ids];
  const ids = rawIds
    .filter((id): id is string => typeof id === 'string')
    // Tolerate the display form: retrieved-memory blocks and grep results show
    // ids wrapped as `[mem_…]`, so a model may copy the bracketed token. Strip
    // surrounding brackets so `[mem_x]` and `mem_x` both resolve.
    .map((id) => id.trim().replace(/^\[+/, '').replace(/\]+$/, '').trim())
    .filter((id) => id.length > 0)
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
    verbatimLog: ctx.verbatimLog ?? getDefaultVerbatimLog(),
  });

  const verbatimResolved = result.found.filter((r) => r.verbatim).length;
  // A log is always supplied above, so any found record that still carries a
  // verbatimRef without `verbatim` set is one whose backing entry was pruned,
  // absent, or unreadable — surface it so a broken/over-pruned verbatim store
  // is visible instead of silently degrading to capped detail.
  const verbatimUnresolved = result.found.filter((r) => r.verbatimRef && !r.verbatim).length;
  const logCtx = {
    repoFullName: ctx.scope.repoFullName,
    branch: ctx.scope.branch ?? null,
    requested: ids.length,
    found: result.found.length,
    missing: result.missing.length,
    verbatim: verbatimResolved,
    verbatimUnresolved,
  };
  const meta = { ...logCtx, missingIds: result.missing };

  if (verbatimUnresolved > 0) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'verbatim_expand_unresolved',
        repoFullName: ctx.scope.repoFullName,
        branch: ctx.scope.branch ?? null,
        unresolved: verbatimUnresolved,
      }),
    );
  }

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

/**
 * Build a memory tool executor bound to a fixed scope — the shape the web
 * Coder / Deep-Reviewer binding (`executeMemory` in `CoderBindingServices`)
 * and any future caller want: `(toolName, args) => { text }`. The scope is
 * captured here from session context and is NOT reachable by the model's
 * args, preserving the cross-repo isolation invariant. `memory_grep` /
 * `memory_expand` are the only recognized tools; anything else returns a
 * benign error string (the caller's role/capability gates run upstream).
 */
export function createMemoryToolExecutor(
  scope: MemoryToolScope,
  store: ContextMemoryStore = getDefaultMemoryStore(),
): (toolName: string, args: Record<string, unknown>) => Promise<{ text: string }> {
  return async (toolName, args) => {
    const ctx: MemoryToolContext = { scope, store };
    if (toolName === 'memory_grep') {
      const r = await runMemoryGrep(args, ctx);
      return { text: r.text };
    }
    if (toolName === 'memory_expand') {
      const r = await runMemoryExpand(args, ctx);
      return { text: r.text };
    }
    return { text: `[Tool Error — ${toolName}] Unknown memory tool.` };
  };
}
