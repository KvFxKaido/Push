/**
 * App compatibility wrapper for the shared tool registry.
 *
 * The canonical module now lives in `lib/tool-registry.ts`. Keep this file
 * as the app-local import surface so existing call sites using
 * `@/lib/tool-registry` do not need to churn during the extraction.
 */

export * from '@push/lib/tool-registry';
