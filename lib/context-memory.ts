/**
 * Public API for Push's typed artifact-memory layer.
 */

import type {
  DelegationOutcome,
  MemoryQuery,
  MemoryRecord,
  MemoryRecordKind,
  MemoryRetrievalResult,
  MemoryScope,
  MemorySource,
  TaskGraphNodeState,
} from './runtime-contract.js';
import { getDefaultMemoryStore, type ContextMemoryStore } from './context-memory-store.js';
import { retrieveRecords } from './context-memory-retrieval.js';
import {
  packRetrievedMemory,
  type MemoryPackOptions,
  type MemoryPackResult,
} from './context-memory-packing.js';
import { supersedeVerificationMemory } from './context-memory-invalidation.js';
import {
  embedOne,
  getDefaultEmbeddingProvider,
  memoryRecordEmbeddingText,
  type EmbeddingProvider,
} from './embedding-provider.js';

const MAX_SUMMARY_CHARS = 400;

// Diagnostics for the embed paths go to stderr, not stdout: this module runs in
// the browser, the Worker, AND the CLI, and on the CLI stdout is the user-output
// / `--json` channel that must not be polluted. `console.error` is captured by
// Worker observability all the same. Chatty success/skip lines are gated behind
// PUSH_DEBUG; failures always log so a silently vector-less store is visible.
const MEMORY_EMBED_DEBUG =
  typeof process !== 'undefined' &&
  (process.env?.PUSH_DEBUG === '1' || process.env?.PUSH_DEBUG === 'true');

function logEmbedEvent(level: 'debug' | 'warn', event: string, ctx: Record<string, unknown>): void {
  if (level === 'debug' && !MEMORY_EMBED_DEBUG) return;
  console.error(JSON.stringify({ level, event, ...ctx }));
}
const MAX_DETAIL_CHARS = 2000;

function truncate(text: string | undefined, cap: number): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

