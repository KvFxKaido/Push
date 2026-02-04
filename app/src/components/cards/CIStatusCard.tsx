import { CheckCircle2, XCircle, Clock, MinusCircle, RefreshCw, Activity } from 'lucide-react';
import type { CIStatusCardData, CICheck, CardAction } from '@/types';

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
      return <MinusCircle className="h-4 w-4 shrink-0 text-[#a1a1aa]" />;
    case 'no-checks':
      return <Activity className="h-4 w-4 shrink-0 text-[#52525b]" />;
  }
}

function overallColor(overall: CIStatusCardData['overall']): string {
  switch (overall) {
    case 'success': return 'text-[#22c55e]';
    case 'failure': return 'text-[#ef4444]';
    case 'pending': return 'text-[#f59e0b]';
    default: return 'text-[#a1a1aa]';
  }
}

function overallBg(overall: CIStatusCardData['overall']): string {
  switch (overall) {
    case 'success': return 'bg-[#22c55e]/5';
    case 'failure': return 'bg-[#ef4444]/5';
    case 'pending': return 'bg-[#f59e0b]/5';
    default: return 'bg-[#52525b]/5';
  }
}

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
      return <MinusCircle className="h-3 w-3 shrink-0 text-[#52525b]" />;
    default:
      return <MinusCircle className="h-3 w-3 shrink-0 text-[#52525b]" />;
  }
}

export function CIStatusCard({ data, messageId, cardIndex, onAction }: CIStatusCardProps) {
  const hasInProgress = data.checks.some(
    (c) => c.status === 'queued' || c.status === 'in_progress',
  );

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${overallBg(data.overall)}`}>
        {overallIcon(data.overall)}
        <span className={`text-sm font-medium ${overallColor(data.overall)}`}>
          CI Status
        </span>
        <span className="ml-auto text-[11px] text-[#52525b]">
          {data.overall === 'no-checks' ? 'No checks' : data.overall.toUpperCase()}
        </span>
      </div>

      {/* Check list */}
      {data.checks.length > 0 ? (
        <div className="px-3 py-2 space-y-1">
          {data.checks.map((check, i) => (
            <div key={i} className="flex items-center gap-2 min-h-[24px]">
              {checkIcon(check)}
              <span className="text-[12px] text-[#a1a1aa] truncate flex-1">
                {check.name}
              </span>
              <span className="text-[11px] text-[#52525b] shrink-0">
                {check.status !== 'completed'
                  ? check.status.replace('_', ' ')
                  : check.conclusion || '—'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-3">
          <p className="text-[12px] text-[#52525b]">
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
            className="flex items-center justify-center gap-1.5 rounded-lg border border-[#1a1a1a] w-full px-4 py-2 text-[12px] font-medium text-[#a1a1aa] transition-all duration-200 hover:bg-[#1a1a1a] hover:text-[#e4e4e7] active:scale-[0.98]"
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
