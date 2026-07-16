/**
 * App compatibility wrapper for the shared tool-display vocabulary.
 *
 * The canonical module lives in `lib/tool-display.ts` (verb/noun labels, the
 * single cross-surface source of truth). Keep this file as the app-local import
 * surface so call sites using `@/lib/tool-display` match the `@/lib/*` pattern.
 */

export * from '@push/lib/tool-display';
