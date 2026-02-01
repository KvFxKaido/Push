/**
 * FileActionsSheet — bottom sheet for file/folder actions.
 *
 * Triggered by tapping a file row. Shows contextual actions:
 * delete, rename. Rename uses an inline input field.
 */

import { useState } from 'react';
import { Trash2, PenLine, X } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import type { FileEntry } from '@/types';

interface FileActionsSheetProps {
  file: FileEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (path: string) => void;
  onRename: (oldPath: string, newName: string) => void;
}

export function FileActionsSheet({
  file,
  open,
  onOpenChange,
  onDelete,
  onRename,
}: FileActionsSheetProps) {
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  const handleOpen = (isOpen: boolean) => {
    if (!isOpen) {
      setRenaming(false);
      setNewName('');
    }
    onOpenChange(isOpen);
  };

  const handleStartRename = () => {
    if (!file) return;
    setNewName(file.name);
    setRenaming(true);
  };

  const handleConfirmRename = () => {
    if (!file || !newName.trim() || newName === file.name) return;
    onRename(file.path, newName.trim());
    handleOpen(false);
  };

  const handleDelete = () => {
    if (!file) return;
    onDelete(file.path);
    handleOpen(false);
  };

  if (!file) return null;

  return (
    <Sheet open={open} onOpenChange={handleOpen}>
      <SheetContent
        side="bottom"
        className="bg-[#111113] border-[#1a1a1e] rounded-t-2xl max-h-[50dvh]"
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="text-[#fafafa] text-sm font-medium truncate">
            {file.name}
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-1 px-4 pb-6">
          {renaming ? (
            <div className="space-y-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmRename();
                  if (e.key === 'Escape') setRenaming(false);
                }}
                autoFocus
                className="w-full rounded-lg border border-[#1a1a1e] bg-[#09090b] px-3 py-2.5 text-sm text-[#fafafa] font-mono placeholder:text-[#52525b] focus:outline-none focus:border-[#3f3f46] transition-colors"
                placeholder="New name"
              />
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRenaming(false)}
                  className="flex-1 text-[#a1a1aa] hover:text-[#fafafa]"
                >
                  <X className="h-3.5 w-3.5 mr-1.5" />
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleConfirmRename}
                  disabled={!newName.trim() || newName === file.name}
                  className="flex-1 bg-[#0070f3] hover:bg-[#0060d3] text-white"
                >
                  <PenLine className="h-3.5 w-3.5 mr-1.5" />
                  Rename
                </Button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={handleStartRename}
                className="flex items-center gap-3 px-3 py-3 rounded-lg text-[#a1a1aa] hover:text-[#fafafa] hover:bg-[#1a1a1e] transition-colors text-left"
              >
                <PenLine className="h-4 w-4 shrink-0" />
                <span className="text-sm">Rename</span>
              </button>
              <button
                onClick={handleDelete}
                className="flex items-center gap-3 px-3 py-3 rounded-lg text-[#ef4444]/80 hover:text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors text-left"
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                <span className="text-sm">Delete</span>
              </button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
