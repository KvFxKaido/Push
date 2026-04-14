/**
 * App compatibility wrapper for the shared Orchestrator prompt builder.
 *
 * The canonical module now lives in `lib/orchestrator-prompt-builder.ts`.
 * Keep this file as the app-local import surface so call sites using
 * `@/lib/orchestrator-prompt-builder` do not need to churn during the
 * extraction. Matches the pattern used by `task-graph.ts`.
 */

export * from '@push/lib/orchestrator-prompt-builder';
