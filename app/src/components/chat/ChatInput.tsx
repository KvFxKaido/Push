import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowUp, Paperclip } from 'lucide-react';
import { AttachmentPreview } from './AttachmentPreview';
import { ScratchpadButton } from './ScratchpadButton';
import { useIsMobile } from '@/hooks/use-mobile';
import { processFile, getTotalAttachmentSize } from '@/lib/file-processing';
import type { StagedAttachment } from '@/lib/file-processing';
import type { AttachmentData } from '@/types';

interface ChatInputProps {
  onSend: (message: string, attachments?: AttachmentData[]) => void;
  disabled?: boolean;
  repoName?: string;
  onScratchpadToggle?: () => void;
  scratchpadHasContent?: boolean;
}

const ACCEPTED_FILES = 'image/*,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.md,.txt,.json,.yaml,.yml,.html,.css,.sql,.sh,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.astro';
const MAX_PAYLOAD = 400 * 1024; // 400KB total

export function ChatInput({ onSend, disabled, repoName, onScratchpadToggle, scratchpadHasContent }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const hasAttachments = stagedAttachments.length > 0;
  const readyAttachments = stagedAttachments.filter((a) => a.status === 'ready');
  const canSend = (value.trim().length > 0 || readyAttachments.length > 0) && !disabled;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 22;
    const maxLines = 4;
    const maxHeight = lineHeight * maxLines + 20;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  const handleSend = useCallback(() => {
    if (!canSend) return;

    // Convert staged attachments to AttachmentData (strip status/error fields)
    const attachments: AttachmentData[] = readyAttachments.map(
      ({ id, type, filename, mimeType, sizeBytes, content, thumbnail }) => ({
        id,
        type,
        filename,
        mimeType,
        sizeBytes,
        content,
        thumbnail,
      }),
    );

    onSend(value.trim(), attachments.length > 0 ? attachments : undefined);
    setValue('');
    setStagedAttachments([]);

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  }, [canSend, value, readyAttachments, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Only use mobile keyboard behavior (Enter = newline) if BOTH:
      // 1. Narrow viewport (mobile layout) AND
      // 2. Touch capability (actual touch device)
      // This prevents desktop users with narrow windows from losing Enter-to-send
      const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      const isMobileDevice = isMobile && hasTouch;

      if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, isMobile],
  );

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Check total size before processing
    const currentSize = getTotalAttachmentSize(stagedAttachments);
    let addedSize = 0;

    for (const file of Array.from(files)) {
      if (currentSize + addedSize + file.size > MAX_PAYLOAD * 1.5) {
        // Skip files that would exceed limit (with some headroom for base64)
        continue;
      }

      // Add placeholder while processing
      const placeholder: StagedAttachment = {
        id: crypto.randomUUID(),
        type: 'document',
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        content: '',
        status: 'processing',
      };
      setStagedAttachments((prev) => [...prev, placeholder]);

      // Process file
      const processed = await processFile(file);
      setStagedAttachments((prev) =>
        prev.map((a) => (a.id === placeholder.id ? { ...processed, id: placeholder.id } : a)),
      );

      addedSize += processed.content.length;
    }

    // Clear input so same file can be selected again
    e.target.value = '';
  }, [stagedAttachments]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setStagedAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  return (
    <div className="safe-area-bottom sticky bottom-0 z-10">
      <div className="bg-[#000]/80 backdrop-blur-xl border-t border-[#1a1a1a]">
        {/* Attachment preview */}
        {hasAttachments && (
          <AttachmentPreview
            attachments={stagedAttachments}
            onRemove={handleRemoveAttachment}
          />
        )}

        <div className="flex items-end gap-2 px-3 py-2.5 max-w-2xl mx-auto">
          {/* Paperclip button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0d0d0d] text-[#52525b] transition-colors hover:text-[#a1a1aa] active:scale-95 disabled:opacity-40"
            aria-label="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </button>

          {/* Scratchpad button */}
          {onScratchpadToggle && (
            <ScratchpadButton
              onClick={onScratchpadToggle}
              hasContent={scratchpadHasContent ?? false}
              disabled={disabled}
            />
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILES}
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Text input */}
          <div className="relative flex-1 rounded-2xl bg-[#0d0d0d] border border-[#1a1a1a] transition-colors duration-200 focus-within:border-[#27272a]">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={repoName ? `Message about ${repoName}...` : 'Message Push...'}
              disabled={disabled}
              rows={1}
              className="w-full resize-none bg-transparent px-4 py-2.5 text-[15px] text-[#fafafa] placeholder:text-[#52525b] outline-none disabled:opacity-40 leading-[22px]"
              style={{ maxHeight: `${22 * 4 + 20}px` }}
            />
          </div>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!canSend}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-200 ${
              canSend
                ? 'bg-[#0070f3] text-white hover:bg-[#0060d3] active:scale-95'
                : 'bg-[#0d0d0d] text-[#52525b]'
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
