"use client"

import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

// vaul spoke in drawer *placement* ("bottom" = docked at the bottom); Base UI
// speaks in dismissal *swipe direction* ("down" = swipe down to dismiss).
// Keep the vaul-era `direction` prop and translate.
type DrawerDirection = "top" | "bottom" | "left" | "right"

const SWIPE_DIRECTION: Record<
  DrawerDirection,
  React.ComponentProps<typeof DrawerPrimitive.Root>["swipeDirection"]
> = {
  top: "up",
  bottom: "down",
  left: "left",
  right: "right",
}

function Drawer({
  direction = "bottom",
  ...props
}: Omit<
  React.ComponentProps<typeof DrawerPrimitive.Root>,
  "swipeDirection"
> & {
  direction?: DrawerDirection
}) {
  return (
    <DrawerPrimitive.Root
      data-slot="drawer"
      swipeDirection={SWIPE_DIRECTION[direction]}
      {...props}
    />
  )
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="fixed inset-0 z-50"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            // Capacitor Android renders edge-to-edge; using env(safe-area-inset-*)
            // for top/bottom keeps the drawer between the status and nav bars.
            // Values are 0 on web/iOS-no-notch, so this is a no-op there.
            "group/drawer-content bg-background fixed z-50 flex h-auto flex-col",
            "data-[swipe-direction=up]:inset-x-0 data-[swipe-direction=up]:top-[env(safe-area-inset-top)] data-[swipe-direction=up]:mb-24 data-[swipe-direction=up]:max-h-[80dvh] data-[swipe-direction=up]:rounded-b-lg data-[swipe-direction=up]:border-b",
            "data-[swipe-direction=down]:inset-x-0 data-[swipe-direction=down]:bottom-[env(safe-area-inset-bottom)] data-[swipe-direction=down]:mt-24 data-[swipe-direction=down]:max-h-[80dvh] data-[swipe-direction=down]:rounded-t-lg data-[swipe-direction=down]:border-t",
            "data-[swipe-direction=right]:top-[env(safe-area-inset-top)] data-[swipe-direction=right]:bottom-[env(safe-area-inset-bottom)] data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:w-3/4 data-[swipe-direction=right]:border-l data-[swipe-direction=right]:sm:max-w-sm",
            "data-[swipe-direction=left]:top-[env(safe-area-inset-top)] data-[swipe-direction=left]:bottom-[env(safe-area-inset-bottom)] data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:w-3/4 data-[swipe-direction=left]:border-r data-[swipe-direction=left]:sm:max-w-sm",
            className
          )}
          {...props}
        >
          <div className="bg-muted mx-auto mt-4 hidden h-2 w-[100px] shrink-0 rounded-full group-data-[swipe-direction=down]/drawer-content:block" />
          <DrawerPrimitive.Content
            data-slot="drawer-content-inner"
            className="flex min-h-0 flex-1 flex-col"
          >
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-0.5 p-4 group-data-[swipe-direction=down]/drawer-content:text-center group-data-[swipe-direction=up]/drawer-content:text-center md:gap-1.5 md:text-left",
        className
      )}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
}
