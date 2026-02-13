import { CheckCircle2, XCircle, Clock, MinusCircle, RefreshCw, Activity } from 'lucide-react';
import type { CIStatusCardData, CICheck, CardAction } from '@/types';
import { CARD_SHELL_CLASS, ciStatusColor, ciStatusBg } from '@/lib/utils';

interface CIStatusCardProps {
  data: CIStatusCardData;
  messageId: string;
  cardIndex: number;
  onAction?: (action: CardAction) => void;
}

function overallIcon(overall: CIStatusCardData['overall']) {
  switch (overall) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-[#22c55e]" />;
    case 'failure':
      return <XCircle className="h-4 w-4 shrink-0 text-[#ef4444]" />;
    case 'pending':
      return <Clock className="h-4 w-4 shrink-0 text-[#f59e0b]" />;
    case 'neutral':
      return <MinusCircle className="h-4 w-4 shrink-0 text-push-fg-secondary" />;
    case 'no-checks':
      return <Activity className="h-4 w-4 shrink-0 text-push-fg-dim" />;
  }
}

const overallColor = (overall: CIStatusCardData['overall']) => ciStatusColor(overall);
const overallBg = (overall: CIStatusCardData['overall']) => ciStatusBg(overall);

function checkIcon(check: CICheck) {
  if (check.status !== 'completed') {
    return <Clock className="h-3 w-3 shrink-0 text-[#f59e0b]" />;
  }
  switch (check.conclusion) {
    case 'success':
      return <CheckCircle2 className="h-3 w-3 shrink-0 text-[#22c55e]" />;
    case 'failure':
      return <XCircle className="h-3 w-3 shrink-0 text-[#ef4444]" />;
    case 'cancelled':
    case 'timed_out':
      return <XCircle className="h-3 w-3 shrink-0 text-[#f59e0b]" />;
    case 'skipped':
    case 'neutral':
      return <MinusCircle className="h-3 w-3 shrink-0 text-push-fg-dim" />;
    default:
      return <MinusCircle className="h-3 w-3 shrink-0 text-push-fg-dim" />;
  }
}

export function CIStatusCard({ data, messageId, cardIndex, onAction }: CIStatusCardProps) {
  const hasInProgress = data.checks.some(
    (c) => c.status === 'queued' || c.status === 'in_progress',
  );

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${overallBg(data.overall)}`}>
        {overallIcon(data.overall)}
        <span className={`text-sm font-medium ${overallColor(data.overall)}`}>
          CI Status
        </span>
        <span className="ml-auto text-[11px] text-push-fg-dim">
          {data.overall === 'no-checks' ? 'No checks' : data.overall.toUpperCase()}
        </span>
      </div>

      {/* Check list */}
      {data.checks.length > 0 ? (
        <div className="px-3 py-2 space-y-1">
          {data.checks.map((check, i) => (
            <div key={i} className="flex items-center gap-2 min-h-[24px]">
              {checkIcon(check)}
              <span className="text-[12px] text-push-fg-secondary truncate flex-1">
                {check.name}
              </span>
              <span className="text-[11px] text-push-fg-dim shrink-0">
                {check.status !== 'completed'
                  ? check.status.replace('_', ' ')
                  : check.conclusion || '—'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-3">
          <p className="text-[12px] text-push-fg-dim">
            No CI checks configured for this repo.
          </p>
        </div>
      )}

      {/* Refresh button when checks are in progress */}
      {hasInProgress && (
        <div className="px-3 pb-3">
          <button
            onClick={() => onAction?.({
              type: 'ci-refresh',
              messageId,
              cardIndex,
            })}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-push-edge w-full px-4 py-2 text-[12px] font-medium text-push-fg-secondary transition-all duration-200 hover:bg-[#111624] hover:text-[#e4e4e7] active:scale-[0.98]"
            style={{ minHeight: '44px' }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
