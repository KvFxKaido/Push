import type { ComponentProps, ReactNode } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';

/**
 * Settings-flavored accordion in the HeroUI "splitted" style: each item is its
 * own rounded card, the trigger row carries `startContent` (icon), a
 * title/subtitle block, optional `endContent` (status dot, spinner), and the
 * rotating chevron indicator. Built on the shadcn Radix primitive so closed
 * content is unmounted (no hidden-but-interactive controls) and expansion is
 * keyboard-accessible for free.
 */
export function SettingsAccordion({ className, ...props }: ComponentProps<typeof Accordion>) {
  return <Accordion className={cn('space-y-2', className)} {...props} />;
}

export interface SettingsAccordionItemProps {
  value: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Leading slot on the trigger row — typically a provider or section icon. */
  startContent?: ReactNode;
  /** Trailing slot before the chevron — status dot, spinner. Non-interactive only: it renders inside the trigger button. */
  endContent?: ReactNode;
  children: ReactNode;
}

export function SettingsAccordionItem({
  value,
  title,
  subtitle,
  startContent,
  endContent,
  children,
}: SettingsAccordionItemProps) {
  return (
    <AccordionItem
      value={value}
      // `last:border-b` undoes the primitive's list-flavored `last:border-b-0`
      // — splitted cards keep their full border.
      className="overflow-hidden rounded-2xl border border-push-edge bg-push-surface/35 shadow-[0_10px_22px_rgba(0,0,0,0.14)] last:border-b"
    >
      <AccordionTrigger className="items-center gap-3 rounded-2xl px-3.5 py-3 transition-colors hover:no-underline hover:bg-white/[0.02] [&>svg]:translate-y-0 [&>svg]:text-push-fg-dim">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {startContent && <span className="flex shrink-0 items-center">{startContent}</span>}
          <span className="min-w-0">
            <span className="block text-xs font-medium text-push-fg-secondary">{title}</span>
            {subtitle && (
              <span className="block truncate text-[11px] font-normal text-push-fg-dim">
                {subtitle}
              </span>
            )}
          </span>
        </span>
        {endContent && <span className="flex shrink-0 items-center gap-2">{endContent}</span>}
      </AccordionTrigger>
      <AccordionContent className="space-y-2 px-3 pb-3">{children}</AccordionContent>
    </AccordionItem>
  );
}
