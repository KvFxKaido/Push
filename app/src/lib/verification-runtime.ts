/**
 * App compatibility wrapper for the shared verification runtime.
 *
 * The canonical module now lives in `lib/verification-runtime.ts`. Keep this
 * file as the app-local import surface so existing call sites using
 * `@/lib/verification-runtime` do not need to churn during the extraction.
 */

export * from '@push/lib/verification-runtime';
