import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useLayoutEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// Chat headers occupy the first 54px below the device safe area. Keep the
// transient notification lane clear of that chrome, with an extra 18px of
// breathing room before the first toast. The value belongs here rather than at
// each route so every surface shares the same top-center lane.
export const TOAST_TOP_OFFSET = "calc(env(safe-area-inset-top, 0px) + 4.5rem)"
const TOAST_CLEARANCE_SELECTOR = "[data-push-toast-clearance]"
const TOAST_CLEARANCE_GAP = 12

type PushToasterProps = Omit<ToasterProps, "position" | "offset">

/**
 * Keeps floating toasts below any visible, in-flow status banners. Banners are
 * the durable control surface for the current chat; a toast must never cover
 * their copy or actions.
 */
function useToastOffset() {
  const [offset, setOffset] = useState<string>(TOAST_TOP_OFFSET)

  useLayoutEffect(() => {
    let frame: number | undefined
    const resizeObserver = new ResizeObserver(scheduleUpdate)

    function update() {
      const clearanceBottom = Array.from(
        document.querySelectorAll<HTMLElement>(TOAST_CLEARANCE_SELECTOR),
      ).reduce((bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom), 0)
      const nextOffset =
        clearanceBottom > 0
          ? `${Math.ceil(clearanceBottom + TOAST_CLEARANCE_GAP)}px`
          : TOAST_TOP_OFFSET
      setOffset((current) => (current === nextOffset ? current : nextOffset))
    }

    function scheduleUpdate() {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        resizeObserver.disconnect()
        document.querySelectorAll<HTMLElement>(TOAST_CLEARANCE_SELECTOR).forEach((element) => {
          resizeObserver.observe(element)
        })
        update()
      })
    }

    const mutationObserver = new MutationObserver(scheduleUpdate)
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', scheduleUpdate)
    scheduleUpdate()

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [])

  return offset
}

const Toaster = ({ ...props }: PushToasterProps) => {
  const { theme = "system" } = useTheme()
  const offset = useToastOffset()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="top-center"
      offset={offset}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
