import { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Ban,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { BackgroundJobStatus, CoderJobCardData } from '@/types';
import {
  CARD_BADGE_ERROR,
  CARD_BADGE_INFO,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_WARNING,
  CARD_HEADER_BG_ERROR,
  CARD_HEADER_BG_INFO,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_WARNING,
  CARD_SHELL_CLASS,
  CARD_TEXT_ERROR,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_WARNING,
  formatElapsedTime,
} from '@/lib/utils';

// A run that hasn't produced a server event in this long while still
// `running` is surfaced to the user with a cancel affordance. Sized
// generously so healthy long runs don't false-positive: Phase 1 emits
// subagent.started and then nothing until terminal, so a 2-minute model
// thinking burst is routine. At 3 minutes of silence we start nudging
// the user, and the DO's 30-minute wall-clock alarm is still the
// authoritative backstop.
const STALL_WARNING_THRESHOLD_MS = 3 * 60 * 1000;

function getStatusLabel(status: BackgroundJobStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

function getStatusClasses(status: BackgroundJobStatus) {
  switch (status) {
    case 'queued':
      return { header: CARD_HEADER_BG_INFO, badge: CARD_BADGE_INFO, text: 'text-push-fg' };
    case 'running':
      return { header: CARD_HEADER_BG_INFO, badge: CARD_BADGE_WARNING, text: 'text-push-fg' };
    case 'completed':
      return { header: CARD_HEADER_BG_SUCCESS, badge: CARD_BADGE_SUCCESS, text: CARD_TEXT_SUCCESS };
    case 'failed':
      return { header: CARD_HEADER_BG_ERROR, badge: CARD_BADGE_ERROR, text: CARD_TEXT_ERROR };
    case 'cancelled':
      return { header: CARD_HEADER_BG_WARNING, badge: CARD_BADGE_WARNING, text: CARD_TEXT_WARNING };
  }
}

const STATUS_ICONS: Record<BackgroundJobStatus, LucideIcon> = {
  queued: CircleDashed,
  running: Loader2,
  completed: CheckCircle2,
  failed: TriangleAlert,
  cancelled: Ban,
};

async function postCancel(jobId: string): Promise<void> {
  try {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  } catch (err) {
    console.warn('[JobCard] Failed to cancel job', jobId, err);
  }
}

export function JobCard({ data }: { data: CoderJobCardData }) {
  const classes = getStatusClasses(data.status);
  const StatusIcon = STATUS_ICONS[data.status];
  const isActive = data.status === 'queued' || data.status === 'running';

  // Re-render every second while the job is in-flight so the elapsed
  // counter advances without the parent having to re-render. On
  // terminal statuses we render from `finishedAt` so the final
  // duration is frozen at the real end time (not reset to 0).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  // Disable Cancel after a single click so impatient taps don't spam
  // /cancel. Terminal states are terminal server-side, so there's no
  // "this job might come back" path we need to reset for.
  const [cancelRequested, setCancelRequested] = useState(false);

  const endTime = isActive ? now : (data.finishedAt ?? now);
  const elapsed = Math.max(0, endTime - data.startedAt);
  const elapsedLabel = formatElapsedTime(elapsed);
  const statusLine = data.latestStatusLine ?? getStatusLabel(data.status);

  const lastEventAt = data.lastEventAt ?? data.startedAt;
  const silentFor = Math.max(0, now - lastEventAt);
  const isStalled = data.status === 'running' && silentFor >= STALL_WARNING_THRESHOLD_MS;

  const handleCancel = async (): Promise<void> => {
    if (cancelRequested) return;
    setCancelRequested(true);
    await postCancel(data.jobId);
    // Don't flip UI state here — the server's cancelled event will
    // arrive over SSE and drive the card through its normal terminal
    // path. If cancel fails (network error), cancelRequested stays true
    // but the status effect will eventually reset it on reconnect.
  };

  return (
    <div className={CARD_SHELL_CLASS}>
      <div
        className={`flex items-center gap-2.5 border-b border-push-edge px-3.5 py-3 ${classes.header}`}
      >
        <Bot className={`h-4 w-4 shrink-0 ${classes.text}`} />
        <span className={`text-push-base font-medium ${classes.text}`}>Background Coder</span>
        <span
          className={`rounded-full px-2 py-0.5 text-push-2xs font-medium uppercase ${classes.badge}`}
        >
          {getStatusLabel(data.status)}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-push-xs text-push-fg-muted">
          <StatusIcon
            className={`h-3.5 w-3.5 ${data.status === 'running' ? 'animate-spin' : ''}`}
          />
          <span>{elapsedLabel}</span>
        </span>
      </div>

      <div className="px-3.5 py-3 space-y-2">
        {data.taskPreview && (
          <p className="text-push-sm text-push-fg-secondary leading-relaxed">{data.taskPreview}</p>
        )}
        <p className="text-push-xs text-push-fg-muted">{statusLine}</p>
        {data.summary && data.status === 'completed' && (
          <p className="text-push-sm text-push-fg-secondary leading-relaxed whitespace-pre-wrap">
            {data.summary}
          </p>
        )}
        {data.error && (data.status === 'failed' || data.status === 'cancelled') && (
          <p className={`text-push-sm leading-relaxed ${CARD_TEXT_ERROR}`}>{data.error}</p>
        )}
        {isStalled && (
          <div
            role="status"
            className={`flex items-start gap-2 rounded-md border border-push-edge ${CARD_HEADER_BG_WARNING} px-3 py-2`}
          >
            <TriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${CARD_TEXT_WARNING}`} />
            <div className="flex-1 min-w-0">
              <p className={`text-push-xs font-medium ${CARD_TEXT_WARNING}`}>Looks stalled</p>
              <p className="text-push-2xs text-push-fg-muted">
                No activity for {formatElapsedTime(silentFor)}. Cancel if the run is stuck — it'll
                otherwise auto-terminate at the 30-minute mark.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelRequested}
              className={`flex shrink-0 items-center gap-1 rounded-md border border-push-edge bg-push-bg px-2 py-1 text-push-2xs font-medium ${CARD_TEXT_WARNING} disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <XCircle className="h-3 w-3" />
              <span>{cancelRequested ? 'Cancelling…' : 'Cancel'}</span>
            </button>
          </div>
        )}
        <p className="text-push-2xs text-push-fg-dim font-mono truncate" title={data.jobId}>
          job {data.jobId}
        </p>
      </div>
    </div>
  );
}
