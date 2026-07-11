import * as React from "react"
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// Radix-style `type="single" | "multiple"` (+ `collapsible`) API preserved:
// Base UI's Accordion only has a `multiple` boolean and array values, so
// single-mode values are translated to/from one-element arrays internally,
// and non-collapsible single mode is emulated by canceling the change that
// would close the last open item (Base UI is always collapsible natively).
type AccordionSingleProps = {
  type: "single"
  collapsible?: boolean
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

type AccordionMultipleProps = {
  type: "multiple"
  collapsible?: never
  value?: string[]
  defaultValue?: string[]
  onValueChange?: (value: string[]) => void
}

type AccordionProps = Omit<
  React.ComponentProps<typeof AccordionPrimitive.Root>,
  "value" | "defaultValue" | "onValueChange" | "multiple"
> &
  (AccordionSingleProps | AccordionMultipleProps)

function toValueArray(value: string | string[] | undefined) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value
  return value === "" ? [] : [value]
}

function Accordion({
  type,
  collapsible,
  value,
  defaultValue,
  onValueChange,
  ...props
}: AccordionProps) {
  const multiple = type === "multiple"
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      multiple={multiple}
      value={toValueArray(value)}
      defaultValue={toValueArray(defaultValue)}
      onValueChange={(next, eventDetails) => {
        if (!multiple && !collapsible && next.length === 0) {
          eventDetails.cancel()
          return
        }
        if (!onValueChange) return
        if (multiple) {
          ;(onValueChange as (value: string[]) => void)(next as string[])
        } else {
          ;(onValueChange as (value: string) => void)(
            (next[0] as string) ?? ""
          )
        }
      }}
      {...props}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b last:border-b-0", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-panel-open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Panel>) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="data-closed:animate-accordion-up data-open:animate-accordion-down overflow-hidden text-sm"
      {...props}
    >
      <div className={cn("pt-0 pb-4", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
