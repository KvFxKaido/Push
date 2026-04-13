/**
 * App compatibility wrapper for the shared ask-user tool detector.
 *
 * The canonical module now lives in `lib/ask-user-tools.ts`. This wrapper
 * preserves the existing `@/lib/ask-user-tools` import surface so Web
 * callers (orchestrator, tool-dispatch, tests) don't need to churn.
 *
 * Note: `lib/ask-user-tools.ts` declares its own `AskUserCardData` /
 * `AskUserOption` shapes that are structurally identical to the ones in
 * `@/types`. Web UI code keeps importing the canonical types from `@/types`;
 * TypeScript's structural typing lets both sides round-trip the same objects.
 */

export * from '@push/lib/ask-user-tools';
