import { type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type StatusBannerVariant = 'info' | 'warning' | 'error' | 'success';

interface StatusBannerProps {
  variant: StatusBannerVariant;
  /** Replaces the default variant icon. Pass `null` to hide it. */
  icon?: ReactNode | null;
  /** Optional title rendered as `text-sm font-medium`. */
  title?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** When set, renders an X close button calling this handler. */
  onDismiss?: () => void;
  className?: string;
}

// One palette table; every screen lands on the same colors per variant.
// Uses `push-status-*` tokens — see DESIGN.md → Status.
const variantClass: Record<StatusBannerVariant, { wrapper: string; iconColor: string }> = {
  info: {
    wrapper: 'border-push-sky/35 bg-push-sky/10 text-push-sky',
    iconColor: 'text-push-sky',
  },
  warning: {
    wrapper: 'border-push-status-warning/40 bg-push-status-warning/10 text-push-status-warning',
    iconColor: 'text-push-status-warning',
  },
  error: {
    wrapper: 'border-push-status-error/40 bg-push-status-error/10 text-push-status-error-soft',
    iconColor: 'text-push-status-error-soft',
  },
  success: {
    wrapper:
      'border-push-status-success/40 bg-push-status-success-bg/60 text-push-status-success-soft',
    iconColor: 'text-push-status-success-soft',
  },
};

const variantIcon: Record<StatusBannerVariant, ReactNode> = {
  info: <Info className="size-4" />,
  warning: <AlertTriangle className="size-4" />,
  error: <XCircle className="size-4" />,
  success: <CheckCircle2 className="size-4" />,
};

/**
 * Inline status alert. Replaces per-screen `border-rose-400/40 bg-rose-500/10`
 * / `bg-amber-500/15 border-amber-400/40` / shadcn `text-destructive` chrome
 * with one component that uses `push-status-*` tokens.
 */
export function StatusBanner({
  variant,
  icon,
  title,
  children,
  onDismiss,
  className,
}: StatusBannerProps) {
  const palette = variantClass[variant];
  const resolvedIcon = icon === null ? null : (icon ?? variantIcon[variant]);
  return (
    <div
      role={variant === 'error' || variant === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2 text-xs',
        palette.wrapper,
        className,
      )}
    >
      {resolvedIcon ? (
        <span className={cn('mt-0.5 shrink-0', palette.iconColor)}>{resolvedIcon}</span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <div className="text-sm font-medium">{title}</div> : null}
        {children ? <div className="leading-relaxed">{children}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-1 opacity-70 hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
