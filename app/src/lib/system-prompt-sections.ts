/**
 * App compatibility wrapper for shared system prompt sections.
 *
 * The canonical module now lives in `lib/system-prompt-sections.ts`. Keep
 * this file as the app-local import surface so existing call sites using
 * `@/lib/system-prompt-sections` do not need to churn during the extraction.
 */

export * from '@push/lib/system-prompt-sections';
