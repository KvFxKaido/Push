import { useState } from 'react';
import { FileCode, ChevronRight } from 'lucide-react';
import type { FileCardData } from '@/types';

export function FileCard({ data }: { data: FileCardData }) {
  const [expanded, setExpanded] = useState(true);
  const lineCount = data.content.split('\n').length;

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-[#151517] transition-colors"
      >
        <ChevronRight
          className={`h-3 w-3 text-[#52525b] shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <FileCode className="h-3.5 w-3.5 text-[#a1a1aa] shrink-0" />
        <span className="text-[13px] text-[#fafafa] font-mono truncate">
          {data.path}
        </span>
        {data.language && (
          <span className="text-[11px] text-[#52525b] bg-[#1a1a1a] px-1.5 py-0.5 rounded shrink-0">
            {data.language}
          </span>
        )}
        <span className="text-[11px] text-[#3a3a3e] shrink-0 ml-auto">
          {lineCount} line{lineCount !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Code content */}
      {expanded && (
        <div className="border-t border-[#1a1a1a]">
          <pre className="px-3 py-2 overflow-x-auto max-h-[400px] overflow-y-auto">
            <code className="font-mono text-[12px] text-[#e4e4e7] leading-relaxed whitespace-pre">
              {data.content}
            </code>
          </pre>
          {data.truncated && (
            <div className="px-3 py-1.5 border-t border-[#1a1a1a] text-[11px] text-[#52525b] italic">
              Content truncated at 5K characters
            </div>
          )}
        </div>
      )}
    </div>
  );
}
