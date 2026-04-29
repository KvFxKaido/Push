import { useState } from 'react';
import { Folder, FileText } from 'lucide-react';
import type { FileListCardData } from '@/types';
import { CARD_SHELL_CLASS, CARD_LIST_CLASS } from '@/lib/utils';
import { formatSize } from '@/lib/diff-utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

export function FileListCard({ data }: { data: FileListCardData }) {
  const [expanded, setExpanded] = useState(data.entries.length <= 5);
  const dirs = data.entries.filter((e) => e.type === 'directory');
  const files = data.entries.filter((e) => e.type === 'file');

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3.5 py-3 hover:bg-push-bg-secondary/50 transition-colors text-left"
      >
        <ExpandChevron expanded={expanded} />
        <Folder className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg truncate">{data.path}</span>
        <span className="text-push-sm text-push-fg-dim shrink-0 ml-1">
          ({dirs.length > 0 && `${dirs.length}d`}
          {dirs.length > 0 && files.length > 0 && ', '}
          {files.length > 0 && `${files.length}f`})
        </span>
        {data.repo && (
          <span className="text-push-sm text-push-fg-dim font-mono ml-auto shrink-0">
            {data.repo}
          </span>
        )}
      </button>

      <ExpandableCardPanel expanded={expanded}>
        <div className={CARD_LIST_CLASS}>
          {dirs.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-2 px-3.5 py-2 hover:bg-push-bg-secondary/30 transition-colors cursor-default"
            >
              <Folder className="h-3.5 w-3.5 text-push-link shrink-0" />
              <span className="text-push-base text-push-fg font-mono truncate">{entry.name}/</span>
            </div>
          ))}
          {files.map((entry) => (
            <div
              key={entry.name}
              className="flex items-center gap-2 px-3.5 py-2 hover:bg-push-bg-secondary/30 transition-colors cursor-default"
            >
              <FileText className="h-3.5 w-3.5 text-push-fg-dim shrink-0" />
              <span className="text-push-base text-push-fg font-mono truncate">{entry.name}</span>
              {entry.size != null && (
                <span className="text-push-xs text-push-fg-dim ml-auto shrink-0">
                  {formatSize(entry.size)}
                </span>
              )}
            </div>
          ))}
        </div>
      </ExpandableCardPanel>
    </div>
  );
}
