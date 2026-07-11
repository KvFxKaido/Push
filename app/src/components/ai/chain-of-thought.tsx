'use client';

import { BrainIcon, ChevronDownIcon, DotIcon, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useControllableState } from './use-controllable-state';

interface ChainOfThoughtContextValue {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);
  if (!context) {
    throw new Error('ChainOfThought components must be used within ChainOfThought');
  }
  return context;
};

export type ChainOfThoughtProps = ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const ChainOfThought = memo(
  ({
    className,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ChainOfThoughtProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    const chainOfThoughtContext = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen]);

    // A single Collapsible root wraps both the trigger (Header) and the content
    // (Content) so Radix wires `aria-controls` ↔ the content id correctly. The
    // context still shares `isOpen` for presentational bits (the chevron); it is
    // NOT a second source of open state.
    return (
      <ChainOfThoughtContext.Provider value={chainOfThoughtContext}>
        <Collapsible
          open={isOpen}
          onOpenChange={setIsOpen}
          className={cn('not-prose max-w-prose space-y-4', className)}
          {...props}
        >
          {children}
        </Collapsible>
      </ChainOfThoughtContext.Provider>
    );
  },
);

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  /** Leading icon for the trigger. Defaults to a brain; consumers with a more
   *  fitting glyph (e.g. a tool group's representative icon) can override it. */
  icon?: LucideIcon;
};

export const ChainOfThoughtHeader = memo(
  ({ className, children, icon: Icon = BrainIcon, ...props }: ChainOfThoughtHeaderProps) => {
    // The Collapsible root lives in ChainOfThought; the trigger finds it via
    // Radix context, so a single root wires trigger ↔ content for a11y. `isOpen`
    // here is presentational only — it rotates the chevron.
    const { isOpen } = useChainOfThought();

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
          className,
        )}
        {...props}
      >
        <Icon className="size-4 shrink-0" />
        {/* `min-w-0 truncate` lets a long header ellipsize instead of
            overflowing its row (a lone label short-circuits harmlessly). */}
        <span className="min-w-0 flex-1 truncate text-left">{children ?? 'Chain of Thought'}</span>
        <ChevronDownIcon
          className={cn('size-4 shrink-0 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')}
        />
      </CollapsibleTrigger>
    );
  },
);

export type ChainOfThoughtStepProps = ComponentProps<'div'> & {
  icon?: LucideIcon;
  label: ReactNode;
  description?: ReactNode;
  status?: 'complete' | 'active' | 'pending';
  /** Draw the vertical connector below the step's icon. Defaults to `true`;
   *  set `false` on the final step so the timeline rail doesn't dangle past
   *  the last node. */
  hasConnector?: boolean;
  /** Classes for the connector rail. Defaults to the shadcn `bg-border` token;
   *  override (e.g. `bg-push-edge`) to fit a host design system. */
  connectorClassName?: string;
};

export const ChainOfThoughtStep = memo(
  ({
    className,
    icon: Icon = DotIcon,
    label,
    description,
    status = 'complete',
    hasConnector = true,
    connectorClassName,
    children,
    ...props
  }: ChainOfThoughtStepProps) => {
    const statusStyles = {
      complete: 'text-muted-foreground',
      active: 'text-foreground',
      pending: 'text-muted-foreground/50',
    };

    return (
      <div
        className={cn(
          'flex gap-2 text-sm',
          statusStyles[status],
          'fade-in-0 slide-in-from-top-2 animate-in',
          className,
        )}
        {...props}
      >
        <div className="relative mt-0.5">
          <Icon className="size-4" />
          {/* Rail starts just below the (size-4) icon and overshoots the step's
              bottom edge so it bridges the inter-step gap to the next node —
              anchored to the icon, not a fixed row height, so it survives both
              tall steps and dense single-line rows. */}
          {hasConnector && (
            <div
              className={cn(
                'absolute top-5 -bottom-3 left-1/2 w-px -translate-x-1/2 bg-border',
                connectorClassName,
              )}
            />
          )}
        </div>
        <div className="flex-1 space-y-2 overflow-hidden">
          <div>{label}</div>
          {description && <div className="text-muted-foreground text-xs">{description}</div>}
          {children}
        </div>
      </div>
    );
  },
);

export type ChainOfThoughtSearchResultsProps = ComponentProps<'div'>;

export const ChainOfThoughtSearchResults = memo(
  ({ className, ...props }: ChainOfThoughtSearchResultsProps) => (
    <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
  ),
);

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>;

export const ChainOfThoughtSearchResult = memo(
  ({ className, children, ...props }: ChainOfThoughtSearchResultProps) => (
    <Badge
      className={cn('gap-1 px-2 py-0.5 font-normal text-xs', className)}
      variant="secondary"
      {...props}
    >
      {children}
    </Badge>
  ),
);

export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>;

export const ChainOfThoughtContent = memo(
  ({ className, children, ...props }: ChainOfThoughtContentProps) => {
    // Content for the single Collapsible root in ChainOfThought — Radix links it
    // to the trigger via context, no second root needed.
    return (
      <CollapsibleContent
        className={cn(
          'mt-2 space-y-3',
          'data-closed:fade-out-0 data-closed:slide-out-to-top-2 data-open:slide-in-from-top-2 text-popover-foreground outline-none data-closed:animate-out data-open:animate-in',
          className,
        )}
        {...props}
      >
        {children}
      </CollapsibleContent>
    );
  },
);

export type ChainOfThoughtImageProps = ComponentProps<'div'> & {
  caption?: string;
};

export const ChainOfThoughtImage = memo(
  ({ className, children, caption, ...props }: ChainOfThoughtImageProps) => (
    <div className={cn('mt-2 space-y-2', className)} {...props}>
      <div className="relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-lg bg-muted p-3">
        {children}
      </div>
      {caption && <p className="text-muted-foreground text-xs">{caption}</p>}
    </div>
  ),
);

ChainOfThought.displayName = 'ChainOfThought';
ChainOfThoughtHeader.displayName = 'ChainOfThoughtHeader';
ChainOfThoughtStep.displayName = 'ChainOfThoughtStep';
ChainOfThoughtSearchResults.displayName = 'ChainOfThoughtSearchResults';
ChainOfThoughtSearchResult.displayName = 'ChainOfThoughtSearchResult';
ChainOfThoughtContent.displayName = 'ChainOfThoughtContent';
ChainOfThoughtImage.displayName = 'ChainOfThoughtImage';
