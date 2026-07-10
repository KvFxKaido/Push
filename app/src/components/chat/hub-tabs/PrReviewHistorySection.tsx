import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import {
  CLOUDFLARE_MODELS,
  SHARED_PROVIDER_MODEL_CATALOG,
  ZAI_MODELS,
} from '@push/lib/provider-models';
import { PROVIDERS, type PreferredProvider } from '@/lib/providers';
import type { ReviewComment } from '@/types';
import { findOpenPRForBranch } from '@/lib/github-tools';
import { cancelPrReview, triggerPrReview, usePrReviewHistory } from '@/hooks/usePrReviewHistory';
import { usePrReviewInflight } from '@/hooks/usePrReviewInflight';
import { usePrReviewConfig } from '@/hooks/usePrReviewConfig';
import type { PrReviewListItem } from '@/worker/pr-review-job-do';
import { HUB_PANEL_SUBTLE_SURFACE_CLASS } from '@/components/chat/hub-styles';
import { Switch } from '@/components/ui/switch';

const AUTOMATED_REVIEW_MODEL_OPTIONS: Partial<Record<PreferredProvider, readonly string[]>> = {
  ...SHARED_PROVIDER_MODEL_CATALOG,
  zai: ZAI_MODELS,
  cloudflare: CLOUDFLARE_MODELS,
};

const AUTOMATED_REVIEW_PROVIDERS = PROVIDERS.filter(
  (provider) => AUTOMATED_REVIEW_MODEL_OPTIONS[provider.type as PreferredProvider]?.length,
);

function getAutomatedReviewModels(provider: string | null | undefined): readonly string[] {
  return provider ? (AUTOMATED_REVIEW_MODEL_OPTIONS[provider as PreferredProvider] ?? []) : [];
}

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

/** Compact token count: 942 → "942", 12_345 → "12.3k". */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/**
 * Human outcome for a completed review's collapsed row. The DO's
 * `commentsPosted` counts only inline-anchored comments, so a body-only or
 * "looks clean" review reports 0 even though it posted — we lead with the
 * `posted` flag and the real finding count (`result.comments.length`) instead.
 *
 * Degraded must be checked BEFORE `posted`: a fallback review also reports
 * `posted: false` (the DO deliberately doesn't post it), and reading that as
 * "Skipped — newer commit" would hide the round-exhaustion failure mode this
 * row exists to surface (Codex P2, PR #907). Matches the check-run's
 * "Review incomplete" vocabulary.
 */
