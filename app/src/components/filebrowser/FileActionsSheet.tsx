/**
 * FileActionsSheet — bottom sheet for file/folder actions.
 *
 * Triggered by tapping a file row. Shows contextual actions:
 * edit (text files), delete. Rename removed to fit Modal free tier.
 */

import { Trash2, FileEdit } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { getFileEditability, formatFileSize } from '@/lib/file-utils';
import type { FileEntry } from '@/types';

interface FileActionsSheetProps {
  file: FileEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (path: string) => void;
  onEdit?: (file: FileEntry) => void;
}

export function FileActionsSheet({
  file,
  open,
  onOpenChange,
  onDelete,
  onEdit,
}: FileActionsSheetProps) {
  const handleDelete = () => {
    if (!file) return;
    onDelete(file.path);
    onOpenChange(false);
  };

  const handleEdit = () => {
    if (!file || !onEdit) return;
    onEdit(file);
    onOpenChange(false);
  };

  if (!file) return null;

  const isDirectory = file.type === 'directory';
  const editability = isDirectory ? null : getFileEditability(file.path, file.size);
  const canEdit = editability?.editable ?? false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-[#0d0d0d] border-[#1a1a1a] rounded-t-2xl max-h-[50dvh]"
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="text-[#fafafa] text-sm font-medium truncate">
            {file.name}
          </SheetTitle>
          <p className="text-xs text-[#52525b]">
            {isDirectory ? 'Folder' : formatFileSize(file.size)}
            {editability?.warning === 'large_file' && (
              <span className="text-[#f59e0b] ml-1">• Large file</span>
            )}
          </p>
        </SheetHeader>

        <div className="flex flex-col gap-1 px-4 pb-6">
          {/* Edit action — only for editable text files */}
          {!isDirectory && canEdit && (
            <button
              onClick={handleEdit}
              className="flex items-center gap-3 px-3 py-3 rounded-lg text-push-accent hover:bg-push-accent/10 transition-colors text-left"
            >
              <FileEdit className="h-4 w-4 shrink-0" />
              <span className="text-sm">Edit file</span>
            </button>
          )}

          {/* Delete action */}
          <button
            onClick={handleDelete}
            className="flex items-center gap-3 px-3 py-3 rounded-lg text-[#ef4444]/80 hover:text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors text-left"
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            <span className="text-sm">Delete</span>
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
