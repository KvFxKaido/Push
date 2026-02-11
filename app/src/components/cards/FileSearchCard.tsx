import { Search, FileText } from 'lucide-react';
import type { FileSearchCardData } from '@/types';

export function FileSearchCard({ data }: { data: FileSearchCardData }) {
  // Group matches by file
  const byFile = new Map<string, typeof data.matches>();
  for (const match of data.matches) {
    if (!byFile.has(match.path)) byFile.set(match.path, []);
    byFile.get(match.path)!.push(match);
  }

  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-push-edge">
        <Search className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-[13px] font-medium text-push-fg">
          {data.totalCount} result{data.totalCount !== 1 ? 's' : ''} for "{data.query}"
        </span>
        {data.path && (
          <span className="text-[12px] text-push-fg-dim font-mono">in {data.path}</span>
        )}
        {data.truncated && (
          <span className="text-[11px] text-[#f59e0b] ml-auto">truncated</span>
        )}
      </div>

      {/* Results grouped by file */}
      <div className="divide-y divide-push-edge max-h-[300px] overflow-y-auto">
        {Array.from(byFile.entries()).map(([filePath, matches]) => (
          <div key={filePath} className="px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <FileText className="h-3 w-3 text-push-fg-dim" />
              <span className="text-[12px] text-push-link font-mono truncate">{filePath}</span>
              <span className="text-[11px] text-push-fg-dim">({matches.length})</span>
            </div>
            <div className="space-y-0.5 ml-4">
              {matches.slice(0, 3).map((match, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px]">
                  {match.line > 0 && (
                    <span className="text-push-fg-dim font-mono shrink-0 w-8 text-right">
                      {match.line}
                    </span>
                  )}
                  <span className="text-push-fg-secondary font-mono truncate">{match.content}</span>
                </div>
              ))}
              {matches.length > 3 && (
                <span className="text-[11px] text-push-fg-dim">
                  +{matches.length - 3} more
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
