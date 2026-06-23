"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // Push retune: dark raised-chrome surface (matches the app's palette, not
        // the stark white-on-dark shadcn default), and the transitions.dev open
        // feel — a subtle scale 0.98 → 1 + fade, snappy in (150ms) / snappier out
        // (75ms), ease-out, pure scale from the Radix transform-origin (no
        // directional slide). `max-w` + `text-balance` let longer "explain this
        // feature" copy wrap instead of forcing a single nowrap line. Reduced
        // motion is handled by the global wildcard in index.css.
        className={cn(
          "bg-push-surface-raised text-push-fg-soft border border-push-edge shadow-push-lg animate-in fade-in-0 zoom-in-[0.98] data-[state=open]:duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=closed]:duration-75 ease-out z-50 w-fit max-w-[16rem] origin-(--radix-tooltip-content-transform-origin) rounded-lg px-3 py-1.5 text-push-xs text-balance",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-push-surface-raised z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
