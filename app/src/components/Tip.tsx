import * as React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/** Hold duration (ms) before a touch long-press reveals the tip. */
const LONG_PRESS_MS = 400;

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
 * devices use a long-press, since hover doesn't exist there. `open` is
 * controlled so both paths can drive it — Radix still updates it from
 * hover/focus/escape via `onOpenChange`, and the long-press additionally forces
 * it open. A move/lift/cancel before the hold completes aborts (so a scroll that
 * starts on the trigger never pops the tip).
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
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLongPress = React.useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      // Mouse/pen reveal on hover; only touch needs the press-and-hold path.
      if (e.pointerType !== 'touch') return;
      clearLongPress();
      timer.current = setTimeout(() => setOpen(true), LONG_PRESS_MS);
    },
    [clearLongPress],
  );

  // Clear any in-flight hold if the component unmounts mid-press.
  React.useEffect(() => clearLongPress, [clearLongPress]);

  return (
    <Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
      <TooltipTrigger
        asChild
        onPointerDown={onPointerDown}
        onPointerUp={clearLongPress}
        onPointerMove={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
