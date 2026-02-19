import { cn } from '@/lib/utils';

interface CardCodeBlockProps {
  children: React.ReactNode;
  /** Extra classes for the inner <code> element (color, whitespace, etc.). */
  codeClassName?: string;
  /** Extra classes for the outer <pre> element (bg, max-height, etc.). */
  preClassName?: string;
}

/**
 * Shared pre/code wrapper used by cards that display raw text output.
 * Base styles: `px-3 py-2 overflow-x-auto` on <pre>,
 *              `font-mono text-[12px] leading-relaxed` on <code>.
 * Pass `codeClassName` / `preClassName` to override color, whitespace, or height.
 */
export function CardCodeBlock({ children, codeClassName, preClassName }: CardCodeBlockProps) {
  return (
    <pre className={cn('px-3 py-2 overflow-x-auto', preClassName)}>
      <code className={cn('font-mono text-[12px] leading-relaxed', codeClassName)}>
        {children}
      </code>
    </pre>
  );
}
