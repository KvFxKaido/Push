import * as React from 'react';
import { useRender } from '@base-ui/react/use-render';

/**
 * Bridges shadcn's Radix-era `asChild` prop onto Base UI's `render` prop.
 *
 * Radix `<Trigger asChild><button>…</button></Trigger>` merged the trigger's
 * props into its single child element. Base UI expresses the same thing as
 * `<Trigger render={<button>…</button>} />` (the rendered element keeps its
 * own children; props/className/style/handlers merge, element's own winning).
 *
 * Base UI part wrappers keep accepting `asChild` so consumers don't churn:
 *
 *   <XPrimitive.Trigger {...asChildProps(asChild, children)} {...props} />
 */
export function asChildProps(
  asChild: boolean | undefined,
  children: React.ReactNode,
):
  | { render: React.ReactElement<Record<string, unknown>> }
  | { children: React.ReactNode } {
  if (asChild && React.isValidElement(children)) {
    return { render: children as React.ReactElement<Record<string, unknown>> };
  }
  return { children };
}

interface RenderSlotProps extends React.HTMLAttributes<HTMLElement> {
  ref?: React.Ref<HTMLElement>;
}

/**
 * Drop-in replacement for `@radix-ui/react-slot`'s `Slot` in the
 * `const Comp = asChild ? Slot : "tag"` idiom, built on Base UI's
 * `useRender`. Requires exactly one element child (same contract Radix
 * enforced via `Children.only`); merging semantics match: event handlers
 * compose, `className`/`style` join, other child props win over ours.
 */
export function RenderSlot({ children, ref, ...props }: RenderSlotProps) {
  const element = React.Children.only(children) as React.ReactElement<
    Record<string, unknown>
  >;
  return useRender({ render: element, ref, props });
}
