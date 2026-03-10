import { FileDiff } from 'lucide-react';
import type { DiffPreviewCardData } from '@/types';
import { useExpandable } from '@/hooks/useExpandable';
import { CARD_SHELL_CLASS } from '@/lib/utils';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

export function DiffLine({ line, index }: { line: string; index: number }) {
  let className = 'font-mono text-push-sm leading-relaxed px-3 whitespace-pre-wrap break-all';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-push-status-success bg-push-status-success/5';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-push-status-error bg-push-status-error/5';
  } else if (line.startsWith('@@')) {
    className += ' text-push-link bg-push-link/10';
  } else if (line.startsWith('diff --git')) {
    className += ' text-push-fg-secondary font-semibold border-t border-push-edge pt-1 mt-1';
  } else {
    className += ' text-push-fg-dim';
  }

  return (
    <div key={index} className={className}>
      {line}
    </div>
  );
}

export function DiffPreviewCard({ data }: { data: DiffPreviewCardData }) {
  const { expanded, toggleExpanded } = useExpandable(false);
  const lines = data.diff.split('\n');

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={toggleExpanded}
        className="w-full px-3.5 py-3 flex items-center gap-2.5 hover:bg-push-surface-hover transition-colors duration-200"
      >
        <FileDiff className="h-4 w-4 shrink-0 text-push-fg-secondary" />
        <span className="flex-1 text-push-base text-push-fg text-left">
          {data.filesChanged} file{data.filesChanged !== 1 ? 's' : ''} changed
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-push-sm text-push-status-success font-mono">+{data.additions}</span>
          <span className="text-push-sm text-push-status-error font-mono">-{data.deletions}</span>
          <ExpandChevron expanded={expanded} />
        </div>
      </button>

      {/* Diff content */}
      <ExpandableCardPanel
        expanded={expanded}
        className="max-h-[400px] overflow-y-auto"
      >
        <div className="py-1">
          {lines.map((line, i) => (
            <DiffLine key={i} line={line} index={i} />
          ))}
        </div>
        {data.truncated && (
          <div className="px-3 py-1.5 text-push-xs text-push-fg-dim italic border-t border-push-edge">
            Diff truncated
          </div>
        )}
      </ExpandableCardPanel>
    </div>
  );
}
