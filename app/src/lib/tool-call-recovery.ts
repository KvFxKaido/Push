/**
 * App compatibility wrapper for the shared tool-call recovery policy.
 *
 * The canonical module now lives in `lib/tool-call-recovery.ts`. This
 * wrapper preserves the existing `@/lib/tool-call-recovery` import
 * surface so Web callers (orchestrator, chat-send, explorer-agent, etc.)
 * don't need to churn.
 */

export * from '@push/lib/tool-call-recovery';
