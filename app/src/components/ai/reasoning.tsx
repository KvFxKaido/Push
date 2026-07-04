'use client';

import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useControllableState } from './use-controllable-state';

/**
 * Collapsible reasoning trace — the layout of the AI-Elements `Reasoning`
 * component, pared to what fits Push: a controlled disclosure (label + chevron)
 * over markdown-rendered thinking. Deliberately no leading brain icon and no
 * shimmer/auto-open/auto-close — the message avatar already animates while
 * streaming (the `hex-thinking` mark), so a second "is thinking" signal here
 * would be redundant.
 *
 * A single Collapsible root wraps the trigger and content so Radix wires
 * `aria-controls` ↔ the content id (see ChainOfThought for the same pattern).
 * Open state is controlled by the caller (Push holds it in `useMessageViewState`
 * above the virtualization boundary, so it survives streaming→settled and
 * scroll remounts — local state would reset on each).
 */

interface ReasoningContextValue {
  isOpen: boolean;
  isStreaming: boolean;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });

    const reasoningContext = useMemo(() => ({ isOpen, isStreaming }), [isOpen, isStreaming]);

    return (
      <ReasoningContext.Provider value={reasoningContext}>
        <Collapsible
          className={cn('not-prose', className)}
          onOpenChange={setIsOpen}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

/** Static label — no shimmer. The avatar carries the streaming animation. */
function defaultLabel(isStreaming: boolean): ReactNode {
  return isStreaming ? 'Reasoning' : 'Thought process';
}

export const ReasoningTrigger = memo(({ className, children, ...props }: ReasoningTriggerProps) => {
  const { isOpen, isStreaming } = useReasoning();

  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center gap-1.5 text-push-xs text-push-fg-dim transition-colors duration-150 hover:text-push-fg-muted',
        className,
      )}
      {...props}
    >
      <span className="flex-1 text-left font-medium">{children ?? defaultLabel(isStreaming)}</span>
      <ChevronDownIcon
        className={cn(
          'size-3.5 shrink-0 transition-transform duration-200',
          isOpen ? 'rotate-180' : 'rotate-0',
        )}
      />
    </CollapsibleTrigger>
  );
});

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent>;

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent
    className={cn(
      'mt-1.5 max-h-[300px] overflow-y-auto pl-3 border-l border-push-edge text-push-sm text-push-fg-dim',
      'outline-none data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  >
    {children}
  </CollapsibleContent>
));

Reasoning.displayName = 'Reasoning';
ReasoningTrigger.displayName = 'ReasoningTrigger';
ReasoningContent.displayName = 'ReasoningContent';
