/**
 * Library picker — opens from a button in the chat composer and lets the
 * user attach previously-saved files to the current chat without
 * re-uploading. Also handles uploading new files directly into the
 * library and managing labels.
 *
 * The picker lives inside a Popover that mirrors the existing
 * ModelPicker styling in ChatInput.tsx so the composer's visual
 * language stays consistent.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Check,
  FileCode,
  FileText,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useChatLibrary } from '@/hooks/useChatLibrary';
import {
  ACCEPTED_FILE_TYPES,
  formatFileSize,
  processFile,
  type StagedAttachment,
} from '@/lib/file-processing';
import type { LibraryItemMeta } from '@/lib/chat-library-types';

interface LibraryPanelProps {
  /** Disable the button (e.g. while streaming) without hiding it. */
  disabled?: boolean;
  /** Called with one or more attachments when the user confirms selection. */
  onAttach: (attachments: StagedAttachment[]) => void;
  /** Shared composer button surface classes — mirrored from ChatInput. */
  buttonClassName: string;
  iconClassName?: string;
}

export function LibraryPanel({
  disabled,
  onAttach,
  buttonClassName,
  iconClassName,
}: LibraryPanelProps) {
  const [open, setOpen] = useState(false);
  // Destructure stable refs from the hook — the wrapping object is a new
  // identity every render, so depending on `lib` directly defeats the
  // useCallback memoization for every handler below.
  const { items, isLoading, error, hasFetched, refresh, save, fetchOne, rename, remove } =
    useChatLibrary();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Single close path that always resets transient UI. The controlled
   * Popover's `onOpenChange` only fires for user-initiated dismissals
   * (escape / click outside), so any place that programmatically closes
   * the panel (the Close button, post-attach auto-close) must route
   * through this helper or the cleanup is skipped and selections leak
   * across reopens.
   */
  const closeAndReset = useCallback(() => {
    setOpen(false);
    setSelected(new Set());
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setOpen(true);
        // Lazy first-load + refresh-on-reopen — fetched from the event
        // handler instead of an effect to avoid cascading-renders lint.
        if (!hasFetched || !isLoading) void refresh();
      } else {
        closeAndReset();
      }
    },
    [closeAndReset, hasFetched, isLoading, refresh],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setBusy(true);
      try {
        for (const file of Array.from(files)) {
          const processed = await processFile(file);
          if (processed.status !== 'ready') continue;
          // StagedAttachment extends AttachmentData; the server discards
          // the client-side id and generates its own. Per-file failures
          // surface via the hook's `error` state — partial success is
          // intentional for batch uploads.
          await save(processed);
        }
      } finally {
        setBusy(false);
        e.target.value = '';
      }
    },
    [save],
  );

  const handleAttachSelected = useCallback(async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      // Parallel fetch — each library `get` is an independent KV
      // round-trip, no need to serialize.
      const results = await Promise.all(Array.from(selected).map((id) => fetchOne(id)));
      const fetched: StagedAttachment[] = [];
      for (const item of results) {
        if (!item) continue;
        // Re-stamp with a fresh id so the same library item can be attached
        // to multiple chats without colliding in the staged-attachment list.
        fetched.push({
          id: crypto.randomUUID(),
          type: item.type,
          filename: item.filename,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
          content: item.content,
          thumbnail: item.thumbnail,
          status: 'ready',
        });
      }
      if (fetched.length > 0) {
        onAttach(fetched);
        closeAndReset();
      }
    } finally {
      setBusy(false);
    }
  }, [closeAndReset, fetchOne, onAttach, selected]);

  const handleStartRename = useCallback((item: LibraryItemMeta) => {
    setRenamingId(item.id);
    setRenameValue(item.label ?? '');
  }, []);

  const handleCommitRename = useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    const ok = await rename(renamingId, trimmed.length === 0 ? null : trimmed);
    // On failure leave the rename UI open so the user doesn't lose their
    // input; the panel's error banner shows the message.
    if (ok) {
      setRenamingId(null);
      setRenameValue('');
    }
  }, [rename, renamingId, renameValue]);

  const handleDelete = useCallback(
    async (id: string) => {
      await remove(id);
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [remove],
  );

  const selectedCount = selected.size;
  const attachLabel = useMemo(
    () => (selectedCount > 0 ? `Attach (${selectedCount})` : 'Attach'),
    [selectedCount],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={buttonClassName}
          aria-label="Open library"
          title="Library — attach saved files"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.05] to-transparent" />
          <BookIcon className={iconClassName ?? 'relative z-10 h-4 w-4'} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="w-[320px] rounded-xl border border-[#1f2531] bg-push-grad-panel p-2.5 text-[#d7deeb] shadow-[0_12px_36px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] animate-fade-in"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1 pt-0.5">
            <p className="text-push-2xs font-medium uppercase tracking-wide text-[#7c879b]">
              Library
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="flex items-center gap-1 rounded-md border border-[#2a3447] bg-[#070a10] px-2 py-1 text-push-2xs text-[#d7deeb] hover:border-[#3d5579] disabled:opacity-60"
              title="Upload files to the library"
            >
              <Plus className="h-3 w-3" />
              Add files
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              multiple
              onChange={handleUpload}
              className="hidden"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-push-2xs text-red-300">
              {error}
            </div>
          )}

          <div className="max-h-[360px] overflow-y-auto rounded-lg border border-[#2a3447] bg-[#070a10]">
            {isLoading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-push-2xs text-[#7c879b]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-4 text-center text-push-2xs text-[#7c879b]">
                No saved files yet. Tap <span className="text-[#d7deeb]">Add files</span> to keep
                files around for reuse across chats.
              </div>
            ) : (
              <ul className="divide-y divide-[#1a2230]">
                {items.map((item) => {
                  const isSelected = selected.has(item.id);
                  const isRenaming = renamingId === item.id;
                  return (
                    <li
                      key={item.id}
                      className={`px-2 py-2 ${isSelected ? 'bg-push-accent/10' : ''}`}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => toggleSelect(item.id)}
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            isSelected
                              ? 'border-push-accent bg-push-accent text-push-bg'
                              : 'border-[#3a4456]'
                          }`}
                          aria-label={isSelected ? 'Deselect' : 'Select'}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </button>
                        <LibraryItemIcon type={item.type} />
                        <div className="min-w-0 flex-1">
                          {isRenaming ? (
                            <input
                              autoFocus
                              type="text"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onBlur={() => void handleCommitRename()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleCommitRename();
                                if (e.key === 'Escape') {
                                  setRenamingId(null);
                                  setRenameValue('');
                                }
                              }}
                              placeholder="Label (leave blank to clear)"
                              className="w-full rounded border border-[#3d5579] bg-[#070a10] px-1.5 py-0.5 text-push-xs text-[#d7deeb] outline-none"
                            />
                          ) : (
                            <p className="truncate text-push-xs text-[#d7deeb]">
                              {item.label || item.filename}
                            </p>
                          )}
                          <p className="truncate text-push-2xs text-[#7c879b]">
                            {item.label ? `${item.filename} · ` : ''}
                            {formatFileSize(item.sizeBytes)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => handleStartRename(item)}
                            className="rounded p-1 text-[#7c879b] hover:text-[#d7deeb]"
                            title="Rename"
                            aria-label="Rename"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(item.id)}
                            className="rounded p-1 text-[#7c879b] hover:text-red-400"
                            title="Delete"
                            aria-label="Delete"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
            <button
              type="button"
              onClick={closeAndReset}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-push-2xs text-[#7c879b] hover:text-[#d7deeb]"
            >
              <X className="h-3 w-3" />
              Close
            </button>
            <button
              type="button"
              onClick={() => void handleAttachSelected()}
              disabled={selectedCount === 0 || busy}
              className="flex items-center gap-1 rounded-md border border-push-accent/40 bg-push-accent/20 px-2.5 py-1 text-push-2xs text-push-accent hover:bg-push-accent/30 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              {attachLabel}
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LibraryItemIcon({ type }: { type: LibraryItemMeta['type'] }) {
  if (type === 'image') return <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#8891a1]" />;
  if (type === 'code') return <FileCode className="mt-0.5 h-4 w-4 shrink-0 text-push-accent" />;
  return <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#8891a1]" />;
}

/**
 * Inline SVG matching the composer's other custom round-button icons —
 * a small open-book glyph. Using lucide's BookOpen would visually clash
 * with the existing custom icon set so we hand-roll a minimal one.
 */
function BookIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H10a2 2 0 0 1 2 2v13a1 1 0 0 0-1-1H4.5A1.5 1.5 0 0 1 3 16.5v-11Z" />
      <path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H14a2 2 0 0 0-2 2v13a1 1 0 0 1 1-1h6.5a1.5 1.5 0 0 0 1.5-1.5v-11Z" />
    </svg>
  );
}
