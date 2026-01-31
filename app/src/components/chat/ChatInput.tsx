import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !disabled;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 22;
    const maxLines = 4;
    const maxHeight = lineHeight * maxLines + 20; // + padding
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend(value.trim());
    setValue('');
    // Reset height after clearing
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  }, [canSend, value, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="safe-area-bottom sticky bottom-0 z-10">
      <div className="bg-[#09090b]/80 backdrop-blur-xl border-t border-[#1a1a1e]">
        <div className="flex items-end gap-2 px-3 py-2.5 max-w-2xl mx-auto">
          <div className="relative flex-1 rounded-2xl bg-[#111113] border border-[#1a1a1e] transition-colors duration-200 focus-within:border-[#27272a]">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Diff..."
              disabled={disabled}
              rows={1}
              className="w-full resize-none bg-transparent px-4 py-2.5 text-[15px] text-[#fafafa] placeholder:text-[#52525b] outline-none disabled:opacity-40 leading-[22px]"
              style={{ maxHeight: `${22 * 4 + 20}px` }}
            />
          </div>
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-200 ${
              canSend
                ? 'bg-[#0070f3] text-white hover:bg-[#0060d3] active:scale-95'
                : 'bg-[#111113] text-[#52525b]'
            }`}
            aria-label="Send message"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
