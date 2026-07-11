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
    let refreshObservedElements = false
    const observedElements = new Set<HTMLElement>()
    const resizeObserver = new ResizeObserver(() => scheduleUpdate())

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

    function syncObservedElements() {
      const nextElements = new Set(
        document.querySelectorAll<HTMLElement>(TOAST_CLEARANCE_SELECTOR),
      )
      observedElements.forEach((element) => {
        if (!nextElements.has(element)) {
          resizeObserver.unobserve(element)
          observedElements.delete(element)
        }
      })
      nextElements.forEach((element) => {
        if (!observedElements.has(element)) {
          resizeObserver.observe(element)
          observedElements.add(element)
        }
      })
    }

    function scheduleUpdate(refreshElements = false) {
      refreshObservedElements ||= refreshElements
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (refreshObservedElements) syncObservedElements()
        refreshObservedElements = false
        update()
      })
    }

    const mutationObserver = new MutationObserver((mutations) => {
      const clearanceMembershipChanged = mutations.some(({ addedNodes, removedNodes }) =>
        [...addedNodes, ...removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(TOAST_CLEARANCE_SELECTOR) ||
              node.querySelector(TOAST_CLEARANCE_SELECTOR) !== null),
        ),
      )
      if (clearanceMembershipChanged) scheduleUpdate(true)
    })
    const handleWindowResize = () => scheduleUpdate()
    mutationObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', handleWindowResize)
    scheduleUpdate(true)

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', handleWindowResize)
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
      mobileOffset={offset}
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
