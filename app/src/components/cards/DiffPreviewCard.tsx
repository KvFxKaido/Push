import { useState } from 'react';
import { ChevronRight, FileDiff } from 'lucide-react';
import type { DiffPreviewCardData } from '@/types';

function DiffLine({ line, index }: { line: string; index: number }) {
  let className = 'font-mono text-[12px] leading-relaxed px-3 whitespace-pre-wrap break-all';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-[#22c55e] bg-[#22c55e]/5';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-[#ef4444] bg-[#ef4444]/5';
  } else if (line.startsWith('@@')) {
    className += ' text-[#0070f3] bg-[#0070f3]/5';
  } else if (line.startsWith('diff --git')) {
    className += ' text-[#a1a1aa] font-semibold border-t border-[#1a1a1e] pt-1 mt-1';
  } else {
    className += ' text-[#52525b]';
  }

  return (
    <div key={index} className={className}>
      {line}
    </div>
  );
}

export function DiffPreviewCard({ data }: { data: DiffPreviewCardData }) {
  const [expanded, setExpanded] = useState(false);
  const lines = data.diff.split('\n');

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1e] bg-[#111113] overflow-hidden max-w-full">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2.5 flex items-center gap-2 hover:bg-[#161618] transition-colors"
      >
        <FileDiff className="h-4 w-4 shrink-0 text-[#a1a1aa]" />
        <span className="flex-1 text-[13px] text-[#e4e4e7] text-left">
          {data.filesChanged} file{data.filesChanged !== 1 ? 's' : ''} changed
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[12px] text-[#22c55e] font-mono">+{data.additions}</span>
          <span className="text-[12px] text-[#ef4444] font-mono">-{data.deletions}</span>
          <ChevronRight
            className={`h-3 w-3 text-[#52525b] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {/* Diff content */}
      {expanded && (
        <div className="border-t border-[#1a1a1e] max-h-[400px] overflow-y-auto">
          <div className="py-1">
            {lines.map((line, i) => (
              <DiffLine key={i} line={line} index={i} />
            ))}
          </div>
          {data.truncated && (
            <div className="px-3 py-1.5 text-[11px] text-[#52525b] italic border-t border-[#1a1a1e]">
              Diff truncated
            </div>
          )}
        </div>
      )}
    </div>
  );
}
