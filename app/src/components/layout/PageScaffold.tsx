import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PageScaffoldWidth = 'full' | 'sm' | 'md' | 'lg';

interface PageScaffoldProps {
  /**
   * Optional top bar. Typically `<HeaderBar … />` but free-form — anything
   * that should render outside the scroll container goes here.
   */
  header?: ReactNode;
  /**
   * Inner content width. `sm` is the onboarding form rhythm (`max-w-sm`,
   * ~24rem), `md` is the pairing-form rhythm (`max-w-md`, ~28rem), `lg`
   * is the wider settings-page rhythm (`max-w-2xl`, ~42rem), `full` keeps
   * the content edge-to-edge for chat / launcher surfaces.
   */
  width?: PageScaffoldWidth;
  /**
   * Vertical alignment of the content area. `start` is the default (top-
   * aligned, scrollable); `center` is for short forms (onboarding) where
   * the content should sit in the middle of the viewport.
   */
  align?: 'start' | 'center';
  /**
   * Optional className applied to the scroll container (NOT the outer
   * gradient wrapper). Use this for padding overrides like `px-4 py-6`.
   */
  className?: string;
  /** Optional className applied to the outer gradient wrapper. */
  outerClassName?: string;
  children: ReactNode;
}

const widthClass: Record<PageScaffoldWidth, string> = {
  full: 'w-full',
  sm: 'mx-auto w-full max-w-sm',
  md: 'mx-auto w-full max-w-md',
  lg: 'mx-auto w-full max-w-2xl',
};

/**
 * Standard Push page wrapper. Owns the dark page gradient, safe-area
 * insets, and content-width rhythm so individual screens don't reinvent
 * them. See DESIGN.md → "Composition layer" for usage notes.
 */
export function PageScaffold({
  header,
  width = 'full',
  align = 'start',
  className,
  outerClassName,
  children,
}: PageScaffoldProps) {
  return (
    <div
      className={cn(
        'relative flex h-dvh flex-col bg-push-grad-page text-push-fg safe-area-top safe-area-bottom',
        outerClassName,
      )}
    >
      {header}
      <div
        className={cn(
          'flex flex-1 flex-col overflow-y-auto',
          align === 'center' && 'items-center justify-center',
          className,
        )}
      >
        <div className={widthClass[width]}>{children}</div>
      </div>
    </div>
  );
}
