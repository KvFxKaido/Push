/**
 * Re-export from shared lib — canonical diff parsing lives in lib/diff-utils.ts.
 * Web app consumers continue to import from '@/lib/diff-utils' unchanged.
 */
export {
  parseDiffStats,
  parseDiffIntoFiles,
  classifyFilePath,
  chunkDiffByFile,
  formatSize,
} from '@push/lib/diff-utils';

export type {
  DiffStats,
  FileDiff,
  FileClassification,
} from '@push/lib/diff-utils';