function completedOutcome(review: PrReviewListItem): string {
  if (review.result?.degraded) return 'Incomplete — no structured output';
  if (review.posted === false) return 'Skipped — newer commit';
  const findings = review.result?.comments.length ?? 0;
  if (findings === 0) return 'Posted · looks clean';
  return `Posted · ${findings} finding${findings !== 1 ? 's' : ''}`;
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
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1 text-push-2xs text-push-fg-dim">
          <Ban className="h-3 w-3" /> Cancelled
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

function ReviewRow({
  review,
  onCancel,
  showPrNumber = false,
}: {
  review: PrReviewListItem;
  /** Cancel this review by deliveryId; resolves after the refresh is kicked. */
  onCancel?: (deliveryId: string) => Promise<void>;
  /** Show the PR number in the row header — used by the cross-PR active list. */
  showPrNumber?: boolean;
}) {
  const [open, setOpen] = useState(review.status === 'running' || review.status === 'completed');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const outcomeNote = review.status === 'completed' ? ` · ${completedOutcome(review)}` : '';
  const usage = review.result?.usage;
  // Only queued/running reviews can be cancelled; everything else is terminal.
  const inFlight = review.status === 'queued' || review.status === 'running';

  const handleCancel = async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancel(review.deliveryId);
    } catch (err) {
      // A 409 here means the review reached a terminal state first (stale-tab
      // race) — the refresh the caller kicks will reconcile the badge, so this
      // message is only meaningful for a genuine network/server failure.
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="border-t border-push-border/40 pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
        >
          <span className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-3 w-3 text-push-fg-dim" />
            ) : (
              <ChevronRight className="h-3 w-3 text-push-fg-dim" />
            )}
            <StatusBadge status={review.status} />
            {showPrNumber && (
              <span className="text-push-2xs text-push-fg-dim">#{review.prNumber}</span>
            )}
            <span className="font-mono text-push-2xs text-push-fg-dim">
              {review.headSha.slice(0, 7)}
            </span>
          </span>
          <span className="text-push-2xs text-push-fg-dim">
            {relativeTime(review.finishedAt ?? review.startedAt ?? review.createdAt)}
            {outcomeNote}
          </span>
        </button>
        {inFlight && onCancel && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            title="Cancel this review"
            className="inline-flex shrink-0 items-center gap-1 text-push-2xs text-push-fg-dim hover:text-red-400 disabled:opacity-50"
          >
            <Ban className="h-3 w-3" />
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
      {inFlight && cancelError && <p className="mt-1 text-push-2xs text-red-400">{cancelError}</p>}
      {open && (
        <>
          <ReviewFindings review={review} />
          {usage && (
            <p className="mt-1 text-push-2xs text-push-fg-dim">
              {formatTokens(usage.totalTokens)} tokens
              <span className="opacity-60">
                {' '}
                ({formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out)
              </span>
            </p>
          )}
        </>
      )}
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
  const { reviews: inflight, refresh: refreshInflight } = usePrReviewInflight(repoFullName ?? null);
  // "Active reviews" is purely a cross-PR monitor: the current PR's in-flight
  // review already appears (cancellable) in the per-PR history below, so exclude
  // it here to avoid rendering two identical rows for the same run.
  const otherPrInflight = useMemo(
    () => inflight.filter((r) => r.prNumber !== prNumber),
    [inflight, prNumber],
  );
  const {
    enabled,
    provider,
    model,
    saving,
    setEnabled,
    setModelConfig,
    error: configError,
  } = usePrReviewConfig();

  const providerOptions = AUTOMATED_REVIEW_PROVIDERS;
  const selectedProvider = useMemo(
    () => providerOptions.find((p) => p.type === provider) ?? null,
    [providerOptions, provider],
  );
  const selectedModels = useMemo(() => getAutomatedReviewModels(provider), [provider]);
  const selectedModel = model && selectedModels.includes(model) ? model : null;
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

  // Cancel an in-flight review, then refresh so the row flips to "Cancelled"
  // without waiting for the next poll. Errors surface inline on the row itself.
  const handleCancel = useCallback(
    async (deliveryId: string) => {
      if (!repoFullName || !prNumber) return;
      try {
        await cancelPrReview(repoFullName, prNumber, deliveryId);
      } finally {
        refresh();
        refreshInflight();
      }
    },
    [repoFullName, prNumber, refresh, refreshInflight],
  );

  // Cancel a review from the cross-PR active list, which carries its own PR
  // number (it may belong to a PR other than the active branch's). Refresh both
  // surfaces so the row clears from the active list and, if it's also the
  // current PR, flips to "Cancelled" in the history below.
  const handleCancelInflight = useCallback(
    async (cancelPr: number, deliveryId: string) => {
      if (!repoFullName) return;
      try {
        await cancelPrReview(repoFullName, cancelPr, deliveryId);
      } finally {
        refreshInflight();
        refresh();
      }
    },
    [repoFullName, refresh, refreshInflight],
  );

  // Render whenever there's a repo — the global on/off toggle plus the per-PR
  // history. (Previously returned null with no open PR or no reviews, so the
  // surface vanished after merge — the visibility gap this fixes; now it shows
  // an explanatory empty state instead.)
  if (!repoFullName) return null;

  return (
    <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3.5 py-3`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="text-xs font-medium text-push-fg">Automated PR reviews</span>
          {prNumber != null && <span className="text-push-2xs text-push-fg-dim">#{prNumber}</span>}
        </span>
        <span className="flex items-center gap-2.5">
          {prNumber != null && (
            <button
              type="button"
              onClick={handleRerun}
              disabled={rerunning || enabled === false}
              title={enabled === false ? 'Reviewer is off' : 'Re-run review'}
              className="inline-flex items-center gap-1 text-push-2xs text-push-fg-dim hover:text-push-fg disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${rerunning ? 'animate-spin' : ''}`} />
              {rerunning ? 'Starting…' : 'Re-run'}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <label className="text-push-2xs text-push-fg-dim" htmlFor="pr-review-provider">
              Model
            </label>
            <select
              id="pr-review-provider"
              className="h-6 rounded border border-push-border/50 bg-push-bg text-push-2xs text-push-fg"
              value={provider ?? ''}
              disabled={saving || provider == null}
              onChange={(e) => {
                const nextProvider = e.target.value as PreferredProvider;
                const nextModel = getAutomatedReviewModels(nextProvider)[0];
                if (!nextModel) return;
                void setModelConfig(nextProvider, nextModel);
              }}
            >
              {provider && !selectedProvider && (
                <option value={provider}>Unavailable ({provider})</option>
              )}
              {providerOptions.map((p) => (
                <option key={p.type} value={p.type}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              id="pr-review-model"
              className="h-6 max-w-[12rem] rounded border border-push-border/50 bg-push-bg text-push-2xs text-push-fg"
              value={model ?? ''}
              disabled={saving || !selectedProvider}
              onChange={(e) => {
                if (!selectedProvider) return;
                void setModelConfig(selectedProvider.type, e.target.value);
              }}
            >
              {model && !selectedModel && <option value={model}>{model} (Unavailable)</option>}
              {selectedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {/* Global reviewer kill-switch — off means no webhook or manual run
              spends provider quota. */}
          <Switch
            checked={enabled ?? true}
            disabled={enabled === null || saving}
            onCheckedChange={(next) => void setEnabled(next)}
            aria-label="Automated PR reviews enabled"
          />
        </span>
      </div>
      {(rerunError || configError) && (
        <p className="mb-1.5 text-push-2xs text-red-400">
          {[rerunError, configError].filter(Boolean).join(' · ')}
        </p>
      )}
      {provider && model && !selectedModel && (
        <p className="mb-1.5 text-push-2xs text-amber-400">
          Configured model is not currently available and upcoming review runs will fail.
        </p>
      )}
      {enabled === false && (
        <p className="mb-1.5 text-push-2xs text-push-fg-dim">
          Reviewer is off — no automated reviews will run (saves provider quota).
        </p>
      )}
      {/* Cross-PR active reviews: every queued/running review for this repo,
          including ones on PRs other than the active branch's — so a runaway
          review is reachable to cancel without branch-hopping. Only shown when
          something is actually in flight. */}
      {otherPrInflight.length > 0 && (
        <div className="mb-2 rounded border border-sky-400/30 bg-sky-400/5 px-2.5 py-2">
          <p className="mb-1.5 flex items-center gap-1.5 text-push-2xs font-medium text-sky-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Active reviews ({otherPrInflight.length})
          </p>
          <div className="space-y-2">
            {otherPrInflight.map((review) => (
              <ReviewRow
                key={`${review.prNumber}:${review.deliveryId}`}
                review={review}
                showPrNumber
                onCancel={(deliveryId) => handleCancelInflight(review.prNumber, deliveryId)}
              />
            ))}
          </div>
        </div>
      )}
      {reviews.length > 0 ? (
        <div className="space-y-2">
          {reviews.map((review) => (
            <ReviewRow key={review.deliveryId} review={review} onCancel={handleCancel} />
          ))}
        </div>
      ) : (
        <p className="text-push-2xs text-push-fg-dim">
          {prNumber != null
            ? 'No reviews yet for this PR.'
            : 'Reviews run automatically when you open a pull request.'}
        </p>
      )}
    </div>
  );
}
