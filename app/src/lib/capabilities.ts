/**
 * App compatibility wrapper for the shared capabilities runtime.
 *
 * The canonical module now lives in `lib/capabilities.ts`. Keep this file
 * as the app-local import surface so call sites using `@/lib/capabilities`
 * do not need to churn during the extraction.
 */

export * from '@push/lib/capabilities';
