/**
 * Library picker (v2a) — opens from a button in the chat composer.
 *
 * Two-view popover: the default view lists every Library; tapping one
 * opens its detail view (items inside + "Attach library" primary
 * action + library management). The detail's Attach button stages
 * every item in the library into the chat composer as a normal
 * attachment, and includes the library's `instructions` (if any) as a
 * synthetic text attachment so it reaches the model the same way as
 * any other file. No per-turn injection in v2a.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
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
import type { LibraryItem, LibraryItemMeta, LibraryMeta } from '@/lib/chat-library-types';

interface LibraryPanelProps {
  disabled?: boolean;
  onAttach: (attachments: StagedAttachment[]) => void;
  buttonClassName: string;
  iconClassName?: string;
}

const NAME_MAX = 200;
const INSTRUCTIONS_MAX = 2000;

export function LibraryPanel({
  disabled,
  onAttach,
  buttonClassName,
  iconClassName,
}: LibraryPanelProps) {
  const [open, setOpen] = useState(false);
  const lib = useChatLibrary();
  const {
    collections,
    isLoading,
    hasFetched,
    error,
    refresh,
    openCollectionId,
    openCollection,
    isDetailLoading,
    openCollectionRef,
    createCollection,
    renameCollection,
    setInstructions,
    deleteCollection,
    saveItem,
    renameItem,
    deleteItem,
    fetchForAttach,
  } = lib;

  const [busy, setBusy] = useState(false);
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameItemValue, setRenameItemValue] = useState('');
  const [isRenamingCollection, setIsRenamingCollection] = useState(false);
  const [renameCollectionValue, setRenameCollectionValue] = useState('');
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);
  const [instructionsValue, setInstructionsValue] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---------- open/close ----------

  const closeAndReset = useCallback(() => {
    setOpen(false);
    setBusy(false);
    setIsCreatingCollection(false);
    setNewCollectionName('');
    setRenamingItemId(null);
    setRenameItemValue('');
    setIsRenamingCollection(false);
    setRenameCollectionValue('');
    setIsEditingInstructions(false);
    setInstructionsValue('');
    void openCollectionRef(null);
  }, [openCollectionRef]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setOpen(true);
        if (!hasFetched || !isLoading) void refresh();
      } else {
        closeAndReset();
      }
    },
    [closeAndReset, hasFetched, isLoading, refresh],
  );

  // ---------- list-view actions ----------

  const handleCommitCreateCollection = useCallback(async () => {
    const trimmed = newCollectionName.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    const created = await createCollection(trimmed);
    setBusy(false);
    if (created) {
      setIsCreatingCollection(false);
      setNewCollectionName('');
      // Drop straight into the new collection so the user can add files.
      await openCollectionRef(created.id);
    }
  }, [createCollection, newCollectionName, openCollectionRef]);

  const handleSelectCollection = useCallback(
    (id: string) => {
      void openCollectionRef(id);
    },
    [openCollectionRef],
  );

  // ---------- detail-view actions ----------

  const handleUploadIntoCollection = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const libId = openCollection?.collection.id;
      if (!libId) return;
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setBusy(true);
      try {
        for (const file of Array.from(files)) {
          const processed = await processFile(file);
          if (processed.status !== 'ready') continue;
          await saveItem(libId, processed);
        }
      } finally {
        setBusy(false);
        e.target.value = '';
      }
    },
    [openCollection, saveItem],
  );

  const handleStartRenameItem = useCallback((item: LibraryItemMeta) => {
    setRenamingItemId(item.id);
    setRenameItemValue(item.label ?? '');
  }, []);

  const handleCommitRenameItem = useCallback(async () => {
    if (!renamingItemId) return;
    const libId = openCollection?.collection.id;
    if (!libId) return;
    const trimmed = renameItemValue.trim();
    const ok = await renameItem(libId, renamingItemId, trimmed.length === 0 ? null : trimmed);
    if (ok) {
      setRenamingItemId(null);
      setRenameItemValue('');
    }
  }, [openCollection, renameItem, renameItemValue, renamingItemId]);

  const handleDeleteItem = useCallback(
    async (id: string) => {
      const libId = openCollection?.collection.id;
      if (!libId) return;
      await deleteItem(libId, id);
    },
    [deleteItem, openCollection],
  );

  const handleStartRenameCollection = useCallback(() => {
    if (!openCollection) return;
    setIsRenamingCollection(true);
    setRenameCollectionValue(openCollection.collection.name);
  }, [openCollection]);

  const handleCommitRenameCollection = useCallback(async () => {
    if (!openCollection) return;
    const trimmed = renameCollectionValue.trim();
    if (trimmed.length === 0) return;
    const ok = await renameCollection(openCollection.collection.id, trimmed);
    if (ok) {
      setIsRenamingCollection(false);
      setRenameCollectionValue('');
    }
  }, [openCollection, renameCollection, renameCollectionValue]);

  const handleStartEditInstructions = useCallback(() => {
    if (!openCollection) return;
    setIsEditingInstructions(true);
    setInstructionsValue(openCollection.collection.instructions ?? '');
  }, [openCollection]);

  const handleCommitInstructions = useCallback(async () => {
    if (!openCollection) return;
    const value = instructionsValue;
    const ok = await setInstructions(
      openCollection.collection.id,
      value.trim().length === 0 ? null : value,
    );
    if (ok) {
      setIsEditingInstructions(false);
      setInstructionsValue('');
    }
  }, [instructionsValue, openCollection, setInstructions]);

  const handleDeleteCollection = useCallback(async () => {
    if (!openCollection) return;
    setBusy(true);
    const ok = await deleteCollection(openCollection.collection.id);
    setBusy(false);
    if (ok) {
      await openCollectionRef(null);
    }
  }, [deleteCollection, openCollection, openCollectionRef]);

  // ---------- Attach Library ----------

  const handleAttachLibrary = useCallback(async () => {
    if (!openCollection) return;
    const libId = openCollection.collection.id;
    const hasItems = openCollection.collection.itemCount > 0;
    const hasInstr =
      typeof openCollection.collection.instructions === 'string' &&
      openCollection.collection.instructions.length > 0;
    if (!hasItems && !hasInstr) return;

    setBusy(true);
    try {
      const items: LibraryItem[] = hasItems ? await fetchForAttach(libId) : [];
      const staged: StagedAttachment[] = items.map((item) => ({
        id: crypto.randomUUID(),
        type: item.type,
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        content: item.content,
        thumbnail: item.thumbnail,
        status: 'ready',
      }));

      // Instructions ride along as a synthetic text attachment. Per
      // the v2a constraint, they only reach the model as normal
      // attached text — no system-prompt injection yet.
      if (hasInstr) {
        const text = openCollection.collection.instructions ?? '';
        const filename = sanitizeInstructionsFilename(openCollection.collection.name);
        staged.unshift({
          id: crypto.randomUUID(),
          type: 'document',
          filename,
          mimeType: 'text/markdown',
          sizeBytes: new Blob([text]).size,
          content: text,
          status: 'ready',
        });
      }

      if (staged.length > 0) {
        onAttach(staged);
        closeAndReset();
      }
    } finally {
      setBusy(false);
    }
  }, [closeAndReset, fetchForAttach, onAttach, openCollection]);

  // ---------- render helpers ----------

  const showingDetail = openCollectionId !== null;
  const detail = openCollection;
  const canAttachLibrary = useMemo(() => {
    if (!detail) return false;
    if (detail.collection.itemCount > 0) return true;
    return (
      typeof detail.collection.instructions === 'string' &&
      detail.collection.instructions.length > 0
    );
  }, [detail]);

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
        className="w-[340px] rounded-xl border border-[#1f2531] bg-push-grad-panel p-2.5 text-[#d7deeb] shadow-[0_12px_36px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)] animate-fade-in"
      >
        {!showingDetail && (
          <CollectionListView
            collections={collections}
            isLoading={isLoading}
            error={error}
            isCreatingCollection={isCreatingCollection}
            newCollectionName={newCollectionName}
            busy={busy}
            onStartCreate={() => {
              setIsCreatingCollection(true);
              setNewCollectionName('');
            }}
            onCancelCreate={() => {
              setIsCreatingCollection(false);
              setNewCollectionName('');
            }}
            onCommitCreate={handleCommitCreateCollection}
            onChangeCreateName={setNewCollectionName}
            onSelectCollection={handleSelectCollection}
            onClose={closeAndReset}
          />
        )}
        {showingDetail && (
          <CollectionDetailView
            detail={detail}
            isLoading={isDetailLoading}
            error={error}
            busy={busy}
            canAttachLibrary={canAttachLibrary}
            fileInputRef={fileInputRef}
            isRenamingCollection={isRenamingCollection}
            renameCollectionValue={renameCollectionValue}
            isEditingInstructions={isEditingInstructions}
            instructionsValue={instructionsValue}
            renamingItemId={renamingItemId}
            renameItemValue={renameItemValue}
            onBack={() => void openCollectionRef(null)}
            onAttachLibrary={handleAttachLibrary}
            onUploadFiles={handleUploadIntoCollection}
            onStartRenameCollection={handleStartRenameCollection}
            onChangeRenameCollection={setRenameCollectionValue}
            onCommitRenameCollection={handleCommitRenameCollection}
            onCancelRenameCollection={() => {
              setIsRenamingCollection(false);
              setRenameCollectionValue('');
            }}
            onStartEditInstructions={handleStartEditInstructions}
            onChangeInstructions={setInstructionsValue}
            onCommitInstructions={handleCommitInstructions}
            onCancelEditInstructions={() => {
              setIsEditingInstructions(false);
              setInstructionsValue('');
            }}
            onStartRenameItem={handleStartRenameItem}
            onChangeRenameItem={setRenameItemValue}
            onCommitRenameItem={handleCommitRenameItem}
            onCancelRenameItem={() => {
              setRenamingItemId(null);
              setRenameItemValue('');
            }}
            onDeleteItem={handleDeleteItem}
            onDeleteCollection={handleDeleteCollection}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Collection list view
// ---------------------------------------------------------------------------

interface CollectionListViewProps {
  collections: LibraryMeta[];
  isLoading: boolean;
  error: string | null;
  isCreatingCollection: boolean;
  newCollectionName: string;
  busy: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCommitCreate: () => void;
  onChangeCreateName: (v: string) => void;
  onSelectCollection: (id: string) => void;
  onClose: () => void;
}

function CollectionListView({
  collections,
  isLoading,
  error,
  isCreatingCollection,
  newCollectionName,
  busy,
  onStartCreate,
  onCancelCreate,
  onCommitCreate,
  onChangeCreateName,
  onSelectCollection,
  onClose,
}: CollectionListViewProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1 pt-0.5">
        <p className="text-push-2xs font-medium uppercase tracking-wide text-[#7c879b]">
          Libraries
        </p>
        {!isCreatingCollection && (
          <button
            type="button"
            onClick={onStartCreate}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-[#2a3447] bg-[#070a10] px-2 py-1 text-push-2xs text-[#d7deeb] hover:border-[#3d5579] disabled:opacity-60"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
        )}
      </div>

      {isCreatingCollection && (
        <div className="rounded-lg border border-[#2a3447] bg-[#070a10] p-2">
          <input
            autoFocus
            type="text"
            maxLength={NAME_MAX}
            value={newCollectionName}
            onChange={(e) => onChangeCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitCreate();
              if (e.key === 'Escape') onCancelCreate();
            }}
            placeholder="Library name"
            className="w-full rounded border border-[#3d5579] bg-[#070a10] px-2 py-1 text-push-xs text-[#d7deeb] outline-none"
          />
          <div className="mt-2 flex justify-end gap-1">
            <button
              type="button"
              onClick={onCancelCreate}
              className="rounded-md px-2 py-1 text-push-2xs text-[#7c879b] hover:text-[#d7deeb]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onCommitCreate}
              disabled={newCollectionName.trim().length === 0 || busy}
              className="rounded-md border border-push-accent/40 bg-push-accent/20 px-2 py-1 text-push-2xs text-push-accent disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-push-2xs text-red-300">
          {error}
        </div>
      )}

      <div className="max-h-[360px] overflow-y-auto rounded-lg border border-[#2a3447] bg-[#070a10]">
        {isLoading && collections.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-push-2xs text-[#7c879b]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading…
          </div>
        ) : collections.length === 0 ? (
          <div className="px-3 py-4 text-center text-push-2xs text-[#7c879b]">
            No libraries yet. Tap <span className="text-[#d7deeb]">New</span> to start one.
          </div>
        ) : (
          <ul className="divide-y divide-[#1a2230]">
            {collections.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelectCollection(c.id)}
                  className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-push-accent/5"
                >
                  <BookIcon className="h-4 w-4 shrink-0 text-[#8891a1]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-push-xs text-[#d7deeb]">{c.name}</p>
                    <p className="truncate text-push-2xs text-[#7c879b]">
                      {c.itemCount} {c.itemCount === 1 ? 'item' : 'items'}
                      {c.hasInstructions ? ' · instructions' : ''}
                    </p>
                  </div>
                  <ChevronLeft className="h-3 w-3 rotate-180 text-[#7c879b]" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-end px-1 pt-0.5">
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-push-2xs text-[#7c879b] hover:text-[#d7deeb]"
        >
          <X className="h-3 w-3" />
          Close
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection detail view
// ---------------------------------------------------------------------------

interface CollectionDetailViewProps {
  detail: {
    collection: import('@/lib/chat-library-types').Library;
    items: LibraryItemMeta[];
  } | null;
  isLoading: boolean;
  error: string | null;
  busy: boolean;
  canAttachLibrary: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isRenamingCollection: boolean;
  renameCollectionValue: string;
  isEditingInstructions: boolean;
  instructionsValue: string;
  renamingItemId: string | null;
  renameItemValue: string;
  onBack: () => void;
  onAttachLibrary: () => void;
  onUploadFiles: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStartRenameCollection: () => void;
  onChangeRenameCollection: (v: string) => void;
  onCommitRenameCollection: () => void;
  onCancelRenameCollection: () => void;
  onStartEditInstructions: () => void;
  onChangeInstructions: (v: string) => void;
  onCommitInstructions: () => void;
  onCancelEditInstructions: () => void;
  onStartRenameItem: (item: LibraryItemMeta) => void;
  onChangeRenameItem: (v: string) => void;
  onCommitRenameItem: () => void;
  onCancelRenameItem: () => void;
  onDeleteItem: (id: string) => void;
  onDeleteCollection: () => void;
}

function CollectionDetailView({
  detail,
  isLoading,
  error,
  busy,
  canAttachLibrary,
  fileInputRef,
  isRenamingCollection,
  renameCollectionValue,
  isEditingInstructions,
  instructionsValue,
  renamingItemId,
  renameItemValue,
  onBack,
  onAttachLibrary,
  onUploadFiles,
  onStartRenameCollection,
  onChangeRenameCollection,
  onCommitRenameCollection,
  onCancelRenameCollection,
  onStartEditInstructions,
  onChangeInstructions,
  onCommitInstructions,
  onCancelEditInstructions,
  onStartRenameItem,
  onChangeRenameItem,
  onCommitRenameItem,
  onCancelRenameItem,
  onDeleteItem,
  onDeleteCollection,
}: CollectionDetailViewProps) {
  if (isLoading && !detail) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-6 text-push-2xs text-[#7c879b]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    );
  }
  if (!detail) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 px-1 pt-0.5">
        <button
          type="button"
          onClick={onBack}
          className="rounded p-1 text-[#7c879b] hover:text-[#d7deeb]"
          aria-label="Back"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {isRenamingCollection ? (
          <input
            autoFocus
            type="text"
            maxLength={NAME_MAX}
            value={renameCollectionValue}
            onChange={(e) => onChangeRenameCollection(e.target.value)}
            onBlur={onCommitRenameCollection}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitRenameCollection();
              if (e.key === 'Escape') onCancelRenameCollection();
            }}
            className="flex-1 rounded border border-[#3d5579] bg-[#070a10] px-1.5 py-0.5 text-push-xs text-[#d7deeb] outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onStartRenameCollection}
            className="flex-1 truncate text-left text-push-xs font-medium text-[#d7deeb]"
            title="Tap to rename"
          >
            {detail.collection.name}
          </button>
        )}
        <span className="text-push-2xs text-[#7c879b]">
          {detail.collection.itemCount} {detail.collection.itemCount === 1 ? 'item' : 'items'}
        </span>
      </div>

      <button
        type="button"
        onClick={onAttachLibrary}
        disabled={!canAttachLibrary || busy}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-push-accent/40 bg-push-accent/20 px-2.5 py-2 text-push-xs text-push-accent hover:bg-push-accent/30 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        Attach library
      </button>

      <InstructionsSection
        instructions={detail.collection.instructions}
        isEditing={isEditingInstructions}
        value={instructionsValue}
        onStartEdit={onStartEditInstructions}
        onChange={onChangeInstructions}
        onCommit={onCommitInstructions}
        onCancel={onCancelEditInstructions}
      />

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-push-2xs text-red-300">
          {error}
        </div>
      )}

      <div className="max-h-[280px] overflow-y-auto rounded-lg border border-[#2a3447] bg-[#070a10]">
        {detail.items.length === 0 ? (
          <div className="px-3 py-4 text-center text-push-2xs text-[#7c879b]">
            No files yet. Tap <span className="text-[#d7deeb]">Add files</span> to upload.
          </div>
        ) : (
          <ul className="divide-y divide-[#1a2230]">
            {detail.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                isRenaming={renamingItemId === item.id}
                renameValue={renameItemValue}
                onStartRename={() => onStartRenameItem(item)}
                onChangeRename={onChangeRenameItem}
                onCommitRename={onCommitRenameItem}
                onCancelRename={onCancelRenameItem}
                onDelete={() => onDeleteItem(item.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1 rounded-md border border-[#2a3447] bg-[#070a10] px-2 py-1 text-push-2xs text-[#d7deeb] hover:border-[#3d5579] disabled:opacity-60"
        >
          <Plus className="h-3 w-3" />
          Add files
        </button>
        <button
          type="button"
          onClick={onDeleteCollection}
          disabled={busy}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-push-2xs text-[#7c879b] hover:text-red-400 disabled:opacity-60"
          title="Delete library (cascades to all files)"
        >
          <Trash2 className="h-3 w-3" />
          Delete library
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        multiple
        onChange={onUploadFiles}
        className="hidden"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instructions sub-section
// ---------------------------------------------------------------------------

interface InstructionsSectionProps {
  instructions?: string;
  isEditing: boolean;
  value: string;
  onStartEdit: () => void;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function InstructionsSection({
  instructions,
  isEditing,
  value,
  onStartEdit,
  onChange,
  onCommit,
  onCancel,
}: InstructionsSectionProps) {
  if (isEditing) {
    return (
      <div className="rounded-lg border border-[#2a3447] bg-[#070a10] p-2">
        <p className="px-0.5 pb-1 text-push-2xs uppercase tracking-wide text-[#7c879b]">
          Instructions
        </p>
        <textarea
          autoFocus
          maxLength={INSTRUCTIONS_MAX}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Voice / canon notes attached when this library is attached. Treated as a normal text attachment for now."
          className="h-24 w-full resize-none rounded border border-[#3d5579] bg-[#070a10] px-2 py-1 text-push-2xs text-[#d7deeb] outline-none"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-push-2xs text-[#7c879b]">
            {value.length}/{INSTRUCTIONS_MAX}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md px-2 py-1 text-push-2xs text-[#7c879b] hover:text-[#d7deeb]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onCommit}
              className="rounded-md border border-push-accent/40 bg-push-accent/20 px-2 py-1 text-push-2xs text-push-accent"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  const hasInstructions = typeof instructions === 'string' && instructions.length > 0;
  return (
    <button
      type="button"
      onClick={onStartEdit}
      className="flex w-full items-start gap-2 rounded-lg border border-dashed border-[#2a3447] bg-[#070a10] px-2 py-2 text-left text-push-2xs text-[#7c879b] hover:border-[#3d5579] hover:text-[#d7deeb]"
    >
      <Pencil className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="flex-1">
        {hasInstructions ? (
          <span className="line-clamp-2 text-[#d7deeb]">{instructions}</span>
        ) : (
          'Add instructions (optional)'
        )}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Item row
// ---------------------------------------------------------------------------

interface ItemRowProps {
  item: LibraryItemMeta;
  isRenaming: boolean;
  renameValue: string;
  onStartRename: () => void;
  onChangeRename: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

function ItemRow({
  item,
  isRenaming,
  renameValue,
  onStartRename,
  onChangeRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: ItemRowProps) {
  return (
    <li className="px-2 py-2">
      <div className="flex items-start gap-2">
        <LibraryItemIcon type={item.type} />
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              autoFocus
              type="text"
              maxLength={NAME_MAX}
              value={renameValue}
              onChange={(e) => onChangeRename(e.target.value)}
              onBlur={onCommitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              placeholder="Label (leave blank to clear)"
              className="w-full rounded border border-[#3d5579] bg-[#070a10] px-1.5 py-0.5 text-push-xs text-[#d7deeb] outline-none"
            />
          ) : (
            <p className="truncate text-push-xs text-[#d7deeb]">{item.label || item.filename}</p>
          )}
          <p className="truncate text-push-2xs text-[#7c879b]">
            {item.label ? `${item.filename} · ` : ''}
            {formatFileSize(item.sizeBytes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onStartRename}
            className="rounded p-1 text-[#7c879b] hover:text-[#d7deeb]"
            title="Rename"
            aria-label="Rename"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onDelete}
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
}

function LibraryItemIcon({ type }: { type: LibraryItemMeta['type'] }) {
  if (type === 'image') return <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#8891a1]" />;
  if (type === 'code') return <FileCode className="mt-0.5 h-4 w-4 shrink-0 text-push-accent" />;
  return <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#8891a1]" />;
}

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

/**
 * Produce a filename for the synthetic instructions attachment. Keeps
 * the library name visible to the model (helpful for prompts that
 * reference "the Project ZERO instructions") while sanitizing
 * characters that would be awkward in a filename.
 */
function sanitizeInstructionsFilename(libraryName: string): string {
  const slug = libraryName
    .trim()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return `${slug || 'library'}-instructions.md`;
}
