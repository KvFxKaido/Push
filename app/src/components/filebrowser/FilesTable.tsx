/**
 * FilesTable — HeroUI-style column table for the file browser.
 *
 * Adapts HeroUI's Table anatomy (sortable column headers with a direction
 * indicator, right-aligned numeric column, sticky header row) onto the
 * existing shadcn table primitives styled with Push tokens — no new
 * dependency, same adaptation pattern as `SettingsAccordion` (PR #1407).
 *
 * Deliberate departures from HeroUI for this touch-first surface:
 * - No selection checkboxes: the whole row is the touch target (tap opens,
 *   500ms long-press opens the actions sheet), and a checkbox column would
 *   fight that idiom.
 * - No expandable tree rows: tapping a directory NAVIGATES here; inline
 *   expansion would change navigation semantics, not just looks.
 * - The `Table` wrapper (an `overflow-x-auto` container) is skipped — the
 *   HeroUI `removeWrapper` analogue — so the sticky header tracks the file
 *   browser's own vertical scroll area instead of a nested scroller.
 *
 * Sorting: directories always group first. When sorting by size they keep
 * name order (a directory's listed size is meaningless); files tie-break by
 * name so equal sizes stay stable.
 */

import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  File,
  FileEdit,
  Folder,
} from 'lucide-react';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getFileEditability } from '@/lib/file-utils';
import { formatSize } from '@/lib/diff-utils';
import type { FileEntry } from '@/types';
import { sortFileEntries, type SortColumn, type SortDirection } from '@/lib/file-table-sort';

interface FilesTableProps {
  files: FileEntry[];
  /** Root directories hide the `..` navigate-up row. */
  isRoot: boolean;
  onNavigateUp: () => void;
  onTap: (file: FileEntry) => void;
  onLongPress: (file: FileEntry) => void;
}

export function FilesTable({ files, isRoot, onNavigateUp, onTap, onLongPress }: FilesTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sorted = useMemo(
    () => sortFileEntries(files, sortColumn, sortDirection),
    [files, sortColumn, sortDirection],
  );

  return (
    <table className="w-full table-fixed caption-bottom text-sm">
      <colgroup>
        <col />
        <col className="w-24" />
      </colgroup>
      <TableHeader className="sticky top-0 z-10 bg-push-surface-inset/95 backdrop-blur-sm [&_tr]:border-push-edge-subtle/70">
        <TableRow className="hover:bg-transparent">
          <SortableColumnHead
            label="Name"
            column="name"
            activeColumn={sortColumn}
            direction={sortDirection}
            onSort={handleSort}
          />
          <SortableColumnHead
            label="Size"
            column="size"
            activeColumn={sortColumn}
            direction={sortDirection}
            onSort={handleSort}
            align="right"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {!isRoot && (
          <TableRow
            onClick={onNavigateUp}
            className="cursor-pointer border-push-edge-subtle/70 transition-colors hover:bg-push-surface-hover active:bg-push-surface-active"
          >
            <TableCell colSpan={2} className="px-4 py-3">
              <span className="flex items-center gap-3">
                <ChevronLeft className="h-4 w-4 shrink-0 text-push-fg-dim" />
                <span className="text-sm text-push-fg-secondary">..</span>
              </span>
            </TableCell>
          </TableRow>
        )}
        {sorted.map((file) => (
          <FilesTableRow key={file.path} file={file} onTap={onTap} onLongPress={onLongPress} />
        ))}
      </TableBody>
    </table>
  );
}

interface SortableColumnHeadProps {
  label: string;
  column: SortColumn;
  activeColumn: SortColumn;
  direction: SortDirection;
  onSort: (column: SortColumn) => void;
  align?: 'left' | 'right';
}

/** HeroUI `Table.SortableColumnHeader` anatomy: the header cell hosts a real
 *  button carrying the label plus an ascending/descending indicator on the
 *  active column, and the `<th>` reports state via `aria-sort`. */
function SortableColumnHead({
  label,
  column,
  activeColumn,
  direction,
  onSort,
  align = 'left',
}: SortableColumnHeadProps) {
  const isActive = column === activeColumn;
  const DirectionIcon = direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={isActive ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`h-9 px-4 ${align === 'right' ? 'text-right' : ''}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 text-push-2xs uppercase tracking-[0.18em] transition-colors ${
          isActive ? 'text-push-fg-secondary' : 'text-push-fg-dim hover:text-push-fg-secondary'
        }`}
      >
        <span>{label}</span>
        {isActive && <DirectionIcon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      </button>
    </TableHead>
  );
}

interface FilesTableRowProps {
  file: FileEntry;
  onTap: (file: FileEntry) => void;
  onLongPress: (file: FileEntry) => void;
}

function FilesTableRow({ file, onTap, onLongPress }: FilesTableRowProps) {
  const [pressTimer, setPressTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [didLongPress, setDidLongPress] = useState(false);

  const handlePointerDown = () => {
    setDidLongPress(false);
    const timer = setTimeout(() => {
      setDidLongPress(true);
      onLongPress(file);
    }, 500);
    setPressTimer(timer);
  };

  const handlePointerUp = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      setPressTimer(null);
    }
    if (!didLongPress) {
      onTap(file);
    }
  };

  const handlePointerLeave = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      setPressTimer(null);
    }
  };

  const isDir = file.type === 'directory';
  const editability = !isDir ? getFileEditability(file.path, file.size) : null;
  const isEditable = editability?.editable ?? false;

  return (
    <TableRow
      tabIndex={0}
      aria-label={file.name}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onTap(file);
        }
      }}
      className="cursor-pointer select-none border-push-edge-subtle/70 transition-colors hover:bg-push-surface-hover active:bg-push-surface-active"
    >
      <TableCell className="px-4 py-3">
        <span className="flex min-w-0 items-center gap-3">
          {isDir ? (
            <Folder className="h-4 w-4 shrink-0 text-push-link" />
          ) : isEditable ? (
            <FileEdit className="h-4 w-4 shrink-0 text-push-status-success" />
          ) : (
            <File className="h-4 w-4 shrink-0 text-push-fg-dim" />
          )}
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-sm ${isDir ? 'text-push-fg' : 'text-push-fg-secondary'}`}
            >
              {file.name}
            </span>
            {!isDir && editability?.warning === 'large_file' && (
              <span className="text-push-2xs text-push-status-warning">Large file</span>
            )}
          </span>
        </span>
      </TableCell>
      <TableCell className="px-4 py-3 text-right">
        {isDir ? (
          <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-push-fg-dim" />
        ) : (
          <span className="font-mono text-push-xs text-push-fg-dim">{formatSize(file.size)}</span>
        )}
      </TableCell>
    </TableRow>
  );
}
