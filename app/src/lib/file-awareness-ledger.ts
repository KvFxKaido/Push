/**
 * App compatibility wrapper for the shared file-awareness ledger.
 *
 * The canonical module now lives in `lib/file-awareness-ledger.ts`. Keep this
 * file as the app-local import surface so existing call sites using
 * `@/lib/file-awareness-ledger` do not need to churn during the extraction.
 */

export * from '@push/lib/file-awareness-ledger';
