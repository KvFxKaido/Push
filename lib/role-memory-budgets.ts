/**
 * Role-aware section budgets for typed-memory retrieval.
 *
 * `buildRetrievedMemoryKnownContext` (in `./context-memory.ts`) packs
 * retrieved records into bounded sections — `facts`, `taskMemory`,
 * `verification`, and `stale`. The per-section character budgets in
 * this module keep retrievals compact enough that they don't crowd
 * out the task-specific prompt, while still admitting enough signal
 * for most delegations.
 *
 * The single source of truth lives in `lib/` so both surfaces (the
 * web runtime in `app/src/lib/role-memory-context.ts` and the daemon
 * in `cli/task-graph-memory.ts`) import from one place. This closes
 * the Gap 2 "parallel vocabularies" antipattern preemptively — if
 * the budgets diverge later, that will be a deliberate tuning call
 * with its own PR, not silent drift between surfaces.
 *
 * Current values are tuned for Reviewer / Auditor delegations (the
 * first callers) and applied to Explorer / Coder task-graph nodes
 * under the same budget in the Gap 3 Step 3 tranche. Future tuning
 * per role is possible by introducing per-role overrides on top of
 * this base.
 */

import type { MemoryPackOptions } from './context-memory-packing.js';

export const ROLE_MEMORY_SECTION_BUDGETS = {
  facts: 600,
  taskMemory: 700,
  verification: 500,
  stale: 250,
} as const;

export const MAX_ROLE_RETRIEVED_MEMORY_RECORDS = 5;

/**
 * Per-record `detail` cap for roles that opt into `MemoryPackOptions.includeTopDetail`
 * (the Auditor today — its SAFE/UNSAFE call benefits from the verbatim verification
 * output stored in `detail`). Chosen to sit at or below the section budgets above so
 * surfaced detail fills the existing allocation rather than raising the prompt ceiling:
 * enabling detail can only spend more of an already-capped budget (the packer falls
 * back to summary-only when it would overflow), never exceed it. The visible tradeoff
 * is a richer top record vs. fewer summary records in the same section — acceptable for
 * the Auditor, where depth on the top verification/decision record beats breadth.
 */
export const AUDITOR_MEMORY_DETAIL_CAP = 400;

/**
 * Pack overrides for roles that surface verbatim top-record `detail`. Shared from
 * `lib/` so both surfaces apply the same Auditor opt-in: the web runtime
 * (`app/src/lib/role-memory-context.ts`) and the CLI commit-gate
 * (`cli/auditor-gate-memory.ts`). Keeping it here closes the cross-surface drift the
 * module docstring warns about — the Auditor's detail policy lives in one place.
 */
export const AUDITOR_MEMORY_PACK_OVERRIDES: Partial<MemoryPackOptions> = {
  includeTopDetail: true,
  detailCap: AUDITOR_MEMORY_DETAIL_CAP,
};
