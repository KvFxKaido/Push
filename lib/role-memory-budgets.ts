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

export const ROLE_MEMORY_SECTION_BUDGETS = {
  facts: 600,
  taskMemory: 700,
  verification: 500,
  stale: 250,
} as const;

export const MAX_ROLE_RETRIEVED_MEMORY_RECORDS = 5;
