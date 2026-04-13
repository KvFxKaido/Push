/**
 * App compatibility wrapper for the shared Auditor file-context enrichment.
 *
 * The canonical module now lives in `lib/auditor-file-context.ts`. Web app
 * consumers keep importing from `@/lib/auditor-file-context`.
 */

export {
  FILE_CONTEXT_PER_FILE_LIMIT,
  FILE_CONTEXT_TOTAL_LIMIT,
  fetchAuditorFileContexts,
} from '@push/lib/auditor-file-context';

export type { AuditorFileContext, FileFetcher } from '@push/lib/auditor-file-context';
