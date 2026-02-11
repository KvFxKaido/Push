/**
 * Full-screen Sheet panel with a CodeMirror editor.
 *
 * - GitHub files → read-only
 * - Sandbox files → editable + save button
 * - Custom header with close button (Sheet's default close is hidden via CSS)
 */

import { useState, useCallback } from 'react';
import { X, Save, FileCode, Lock, Pencil } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { useCodeMirror } from '@/hooks/useCodeMirror';
import type { EditorCardData, CardAction } from '@/types';

interface EditorPanelProps {
  data: EditorCardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

export function EditorPanel({
  data,
  open,
  onOpenChange,
  messageId,
  cardIndex,
  onAction,
}: EditorPanelProps) {
  const editable = data.source === 'sandbox';
  const [editedContent, setEditedContent] = useState(data.content);
  const [saving, setSaving] = useState(false);
  const isDirty = editable && editedContent !== data.content;

  const handleDocChange = useCallback((doc: string) => {
    setEditedContent(doc);
  }, []);

  const { containerRef } = useCodeMirror({
    doc: data.content,
    language: data.language,
    readOnly: !editable,
    onDocChange: editable ? handleDocChange : undefined,
  });

  const handleSave = useCallback(() => {
    if (!onAction || !messageId || !data.sandboxId || !isDirty) return;
    setSaving(true);
    onAction({
      type: 'editor-save',
      messageId,
      cardIndex: cardIndex ?? 0,
      path: data.path,
      content: editedContent,
      sandboxId: data.sandboxId,
    });
    // The parent will handle the actual write — we optimistically show saved state
    setTimeout(() => setSaving(false), 1000);
  }, [onAction, messageId, cardIndex, data.path, data.sandboxId, editedContent, isDirty]);

  const filename = data.path.split('/').pop() || data.path;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[92dvh] rounded-t-xl border-t border-push-edge bg-[#05080e] p-0 gap-0 [&>[data-slot=sheet-close]]:hidden"
      >
        {/* Accessible but visually hidden title/description */}
        <SheetTitle className="sr-only">{filename}</SheetTitle>
        <SheetDescription className="sr-only">
          {editable ? 'Editable' : 'Read-only'} file viewer for {data.path}
        </SheetDescription>

        {/* Custom header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-push-edge bg-[#05080e] shrink-0">
          <button
            onClick={() => onOpenChange(false)}
            className="p-1 rounded hover:bg-[#111624] transition-colors"
          >
            <X className="h-4 w-4 text-push-fg-muted" />
          </button>

          <FileCode className="h-3.5 w-3.5 text-push-fg-secondary shrink-0" />
          <span className="text-[13px] text-push-fg font-mono truncate flex-1">
            {data.path}
          </span>

          {/* Mode badge */}
          {editable ? (
            <span className="flex items-center gap-1 text-[11px] text-[#86efac] bg-[#86efac12] px-1.5 py-0.5 rounded shrink-0">
              <Pencil className="h-2.5 w-2.5" />
              Edit
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-push-fg-dim bg-[#111624] px-1.5 py-0.5 rounded shrink-0">
              <Lock className="h-2.5 w-2.5" />
              Read-only
            </span>
          )}

          {data.language && (
            <span className="text-[11px] text-push-fg-dim bg-[#111624] px-1.5 py-0.5 rounded shrink-0">
              {data.language}
            </span>
          )}

          {/* Save button — sandbox only */}
          {editable && (
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className={`flex items-center gap-1 text-[12px] px-2 py-1 rounded transition-colors shrink-0 ${
                isDirty && !saving
                  ? 'bg-[#a78bfa] text-[#0c0c0e] hover:bg-[#8b5cf6]'
                  : 'bg-[#111624] text-[#5f6b80] cursor-not-allowed'
              }`}
            >
              <Save className="h-3 w-3" />
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>

        {/* CodeMirror editor fills remaining space */}
        <div ref={containerRef} className="flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-scroller]:!overflow-auto" />
      </SheetContent>
    </Sheet>
  );
}
