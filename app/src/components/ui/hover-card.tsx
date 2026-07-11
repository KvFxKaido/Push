"use client"

import * as React from "react"
import { PreviewCard as HoverCardPrimitive } from "@base-ui/react/preview-card"

import { cn } from "@/lib/utils"
import { asChildProps } from "./render-slot"

function HoverCard({
  ...props
}: Omit<React.ComponentProps<typeof HoverCardPrimitive.Root>, "children"> & {
  // Base UI also allows a payload-render function here; the Radix-era wrapper
  // API was plain ReactNode, so keep that for consumers.
  children?: React.ReactNode
}) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger> & {
  asChild?: boolean
}) {
  return (
    <HoverCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function HoverCardContent({
  className,
  align = "center",
  side,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Popup> & {
  side?: React.ComponentProps<typeof HoverCardPrimitive.Positioner>["side"]
  sideOffset?: React.ComponentProps<
    typeof HoverCardPrimitive.Positioner
  >["sideOffset"]
  align?: React.ComponentProps<typeof HoverCardPrimitive.Positioner>["align"]
  alignOffset?: React.ComponentProps<
    typeof HoverCardPrimitive.Positioner
  >["alignOffset"]
  collisionPadding?: React.ComponentProps<
    typeof HoverCardPrimitive.Positioner
  >["collisionPadding"]
}) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Positioner
        data-slot="hover-card-positioner"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <HoverCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--transform-origin) rounded-md border p-4 shadow-md outline-hidden",
            className
          )}
          {...props}
        />
      </HoverCardPrimitive.Positioner>
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
