import { useEffect, useState } from 'react';
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import type { ReviewComment } from '@/types';
import { findOpenPRForBranch } from '@/lib/github-tools';
import { triggerPrReview, usePrReviewHistory } from '@/hooks/usePrReviewHistory';
import type { PrReviewListItem } from '@/worker/pr-review-job-do';
import { HUB_PANEL_SUBTLE_SURFACE_CLASS } from '@/components/chat/hub-styles';

interface PrReviewHistorySectionProps {
  repoFullName: string | null | undefined;
  activeBranch: string | null | undefined;
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusBadge({ status }: { status: PrReviewListItem['status'] }) {
  switch (status) {
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1 text-push-2xs text-push-fg-dim">
          <Clock className="h-3 w-3" /> Queued
        </span>
      );
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 text-push-2xs text-sky-400">
          <Loader2 className="h-3 w-3 animate-spin" /> Reviewing
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 text-push-2xs text-emerald-400">
          <CheckCircle className="h-3 w-3" /> Completed
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 text-push-2xs text-red-400">
          <XCircle className="h-3 w-3" /> Failed
        </span>
      );
    default:
      // superseded / duplicate — terminal but uninteresting.
      return <span className="text-push-2xs text-push-fg-dim capitalize">{status}</span>;
  }
}

const SEVERITY_DOT: Record<ReviewComment['severity'], string> = {
  critical: 'text-red-400',
  warning: 'text-amber-400',
  suggestion: 'text-sky-400',
  note: 'text-push-fg-dim',
};

function severityRank(s: ReviewComment['severity']): number {
  return { critical: 0, warning: 1, suggestion: 2, note: 3 }[s];
}

function ReviewFindings({ review }: { review: PrReviewListItem }) {
  if (review.status === 'failed') {
    return <p className="mt-1.5 text-push-2xs text-red-400">{review.error ?? 'Review failed.'}</p>;
  }
  const result = review.result;
  if (!result) {
    return <p className="mt-1.5 text-push-2xs text-push-fg-dim">No findings recorded.</p>;
  }
  const comments = [...result.comments].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );
  return (
    <div className="mt-1.5 space-y-1.5">
      {result.summary && (
        <p className="text-push-xs leading-relaxed text-push-fg-secondary">{result.summary}</p>
      )}
      {result.truncated && (
        <p className="text-push-2xs text-amber-400">
          Partial — reviewed {result.filesReviewed} of {result.totalFiles} files.
        </p>
      )}
      {comments.length > 0 && (
        <ul className="space-y-1">
          {comments.map((c, i) => (
            <li key={i} className="flex items-start gap-1.5 text-push-2xs">
              <span className={`mt-0.5 ${SEVERITY_DOT[c.severity]}`}>●</span>
              <span className="min-w-0">
                <span className="text-push-fg-dim">
                  {c.file}
                  {typeof c.line === 'number' ? `:${c.line}` : ''}
                </span>{' '}
                <span className="text-push-fg-secondary">{c.comment}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewRow({ review }: { review: PrReviewListItem }) {
  const [open, setOpen] = useState(review.status === 'running' || review.status === 'completed');
  const postedNote =
    review.status === 'completed' && typeof review.commentsPosted === 'number'
      ? ` · ${review.commentsPosted} comment${review.commentsPosted !== 1 ? 's' : ''} posted`
      : '';
  return (
    <div className="border-t border-push-border/40 pt-2 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-3 w-3 text-push-fg-dim" />
          ) : (
            <ChevronRight className="h-3 w-3 text-push-fg-dim" />
          )}
          <StatusBadge status={review.status} />
          <span className="font-mono text-push-2xs text-push-fg-dim">
            {review.headSha.slice(0, 7)}
          </span>
        </span>
        <span className="text-push-2xs text-push-fg-dim">
          {relativeTime(review.finishedAt ?? review.startedAt ?? review.createdAt)}
          {postedNote}
        </span>
      </button>
      {open && <ReviewFindings review={review} />}
    </div>
  );
}

/**
 * Read-only history of webhook-triggered (autonomous) PR reviews for the active
 * branch's open PR. Resolves the open PR, then polls the PrReviewJob DO via
 * `usePrReviewHistory`. Renders nothing when there's no PR or no reviews yet, so
 * it stays invisible until the webhook trigger has actually run.
 */
export function PrReviewHistorySection({
  repoFullName,
  activeBranch,
}: PrReviewHistorySectionProps) {
  const [prNumber, setPrNumber] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const resolvePr = async () => {
      if (!repoFullName || !activeBranch) {
        if (!cancelled) setPrNumber(null);
        return;
      }
      try {
        const pr = await findOpenPRForBranch(repoFullName, activeBranch);
        if (!cancelled) setPrNumber(pr?.number ?? null);
      } catch {
        if (!cancelled) setPrNumber(null);
      }
    };
    void resolvePr();
    return () => {
      cancelled = true;
    };
  }, [repoFullName, activeBranch]);

  const { reviews, refresh } = usePrReviewHistory(repoFullName ?? null, prNumber);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  const handleRerun = async () => {
    if (!repoFullName || !prNumber || rerunning) return;
    setRerunning(true);
    setRerunError(null);
    try {
      await triggerPrReview(repoFullName, prNumber);
      refresh(); // start polling immediately so the queued review shows up
    } catch (err) {
      setRerunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunning(false);
    }
  };

  if (!prNumber || reviews.length === 0) return null;

  return (
    <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3.5 py-3`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="text-xs font-medium text-push-fg">Automated PR reviews</span>
          <span className="text-push-2xs text-push-fg-dim">#{prNumber}</span>
        </span>
        <button
          type="button"
          onClick={handleRerun}
          disabled={rerunning}
          className="inline-flex items-center gap-1 text-push-2xs text-push-fg-dim hover:text-push-fg disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${rerunning ? 'animate-spin' : ''}`} />
          {rerunning ? 'Starting…' : 'Re-run'}
        </button>
      </div>
      {rerunError && <p className="mb-1.5 text-push-2xs text-red-400">{rerunError}</p>}
      <div className="space-y-2">
        {reviews.map((review) => (
          <ReviewRow key={review.deliveryId} review={review} />
        ))}
      </div>
    </div>
  );
}
