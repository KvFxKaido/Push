"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"
import { asChildProps } from "./render-slot"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider> & {
  /** Radix-era name for Base UI's `delay`. */
  delayDuration?: number
}) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  delayDuration,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Root>, "children"> & {
  /**
   * Radix-era root prop; Base UI puts the open delay on the Provider, so the
   * wrapper forwards it to the per-tooltip Provider it already renders.
   */
  delayDuration?: number
  // Base UI also allows a payload-render function here; the Radix-era wrapper
  // API was plain ReactNode, so keep that for consumers.
  children?: React.ReactNode
}) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger> & {
  asChild?: boolean
}) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align,
  alignOffset,
  collisionPadding,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Popup> & {
  side?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["side"]
  sideOffset?: React.ComponentProps<
    typeof TooltipPrimitive.Positioner
  >["sideOffset"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Positioner>["align"]
  alignOffset?: React.ComponentProps<
    typeof TooltipPrimitive.Positioner
  >["alignOffset"]
  collisionPadding?: React.ComponentProps<
    typeof TooltipPrimitive.Positioner
  >["collisionPadding"]
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          // Push retune: dark raised-chrome surface (matches the app's palette, not
          // the stark white-on-dark shadcn default), and the transitions.dev open
          // feel — a subtle scale 0.98 → 1 + fade, snappy in (150ms) / snappier out
          // (75ms), ease-out, pure scale from the Base UI transform-origin (no
          // directional slide). `max-w` + `text-balance` let longer "explain this
          // feature" copy wrap instead of forcing a single nowrap line. Reduced
          // motion is handled by the global wildcard in index.css.
          className={cn(
            "bg-push-surface-raised text-push-fg-soft border border-push-edge shadow-push-lg animate-in fade-in-0 zoom-in-[0.98] data-open:duration-150 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] data-closed:duration-75 ease-out z-50 w-fit max-w-[16rem] origin-(--transform-origin) rounded-lg px-3 py-1.5 text-push-xs text-balance",
            className
          )}
          {...props}
        >
          {children}
          {/* Base UI's Arrow is a plain positioned <div> (not Radix's SVG), so the
              surface color is `bg-*` and the protrusion past the popup edge is a
              per-side offset keyed off `data-side`. */}
          <TooltipPrimitive.Arrow className="bg-push-surface-raised z-50 size-2.5 rotate-45 rounded-[2px] data-[side=top]:bottom-[-4px] data-[side=bottom]:top-[-4px] data-[side=left]:right-[-4px] data-[side=right]:left-[-4px]" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
