import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  HUB_PANEL_SURFACE_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
} from '@/components/chat/hub-styles';

interface SectionCardProps {
  /**
   * Visual weight. `panel` (default) is the top-level form panel — same
   * surface as OnboardingScreen's main card. `subtle` is the lighter
   * nested panel used inside a `panel`.
   */
  variant?: 'panel' | 'subtle';
  /** Optional eyebrow / heading row at the top of the card. */
  title?: ReactNode;
  /** Optional description below the title. */
  description?: ReactNode;
  /**
   * Body padding override. Defaults to `p-4`; pass e.g. `'px-4 py-3'`
   * for tighter rows or `'p-6'` for spacious panels.
   */
  padding?: string;
  /** Optional className applied to the outer card. */
  className?: string;
  children: ReactNode;
}

/**
 * Standard content card on a Push glass panel surface. Wraps
 * `HUB_PANEL_SURFACE_CLASS` (or `_SUBTLE_`) with consistent padding and
 * an optional title/description header.
 */
export function SectionCard({
  variant = 'panel',
  title,
  description,
  padding = 'p-4',
  className,
  children,
}: SectionCardProps) {
  const surface = variant === 'subtle' ? HUB_PANEL_SUBTLE_SURFACE_CLASS : HUB_PANEL_SURFACE_CLASS;
  return (
    <div className={cn(surface, padding, className)}>
      {title || description ? (
        <div className="mb-3 space-y-1">
          {title ? <div className="text-sm font-medium text-push-fg">{title}</div> : null}
          {description ? (
            <p className="text-push-xs text-push-fg-muted leading-relaxed">{description}</p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-3">{children}</div>
    </div>
  );
}
