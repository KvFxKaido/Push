import { X, FileCode, FileText, Loader2, AlertTriangle } from 'lucide-react';
import type { StagedAttachment } from '@/lib/file-processing';
import { formatFileSize, getTotalAttachmentSize } from '@/lib/file-processing';

interface AttachmentPreviewProps {
  attachments: StagedAttachment[];
  onRemove: (id: string) => void;
}

const MAX_PAYLOAD_WARNING = 300 * 1024; // Show warning at 300KB

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  const totalSize = getTotalAttachmentSize(attachments);
  const showWarning = totalSize > MAX_PAYLOAD_WARNING;

  return (
    <div className="px-3 pt-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
        {attachments.map((att) => (
          <AttachmentChip key={att.id} attachment={att} onRemove={onRemove} />
        ))}
      </div>
      {showWarning && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-500 pb-1">
          <AlertTriangle className="h-3 w-3" />
          <span>Large payload ({formatFileSize(totalSize)})</span>
        </div>
      )}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: StagedAttachment;
  onRemove: (id: string) => void;
}) {
  const isProcessing = attachment.status === 'processing';
  const isError = attachment.status === 'error';

  return (
    <div
      className={`relative flex items-center gap-2 rounded-lg border px-2 py-1.5 shrink-0 ${
        isError
          ? 'border-red-500/30 bg-red-500/10'
          : 'border-[#1a1a1a] bg-[#0d0d0d]'
      }`}
    >
      {/* Thumbnail or icon */}
      {attachment.type === 'image' && attachment.thumbnail ? (
        <img
          src={attachment.thumbnail}
          alt={attachment.filename}
          className="h-8 w-8 rounded object-cover"
        />
      ) : attachment.type === 'code' ? (
        <FileCode className="h-5 w-5 text-[#0070f3]" />
      ) : (
        <FileText className="h-5 w-5 text-[#a1a1aa]" />
      )}

      {/* Filename and size */}
      <div className="flex flex-col min-w-0">
        <span className="text-xs text-[#fafafa] truncate max-w-[120px]">
          {attachment.filename}
        </span>
        <span className="text-[10px] text-[#52525b]">
          {isError ? attachment.error : formatFileSize(attachment.sizeBytes)}
        </span>
      </div>

      {/* Processing spinner or remove button */}
      {isProcessing ? (
        <Loader2 className="h-4 w-4 text-[#52525b] animate-spin" />
      ) : (
        <button
          onClick={() => onRemove(attachment.id)}
          className="h-5 w-5 flex items-center justify-center rounded-full hover:bg-[#1a1a1a] text-[#52525b] hover:text-[#a1a1aa] transition-colors"
          aria-label={`Remove ${attachment.filename}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
