import { useEffect, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Ban,
  PauseCircle,
  Play,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { BackgroundJobStatus, CardAction, CoderJobCardData } from '@/types';
import { resolveApiUrl } from '@/lib/api-url';
import { getRoleLabel } from '@push/lib/role-display';
import {
  CARD_BADGE_ERROR,
  CARD_BADGE_INFO,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_WARNING,
  CARD_BUTTON_CLASS,
  CARD_HEADER_BG_ERROR,
  CARD_HEADER_BG_INFO,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_WARNING,
  CARD_INPUT_CLASS,
  CARD_SHELL_CLASS,
  CARD_TEXT_ERROR,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_WARNING,
  formatElapsedTime,
} from '@/lib/utils';

// A run that hasn't produced a server event in this long while still
// `running` is surfaced to the user with a cancel affordance. Sized
// generously so healthy long runs don't false-positive: PR 1 emits
// job.started and then nothing until terminal, so a 2-minute model
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
    case 'suspended':
      return 'Waiting';
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
    case 'suspended':
      // Attention state: header warning tint + warning badge to draw the eye,
      // since the run is blocked on the user answering.
      return { header: CARD_HEADER_BG_WARNING, badge: CARD_BADGE_WARNING, text: CARD_TEXT_WARNING };
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
  suspended: PauseCircle,
  completed: CheckCircle2,
  failed: TriangleAlert,
  cancelled: Ban,
};

async function postCancel(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(resolveApiUrl(`/api/jobs/${encodeURIComponent(jobId)}/cancel`), {
      method: 'POST',
    });
    // fetch() only rejects on network-level failure; a 4xx/5xx response
    // still resolves. Without the res.ok check a rejected cancel would
    // look like a success and leave the button stuck in "Cancelling…".
    if (!res.ok) {
      console.warn('[JobCard] Cancel request rejected', jobId, res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[JobCard] Failed to cancel job', jobId, err);
    return false;
  }
}

/**
 * Guidance panel for a durably-suspended job: shows what the run is blocked on
 * and an input to answer it. Mounted only while `status === 'suspended'`, so its
 * local `answer`/`submitting` state resets naturally on unmount — a successful
 * resume flips the job to running (unmounts this), and a rejected resume rolls
 * the job back to suspended (remounts fresh). `onResume` is fire-and-forget; the
 * parent's optimistic status flip drives the mount/unmount.
 */
function SuspendedGuidancePanel({
  question,
  context,
  onResume,
}: {
  question?: string;
  context?: string;
  onResume: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    const trimmed = answer.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    onResume(trimmed);
  };

  return (
    <div
      className={`space-y-2 rounded-md border border-push-edge ${CARD_HEADER_BG_WARNING} px-3 py-2.5`}
    >
      <div className="flex items-start gap-2">
        <PauseCircle className={`mt-0.5 h-4 w-4 shrink-0 ${CARD_TEXT_WARNING}`} />
        <div className="min-w-0 flex-1">
          <p className={`text-push-xs font-medium ${CARD_TEXT_WARNING}`}>Needs your guidance</p>
          {question && (
            <p className="text-push-sm text-push-fg-secondary leading-relaxed whitespace-pre-wrap">
              {question}
            </p>
          )}
          {context && (
            <p className="mt-1 text-push-2xs text-push-fg-muted leading-relaxed whitespace-pre-wrap">
              {context}
            </p>
          )}
        </div>
      </div>
      <textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter submits, matching the app's other multiline inputs.
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        rows={3}
        disabled={submitting}
        placeholder="Type your guidance to resume the job…"
        className={`${CARD_INPUT_CLASS} resize-none leading-relaxed disabled:opacity-50`}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!answer.trim() || submitting}
        className={`${CARD_BUTTON_CLASS} h-9 w-full`}
      >
        <Play className="h-3.5 w-3.5" />
        {submitting ? 'Resuming…' : 'Resume job'}
      </button>
    </div>
  );
}

export function JobCard({
  data,
  messageId = '',
  cardIndex = 0,
  onAction,
}: {
  data: CoderJobCardData;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}) {
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
  // A job that stays 'queued' past the threshold is almost always stuck
  // client-side — the SSE stream never attached or `job.started`
  // never arrived — and cancel is the same affordance a user would want
  // either way. `queued` is otherwise a very brief optimistic state, so
  // in practice the banner only fires here when something went wrong.
  const isStalled =
    (data.status === 'running' || data.status === 'queued') &&
    silentFor >= STALL_WARNING_THRESHOLD_MS;

  const handleCancel = async (): Promise<void> => {
    if (cancelRequested) return;
    setCancelRequested(true);
    const ok = await postCancel(data.jobId);
    if (!ok) {
      // Re-enable the button so the user can retry. The server's
      // cancelled event — which normally drives the card to its
      // terminal state — never fires on a rejected request, so without
      // this reset we'd leave the UI stuck in "Cancelling…" forever.
      setCancelRequested(false);
    }
    // On success, don't flip UI state — the SSE cancelled event will
    // transition the card through its normal terminal path.
  };

  return (
    <div className={CARD_SHELL_CLASS}>
      <div
        className={`flex items-center gap-2.5 border-b border-push-edge px-3.5 py-3 ${classes.header}`}
      >
        <Bot className={`h-4 w-4 shrink-0 ${classes.text}`} />
        <span className={`text-push-base font-medium ${classes.text}`}>
          {getRoleLabel('coder', { background: true })}
        </span>
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
        {data.status === 'suspended' && (
          <SuspendedGuidancePanel
            question={data.question}
            context={data.context}
            onResume={(answer) =>
              onAction?.({
                type: 'job-resume',
                messageId,
                cardIndex,
                jobId: data.jobId,
                answer,
              })
            }
          />
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
