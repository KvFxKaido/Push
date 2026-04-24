/**
 * App compatibility wrapper for the shared todo tool detector.
 *
 * The canonical module lives in `lib/todo-tools.ts`. This wrapper preserves
 * the existing `@/lib/todo-tools` import surface so Web callers don't need
 * to reach across the package boundary.
 */

export * from '@push/lib/todo-tools';
