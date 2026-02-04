/**
 * FileActionsSheet — bottom sheet for file/folder actions.
 *
 * Triggered by tapping a file row. Shows contextual actions:
 * delete, rename. Rename uses an inline input field.
 */

import { Trash2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { FileEntry } from '@/types';

interface FileActionsSheetProps {
  file: FileEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (path: string) => void;
}

export function FileActionsSheet({
  file,
  open,
  onOpenChange,
  onDelete,
}: FileActionsSheetProps) {
  const handleDelete = () => {
    if (!file) return;
    onDelete(file.path);
    onOpenChange(false);
  };

  if (!file) return null;

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
        </SheetHeader>

        <div className="flex flex-col gap-1 px-4 pb-6">
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
