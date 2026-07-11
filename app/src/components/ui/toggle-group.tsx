import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  }
>({
  size: "default",
  variant: "default",
  spacing: 0,
})

// Radix-style `type`/`value` API preserved: Base UI's ToggleGroup only has a
// `multiple` boolean and array values, so single-mode values are translated
// to/from one-element arrays internally.
type ToggleGroupSingleProps = {
  type: "single"
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

type ToggleGroupMultipleProps = {
  type: "multiple"
  value?: string[]
  defaultValue?: string[]
  onValueChange?: (value: string[]) => void
}

type ToggleGroupProps = Omit<
  React.ComponentProps<typeof ToggleGroupPrimitive>,
  "value" | "defaultValue" | "onValueChange" | "multiple"
> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  } & (ToggleGroupSingleProps | ToggleGroupMultipleProps)

function toValueArray(value: string | string[] | undefined) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value
  return value === "" ? [] : [value]
}

function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  type,
  value,
  defaultValue,
  onValueChange,
  children,
  ...props
}: ToggleGroupProps) {
  const handleValueChange = React.useMemo(() => {
    if (!onValueChange) return undefined
    return (groupValue: string[]) => {
      if (type === "multiple") {
        ;(onValueChange as (value: string[]) => void)(groupValue)
      } else {
        ;(onValueChange as (value: string) => void)(groupValue[0] ?? "")
      }
    }
  }, [onValueChange, type])

  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      multiple={type === "multiple"}
      value={toValueArray(value)}
      defaultValue={toValueArray(defaultValue)}
      onValueChange={handleValueChange}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit items-center gap-[calc(var(--gap)*0.25rem)] rounded-md data-[spacing=default]:data-[variant=outline]:shadow-xs",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        "w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10",
        "data-[spacing=0]:rounded-none data-[spacing=0]:shadow-none data-[spacing=0]:first:rounded-l-md data-[spacing=0]:last:rounded-r-md data-[spacing=0]:data-[variant=outline]:border-l-0 data-[spacing=0]:data-[variant=outline]:first:border-l",
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
