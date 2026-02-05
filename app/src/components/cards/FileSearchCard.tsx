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
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1a1a1a]">
        <Search className="h-3.5 w-3.5 text-[#a1a1aa]" />
        <span className="text-[13px] font-medium text-[#fafafa]">
          {data.totalCount} result{data.totalCount !== 1 ? 's' : ''} for "{data.query}"
        </span>
        {data.path && (
          <span className="text-[12px] text-[#52525b] font-mono">in {data.path}</span>
        )}
        {data.truncated && (
          <span className="text-[11px] text-[#f59e0b] ml-auto">truncated</span>
        )}
      </div>

      {/* Results grouped by file */}
      <div className="divide-y divide-[#1a1a1a] max-h-[300px] overflow-y-auto">
        {Array.from(byFile.entries()).map(([filePath, matches]) => (
          <div key={filePath} className="px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1">
              <FileText className="h-3 w-3 text-[#52525b]" />
              <span className="text-[12px] text-[#0070f3] font-mono truncate">{filePath}</span>
              <span className="text-[11px] text-[#52525b]">({matches.length})</span>
            </div>
            <div className="space-y-0.5 ml-4">
              {matches.slice(0, 3).map((match, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px]">
                  {match.line > 0 && (
                    <span className="text-[#52525b] font-mono shrink-0 w-8 text-right">
                      {match.line}
                    </span>
                  )}
                  <span className="text-[#a1a1aa] font-mono truncate">{match.content}</span>
                </div>
              ))}
              {matches.length > 3 && (
                <span className="text-[11px] text-[#52525b]">
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
