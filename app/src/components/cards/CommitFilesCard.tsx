import { GitCommit, Plus, Minus, FileEdit } from 'lucide-react';
import type { CommitFilesCardData } from '@/types';

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function CommitFilesCard({ data }: { data: CommitFilesCardData }) {
  const statusIcon = (status: string) => {
    switch (status) {
      case 'added': return <Plus className="h-3 w-3 text-[#22c55e]" />;
      case 'removed': return <Minus className="h-3 w-3 text-[#ef4444]" />;
      default: return <FileEdit className="h-3 w-3 text-[#f59e0b]" />;
    }
  };

  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
      {/* Header */}
      <div className="px-3 py-2 border-b border-push-edge">
        <div className="flex items-center gap-2">
          <GitCommit className="h-3.5 w-3.5 text-push-fg-secondary" />
          <span className="text-[12px] text-push-link font-mono">{data.sha.slice(0, 7)}</span>
          <span className="text-[13px] text-[#e4e4e7] truncate flex-1">{data.message}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-push-fg-dim">
          <span>{data.author}</span>
          <span>{timeAgo(data.date)}</span>
          <span className="ml-auto">
            <span className="text-[#22c55e]">+{data.totalChanges.additions}</span>
            {' '}
            <span className="text-[#ef4444]">-{data.totalChanges.deletions}</span>
          </span>
        </div>
      </div>

      {/* File list */}
      <div className="divide-y divide-push-edge max-h-[250px] overflow-y-auto">
        {data.files.map((file) => (
          <div key={file.filename} className="px-3 py-1.5 flex items-center gap-2">
            {statusIcon(file.status)}
            <span className="text-[12px] text-[#e4e4e7] font-mono truncate flex-1">
              {file.filename}
            </span>
            <span className="text-[11px] text-push-fg-dim shrink-0">
              <span className="text-[#22c55e]">+{file.additions}</span>
              {' '}
              <span className="text-[#ef4444]">-{file.deletions}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Footer with count */}
      <div className="px-3 py-1.5 border-t border-push-edge text-[11px] text-push-fg-dim">
        {data.files.length} file{data.files.length !== 1 ? 's' : ''} changed
      </div>
    </div>
  );
}
