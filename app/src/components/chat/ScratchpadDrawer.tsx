/**
 * ScratchpadDrawer — slide-out shared notepad.
 *
 * Desktop: slides from the right (320px wide)
 * Mobile: slides from bottom (60% viewport height)
 *
 * Both user and Kimi can edit. User edits directly,
 * Kimi edits via set_scratchpad / append_scratchpad tools.
 */

import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, Trash2, X } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';

interface ScratchpadDrawerProps {
  isOpen: boolean;
  content: string;
  memories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onContentChange: (content: string) => void;
  onClose: () => void;
  onClear: () => void;
  onSaveMemory: (name: string) => void;
  onLoadMemory: (id: string | null) => void;
  onDeleteMemory: (id: string) => void;
}

export function ScratchpadDrawer({
  isOpen,
  content,
  memories,
  activeMemoryId,
  onContentChange,
  onClose,
  onClear,
  onSaveMemory,
  onLoadMemory,
  onDeleteMemory,
}: ScratchpadDrawerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [isNamingMemory, setIsNamingMemory] = useState(false);
  const [memoryName, setMemoryName] = useState('');

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

  // Focus name input when entering naming mode
  useEffect(() => {
    if (isNamingMemory && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [isNamingMemory]);

  const handleStartNaming = () => {
    setMemoryName('');
    setIsNamingMemory(true);
  };

  const handleCancelNaming = () => {
    setIsNamingMemory(false);
    setMemoryName('');
  };

  const handleConfirmNaming = () => {
    const trimmed = memoryName.trim();
    if (!trimmed) return;
    onSaveMemory(trimmed);
    setIsNamingMemory(false);
    setMemoryName('');
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirmNaming();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelNaming();
    }
  };

  const handleLoadMemory = (value: string) => {
    onLoadMemory(value || null);
  };

  const activeMemory = memories.find((memory) => memory.id === activeMemoryId) ?? null;

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
              onClick={handleStartNaming}
              disabled={!content.trim() || isNamingMemory}
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[#52525b] transition-colors hover:text-[#a1a1aa] hover:bg-[#0d0d0d] active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Save scratchpad memory"
              title="Save memory"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              Save
            </button>
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

        {/* Inline memory naming input */}
        {isNamingMemory && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1a1a1a] bg-[#0a0a0a]">
            <input
              ref={nameInputRef}
              type="text"
              value={memoryName}
              onChange={(e) => setMemoryName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              placeholder="Name this memory..."
              className="h-8 flex-1 rounded-lg border border-[#27272a] bg-[#0d0d0d] px-3 text-xs text-[#e4e4e7] outline-none focus:border-[#3f3f46] placeholder:text-[#52525b]"
              aria-label="Memory name"
            />
            <button
              onClick={handleConfirmNaming}
              disabled={!memoryName.trim()}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#16a34a] text-white transition-colors hover:bg-[#15803d] active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
              aria-label="Confirm memory name"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              onClick={handleCancelNaming}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[#52525b] transition-colors hover:text-[#a1a1aa] hover:bg-[#0d0d0d] active:scale-95"
              aria-label="Cancel naming"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1a1a1a]">
          <select
            value={activeMemoryId ?? ''}
            onChange={(e) => handleLoadMemory(e.target.value)}
            className="h-8 flex-1 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] px-2 text-xs text-[#e4e4e7] outline-none focus:border-[#27272a]"
            aria-label="Select saved memory"
          >
            <option value="">Scratchpad (unsaved)</option>
            {memories.map((memory) => (
              <option key={memory.id} value={memory.id}>
                {memory.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => activeMemory && onDeleteMemory(activeMemory.id)}
            disabled={!activeMemory}
            className="flex h-8 items-center rounded-lg border border-[#1a1a1a] px-2 text-xs text-[#52525b] transition-colors hover:text-[#f97316] hover:border-[#27272a] hover:bg-[#0d0d0d] active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
            aria-label="Delete memory"
          >
            Delete
          </button>
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
