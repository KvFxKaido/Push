"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"
import { asChildProps } from "./render-slot"

function Popover({
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitive.Root>, "children"> & {
  // Base UI also allows a payload-render function here; the Radix-era wrapper
  // API was plain ReactNode, so keep that for consumers.
  children?: React.ReactNode
}) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger> & {
  asChild?: boolean
}) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function PopoverContent({
  className,
  align = "center",
  side,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"]
  sideOffset?: React.ComponentProps<
    typeof PopoverPrimitive.Positioner
  >["sideOffset"]
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["align"]
  alignOffset?: React.ComponentProps<
    typeof PopoverPrimitive.Positioner
  >["alignOffset"]
  collisionPadding?: React.ComponentProps<
    typeof PopoverPrimitive.Positioner
  >["collisionPadding"]
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        data-slot="popover-positioner"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--transform-origin) rounded-md border p-4 shadow-md outline-hidden",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