let idCounter = 0;
function generateId(source: MemorySource['kind']): string {
  idCounter = (idCounter + 1) & 0xffffffff;
  return `mem_${source}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export interface CreateMemoryRecordInput {
  kind: MemoryRecordKind;
  summary: string;
  detail?: string;
  scope: MemoryScope;
  source: Omit<MemorySource, 'createdAt'> & { createdAt?: number };
  relatedFiles?: string[];
  relatedSymbols?: string[];
  tags?: string[];
  freshness?: MemoryRecord['freshness'];
  derivedFrom?: string[];
}

export function createMemoryRecord(input: CreateMemoryRecordInput): MemoryRecord {
  const summary = truncate(input.summary, MAX_SUMMARY_CHARS);
  if (!summary) {
    throw new Error('createMemoryRecord: summary is required');
  }
  return {
    id: generateId(input.source.kind),
    kind: input.kind,
    summary,
    detail: truncate(input.detail, MAX_DETAIL_CHARS),
    scope: input.scope,
    source: {
      kind: input.source.kind,
      label: input.source.label,
      createdAt: input.source.createdAt ?? Date.now(),
    },
    relatedFiles:
      input.relatedFiles && input.relatedFiles.length > 0 ? input.relatedFiles : undefined,
    relatedSymbols:
      input.relatedSymbols && input.relatedSymbols.length > 0 ? input.relatedSymbols : undefined,
    tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
    freshness: input.freshness ?? 'fresh',
    derivedFrom: input.derivedFrom,
  };
}

/**
 * Best-effort: compute embeddings for freshly-written records and patch them
 * back onto the store. Batches all texts into one provider call. Never throws —
 * a failed/absent embedder simply leaves the records vector-less, and retrieval
 * falls back to lexical scoring for them. Awaited by the write helpers so the
 * vector is in place before the next retrieval, but a no-op (single `return`)
 * when no provider is configured, which is the common CLI case.
 *
 * Emits one structured log per terminal branch so an operator can tell
 * "embedding skipped (no provider)" from "embedding ran" from "embedding
 * failed" — otherwise a silently vector-less store is indistinguishable from a
 * working one until recall quality quietly degrades.
 */
async function enrichEmbeddings(
  records: MemoryRecord[],
  store: ContextMemoryStore,
  provider: EmbeddingProvider | null = getDefaultEmbeddingProvider(),
): Promise<void> {
  if (!provider || records.length === 0) {
    if (records.length > 0) {
      logEmbedEvent('debug', 'memory_embed_skipped', { count: records.length });
    }
    return;
  }
  try {
    const texts = records.map(memoryRecordEmbeddingText);
    const results = await provider.embed(texts);
    let enriched = 0;
    await Promise.all(
      records.map(async (record, i) => {
        const vector = results[i]?.vector;
        if (!vector) return;
        const embeddingModel = results[i]?.model ?? provider.model;
        await store.update(record.id, { embedding: vector, embeddingModel });
        // Also mutate the in-memory record: write helpers return these
        // instances to callers, and the store's update() persists a *copy* —
        // so without this the returned object would lack the embedding it was
        // just given.
        record.embedding = vector;
        record.embeddingModel = embeddingModel;
        enriched++;
      }),
    );
    logEmbedEvent('debug', 'memory_embed_enriched', { count: records.length, enriched });
  } catch (error) {
    logEmbedEvent('warn', 'memory_embed_failed', {
      count: records.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Return a copy of `query` with `queryEmbedding`/`queryEmbeddingModel`
 * populated from `query.taskText`, or the query unchanged when no provider is
 * configured or embedding fails. Idempotent: leaves an already-embedded query
 * alone so callers that pre-embed don't pay twice.
 */
async function withQueryEmbedding(query: MemoryQuery): Promise<MemoryQuery> {
  if (query.queryEmbedding) return query;
  const result = await embedOne(query.taskText);
  if (!result || !result.vector) return query;
  return { ...query, queryEmbedding: result.vector, queryEmbeddingModel: result.model };
}

export interface WriteDecisionMemoryInput {
  scope: MemoryScope;
  question: string;
  answer: string;
  store?: ContextMemoryStore;
}

export async function writeDecisionMemory(input: WriteDecisionMemoryInput): Promise<MemoryRecord> {
  const store = input.store ?? getDefaultMemoryStore();
  const record = createMemoryRecord({
    kind: 'decision',
    summary: input.answer,
    detail: `Question: ${input.question}`,
    scope: { ...input.scope, role: 'orchestrator' },
    source: {
      kind: 'orchestrator',
      label: 'Interactive Checkpoint Decision',
    },
  });
  await store.write(record);
  await enrichEmbeddings([record], store);
  return record;
}

export interface WriteExplorerMemoryInput {
  scope: MemoryScope;
  summary: string;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  rounds?: number;
  store?: ContextMemoryStore;
}

export async function writeExplorerMemory(
  input: WriteExplorerMemoryInput,
): Promise<MemoryRecord | null> {
  if (!input.summary?.trim()) return null;
  const store = input.store ?? getDefaultMemoryStore();
  const record = createMemoryRecord({
    kind: 'finding',
    summary: input.summary,
    scope: { ...input.scope, role: 'explorer' },
    source: {
      kind: 'explorer',
      label: `Explorer investigation${input.rounds ? ` (${input.rounds} rounds)` : ''}`,
    },
    relatedFiles: input.relatedFiles,
    relatedSymbols: input.relatedSymbols,
  });
  await store.write(record);
  await enrichEmbeddings([record], store);
  return record;
}

export interface WriteCoderMemoryInput {
  scope: MemoryScope;
  outcome: DelegationOutcome;
  diffPaths?: string[];
  verificationCommandsById?: Record<string, string>;
  store?: ContextMemoryStore;
}

export async function writeCoderMemory(input: WriteCoderMemoryInput): Promise<MemoryRecord[]> {
  if (input.outcome.agent !== 'coder') return [];
  const store = input.store ?? getDefaultMemoryStore();
  const written: MemoryRecord[] = [];
  const coderScope: MemoryScope = { ...input.scope, role: 'coder' };

  const outcome = input.outcome;
  const outcomeRecord = createMemoryRecord({
    kind: 'task_outcome',
    summary: outcome.summary || `Coder run: ${outcome.status}`,
    detail: outcome.nextRequiredAction ? `Next required: ${outcome.nextRequiredAction}` : undefined,
    scope: coderScope,
    source: {
      kind: 'coder',
      label: `Coder delegation (${outcome.status}, ${outcome.rounds}r)`,
    },
    relatedFiles: input.diffPaths,
    tags: [outcome.status],
  });
  await store.write(outcomeRecord);
  written.push(outcomeRecord);

  if (input.diffPaths && input.diffPaths.length > 0) {
    const fileChange = createMemoryRecord({
      kind: 'file_change',
      summary: `Touched ${input.diffPaths.length} file${input.diffPaths.length === 1 ? '' : 's'} in ${input.scope.branch ?? 'workspace'}`,
      scope: coderScope,
      source: {
        kind: 'coder',
        label: 'Workspace diff',
      },
      relatedFiles: input.diffPaths,
      derivedFrom: [outcomeRecord.id],
    });
    await store.write(fileChange);
    written.push(fileChange);
  }

  for (const check of outcome.checks) {
    await supersedeVerificationMemory({
      scope: coderScope,
      checkId: check.id,
      command: input.verificationCommandsById?.[check.id],
      store,
    });
    const verification = createMemoryRecord({
      kind: 'verification_result',
      summary: `${check.id}: ${check.passed ? 'passed' : 'failed'}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}`,
      detail: check.output,
      scope: coderScope,
      source: {
        kind: 'coder',
        label: `Verification: ${check.id}`,
      },
      tags: [
        check.passed ? 'pass' : 'fail',
        `check:${check.id}`,
        ...(input.verificationCommandsById?.[check.id]
          ? [`command:${input.verificationCommandsById[check.id].trim().replace(/\s+/g, ' ')}`]
          : []),
      ],
      derivedFrom: [outcomeRecord.id],
    });
    await store.write(verification);
    written.push(verification);
  }

  await enrichEmbeddings(written, store);
  return written;
}

export interface WriteTaskGraphNodeMemoryInput {
  scope: MemoryScope;
  nodeState: TaskGraphNodeState;
  store?: ContextMemoryStore;
}

export async function writeTaskGraphNodeMemory(
  input: WriteTaskGraphNodeMemoryInput,
): Promise<MemoryRecord | null> {
  const { nodeState } = input;
  if (nodeState.status !== 'completed') return null;
  const summary = nodeState.delegationOutcome?.summary || nodeState.result;
  if (!summary?.trim()) return null;

  const store = input.store ?? getDefaultMemoryStore();
  const evidenceLabels = nodeState.delegationOutcome?.evidence?.map((evidence) => evidence.label);
  const kind: MemoryRecordKind = nodeState.node.agent === 'coder' ? 'task_outcome' : 'finding';

  const record = createMemoryRecord({
    kind,
    summary,
    detail: nodeState.delegationOutcome?.nextRequiredAction
      ? `Next required: ${nodeState.delegationOutcome.nextRequiredAction}`
      : undefined,
    scope: {
      ...input.scope,
      role: nodeState.node.agent,
      taskId: nodeState.node.id,
    },
    source: {
      kind: 'task_graph',
      label: `Graph node "${nodeState.node.id}" (${nodeState.node.agent})`,
    },
    relatedFiles: nodeState.node.files,
    tags: evidenceLabels,
  });
  await store.write(record);
  await enrichEmbeddings([record], store);
  return record;
}

export interface RetrieveMemoryForDelegationInput {
  query: MemoryQuery;
  store?: ContextMemoryStore;
}

export async function retrieveMemoryForDelegation(
  input: RetrieveMemoryForDelegationInput,
): Promise<MemoryRetrievalResult> {
  const store = input.store ?? getDefaultMemoryStore();
  const query = await withQueryEmbedding(input.query);
  return retrieveRecords(store, query);
}

export async function buildRetrievedMemoryKnownContext(
  query: MemoryQuery,
  options: MemoryPackOptions & { store?: ContextMemoryStore } = {},
): Promise<{ line: string | null; result: MemoryRetrievalResult; packResult: MemoryPackResult }> {
  const { store, ...packOptions } = options;
  const result = await retrieveMemoryForDelegation({
    query: query.includeStale === undefined ? { ...query, includeStale: true } : query,
    store,
  });
  const packResult = packRetrievedMemory(result.records, packOptions);
  return {
    line: packResult.block || null,
    result,
    packResult,
  };
}

export {
  getDefaultMemoryStore,
  setDefaultMemoryStore,
  createInMemoryStore,
} from './context-memory-store.js';
export { scoreRecord, retrieveRecords } from './context-memory-retrieval.js';
export { expandMemoryRecords, grepMemory } from './context-memory-expand.js';
export type {
  ExpandedMemoryRecord,
  MemoryExpandInput,
  MemoryExpandResult,
  MemoryGrepInput,
  MemoryGrepMatch,
  MemoryGrepResult,
  MemoryGrepField,
  MemoryScopeGuard,
} from './context-memory-expand.js';
export {
  packRetrievedMemory,
  DEFAULT_MEMORY_PACK_BUDGET_CHARS,
  DEFAULT_MEMORY_PACK_SECTION_BUDGETS,
  classifyRetrievedMemorySection,
  MEMORY_PACK_SECTION_ORDER,
} from './context-memory-packing.js';
export {
  expireBranchScopedMemory,
  invalidateMemoryForChangedFiles,
  supersedeVerificationMemory,
} from './context-memory-invalidation.js';
export type { ContextMemoryStore } from './context-memory-store.js';
export type { MemoryPackOptions, MemoryPackResult } from './context-memory-packing.js';
