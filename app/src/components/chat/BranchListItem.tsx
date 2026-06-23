import { Check, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { useLongPress } from '@/hooks/useLongPress';
import { HUB_TAG_CLASS } from './hub-styles';

interface BranchListItemProps {
  name: string;
  isDefault: boolean;
  isActive: boolean;
  /** Deletable = not the active branch and not the repo default. */
  canDelete: boolean;
  /** This branch's delete is in flight. */
  isDeleting: boolean;
  /** Any branch delete is in flight — blocks starting another. */
  anyDeleting: boolean;
  onSwitch: () => void;
  onDelete: () => void;
}

/**
 * One row in the workspace branch picker. Tapping the row switches branches.
 * Delete is collapsed by default to reclaim the list's vertical space and
 * surfaced on demand: hover (or keyboard focus) on pointer devices, long-press
 * on touch. Once revealed, a single tap deletes — the deliberate reveal is the
 * guard, so there's no second confirm step. A long-press never also switches
 * branches: `consumeClick` swallows the tap that follows the hold.
 */
export function BranchListItem({
  name,
  isDefault,
  isActive,
  canDelete,
  isDeleting,
  anyDeleting,
  onSwitch,
  onDelete,
}: BranchListItemProps) {
  const [revealed, setRevealed] = useState(false);
  const { pointerHandlers, consumeClick } = useLongPress(() => {
    if (canDelete) setRevealed(true);
  });

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => {
          // A long-press just revealed Delete — don't also switch branches.
          if (consumeClick()) return;
          if (!isActive) onSwitch();
        }}
        {...pointerHandlers}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
          isActive ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'text-push-fg' : 'text-push-fg-secondary'}`}
        >
          {name}
        </span>
        {isDefault && <span className={HUB_TAG_CLASS}>default</span>}
        {isActive && <Check className="h-3.5 w-3.5 text-push-link" />}
      </button>
      {canDelete && (
        // Collapsed (zero-height, clipped) until revealed, so it costs no space
        // at rest. Revealed by hover / keyboard focus (pointer) or long-press
        // (touch, via `revealed`).
        <div
          className={`overflow-hidden transition-all duration-200 ${
            revealed
              ? 'max-h-9 opacity-100'
              : 'max-h-0 opacity-0 group-hover:max-h-9 group-hover:opacity-100 group-focus-within:max-h-9 group-focus-within:opacity-100'
          }`}
        >
          <button
            type="button"
            onClick={() => {
              if (!anyDeleting) onDelete();
            }}
            disabled={anyDeleting}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-push-xs text-push-fg-dim transition-colors hover:bg-white/[0.03] hover:text-red-300 disabled:opacity-60"
          >
            {isDeleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  );
}
