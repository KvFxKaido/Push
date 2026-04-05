/**
 * context-memory.ts
 *
 * Public API for Push's typed artifact-memory layer.
 *
 * What this layer is:
 *   - A small store of typed, scoped `MemoryRecord`s written by Explorer,
 *     Coder, and task-graph completions.
 *   - A deterministic retriever that picks the most relevant records for a
 *     delegation call, without embeddings.
 *   - A bounded packer that converts retrieved records into compact text
 *     safe to inject into existing `knownContext` / prompt `memory` paths.
 *
 * What this layer is NOT:
 *   - It does not replace Coder working memory (`[CODER_STATE]`) — that
 *     remains the live per-run state layer.
 *   - It does not replace chat transcript compaction.
 *   - It does not touch server state or sync across repos.
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
} from '@/types';
import { getDefaultMemoryStore, type ContextMemoryStore } from './context-memory-store';
import { retrieveRecords } from './context-memory-retrieval';
import { packRetrievedMemory, type MemoryPackOptions, type MemoryPackResult } from './context-memory-packing';

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

const MAX_SUMMARY_CHARS = 400;
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
    relatedFiles: input.relatedFiles && input.relatedFiles.length > 0 ? input.relatedFiles : undefined,
    relatedSymbols: input.relatedSymbols && input.relatedSymbols.length > 0 ? input.relatedSymbols : undefined,
    tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
    freshness: input.freshness ?? 'fresh',
    derivedFrom: input.derivedFrom,
  };
}

// ---------------------------------------------------------------------------
// Write helpers — one per agent source
// ---------------------------------------------------------------------------

export interface WriteExplorerMemoryInput {
  scope: MemoryScope;
  summary: string;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  rounds?: number;
  store?: ContextMemoryStore;
}

/**
 * Capture an Explorer completion as a `finding` record.
 * Phase 1 keeps this to a single record per completion — summary is what
 * the Explorer already returns. Future phases can split into finding +
 * symbol_trace + dependency_trace as Explorer output gets more structured.
 */
export function writeExplorerMemory(input: WriteExplorerMemoryInput): MemoryRecord | null {
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
  store.write(record);
  return record;
}

export interface WriteCoderMemoryInput {
  scope: MemoryScope;
  outcome: DelegationOutcome;
  diffPaths?: string[];
  store?: ContextMemoryStore;
}

/**
 * Capture a Coder completion as:
 *   - a `task_outcome` record summarizing the delegation outcome
 *   - a `verification_result` record per acceptance check
 *   - a `file_change` record if the run touched files
 *
 * All three share a `derivedFrom` chain back to the parent task_outcome so
 * later invalidation can walk the graph.
 */
export function writeCoderMemory(input: WriteCoderMemoryInput): MemoryRecord[] {
  if (input.outcome.agent !== 'coder') return [];
  const store = input.store ?? getDefaultMemoryStore();
  const written: MemoryRecord[] = [];
  const coderScope: MemoryScope = { ...input.scope, role: 'coder' };

  const outcome = input.outcome;
  const outcomeRecord = createMemoryRecord({
    kind: 'task_outcome',
    summary: outcome.summary || `Coder run: ${outcome.status}`,
    detail: outcome.nextRequiredAction
      ? `Next required: ${outcome.nextRequiredAction}`
      : undefined,
    scope: coderScope,
    source: {
      kind: 'coder',
      label: `Coder delegation (${outcome.status}, ${outcome.rounds}r)`,
    },
    relatedFiles: input.diffPaths,
    tags: [outcome.status],
  });
  store.write(outcomeRecord);
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
    store.write(fileChange);
    written.push(fileChange);
  }

  for (const check of outcome.checks) {
    const verification = createMemoryRecord({
      kind: 'verification_result',
      summary: `${check.id}: ${check.passed ? 'passed' : 'failed'}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ''}`,
      detail: check.output,
      scope: coderScope,
      source: {
        kind: 'coder',
        label: `Verification: ${check.id}`,
      },
      tags: [check.passed ? 'pass' : 'fail'],
      derivedFrom: [outcomeRecord.id],
    });
    store.write(verification);
    written.push(verification);
  }

  return written;
}

export interface WriteTaskGraphNodeMemoryInput {
  scope: MemoryScope;
  nodeState: TaskGraphNodeState;
  store?: ContextMemoryStore;
}

/**
 * Capture a single task-graph node completion as a typed record.
 *
 * This complements — does not replace — the `TaskGraphMemoryEntry` that
 * the task-graph executor injects into in-graph dependent tasks. That
 * entry is intra-graph shared memory; this record is artifact memory
 * that can be retrieved by later, unrelated delegations.
 */
export function writeTaskGraphNodeMemory(
  input: WriteTaskGraphNodeMemoryInput,
): MemoryRecord | null {
  const { nodeState } = input;
  if (nodeState.status !== 'completed') return null;
  const summary = nodeState.delegationOutcome?.summary || nodeState.result;
  if (!summary?.trim()) return null;

  const store = input.store ?? getDefaultMemoryStore();
  const evidenceLabels = nodeState.delegationOutcome?.evidence?.map((e) => e.label);
  const kind: MemoryRecordKind =
    nodeState.node.agent === 'coder' ? 'task_outcome' : 'finding';

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
  store.write(record);
  return record;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export interface RetrieveMemoryForDelegationInput {
  query: MemoryQuery;
  store?: ContextMemoryStore;
}

export function retrieveMemoryForDelegation(
  input: RetrieveMemoryForDelegationInput,
): MemoryRetrievalResult {
  const store = input.store ?? getDefaultMemoryStore();
  return retrieveRecords(store, input.query);
}

/**
 * Convenience: retrieve + pack in one call, returning a single compact
 * `[RETRIEVED_MEMORY]` block ready to push into `knownContext` for a
 * delegation brief. Returns null when nothing matched (caller should skip
 * appending an empty block).
 */
export function buildRetrievedMemoryKnownContext(
  query: MemoryQuery,
  options: MemoryPackOptions & { store?: ContextMemoryStore } = {},
): { line: string | null; result: MemoryRetrievalResult; packResult: MemoryPackResult } {
  const { store, ...packOptions } = options;
  const result = retrieveMemoryForDelegation({ query, store });
  const packResult = packRetrievedMemory(result.records, packOptions);
  return {
    line: packResult.block || null,
    result,
    packResult,
  };
}

// Re-export for convenience.
export { getDefaultMemoryStore, setDefaultMemoryStore, createInMemoryStore } from './context-memory-store';
export { scoreRecord, retrieveRecords } from './context-memory-retrieval';
export {
  packRetrievedMemory,
  DEFAULT_MEMORY_PACK_BUDGET_CHARS,
} from './context-memory-packing';
export type { ContextMemoryStore } from './context-memory-store';
export type { MemoryPackOptions, MemoryPackResult } from './context-memory-packing';
