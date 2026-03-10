import { CheckCircle2, Clock, MinusCircle, XCircle } from 'lucide-react';
import type { WorkflowRunItem } from '@/types';
import { ciStatusBg, ciStatusColor } from '@/lib/utils';

export type CheckTone = 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';

function normalizeToneForColor(tone: CheckTone): 'success' | 'failure' | 'pending' | 'neutral' {
  return tone === 'unknown' ? 'neutral' : tone;
}

export function checkToneColorClass(tone: CheckTone): string {
  return ciStatusColor(normalizeToneForColor(tone));
}

export function checkToneBgClass(tone: CheckTone): string {
  return ciStatusBg(normalizeToneForColor(tone));
}

export function getCheckTone(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): CheckTone {
  if (status && status !== 'completed') return 'pending';

  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'cancelled':
    case 'timed_out':
      return 'pending';
    case 'neutral':
    case 'skipped':
      return 'neutral';
    default:
      return 'unknown';
  }
}

export function getWorkflowRunsHeaderTone(runs: WorkflowRunItem[]): CheckTone {
  if (runs.length === 0) return 'unknown';

  const first = runs[0];
  const tone = getCheckTone(first.status, first.conclusion);
  return tone === 'neutral' ? 'unknown' : tone;
}

export function getWorkflowLogsHeaderTone(conclusion: string | null): 'success' | 'failure' | 'pending' {
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    default:
      return 'pending';
  }
}

interface CheckToneIconOptions {
  neutralClassName?: string;
  unknownClassName?: string;
}

export function renderCheckToneIcon(
  tone: CheckTone,
  sizeClasses: string,
  options?: CheckToneIconOptions,
) {
  const neutralClassName = options?.neutralClassName || 'text-push-fg-secondary';
  const unknownClassName = options?.unknownClassName || 'text-push-fg-secondary';

  switch (tone) {
    case 'success':
      return <CheckCircle2 className={`${sizeClasses} text-push-status-success`} />;
    case 'failure':
      return <XCircle className={`${sizeClasses} text-push-status-error`} />;
    case 'pending':
      return <Clock className={`${sizeClasses} text-push-status-warning`} />;
    case 'neutral':
      return <MinusCircle className={`${sizeClasses} ${neutralClassName}`} />;
    case 'unknown':
      return <MinusCircle className={`${sizeClasses} ${unknownClassName}`} />;
  }
}
