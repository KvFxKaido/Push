/**
 * One typed carrier for per-run state that used to move through the runtime
 * as separate correlation, memory-scope, and working-memory values.
 *
 * This is an internal consolidation contract, not a public SDK facade.
 */

import type { CorrelationContext } from './correlation-context.js';
import type { MemoryScope } from './runtime-contract.js';
import type { CoderWorkingMemory } from './working-memory.js';

export interface RuntimeMemoryContext {
  /**
   * Durable scope for typed context-memory reads/writes. Null in scratch or
   * chat-only modes where no repo-backed memory can be addressed safely.
   */
  scope: MemoryScope | null;
}

export interface RuntimeWorkingMemoryContext {
  /**
   * Latest Coder/lead-kernel working memory for the active run. Null before a
   * Coder state update has happened or after the run has been reset.
   */
  coder: CoderWorkingMemory | null;
}

export interface PushRuntimeContext {
  /** Passive observability tags carried across spans, run events, and logs. */
  correlation: CorrelationContext;
  /** Typed memory addressability for the current run. */
  memory: RuntimeMemoryContext;
  /** Mutable agent working memory for active run kernels. */
  workingMemory: RuntimeWorkingMemoryContext;
}

export const RUNTIME_CONTEXT_SECTIONS = [
  'correlation',
  'memory',
  'workingMemory',
] as const satisfies ReadonlyArray<keyof PushRuntimeContext>;

export interface CreateRuntimeContextInput {
  correlation?: CorrelationContext;
  memory?: Partial<RuntimeMemoryContext>;
  workingMemory?: Partial<RuntimeWorkingMemoryContext>;
}

export function createRuntimeContext(input: CreateRuntimeContextInput = {}): PushRuntimeContext {
  return {
    correlation: { ...(input.correlation ?? {}) },
    memory: {
      scope: input.memory?.scope ?? null,
    },
    workingMemory: {
      coder: input.workingMemory?.coder ?? null,
    },
  };
}

export function buildRuntimeMemoryScope(input: {
  repoFullName: string | null | undefined;
  branch?: string | null;
  chatId?: string | null;
  extras?: Partial<MemoryScope>;
}): MemoryScope | null {
  if (!input.repoFullName) return null;
  // runId deliberately stays OUT of the durable scope: it is a correlation
  // (observability) tag, not a memory-addressability key. Stamping a per-run
  // id onto every persisted record is a latent recall-narrowing footgun if any
  // future retrieval/invalidation path ever keys on scope.runId — today nothing
  // does, and MemoryQuery has no runId field. A deliberate run-scoped write can
  // still opt in through `extras`.
  return {
    repoFullName: input.repoFullName,
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.extras ?? {}),
  };
}

export function setRuntimeCoderWorkingMemory(
  runtimeContext: PushRuntimeContext,
  state: CoderWorkingMemory | null,
): void {
  runtimeContext.workingMemory.coder = state;
}

export function clearRuntimeCoderWorkingMemory(runtimeContext: PushRuntimeContext): void {
  setRuntimeCoderWorkingMemory(runtimeContext, null);
}

export function readRuntimeCoderWorkingMemory(
  runtimeContext: PushRuntimeContext,
): CoderWorkingMemory | null {
  return runtimeContext.workingMemory.coder;
}
