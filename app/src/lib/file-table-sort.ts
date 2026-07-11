/**
 * Pure sorting for the file-browser table (`FilesTable`). Lives outside the
 * component file so the component keeps fast-refresh eligibility and the sort
 * contract stays directly testable.
 */

import type { FileEntry } from '@/types';

export type SortColumn = 'name' | 'size';
export type SortDirection = 'asc' | 'desc';

function compareNames(a: FileEntry, b: FileEntry): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** Directories always group first; when sorting by size they keep ascending
 *  name order (a directory's listed size is meaningless); files tie-break by
 *  name on equal sizes so the order is stable. */
export function sortFileEntries(
  files: readonly FileEntry[],
  column: SortColumn,
  direction: SortDirection,
): FileEntry[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (a.type === 'directory') {
      return compareNames(a, b) * (column === 'name' ? dir : 1);
    }
    if (column === 'size') {
      return (a.size - b.size) * dir || compareNames(a, b);
    }
    return compareNames(a, b) * dir;
  });
}
