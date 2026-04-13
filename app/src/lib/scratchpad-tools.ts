/**
 * App compatibility wrapper for the shared scratchpad tool detector.
 *
 * The canonical module now lives in `lib/scratchpad-tools.ts`. This wrapper
 * preserves the existing `@/lib/scratchpad-tools` import surface so Web
 * callers (orchestrator, tool-dispatch, chat-send) don't need to churn.
 */

export * from '@push/lib/scratchpad-tools';
