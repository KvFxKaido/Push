import { type CSSProperties } from 'react';
import { NotebookText } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import { timeAgoCompact } from '@/lib/utils';
import { cardViewTransitionName } from './scratchpad-morph';

interface ScratchpadMemoryGalleryProps {
  memories: ScratchpadMemory[];
  activeMemoryId: string | null;
  /**
   * The memory currently open in the full-screen editor, if any. It relinquishes
   * its morph name to the editor panel so only one element carries it during the
   * View Transition.
   */
  openMemoryId: string | null;
  /** Switch the live notes back to the unsaved draft ("Current notes"). */
  onLoad: (id: string | null) => void;
  /** Open a saved memory in the full-screen editor (loads it as the live note). */
  onOpenMemory: (memory: ScratchpadMemory) => void;
}

function previewOf(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}…` : collapsed;
}

/**
 * A gallery of saved scratchpad memories. Each card morphs (via the View
 * Transitions API, with an instant fallback) into the full-screen note editor
 * where it can be edited in place — `onOpenMemory` loads it as the live note and
 * raises the editor. The "Current notes" row switches the live notes back to the
 * unsaved draft. Replaces the flat `<select>` memory picker with a browsable,
 * previewable surface.
 */
export function ScratchpadMemoryGallery({
  memories,
  activeMemoryId,
  openMemoryId,
  onLoad,
  onOpenMemory,
}: ScratchpadMemoryGalleryProps) {
  if (memories.length === 0) return null;

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
          // The card open in the editor relinquishes its morph name to the
          // editor panel so only one element carries it during the transition.
          const vtName = openMemoryId === memory.id ? undefined : cardViewTransitionName(memory.id);
          return (
            <li key={memory.id}>
              <button
                type="button"
                onClick={() => onOpenMemory(memory)}
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
    </div>
  );
}
