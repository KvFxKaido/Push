import { useState } from 'react';
import { FileCode, ChevronRight } from 'lucide-react';
import type { FileCardData } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

export function FileCard({ data }: { data: FileCardData }) {
  const [expanded, setExpanded] = useState(true);
  const lineCount = data.content.split('\n').length;

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3.5 py-3 flex items-center gap-2 hover:bg-[#151517] transition-colors duration-200"
      >
        <ChevronRight
          className={`h-3 w-3 text-push-fg-dim shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <FileCode className="h-3.5 w-3.5 text-push-fg-secondary shrink-0" />
        <span className="text-[13px] text-push-fg font-mono truncate">
          {data.path}
        </span>
        {data.language && (
          <span className="text-[11px] text-push-fg-dim bg-[#111624] px-1.5 py-0.5 rounded shrink-0">
            {data.language}
          </span>
        )}
        <span className="text-[11px] text-[#5f6b80] shrink-0 ml-auto">
          {lineCount} line{lineCount !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Code content */}
      {expanded && (
        <div className="border-t border-push-edge expand-in">
          <pre className="px-3 py-2 overflow-x-auto max-h-[400px] overflow-y-auto">
            <code className="font-mono text-[12px] text-[#e4e4e7] leading-relaxed whitespace-pre">
              {data.content}
            </code>
          </pre>
          {data.truncated && (
            <div className="px-3 py-1.5 border-t border-push-edge text-[11px] text-push-fg-dim italic">
              Content truncated at 5K characters
            </div>
          )}
        </div>
      )}
    </div>
  );
}
