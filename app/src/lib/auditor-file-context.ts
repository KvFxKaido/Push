/**
 * Auditor file-context enrichment — fetches and budgets full file contents
 * so the Auditor can review diffs in the context of surrounding code.
 *
 * Callers supply a FileFetcher callback (sandbox reads, GitHub API, etc.)
 * so this module stays decoupled from any specific data source.
 */

import { classifyFilePath, type FileClassification } from '@/lib/diff-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Pre-fetched file content for Auditor context enrichment. */
export interface AuditorFileContext {
  path: string;
  content: string;
  /** True if content was truncated to fit per-file cap. */
  truncated: boolean;
  classification: FileClassification;
}

/**
 * Caller-supplied function that reads a single file's content.
 * Return null to skip the file (e.g. not found, binary, error).
 */
export type FileFetcher = (path: string) => Promise<{ content: string; truncated: boolean } | null>;

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Max characters per individual file. */
export const FILE_CONTEXT_PER_FILE_LIMIT = 10_000;

/** Max total characters across all file contexts. */
export const FILE_CONTEXT_TOTAL_LIMIT = 60_000;

const CLASSIFICATION_PRIORITY: Record<FileClassification, number> = {
  production: 0,
  tooling: 1,
  test: 2,
  fixture: 3,
};

/** Only these classifications are worth fetching for security review. */
const ELIGIBLE_CLASSIFICATIONS = new Set<FileClassification>(['production', 'tooling']);

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Fetch and budget file contexts for the Auditor.
 *
 * - Filters to production + tooling files only
 * - Sorts by classification priority (production first)
 * - Fetches in parallel via `fetcher`
 * - Applies per-file and total caps
 * - Catches individual fetch failures gracefully (skips that file)
 */
export async function fetchAuditorFileContexts(
  filePaths: string[],
  fetcher: FileFetcher,
  onStatus?: (phase: string) => void,
): Promise<AuditorFileContext[]> {
  // 1. Classify and filter
  const candidates = filePaths
    .map((path) => ({ path, classification: classifyFilePath(path) }))
    .filter((c) => ELIGIBLE_CLASSIFICATIONS.has(c.classification))
    .sort((a, b) => CLASSIFICATION_PRIORITY[a.classification] - CLASSIFICATION_PRIORITY[b.classification]);

  if (candidates.length === 0) return [];

  onStatus?.(`Fetching context for ${candidates.length} file(s)...`);

  // 2. Fetch in parallel with individual error handling
  const results = await Promise.all(
    candidates.map(async ({ path, classification }) => {
      try {
        const result = await fetcher(path);
        if (!result || !result.content) return null;

        let { content } = result;
        let { truncated } = result;
        if (content.length > FILE_CONTEXT_PER_FILE_LIMIT) {
          content = content.slice(0, FILE_CONTEXT_PER_FILE_LIMIT);
          truncated = true;
        }
        return { path, content, truncated, classification } satisfies AuditorFileContext;
      } catch {
        return null;
      }
    }),
  );

  // 3. Apply total budget (files are already priority-sorted)
  const contexts: AuditorFileContext[] = [];
  let totalSize = 0;
  for (const ctx of results) {
    if (!ctx) continue;
    if (totalSize + ctx.content.length > FILE_CONTEXT_TOTAL_LIMIT) {
      const remaining = FILE_CONTEXT_TOTAL_LIMIT - totalSize;
      if (remaining > 1000) {
        contexts.push({ ...ctx, content: ctx.content.slice(0, remaining), truncated: true });
        totalSize += remaining;
      }
      break;
    }
    contexts.push(ctx);
    totalSize += ctx.content.length;
  }

  return contexts;
}
