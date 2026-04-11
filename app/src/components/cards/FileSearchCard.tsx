import { Search, FileText } from 'lucide-react';
import type { FileSearchCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_LIST_CLASS,
  CARD_PANEL_SUBTLE_CLASS,
  CARD_BADGE_WARNING,
} from '@/lib/utils';

export function FileSearchCard({ data }: { data: FileSearchCardData }) {
  // Group matches by file
  const byFile = new Map<string, typeof data.matches>();
  for (const match of data.matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path)!.push(match);
  }

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-push-edge/80 px-3.5 py-3">
        <Search className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-push-base font-medium text-push-fg">
          {data.totalCount} result{data.totalCount !== 1 ? 's' : ''} for "{data.query}"
        </span>
        {data.path && (
          <span className="text-push-sm text-push-fg-dim font-mono">in {data.path}</span>
        )}
        {data.truncated && (
          <span className={`${CARD_BADGE_WARNING} ml-auto px-1.5 py-0.5 text-push-xs`}>
            truncated
          </span>
        )}
      </div>

      {/* Results grouped by file */}
      <div className={`${CARD_LIST_CLASS} max-h-[300px] overflow-y-auto px-3 py-2`}>
        {Array.from(byFile.entries()).map(([filePath, matches]) => (
          <div key={filePath} className={`${CARD_PANEL_SUBTLE_CLASS} px-3 py-2.5`}>
            <div className="mb-1 flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-push-fg-dim" />
              <span className="text-push-sm text-push-link font-mono truncate">{filePath}</span>
              <span className="text-push-xs text-push-fg-dim">({matches.length})</span>
            </div>
            <div className="ml-4 space-y-1">
              {matches.slice(0, 3).map((match, i) => (
                <div key={i} className="flex items-start gap-2 text-push-sm">
                  {match.line > 0 && (
                    <span className="text-push-fg-dim font-mono shrink-0 w-8 text-right">
                      {match.line}
                    </span>
                  )}
                  <span className="text-push-fg-secondary font-mono truncate">{match.content}</span>
                </div>
              ))}
              {matches.length > 3 && (
                <span className="text-push-xs text-push-fg-dim">+{matches.length - 3} more</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
