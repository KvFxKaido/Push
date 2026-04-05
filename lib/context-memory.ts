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
} from './runtime-contract';
import { getDefaultMemoryStore, type ContextMemoryStore } from './context-memory-store';
import { retrieveRecords } from './context-memory-retrieval';
import { packRetrievedMemory, type MemoryPackOptions, type MemoryPackResult } from './context-memory-packing';
import { supersedeVerificationMemory } from './context-memory-invalidation';

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

export interface WriteExplorerMemoryInput {
  scope: MemoryScope;
  summary: string;
  relatedFiles?: string[];
  relatedSymbols?: string[];
  rounds?: number;
  store?: ContextMemoryStore;
}

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
  verificationCommandsById?: Record<string, string>;
  store?: ContextMemoryStore;
}

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
    supersedeVerificationMemory({
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

export function writeTaskGraphNodeMemory(
  input: WriteTaskGraphNodeMemoryInput,
): MemoryRecord | null {
  const { nodeState } = input;
  if (nodeState.status !== 'completed') return null;
  const summary = nodeState.delegationOutcome?.summary || nodeState.result;
  if (!summary?.trim()) return null;

  const store = input.store ?? getDefaultMemoryStore();
  const evidenceLabels = nodeState.delegationOutcome?.evidence?.map((evidence) => evidence.label);
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

export function buildRetrievedMemoryKnownContext(
  query: MemoryQuery,
  options: MemoryPackOptions & { store?: ContextMemoryStore } = {},
): { line: string | null; result: MemoryRetrievalResult; packResult: MemoryPackResult } {
  const { store, ...packOptions } = options;
  const result = retrieveMemoryForDelegation({
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

export { getDefaultMemoryStore, setDefaultMemoryStore, createInMemoryStore } from './context-memory-store';
export { scoreRecord, retrieveRecords } from './context-memory-retrieval';
export {
  packRetrievedMemory,
  DEFAULT_MEMORY_PACK_BUDGET_CHARS,
  DEFAULT_MEMORY_PACK_SECTION_BUDGETS,
  classifyRetrievedMemorySection,
  MEMORY_PACK_SECTION_ORDER,
} from './context-memory-packing';
export { expireBranchScopedMemory, invalidateMemoryForChangedFiles, supersedeVerificationMemory } from './context-memory-invalidation';
export type { ContextMemoryStore } from './context-memory-store';
export type { MemoryPackOptions, MemoryPackResult } from './context-memory-packing';
