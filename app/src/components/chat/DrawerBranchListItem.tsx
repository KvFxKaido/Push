import { Check, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useLongPress } from '@/hooks/useLongPress';

interface DrawerBranchListItemProps {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
  isActive: boolean;
  /** Deletable = not the active branch, the repo default, or protected. */
  canDelete: boolean;
  /** This branch's delete is in flight. */
  isDeleting: boolean;
  /** Any branch delete is in flight — blocks starting another. */
  anyDeleting: boolean;
  /** This branch's switch is in flight. */
  isSwitching: boolean;
  onSwitch: () => void;
  onDelete: () => void;
}

/**
 * One branch row in the chat-history drawer's "Switch Branch" picker. This is
 * the Radix-dropdown sibling of `BranchListItem` (the workspace branch picker)
 * and matches its Delete affordance deliberately: Delete is collapsed by default
 * (zero-height, clipped) so it costs no space at rest, and is surfaced on demand
 * — hover or keyboard focus on pointer devices, long-press on touch. Once
 * revealed, a single tap deletes; the deliberate reveal is the guard, so there's
 * no separate confirm step. A long-press never also switches branches:
 * `consumeClick` swallows the tap that follows the hold.
 */
export function DrawerBranchListItem({
  name,
  isDefault,
  isProtected,
  isActive,
  canDelete,
  isDeleting,
  anyDeleting,
  isSwitching,
  onSwitch,
  onDelete,
}: DrawerBranchListItemProps) {
  const [revealed, setRevealed] = useState(false);
  const { pointerHandlers, consumeClick } = useLongPress(() => {
    if (canDelete) setRevealed(true);
  });

  return (
    <div className="group">
      <DropdownMenuItem
        onSelect={(e) => {
          // Keep the menu open; switching closes it on success, and a revealed
          // Delete should leave the picker up.
          e.preventDefault();
          // A long-press just revealed Delete — don't also switch branches.
          if (consumeClick()) return;
          if (!isActive) onSwitch();
        }}
        {...pointerHandlers}
        className={`mx-1 flex items-center gap-2 rounded-lg px-3 py-2 ${
          isActive ? 'bg-push-surface-active' : 'hover:bg-push-surface-hover'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'text-push-fg' : 'text-push-fg-secondary'}`}
        >
          {name}
        </span>
        {isDefault && (
          <span className="rounded-full bg-push-surface-active px-1.5 py-0.5 text-push-2xs text-push-link">
            default
          </span>
        )}
        {isProtected && (
          <span className="rounded-full bg-push-surface-active px-1.5 py-0.5 text-push-2xs text-push-status-error-soft">
            protected
          </span>
        )}
        {isActive && <Check className="h-3.5 w-3.5 text-push-link" />}
        {isSwitching && <Loader2 className="h-3.5 w-3.5 animate-spin text-push-link" />}
      </DropdownMenuItem>
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
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              if (!anyDeleting) onDelete();
            }}
            disabled={anyDeleting}
            className="mx-1 mb-1 flex items-center gap-2 rounded-lg px-3 py-1.5 text-push-xs text-push-fg-dim hover:bg-push-surface-hover hover:text-red-300 disabled:opacity-60"
          >
            {isDeleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            {isDeleting ? `Deleting ${name}...` : `Delete ${name}`}
          </DropdownMenuItem>
        </div>
      )}
    </div>
  );
}
