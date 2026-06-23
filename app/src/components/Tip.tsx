import * as React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useLongPress } from '@/hooks/useLongPress';

type TipSide = React.ComponentProps<typeof TooltipContent>['side'];

interface TipProps {
  /** The explanation shown on hover/focus/long-press — replaces a native `title`. */
  content: React.ReactNode;
  /** The trigger: a single element (icon button, chip, …) that can take a ref. */
  children: React.ReactElement;
  side?: TipSide;
  sideOffset?: number;
  /** Extra classes for the tooltip surface. */
  className?: string;
}

/**
 * The shared "explain this control" affordance — replaces native `title=`
 * (unstyled, ~700ms-delayed, and invisible on touch) with the retuned Radix
 * tooltip, so the explanation portals out of `overflow:hidden` panels, collides
 * correctly near edges, and follows the app's palette/motion.
 *
 * Reveal model (mobile-first): pointer devices use Radix hover/focus; touch
 * devices use a long-press (`useLongPress`), since hover doesn't exist there.
 * `open` is controlled so both paths drive it — Radix still updates it from
 * hover/focus/escape via `onOpenChange`, and the long-press forces it open.
 *
 * Long-press is a progressive enhancement: on touch the subsequent tap still
 * activates the underlying control. Keep that in mind for destructive triggers.
 */
export function Tip({
  content,
  children,
  side = 'top',
  sideOffset = 6,
  className,
}: TipProps) {
  const [open, setOpen] = React.useState(false);
  const { pointerHandlers } = useLongPress(() => setOpen(true));

  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
      <TooltipTrigger asChild {...pointerHandlers}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
