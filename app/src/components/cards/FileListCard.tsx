import { Folder, FileText } from 'lucide-react';
import type { FileListCardData } from '@/types';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileListCard({ data }: { data: FileListCardData }) {
  const dirs = data.entries.filter((e) => e.type === 'directory');
  const files = data.entries.filter((e) => e.type === 'file');

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1e] bg-[#111113] overflow-hidden max-w-full">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1a1a1e]">
        <Folder className="h-3.5 w-3.5 text-[#a1a1aa]" />
        <span className="text-[13px] font-medium text-[#fafafa] truncate">
          {data.path}
        </span>
        <span className="text-[12px] text-[#52525b] shrink-0">
          {dirs.length > 0 && `${dirs.length} dir${dirs.length !== 1 ? 's' : ''}`}
          {dirs.length > 0 && files.length > 0 && ', '}
          {files.length > 0 && `${files.length} file${files.length !== 1 ? 's' : ''}`}
        </span>
        {data.repo && (
          <span className="text-[12px] text-[#52525b] font-mono ml-auto shrink-0">{data.repo}</span>
        )}
      </div>

      {/* Entry list */}
      <div className="divide-y divide-[#1a1a1e]">
        {dirs.map((entry) => (
          <div key={entry.name} className="px-3 py-1.5 flex items-center gap-2">
            <Folder className="h-3.5 w-3.5 text-[#0070f3] shrink-0" />
            <span className="text-[13px] text-[#e4e4e7] font-mono truncate">
              {entry.name}/
            </span>
          </div>
        ))}
        {files.map((entry) => (
          <div key={entry.name} className="px-3 py-1.5 flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-[#52525b] shrink-0" />
            <span className="text-[13px] text-[#e4e4e7] font-mono truncate">
              {entry.name}
            </span>
            {entry.size != null && (
              <span className="text-[11px] text-[#3a3a3e] ml-auto shrink-0">
                {formatSize(entry.size)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
