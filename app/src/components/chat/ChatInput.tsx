import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { AttachmentPreview } from './AttachmentPreview';
import { ScratchpadButton } from './ScratchpadButton';
import { ContextMeter } from './ContextMeter';
import { useIsMobile } from '@/hooks/use-mobile';
import { processFile, getTotalAttachmentSize } from '@/lib/file-processing';
import type { StagedAttachment } from '@/lib/file-processing';
import type { AttachmentData } from '@/types';

interface ChatInputProps {
  onSend: (message: string, attachments?: AttachmentData[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  repoName?: string;
  onScratchpadToggle?: () => void;
  scratchpadHasContent?: boolean;
  contextUsage?: { used: number; max: number; percent: number };
}

const ACCEPTED_FILES = 'image/*,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.md,.txt,.json,.yaml,.yml,.html,.css,.sql,.sh,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.astro';
const MAX_PAYLOAD = 400 * 1024; // 400KB total

export function ChatInput({ onSend, onStop, isStreaming, repoName, onScratchpadToggle, scratchpadHasContent, contextUsage }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const hasAttachments = stagedAttachments.length > 0;
  const readyAttachments = stagedAttachments.filter((a) => a.status === 'ready');
  const canSend = (value.trim().length > 0 || readyAttachments.length > 0) && !isStreaming;

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
        if (isStreaming) {
          onStop?.();
        } else {
          handleSend();
        }
      }
    },
    [handleSend, onStop, isStreaming, isMobile],
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

  const handleButtonClick = () => {
    if (isStreaming) {
      onStop?.();
    } else {
      handleSend();
    }
  };

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

        <div className="px-4 py-3">
          <div className="relative flex items-end gap-2">
            {/* Scratchpad button */}
            <ScratchpadButton
              onClick={onScratchpadToggle ?? (() => {})}
              hasContent={scratchpadHasContent ?? false}
              disabled={isStreaming}
            />

            {/* File attachment button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors duration-200 active:scale-95 ${
                isStreaming
                  ? 'text-[#52525b] cursor-not-allowed'
                  : 'text-[#71717a] hover:text-[#a1a1aa] hover:bg-[#111]'
              }`}
              aria-label="Attach file"
              title="Attach file"
            >
              <Paperclip className="h-5 w-5" />
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILES}
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Text input */}
            <div className="relative flex-1">
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={repoName ? `Message #${repoName}` : 'Ask about code...'}
                disabled={isStreaming}
                rows={1}
                className="w-full resize-none rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] px-3 py-2.5 pr-10 text-sm text-[#fafafa] placeholder:text-[#52525b] focus:border-[#3f3f46] focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>

            {/* Send/Stop button */}
            <button
              type="button"
              onClick={handleButtonClick}
              disabled={!isStreaming && !canSend}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all duration-200 active:scale-95 ${
                isStreaming
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/50'
                  : canSend
                  ? 'bg-[#0070f3] text-white hover:bg-[#0060d3] shadow-lg shadow-blue-500/20'
                  : 'bg-[#1a1a1a] text-[#52525b] cursor-not-allowed'
              }`}
              aria-label={isStreaming ? 'Stop generating' : 'Send message'}
              title={isStreaming ? 'Stop generating' : 'Send message'}
            >
              {isStreaming ? (
                <Square className="h-4 w-4 fill-current" />
              ) : (
                <ArrowUp className="h-5 w-5" />
              )}
            </button>
          </div>

          {/* Status row */}
          {isStreaming ? (
            <div className="mt-2 flex items-center justify-between px-1">
              <span className="text-xs text-[#52525b]">
                Generating... Click stop to cancel
              </span>
              {contextUsage && <ContextMeter {...contextUsage} />}
            </div>
          ) : readyAttachments.length > 0 ? (
            <div className="mt-2 flex items-center justify-between px-1">
              <span className="text-xs text-[#52525b]">
                {readyAttachments.length} attachment{readyAttachments.length > 1 ? 's' : ''} ready
              </span>
              {contextUsage && <ContextMeter {...contextUsage} />}
            </div>
          ) : contextUsage && contextUsage.percent >= 5 ? (
            <div className="mt-2 flex items-center justify-end px-1">
              <ContextMeter {...contextUsage} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
