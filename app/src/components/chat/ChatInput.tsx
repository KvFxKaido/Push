import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { AttachmentPreview } from './AttachmentPreview';
import { WorkspacePanelButton } from './WorkspacePanelButton';
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
  onWorkspacePanelToggle?: () => void;
  scratchpadHasContent?: boolean;
  agentActive?: boolean;
  contextUsage?: { used: number; max: number; percent: number };
}

const ACCEPTED_FILES = 'image/*,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.md,.txt,.json,.yaml,.yml,.html,.css,.sql,.sh,.rb,.php,.swift,.kt,.scala,.vue,.svelte,.astro';
const MAX_PAYLOAD = 400 * 1024; // 400KB total

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  repoName,
  onWorkspacePanelToggle,
  scratchpadHasContent,
  agentActive,
  contextUsage,
}: ChatInputProps) {
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

  const statusText = isStreaming
    ? 'Generating...'
    : readyAttachments.length > 0
      ? `${readyAttachments.length} attachment${readyAttachments.length > 1 ? 's' : ''} ready`
      : null;

  return (
    <div className="safe-area-bottom sticky bottom-0 z-10 px-3 pb-3">
      <div className="relative overflow-hidden rounded-[24px] border border-[#171c25] bg-[linear-gradient(180deg,#0a0d13_0%,#04060a_100%)] shadow-[0_20px_52px_rgba(0,0,0,0.68)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-white/[0.03] to-transparent" />

        {/* Attachment preview */}
        {hasAttachments && (
          <div className="px-3 pt-3">
            <AttachmentPreview
              attachments={stagedAttachments}
              onRemove={handleRemoveAttachment}
            />
          </div>
        )}

        {/* Text input */}
        <div className="px-3 pt-3">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={repoName ? `Ask about ${repoName}...` : 'Ask about code...'}
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none overflow-hidden bg-transparent px-1 pb-2 text-[15px] leading-6 text-push-fg placeholder:text-[#6f7787] focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>

        <div className="flex items-center gap-2 px-2 pb-2.5 pt-1.5">
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Workspace panel toggle */}
            <WorkspacePanelButton
              onClick={onWorkspacePanelToggle ?? (() => {})}
              scratchpadHasContent={scratchpadHasContent ?? false}
              agentActive={agentActive ?? false}
            />

            {/* File attachment button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              className={`flex h-9 w-9 items-center justify-center rounded-xl border transition-all duration-200 active:scale-95 ${
                isStreaming
                  ? 'cursor-not-allowed border-[#1f2430] text-[#545c6e]'
                  : 'border-push-edge bg-[#080b10]/95 text-[#8891a1] hover:border-push-edge-hover hover:bg-[#0d1119] hover:text-[#e2e8f0]'
              }`}
              aria-label="Attach file"
              title="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILES}
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          <div className="min-w-0 flex-1 px-1">
            {statusText ? (
              <p className="truncate text-xs text-[#788396]">
                {statusText}
              </p>
            ) : contextUsage && contextUsage.percent >= 5 ? (
              <ContextMeter {...contextUsage} />
            ) : null}
          </div>

          {/* Send/Stop button */}
          <button
            type="button"
            onClick={handleButtonClick}
            disabled={!isStreaming && !canSend}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-all duration-200 active:scale-95 ${
              isStreaming
                ? 'border-red-400/50 bg-red-500/20 text-red-300 hover:bg-red-500/30'
                : canSend
                  ? 'border-push-sky/60 bg-push-sky/15 text-[#7dd3fc] shadow-[0_0_20px_rgba(56,189,248,0.25)] hover:bg-push-sky/25 hover:text-[#bae6fd]'
                  : 'cursor-not-allowed border-[#262c38] bg-[#151a22] text-[#576176]'
            }`}
            aria-label={isStreaming ? 'Stop generating' : 'Send message'}
            title={isStreaming ? 'Stop generating' : 'Send message'}
          >
            {isStreaming ? (
              <Square className="h-4 w-4 fill-current" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
