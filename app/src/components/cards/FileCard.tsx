import { FileCode } from 'lucide-react';
import type { FileCardData } from '@/types';
import { useExpandable } from '@/hooks/useExpandable';
import { CARD_SHELL_CLASS, CARD_BADGE_INFO } from '@/lib/utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';
import { CardCodeBlock } from './card-code-block';

export function FileCard({ data }: { data: FileCardData }) {
  const { expanded, toggleExpanded } = useExpandable(true, { collapseOnMobile: true });
  const lineCount = data.content.split('\n').length;

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={toggleExpanded}
        className="flex w-full items-center gap-2 px-3.5 py-3 transition-colors duration-200 hover:bg-white/[0.02]"
      >
        <ExpandChevron expanded={expanded} className="shrink-0" />
        <FileCode className="h-3.5 w-3.5 text-push-fg-secondary shrink-0" />
        <span className="text-push-base text-push-fg font-mono truncate">{data.path}</span>
        {data.language && (
          <span className={`${CARD_BADGE_INFO} shrink-0 px-1.5 py-0.5 text-push-xs`}>
            {data.language}
          </span>
        )}
        <span className="text-push-xs text-push-fg-dim shrink-0 ml-auto">
          {lineCount} line{lineCount !== 1 ? 's' : ''}
        </span>
      </button>

      {/* Code content */}
      <ExpandableCardPanel expanded={expanded}>
        <CardCodeBlock
          preClassName="max-h-[400px] overflow-y-auto"
          codeClassName="text-push-fg whitespace-pre"
        >
          {data.content}
        </CardCodeBlock>
        {data.truncated && (
          <div className="px-3 py-1.5 border-t border-push-edge text-push-xs text-push-fg-dim italic">
            Content truncated at 5K characters
          </div>
        )}
      </ExpandableCardPanel>
    </div>
  );
}
