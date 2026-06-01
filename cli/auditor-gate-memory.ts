/**
 * Retrieved-memory context for the CLI Auditor commit gate.
 *
 * The CLI gate (`makeAuditorPreCommitGate` in `cli/tools.ts`) historically passed
 * an empty runtime context to `runAuditor` — so the CLI Auditor evaluated diffs with
 * none of the typed memory the web Auditor sees. This module closes that asymmetry:
 * it retrieves Auditor-scoped records and surfaces the top record's verbatim `detail`
 * (e.g. prior verification output / decision rationale), mirroring the web path in
 * `app/src/lib/role-memory-context.ts`.
 *
 * Both surfaces apply the same shared `AUDITOR_MEMORY_PACK_OVERRIDES` + section
 * budgets from `lib/role-memory-budgets.ts`, so the Auditor's detail policy stays in
 * one place. Retrieval is best-effort: any failure (or empty result) returns `''` so
 * the gate still runs the Auditor — memory is advisory, never a commit blocker.
 */

import { buildRetrievedMemoryKnownContext } from '../lib/context-memory.ts';
import type { ContextMemoryStore } from '../lib/context-memory-store.ts';
import { parseDiffStats } from '../lib/diff-utils.ts';
import {
  AUDITOR_MEMORY_PACK_OVERRIDES,
  MAX_ROLE_RETRIEVED_MEMORY_RECORDS,
  ROLE_MEMORY_SECTION_BUDGETS,
} from '../lib/role-memory-budgets.ts';
import type { MemoryScope } from '../lib/runtime-contract.ts';

export type AuditorGateMemoryScope = Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId'>;

export interface BuildAuditorGateRuntimeContextInput {
  scope: AuditorGateMemoryScope;
  diff: string;
  store?: ContextMemoryStore;
}

/**
 * Build the Auditor commit-gate runtime context (a retrieved-memory block, or `''`).
 * Pure aside from the memory-store read, so it is unit-testable without git: the
 * caller resolves `scope` (repo + branch) and passes it in.
 */
export async function buildAuditorGateRuntimeContext(
  input: BuildAuditorGateRuntimeContextInput,
): Promise<string> {
  const { scope, diff, store } = input;
  if (!scope.repoFullName) return '';

  const fileNames = parseDiffStats(diff).fileNames.slice(0, 8);
  const fileHints = fileNames.length > 0 ? fileNames : undefined;

  try {
    const { line } = await buildRetrievedMemoryKnownContext(
      {
        repoFullName: scope.repoFullName,
        branch: scope.branch,
        chatId: scope.chatId,
        role: 'auditor',
        taskText: ['audit', 'commit', ...fileNames.slice(0, 4)].filter(Boolean).join(' '),
        fileHints,
        maxRecords: MAX_ROLE_RETRIEVED_MEMORY_RECORDS,
      },
      {
        sectionBudgets: ROLE_MEMORY_SECTION_BUDGETS,
        ...AUDITOR_MEMORY_PACK_OVERRIDES,
        store,
      },
    );
    return line ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Symmetric with the gate's fail-open posture: log and degrade to no context.
    console.log(
      JSON.stringify({ level: 'warn', event: 'auditor_gate_memory_failed', error: message }),
    );
    return '';
  }
}
