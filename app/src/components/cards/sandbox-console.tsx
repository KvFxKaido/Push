import type { ComponentProps, ReactNode } from 'react';
import { CheckCircle2, ChevronDown, Circle, XCircle } from 'lucide-react';
import { TerminalCrateIcon } from '@/components/icons/push-custom-icons';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

// Push-styled adaptation of Vercel's AI Elements "Sandbox" component
// (https://ai-sdk.dev/elements, Apache-2.0). The compound API is preserved so
// the surface reads the same as upstream; the shadcn palette is swapped for
// Push design tokens (push-*) per DESIGN.md so it matches the rest of the app.
// Used by the Agent Console (`HubConsoleTab`) to render `sandbox_exec` runs as
// collapsible, tabbed code/console cards.

export type SandboxState = 'running' | 'completed' | 'error';

const STATUS_LABELS: Record<SandboxState, string> = {
  running: 'Running',
  completed: 'Completed',
  error: 'Error',
};

const STATUS_ICONS: Record<SandboxState, ReactNode> = {
  running: <Circle className="size-3 animate-pulse text-push-link" />,
  completed: <CheckCircle2 className="size-3 text-push-status-success" />,
  error: <XCircle className="size-3 text-push-status-error" />,
};

function SandboxStatusBadge({ state }: { state: SandboxState }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.04] px-2 py-0.5 text-push-xs font-medium text-push-fg-secondary">
      {STATUS_ICONS[state]}
      {STATUS_LABELS[state]}
    </span>
  );
}

export type SandboxProps = ComponentProps<typeof Collapsible>;

export function Sandbox({ className, ...props }: SandboxProps) {
  return (
    <Collapsible
      className={cn('group w-full overflow-hidden rounded-md border border-push-edge', className)}
      {...props}
    />
  );
}

export interface SandboxHeaderProps {
  title?: string;
  state: SandboxState;
  className?: string;
}

export function SandboxHeader({ className, title, state }: SandboxHeaderProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        'flex w-full items-center justify-between gap-3 px-3 py-2 transition-colors hover:bg-white/[0.02]',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <TerminalCrateIcon className="size-4 shrink-0 text-push-fg-secondary" />
        {title && <code className="truncate font-mono text-push-base text-push-fg">{title}</code>}
        <SandboxStatusBadge state={state} />
      </div>
      <ChevronDown className="size-4 shrink-0 text-push-fg-dim transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
}

export type SandboxContentProps = ComponentProps<typeof CollapsibleContent>;

export function SandboxContent({ className, ...props }: SandboxContentProps) {
  return (
    <CollapsibleContent className={cn('overflow-hidden outline-none', className)} {...props} />
  );
}

export type SandboxTabsProps = ComponentProps<typeof Tabs>;

export function SandboxTabs({ className, ...props }: SandboxTabsProps) {
  return <Tabs className={cn('w-full gap-0', className)} {...props} />;
}

export type SandboxTabsBarProps = ComponentProps<'div'>;

export function SandboxTabsBar({ className, ...props }: SandboxTabsBarProps) {
  return (
    <div
      className={cn('flex w-full items-center border-y border-push-edge', className)}
      {...props}
    />
  );
}

export type SandboxTabsListProps = ComponentProps<typeof TabsList>;

export function SandboxTabsList({ className, ...props }: SandboxTabsListProps) {
  return (
    <TabsList
      className={cn('h-auto rounded-none border-0 bg-transparent p-0', className)}
      {...props}
    />
  );
}

export type SandboxTabsTriggerProps = ComponentProps<typeof TabsTrigger>;

export function SandboxTabsTrigger({ className, ...props }: SandboxTabsTriggerProps) {
  return (
    <TabsTrigger
      className={cn(
        'rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 py-1.5 font-medium text-push-xs text-push-fg-dim shadow-none transition-colors data-[state=active]:border-push-accent data-[state=active]:bg-transparent data-[state=active]:text-push-fg data-[state=active]:shadow-none',
        className,
      )}
      {...props}
    />
  );
}

export type SandboxTabContentProps = ComponentProps<typeof TabsContent>;

export function SandboxTabContent({ className, ...props }: SandboxTabContentProps) {
  return <TabsContent className={cn('mt-0 text-push-sm', className)} {...props} />;
}
