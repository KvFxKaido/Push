/**
 * App compatibility wrapper for the shared task-graph runtime.
 *
 * The canonical executor now lives in `lib/task-graph.ts`. Keep this module
 * as the app-local import surface so the web hooks and tests do not need to
 * churn during the extraction.
 */

export * from '@push/lib/task-graph';
