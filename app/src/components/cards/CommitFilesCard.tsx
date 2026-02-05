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
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2">
          <GitCommit className="h-3.5 w-3.5 text-[#a1a1aa]" />
          <span className="text-[12px] text-[#0070f3] font-mono">{data.sha.slice(0, 7)}</span>
          <span className="text-[13px] text-[#e4e4e7] truncate flex-1">{data.message}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-[#52525b]">
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
      <div className="divide-y divide-[#1a1a1a] max-h-[250px] overflow-y-auto">
        {data.files.map((file) => (
          <div key={file.filename} className="px-3 py-1.5 flex items-center gap-2">
            {statusIcon(file.status)}
            <span className="text-[12px] text-[#e4e4e7] font-mono truncate flex-1">
              {file.filename}
            </span>
            <span className="text-[11px] text-[#52525b] shrink-0">
              <span className="text-[#22c55e]">+{file.additions}</span>
              {' '}
              <span className="text-[#ef4444]">-{file.deletions}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Footer with count */}
      <div className="px-3 py-1.5 border-t border-[#1a1a1a] text-[11px] text-[#52525b]">
        {data.files.length} file{data.files.length !== 1 ? 's' : ''} changed
      </div>
    </div>
  );
}
