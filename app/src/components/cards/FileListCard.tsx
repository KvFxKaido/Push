import { Folder, FileText } from 'lucide-react';
import type { FileListCardData } from '@/types';
import { CARD_SHELL_CLASS, CARD_LIST_CLASS } from '@/lib/utils';
import { formatSize } from '@/lib/diff-utils';

export function FileListCard({ data }: { data: FileListCardData }) {
  const dirs = data.entries.filter((e) => e.type === 'directory');
  const files = data.entries.filter((e) => e.type === 'file');

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-push-edge">
        <Folder className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg truncate">
          {data.path}
        </span>
        <span className="text-push-sm text-push-fg-dim shrink-0">
          {dirs.length > 0 && `${dirs.length} dir${dirs.length !== 1 ? 's' : ''}`}
          {dirs.length > 0 && files.length > 0 && ', '}
          {files.length > 0 && `${files.length} file${files.length !== 1 ? 's' : ''}`}
        </span>
        {data.repo && (
          <span className="text-push-sm text-push-fg-dim font-mono ml-auto shrink-0">{data.repo}</span>
        )}
      </div>

      {/* Entry list */}
      <div className={CARD_LIST_CLASS}>
        {dirs.map((entry) => (
          <div key={entry.name} className="px-3 py-1.5 flex items-center gap-2">
            <Folder className="h-3.5 w-3.5 text-push-link shrink-0" />
            <span className="text-push-base text-push-fg font-mono truncate">
              {entry.name}/
            </span>
          </div>
        ))}
        {files.map((entry) => (
          <div key={entry.name} className="px-3 py-1.5 flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-push-fg-dim shrink-0" />
            <span className="text-push-base text-push-fg font-mono truncate">
              {entry.name}
            </span>
            {entry.size != null && (
              <span className="text-push-xs text-push-fg-dim ml-auto shrink-0">
                {formatSize(entry.size)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
