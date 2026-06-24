import type { ComponentType, SVGProps } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deriveStepStatus, type MultiStepLoaderState } from './multi-step-loader-status';

export type { MultiStepLoaderState } from './multi-step-loader-status';

export interface MultiStepLoaderStep {
  /** Stable identity for the step (used as React key). */
  key: string;
  /** Label shown while the step is pending/active. */
  label: string;
  /** Optional short label shown once the step has completed (defaults to `label`). */
  doneLabel?: string;
  /** Optional leading icon for the resting (pending) state. */
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

export interface MultiStepLoaderProps {
  steps: readonly MultiStepLoaderStep[];
  /**
   * Index of the live step.
   * - `running`: the spinning, in-progress step.
   * - `error`: the step that failed (everything after it is treated as skipped).
   * Ignored when `state === 'success'` (all steps render done).
   */
  currentStep: number;
  state: MultiStepLoaderState;
  /** Surfaced under the failed step when `state === 'error'`. */
  errorMessage?: string | null;
  className?: string;
}

/**
 * Presentational, event-driven multi-step progress. Unlike the stock
 * fixed-timer "multi-step loader", this advances purely from the `currentStep`
 * + `state` props its caller derives from real runtime state (commit phases,
 * task-graph events), so it never shows fake progress. Pure lucide + Tailwind —
 * no framer-motion / tabler-icons dependency. Hookless so it can be called as a
 * plain function in tests.
 */
export function MultiStepLoader({
  steps,
  currentStep,
  state,
  errorMessage,
  className,
}: MultiStepLoaderProps) {
  return (
    <ol className={cn('flex flex-col gap-1.5', className)} aria-label="Progress">
      {steps.map((step, index) => {
        const status = deriveStepStatus(index, currentStep, state);
        const RestIcon = step.icon;
        return (
          <li
            key={step.key}
            aria-current={status === 'active' ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 text-push-xs transition-opacity duration-200',
              status === 'pending' && 'opacity-40',
            )}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {status === 'active' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-push-accent" />
              ) : status === 'done' ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : status === 'error' ? (
                <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
              ) : RestIcon ? (
                <RestIcon className="h-3.5 w-3.5 text-push-fg-dim" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-push-fg-dim" />
              )}
            </span>
            <span
              className={cn(
                'min-w-0 truncate',
                status === 'active' && 'text-push-fg',
                status === 'done' && 'text-push-fg-secondary',
                status === 'error' && 'text-red-300',
                status === 'pending' && 'text-push-fg-dim',
              )}
            >
              {status === 'done' ? (step.doneLabel ?? step.label) : step.label}
            </span>
          </li>
        );
      })}
      {state === 'error' && errorMessage && (
        <li className="mt-0.5 pl-6 text-push-2xs text-red-300">{errorMessage}</li>
      )}
    </ol>
  );
}
