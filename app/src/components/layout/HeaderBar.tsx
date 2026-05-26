import { type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HUB_MATERIAL_ROUND_BUTTON_CLASS } from '@/components/chat/hub-styles';

interface HeaderBarProps {
  /**
   * Back affordance. Pass a callback to render the standard
   * `HUB_MATERIAL_ROUND_BUTTON` with a `ChevronLeft`. Omit when the
   * screen has no back direction (root surfaces, modals with their
   * own close).
   */
  back?: () => void;
  /** Optional explicit aria-label for the back button (default "Back"). */
  backLabel?: string;
  /** Optional icon shown to the left of the title (above the subtitle). */
  icon?: ReactNode;
  /**
   * Title text or node. Renders as `text-sm font-medium text-push-fg`
   * centered between the back button and the actions slot.
   */
  title?: ReactNode;
  /** Optional subtitle below the title (`text-push-xs text-push-fg-muted`). */
  subtitle?: ReactNode;
  /** Right-side action slot. Free-form — pass HUB pills, icon buttons, etc. */
  actions?: ReactNode;
  /** Optional bottom divider. Default `true` for screens that scroll. */
  divider?: boolean;
  className?: string;
}

/**
 * Unified top-bar primitive. Three-column grid: back / title-block /
 * actions. See DESIGN.md → "Composition layer" for usage.
 */
export function HeaderBar({
  back,
  backLabel = 'Back',
  icon,
  title,
  subtitle,
  actions,
  divider = true,
  className,
}: HeaderBarProps) {
  return (
    <header
      className={cn(
        'grid grid-cols-[auto_1fr_auto] items-center gap-2 px-3 pt-3 pb-2',
        divider && 'border-b border-push-edge/40',
        className,
      )}
    >
      <div className="flex items-center">
        {back ? (
          <button
            type="button"
            onClick={back}
            aria-label={backLabel}
            className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
          >
            <ChevronLeft className="size-4" />
          </button>
        ) : (
          // Reserve grid cell so the title stays centered when back is absent.
          <span className="size-8" aria-hidden />
        )}
      </div>
      <div className="flex min-w-0 items-center justify-center gap-2">
        {icon ? <span className="text-push-fg-muted">{icon}</span> : null}
        <div className="min-w-0 text-center">
          {title ? <div className="truncate text-sm font-medium text-push-fg">{title}</div> : null}
          {subtitle ? (
            <div className="truncate text-push-xs text-push-fg-muted">{subtitle}</div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">{actions}</div>
    </header>
  );
}
