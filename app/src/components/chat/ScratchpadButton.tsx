/**
 * ScratchpadButton — toggle button for the scratchpad drawer.
 *
 * Shows a badge dot when scratchpad has content.
 */

import { StickyNote } from 'lucide-react';

interface ScratchpadButtonProps {
  onClick: () => void;
  hasContent: boolean;
  disabled?: boolean;
}

export function ScratchpadButton({ onClick, hasContent, disabled }: ScratchpadButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0d0d0d] text-[#52525b] transition-colors hover:text-[#a1a1aa] active:scale-95 disabled:opacity-40"
      aria-label="Open scratchpad"
      title="Scratchpad"
    >
      <StickyNote className="h-4 w-4" />
      {hasContent && (
        <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[#0070f3]" />
      )}
    </button>
  );
}
