/**
 * ScratchpadDrawer — slide-out shared notepad.
 *
 * Desktop: slides from the right (320px wide)
 * Mobile: slides from bottom (60% viewport height)
 *
 * Both user and Kimi can edit. User edits directly,
 * Kimi edits via set_scratchpad / append_scratchpad tools.
 */

import { useEffect, useRef } from 'react';
import { X, Trash2 } from 'lucide-react';

interface ScratchpadDrawerProps {
  isOpen: boolean;
  content: string;
  onContentChange: (content: string) => void;
  onClose: () => void;
  onClear: () => void;
}

export function ScratchpadDrawer({
  isOpen,
  content,
  onContentChange,
  onClose,
  onClear,
}: ScratchpadDrawerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when opened
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      // Small delay to let animation start
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <>
      {/* Backdrop (mobile only) */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 md:hidden ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed z-50 bg-[#000] border-[#1a1a1a] transition-transform duration-300 ease-out flex flex-col
          /* Mobile: bottom sheet */
          inset-x-0 bottom-0 h-[60vh] rounded-t-2xl border-t border-x
          /* Desktop: right drawer */
          md:inset-y-0 md:right-0 md:left-auto md:w-[360px] md:h-full md:rounded-none md:rounded-l-2xl md:border-l md:border-t-0 md:border-b-0
          ${isOpen
            ? 'translate-y-0 md:translate-y-0 md:translate-x-0'
            : 'translate-y-full md:translate-y-0 md:translate-x-full'
          }
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a] shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-base">📝</span>
            <h2 className="text-sm font-semibold text-[#fafafa]">Scratchpad</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onClear}
              disabled={!content.trim()}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#52525b] transition-colors hover:text-[#a1a1aa] hover:bg-[#0d0d0d] active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Clear scratchpad"
              title="Clear"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#52525b] transition-colors hover:text-[#a1a1aa] hover:bg-[#0d0d0d] active:scale-95"
              aria-label="Close scratchpad"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden p-3">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            placeholder="Shared notes between you and Kimi...

• Paste code, errors, requirements
• Ask Kimi to add ideas here
• Reference in conversation

Kimi sees this in every message."
            className="h-full w-full resize-none bg-[#0d0d0d] border border-[#1a1a1a] rounded-xl px-4 py-3 text-sm text-[#fafafa] placeholder:text-[#52525b] outline-none focus:border-[#27272a] font-mono leading-relaxed"
          />
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-[#1a1a1a] shrink-0">
          <p className="text-xs text-[#52525b]">
            Kimi can update this via <code className="text-[#71717a]">set_scratchpad</code> or <code className="text-[#71717a]">append_scratchpad</code>
          </p>
        </div>
      </div>
    </>
  );
}
