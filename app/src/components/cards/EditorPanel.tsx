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
import { CARD_BADGE_INFO, CARD_BUTTON_CLASS, CARD_ICON_BUTTON_CLASS } from '@/lib/utils';

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
      expectedVersion: data.version,
      expectedWorkspaceRevision: data.workspaceRevision,
    });
    // The parent will handle the actual write — we optimistically show saved state
    setTimeout(() => setSaving(false), 1000);
  }, [onAction, messageId, cardIndex, data.path, data.sandboxId, data.version, data.workspaceRevision, editedContent, isDirty]);

  const filename = data.path.split('/').pop() || data.path;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[92dvh] rounded-t-xl border-t border-push-edge bg-push-grad-panel p-0 gap-0 [&>[data-slot=sheet-close]]:hidden"
      >
        {/* Accessible but visually hidden title/description */}
        <SheetTitle className="sr-only">{filename}</SheetTitle>
        <SheetDescription className="sr-only">
          {editable ? 'Editable' : 'Read-only'} file viewer for {data.path}
        </SheetDescription>

        {/* Custom header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-push-edge/80 bg-[linear-gradient(180deg,rgba(10,13,20,0.84)_0%,rgba(6,8,13,0.92)_100%)] px-3 py-2.5 backdrop-blur-xl">
          <button
            onClick={() => onOpenChange(false)}
            className={`${CARD_ICON_BUTTON_CLASS} h-8 w-8`}
          >
            <X className="h-4 w-4" />
          </button>

          <FileCode className="h-3.5 w-3.5 text-push-fg-secondary shrink-0" />
          <span className="text-push-base text-push-fg font-mono truncate flex-1">
            {data.path}
          </span>

          {/* Mode badge */}
          {editable ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-push-xs text-emerald-300">
              <Pencil className="h-2.5 w-2.5" />
              Edit
            </span>
          ) : (
            <span className={`${CARD_BADGE_INFO} flex shrink-0 items-center gap-1 px-2 py-0.5 text-push-xs`}>
              <Lock className="h-2.5 w-2.5" />
              Read-only
            </span>
          )}

          {data.language && (
            <span className={`${CARD_BADGE_INFO} shrink-0 px-2 py-0.5 text-push-xs`}>
              {data.language}
            </span>
          )}

          {/* Save button — sandbox only */}
          {editable && (
            <button
              onClick={handleSave}
              disabled={!isDirty || saving}
              className={`${CARD_BUTTON_CLASS} h-9 shrink-0 ${isDirty && !saving ? 'text-emerald-300' : ''}`}
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
