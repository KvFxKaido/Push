import { type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ExpandChevronProps {
  expanded: boolean;
  className?: string;
}

export function ExpandChevron({ expanded, className }: ExpandChevronProps) {
  return (
    <ChevronRight
      className={cn(
        'h-3 w-3 text-push-fg-dim transition-transform duration-200',
        expanded && 'rotate-90',
        className,
      )}
    />
  );
}

interface ExpandableCardPanelProps {
  expanded: boolean;
  children: ReactNode;
  className?: string;
  bordered?: boolean;
}

export function ExpandableCardPanel({
  expanded,
  children,
  className,
  bordered = true,
}: ExpandableCardPanelProps) {
  if (!expanded) return null;

  return (
    <div className={cn('expand-in', bordered && 'border-t border-push-edge', className)}>
      {children}
    </div>
  );
}
