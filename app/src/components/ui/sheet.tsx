import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { asChildProps } from "./render-slot"

function Sheet({
  ...props
}: Omit<React.ComponentProps<typeof SheetPrimitive.Root>, "children"> & {
  // Base UI also allows a payload-render function here; the Radix-era wrapper
  // API was plain ReactNode, so keep that for consumers.
  children?: React.ReactNode
}) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger> & {
  asChild?: boolean
}) {
  return (
    <SheetPrimitive.Trigger
      data-slot="sheet-trigger"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function SheetClose({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close> & {
  asChild?: boolean
}) {
  return (
    <SheetPrimitive.Close
      data-slot="sheet-close"
      {...asChildProps(asChild, children)}
      {...props}
    />
  )
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Backdrop>) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  forceMount,
  overlayClassName,
  hideOverlay = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Popup> & {
  side?: "top" | "right" | "bottom" | "left"
  /** Radix-era name for Base UI's `keepMounted` (taken by the Portal). */
  forceMount?: boolean
  overlayClassName?: string
  hideOverlay?: boolean
}) {
  return (
    <SheetPortal keepMounted={forceMount ? true : undefined}>
      {!hideOverlay ? <SheetOverlay className={overlayClassName} /> : null}
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          // Capacitor Android renders edge-to-edge; using env(safe-area-inset-*)
          // for the anchored edges keeps the sheet between the status and nav
          // bars without overlapping the system UI. Values are 0 on web and on
          // iOS without a notch, so this is a no-op there. h-full is dropped
          // for left/right because top + bottom already imply the height —
          // keeping h-full would override `bottom` and re-extend past the nav.
          //
          // Slide timing/easing is NOT set here: it's retimed onto the shared
          // `--panel-*` motion tokens in index.css (the `[data-slot=sheet-content]`
          // rules), so every Push panel shares one open/close feel. The classes
          // below only declare the animation + directional slide.
          "bg-background data-open:animate-in data-closed:animate-out fixed z-50 flex flex-col gap-4 shadow-lg",
          side === "right" &&
            "data-closed:slide-out-to-right data-open:slide-in-from-right top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)] right-0 w-3/4 border-l sm:max-w-sm",
          side === "left" &&
            "data-closed:slide-out-to-left data-open:slide-in-from-left top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)] left-0 w-3/4 border-r sm:max-w-sm",
          side === "top" &&
            "data-closed:slide-out-to-top data-open:slide-in-from-top inset-x-0 top-[env(safe-area-inset-top)] h-auto border-b",
          side === "bottom" &&
            "data-closed:slide-out-to-bottom data-open:slide-in-from-bottom inset-x-0 bottom-[env(safe-area-inset-bottom)] h-auto border-t",
          className
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          data-slot="sheet-close"
          className="ring-offset-background focus:ring-ring data-open:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none"
        >
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
