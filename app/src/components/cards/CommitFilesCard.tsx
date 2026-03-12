import { GitCommit, Plus, Minus, FileEdit } from 'lucide-react';
import type { CommitFilesCardData } from '@/types';
import { timeAgo, CARD_SHELL_CLASS, CARD_TEXT_SUCCESS, CARD_TEXT_ERROR, CARD_TEXT_WARNING, CARD_LIST_CLASS } from '@/lib/utils';

export function CommitFilesCard({ data }: { data: CommitFilesCardData }) {
  const statusIcon = (status: string) => {
    switch (status) {
      case 'added': return <Plus className={`h-3 w-3 ${CARD_TEXT_SUCCESS}`} />;
      case 'removed': return <Minus className={`h-3 w-3 ${CARD_TEXT_ERROR}`} />;
      default: return <FileEdit className={`h-3 w-3 ${CARD_TEXT_WARNING}`} />;
    }
  };

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="border-b border-push-edge/80 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <GitCommit className="h-3.5 w-3.5 text-push-fg-secondary" />
          <span className="text-push-sm text-push-link font-mono">{data.sha.slice(0, 7)}</span>
          <span className="text-push-base text-push-fg truncate flex-1">{data.message}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-push-xs text-push-fg-dim">
          <span>{data.author}</span>
          <span>{timeAgo(data.date)}</span>
          <span className="ml-auto">
            <span className="text-push-status-success">+{data.totalChanges.additions}</span>
            {' '}
            <span className="text-push-status-error">-{data.totalChanges.deletions}</span>
          </span>
        </div>
      </div>

      {/* File list */}
      <div className={`${CARD_LIST_CLASS} max-h-[250px] overflow-y-auto`}>
        {data.files.map((file) => (
          <div key={file.filename} className="flex items-center gap-2 px-3.5 py-2">
            {statusIcon(file.status)}
            <span className="text-push-sm text-push-fg font-mono truncate flex-1">
              {file.filename}
            </span>
            <span className="text-push-xs text-push-fg-dim shrink-0">
              <span className="text-push-status-success">+{file.additions}</span>
              {' '}
              <span className="text-push-status-error">-{file.deletions}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Footer with count */}
      <div className="border-t border-push-edge/80 px-3.5 py-2 text-push-xs text-push-fg-dim">
        {data.files.length} file{data.files.length !== 1 ? 's' : ''} changed
      </div>
    </div>
  );
}
