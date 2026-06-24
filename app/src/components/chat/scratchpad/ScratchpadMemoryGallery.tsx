import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Download, NotebookText, Trash2, X } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import { useOutsideClick } from '@/hooks/use-outside-click';
import { runViewTransition } from '@/lib/view-transition';
import { timeAgoCompact } from '@/lib/utils';
import { DottedGlowBackground } from '@/components/ui/dotted-glow-background';

interface ScratchpadMemoryGalleryProps {
  memories: ScratchpadMemory[];
  activeMemoryId: string | null;
  /** Load a memory into the live notes (id) or restore the unsaved draft (null). */
  onLoad: (id: string | null) => void;
  onDelete: (id: string) => void;
}

// view-transition-name must be a valid CSS custom-ident. Memory ids are UUIDs
// (or `mem-…`); the constant prefix guarantees a leading letter, and we scrub
// any stray characters so the morph name never breaks the transition.
function cardViewTransitionName(id: string): string {
  return `scratch-card-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function previewOf(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

/**
 * A gallery of saved scratchpad memories. Each card morphs (via the View
 * Transitions API, with an instant fallback) into a full reader overlay where
 * the note can be loaded into the live notes or deleted. Replaces the flat
 * `<select>` memory picker with a browsable, previewable surface.
 *
 * The active memory and the "Current notes" draft are mutually exclusive, the
 * same contract `useScratchpad.loadMemory` enforces — loading `null` restores
 * the unsaved draft.
 */
export function ScratchpadMemoryGallery({
  memories,
  activeMemoryId,
  onLoad,
  onDelete,
}: ScratchpadMemoryGalleryProps) {
  const [active, setActive] = useState<ScratchpadMemory | null>(null);

  if (memories.length === 0) return null;

  const openMemory = (memory: ScratchpadMemory) => {
    runViewTransition(() => setActive(memory));
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onLoad(null)}
        aria-pressed={activeMemoryId === null}
        className={`flex items-center justify-between rounded-[14px] border px-3 py-2 text-left transition-colors ${
          activeMemoryId === null
            ? 'border-push-accent/40 bg-push-accent/[0.08] text-push-fg'
            : 'border-push-edge/70 bg-black/10 text-push-fg-secondary hover:border-push-edge-hover hover:text-push-fg'
        }`}
      >
        <span className="flex items-center gap-2">
          <NotebookText className="h-3.5 w-3.5 text-push-fg-dim" />
          <span className="text-push-xs font-medium">Current notes</span>
        </span>
        {activeMemoryId === null && <span className="text-push-2xs text-push-accent">editing</span>}
      </button>

      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {memories.map((memory) => {
          const isActive = memory.id === activeMemoryId;
          // The opened card relinquishes its morph name to the overlay so only
          // one element carries it during the transition.
          const vtName = active?.id === memory.id ? undefined : cardViewTransitionName(memory.id);
          return (
            <li key={memory.id}>
              <button
                type="button"
                onClick={() => openMemory(memory)}
                style={{ viewTransitionName: vtName } as CSSProperties}
                className={`flex h-full w-full flex-col gap-1.5 rounded-[14px] border px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'border-push-accent/40 bg-push-accent/[0.08]'
                    : 'border-push-edge/70 bg-black/10 hover:border-push-edge-hover'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-push-xs font-medium text-push-fg">
                    {memory.name}
                  </span>
                  {isActive && (
                    <span className="shrink-0 text-push-2xs text-push-accent">editing</span>
                  )}
                </span>
                <span className="line-clamp-2 text-push-2xs leading-relaxed text-push-fg-dim">
                  {previewOf(memory.content) || 'Empty note'}
                </span>
                <span className="text-push-2xs text-push-fg-dim/80">
                  {timeAgoCompact(memory.updatedAt)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {active && (
        <MemoryOverlay
          memory={active}
          isActive={active.id === activeMemoryId}
          onClose={() => runViewTransition(() => setActive(null))}
          onLoad={() =>
            runViewTransition(() => {
              onLoad(active.id);
              setActive(null);
            })
          }
          onDelete={() =>
            runViewTransition(() => {
              onDelete(active.id);
              setActive(null);
            })
          }
        />
      )}
    </div>
  );
}

interface MemoryOverlayProps {
  memory: ScratchpadMemory;
  isActive: boolean;
  onClose: () => void;
  onLoad: () => void;
  onDelete: () => void;
}

function MemoryOverlay({ memory, isActive, onClose, onLoad, onDelete }: MemoryOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useOutsideClick(panelRef, onClose);

  // Escape to dismiss + lock background scroll while the reader is open, the
  // same affordances a modal sheet provides.
  useEscapeAndScrollLock(onClose);

  const headerGlowVars = {
    '--push-glow-dot': 'rgb(var(--push-accent-rgb, 125 211 252) / 0.5)',
    '--push-glow-dot-glow': 'rgb(var(--push-accent-rgb, 125 211 252) / 0.95)',
  } as CSSProperties;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Note: ${memory.name}`}
    >
      <div className="scratch-overlay-backdrop absolute inset-0 bg-black/55 backdrop-blur-[2px]" />
      <div
        ref={panelRef}
        style={{ viewTransitionName: cardViewTransitionName(memory.id) } as CSSProperties}
        className="scratch-overlay-panel relative z-10 flex max-h-[88dvh] w-full max-w-[520px] flex-col overflow-hidden rounded-t-[22px] border border-push-edge bg-push-surface-raised shadow-[0_24px_60px_rgba(0,0,0,0.5)] sm:rounded-[22px]"
      >
        <div
          className="relative overflow-hidden border-b border-push-edge px-4 py-3"
          style={headerGlowVars}
        >
          <DottedGlowBackground
            className="opacity-60 mask-radial-to-85% mask-radial-at-left"
            gap={16}
            radius={1.4}
            colorLightVar="--push-glow-dot"
            glowColorLightVar="--push-glow-dot-glow"
            colorDarkVar="--push-glow-dot"
            glowColorDarkVar="--push-glow-dot-glow"
            colorKey={memory.id}
          />
          <div className="relative flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-push-fg">{memory.name}</p>
              <p className="mt-0.5 text-push-2xs text-push-fg-dim">
                Edited {timeAgoCompact(memory.updatedAt)} · {memory.content.length} chars
                {isActive ? ' · editing now' : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close note"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-push-edge bg-black/20 text-push-fg-dim transition-colors hover:text-push-fg"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-push-fg-secondary">
            {memory.content.trim() || 'This note is empty.'}
          </pre>
        </div>

        <div className="flex items-center gap-2 border-t border-push-edge px-4 py-3">
          <button
            type="button"
            onClick={onLoad}
            disabled={isActive}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full border border-push-accent/40 bg-push-accent/[0.1] px-3 py-2 text-push-xs font-medium text-push-fg transition-colors hover:bg-push-accent/[0.16] disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            {isActive ? 'Loaded' : 'Load into notes'}
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete note"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-push-edge bg-black/15 text-push-fg-dim transition-colors hover:border-red-500/40 hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function useEscapeAndScrollLock(onEscape: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onEscape]);
}
