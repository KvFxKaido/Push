import { FileCode } from 'lucide-react';
import type { FileCardData } from '@/types';
import { useExpandable } from '@/hooks/useExpandable';
import { CARD_SHELL_CLASS } from '@/lib/utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';
import { CardCodeBlock } from './card-code-block';

export function FileCard({ data }: { data: FileCardData }) {
  const { expanded, toggleExpanded } = useExpandable(true);
  const lineCount = data.content.split('\n').length;

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={toggleExpanded}
        className="w-full px-3.5 py-3 flex items-center gap-2 hover:bg-[#151517] transition-colors duration-200"
      >
        <ExpandChevron expanded={expanded} className="shrink-0" />
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
      <ExpandableCardPanel expanded={expanded}>
        <CardCodeBlock
          preClassName="max-h-[400px] overflow-y-auto"
          codeClassName="text-[#e4e4e7] whitespace-pre"
        >
          {data.content}
        </CardCodeBlock>
        {data.truncated && (
          <div className="px-3 py-1.5 border-t border-push-edge text-[11px] text-push-fg-dim italic">
            Content truncated at 5K characters
          </div>
        )}
      </ExpandableCardPanel>
    </div>
  );
}
