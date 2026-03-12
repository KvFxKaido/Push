import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  MessageSquareText,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { DiffLine } from '@/components/cards/DiffPreviewCard';
import { parseDiffStats } from '@/lib/diff-utils';
import {
  fetchPullRequestDetail,
  fetchRepoPullRequests,
  type RepoPullRequestDetail,
  type RepoPullRequestListItem,
} from '@/lib/github-tools';
import { timeAgo } from '@/lib/utils';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_MATERIAL_ROUND_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { DiffPreviewCardData } from '@/types';

interface HubPRsTabProps {
  repoFullName?: string;
  activeBranch?: string;
  onOpenDiff: (payload: {
    diffData: DiffPreviewCardData;
    label: string;
    mode: 'review-github';
    target?: { path: string; line?: number };
  }) => void;
  onOpenReviewTab?: () => void;
}

type DetailSection = 'overview' | 'changes' | 'conversation';

function stateBadge(pr: RepoPullRequestListItem | RepoPullRequestDetail) {
  if (pr.state === 'merged') {
    return 'bg-violet-500/15 text-violet-300';
  }
  if (pr.state === 'closed') {
    return 'bg-red-500/15 text-red-300';
  }
  return 'bg-emerald-500/15 text-emerald-300';
}

function checksTone(overall: RepoPullRequestDetail['status']['checksOverall']) {
  switch (overall) {
    case 'success':
      return { label: 'Checks passing', className: 'bg-emerald-500/15 text-emerald-300', Icon: CheckCircle2 };
    case 'failure':
      return { label: 'Checks failing', className: 'bg-red-500/15 text-red-300', Icon: XCircle };
    case 'pending':
      return { label: 'Checks running', className: 'bg-amber-500/15 text-amber-300', Icon: Loader2 };
    case 'neutral':
      return { label: 'Checks neutral', className: 'bg-slate-500/15 text-slate-300', Icon: CircleSlash };
    case 'no-checks':
      return { label: 'No checks', className: 'bg-slate-500/15 text-slate-300', Icon: CircleSlash };
    default:
      return { label: 'Checks unknown', className: 'bg-slate-500/15 text-slate-300', Icon: CircleSlash };
  }
}

function mergeTone(detail: RepoPullRequestDetail) {
  if (detail.status.canMerge) {
    return { label: 'Ready to merge', className: 'bg-emerald-500/15 text-emerald-300', Icon: ShieldCheck };
  }
  if (detail.status.mergeable === false || detail.status.checksOverall === 'failure') {
    return { label: 'Blocked', className: 'bg-red-500/15 text-red-300', Icon: ShieldAlert };
  }
  if (detail.status.mergeable === null || detail.status.checksOverall === 'pending') {
    return { label: 'In progress', className: 'bg-amber-500/15 text-amber-300', Icon: Loader2 };
  }
  return { label: 'Needs attention', className: 'bg-slate-500/15 text-slate-300', Icon: ShieldAlert };
}

function reviewStateBadge(state: RepoPullRequestDetail['reviews'][number]['state']) {
  switch (state) {
    case 'approved':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'changes_requested':
      return 'bg-red-500/15 text-red-300';
    case 'dismissed':
      return 'bg-slate-500/15 text-slate-300';
    case 'pending':
      return 'bg-amber-500/15 text-amber-300';
    default:
      return 'bg-sky-500/15 text-sky-300';
  }
}

export function HubPRsTab({
  repoFullName,
  activeBranch,
  onOpenDiff,
  onOpenReviewTab,
}: HubPRsTabProps) {
  const [prs, setPrs] = useState<RepoPullRequestListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<RepoPullRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadNonce, setDetailReloadNonce] = useState(0);
  const [detailSection, setDetailSection] = useState<DetailSection>('overview');
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const refreshList = useCallback(async () => {
    if (!repoFullName) {
      setPrs([]);
      setListError(null);
      setSelectedPrNumber(null);
      return;
    }

    setListLoading(true);
    setListError(null);
    try {
      const nextPrs = await fetchRepoPullRequests(repoFullName, 'open');
      setPrs(nextPrs);
      setSelectedPrNumber((prev) => {
        if (prev && nextPrs.some((pr) => pr.number === prev)) return prev;
        if (activeBranch) {
          const activePr = nextPrs.find((pr) => pr.headRef === activeBranch);
          if (activePr) return activePr.number;
        }
        return null;
      });
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load pull requests.');
      setPrs([]);
      setSelectedPrNumber(null);
    } finally {
      setListLoading(false);
    }
  }, [activeBranch, repoFullName]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setExpandedFiles(new Set());
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!repoFullName || !selectedPrNumber) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    const repo = repoFullName;
    const prNumber = selectedPrNumber;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetailSection('overview');

    async function loadDetail() {
      try {
        const nextDetail = await fetchPullRequestDetail(repo, prNumber);
        if (cancelled) return;
        setDetail(nextDetail);
        setExpandedFiles(new Set(nextDetail.files.length > 0 ? [nextDetail.files[0].filename] : []));
      } catch (err) {
        if (cancelled) return;
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : 'Failed to load pull request.');
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [detailReloadNonce, repoFullName, selectedPrNumber]);

  const selectedListItem = useMemo(
    () => prs.find((pr) => pr.number === selectedPrNumber) ?? null,
    [prs, selectedPrNumber],
  );

  const handleOpenDiff = useCallback(() => {
    if (!detail?.diff) return;
    const stats = parseDiffStats(detail.diff);
    onOpenDiff({
      diffData: {
        diff: detail.diff,
        filesChanged: stats.filesChanged,
        additions: stats.additions,
        deletions: stats.deletions,
        truncated: false,
      },
      label: `PR #${detail.number}`,
      mode: 'review-github',
    });
  }, [detail, onOpenDiff]);

  const toggleFile = useCallback((filename: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  if (!repoFullName) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="text-sm text-push-fg-secondary">Select a repo to browse pull requests.</p>
      </div>
    );
  }

  if (!selectedPrNumber) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-push-edge px-3 py-2">
          <div>
            <p className="text-xs text-push-fg-dim">Pull requests</p>
            <p className="text-push-2xs text-push-fg-dim">{repoFullName}</p>
          </div>
          <button
            onClick={() => void refreshList()}
            disabled={listLoading}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
          >
            <HubControlGlow />
            {listLoading ? (
              <Loader2 className="relative z-10 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="relative z-10 h-3.5 w-3.5" />
            )}
            <span className="relative z-10">Refresh</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listLoading && prs.length === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-push-fg-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading pull requests...
            </div>
          ) : listError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
              <p className="text-xs text-red-300">{listError}</p>
              <button
                onClick={() => void refreshList()}
                className="text-xs text-push-link hover:underline"
              >
                Retry
              </button>
            </div>
          ) : prs.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="text-sm text-push-fg-secondary">No open pull requests in this repo.</p>
            </div>
          ) : (
            <ul className="divide-y divide-push-edge">
              {prs.map((pr) => {
                const commentCount = pr.comments + pr.reviewComments;
                const isActiveBranchPr = activeBranch && pr.headRef === activeBranch;
                return (
                  <li key={pr.number}>
                    <button
                      onClick={() => setSelectedPrNumber(pr.number)}
                      className="w-full px-3 py-3 text-left hover:bg-push-surface-hover"
                    >
                      <div className="flex items-start gap-2">
                        <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-push-accent" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="line-clamp-2 text-sm font-medium leading-tight text-push-fg">
                              {pr.title}
                            </p>
                            {pr.isDraft && (
                              <span className={HUB_TAG_CLASS}>
                                Draft
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-push-xs text-push-fg-dim">
                            <span>#{pr.number}</span>
                            <span>{timeAgo(pr.updatedAt || pr.createdAt)}</span>
                            {isActiveBranchPr && (
                              <span className={HUB_TAG_CLASS}>
                                active branch
                              </span>
                            )}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-push-xs text-push-fg-dim">
                            <span className={`${HUB_TAG_CLASS} ${stateBadge(pr)}`}>
                              {pr.state}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <GitBranch className="h-3 w-3" />
                              {pr.headRef} → {pr.baseRef}
                            </span>
                            {(pr.additions > 0 || pr.deletions > 0) && (
                              <span className="font-mono">
                                <span className="text-push-status-success">+{pr.additions}</span>{' '}
                                <span className="text-push-status-error">-{pr.deletions}</span>
                              </span>
                            )}
                            {commentCount > 0 && (
                              <span className="inline-flex items-center gap-1">
                                <MessageSquareText className="h-3 w-3" />
                                {commentCount}
                              </span>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-push-fg-dim" />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    );
  }

  const currentDetail = detail ?? selectedListItem;
  const commentCount = currentDetail ? currentDetail.comments + currentDetail.reviewComments : 0;
  const canUseReviewTab = Boolean(detail && activeBranch && detail.headRef === activeBranch && onOpenReviewTab);
  const checksSummary = detail ? checksTone(detail.status.checksOverall) : null;
  const mergeSummary = detail ? mergeTone(detail) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-push-edge px-3 py-2">
        <button
          onClick={() => {
            setSelectedPrNumber(null);
            setDetail(null);
            setDetailError(null);
          }}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
        >
          <HubControlGlow />
          <ArrowLeft className="relative z-10 h-3.5 w-3.5" />
          <span className="relative z-10">All PRs</span>
        </button>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              void refreshList();
              if (selectedPrNumber) setDetailReloadNonce((value) => value + 1);
            }}
            disabled={listLoading || detailLoading}
            className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
            aria-label="Refresh pull requests"
          >
            <HubControlGlow />
            {listLoading || detailLoading ? (
              <Loader2 className="relative z-10 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="relative z-10 h-3.5 w-3.5" />
            )}
          </button>
          {detail?.url && (
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
              aria-label="Open pull request on GitHub"
            >
              <HubControlGlow />
              <ExternalLink className="relative z-10 h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detailLoading && !detail ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-push-fg-dim">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading pull request...
          </div>
        ) : detailError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
              <p className="text-xs text-red-300">{detailError}</p>
              <button
                onClick={() => setDetailReloadNonce((value) => value + 1)}
                className="text-xs text-push-link hover:underline"
              >
                Retry
            </button>
          </div>
        ) : detail ? (
          <div className="space-y-4 p-3">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${HUB_TAG_CLASS} text-push-xs font-medium ${stateBadge(detail)}`}>
                  {detail.state}
                </span>
                {detail.isDraft && (
                  <span className={HUB_TAG_CLASS}>
                    Draft
                  </span>
                )}
                <span className="text-push-xs text-push-fg-dim">#{detail.number}</span>
              </div>

              <h3 className="text-base font-semibold leading-tight text-push-fg">
                {detail.title}
              </h3>

              <div className="flex flex-wrap items-center gap-2 text-push-xs text-push-fg-dim">
                <span>{detail.author}</span>
                <span>opened {timeAgo(detail.createdAt)}</span>
                <span className={`${HUB_TAG_CLASS} gap-1`}>
                  <GitBranch className="h-3 w-3" />
                  {detail.headRef} → {detail.baseRef}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-2`}>
                <p className="text-push-2xs uppercase tracking-wide text-push-fg-dim">Changes</p>
                <p className="mt-1 text-sm font-medium text-push-fg">{detail.changedFiles} files</p>
                <p className="text-push-xs font-mono">
                  <span className="text-push-status-success">+{detail.additions}</span>{' '}
                  <span className="text-push-status-error">-{detail.deletions}</span>
                </p>
              </div>
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-2`}>
                <p className="text-push-2xs uppercase tracking-wide text-push-fg-dim">Commits</p>
                <p className="mt-1 text-sm font-medium text-push-fg">{detail.commits.length}</p>
              </div>
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-2`}>
                <p className="text-push-2xs uppercase tracking-wide text-push-fg-dim">Discussion</p>
                <p className="mt-1 text-sm font-medium text-push-fg">{commentCount}</p>
              </div>
            </div>

            {detail && checksSummary && mergeSummary && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                  <div className="flex items-center gap-2">
                    <mergeSummary.Icon className={`h-4 w-4 ${mergeSummary.Icon === Loader2 ? 'animate-spin' : ''}`} />
                    <p className={`rounded-full px-2 py-0.5 text-push-xs font-medium ${mergeSummary.className}`}>
                      {mergeSummary.label}
                    </p>
                  </div>
                  <p className="mt-2 text-push-sm text-push-fg-secondary">
                    Mergeable:{' '}
                    <span className="text-push-fg">
                      {detail.status.mergeable === null ? 'computing' : detail.status.mergeable ? 'yes' : 'no'}
                    </span>
                  </p>
                  <p className="text-push-xs text-push-fg-dim">
                    State: {detail.status.mergeableState}
                  </p>
                </div>

                <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                  <div className="flex items-center gap-2">
                    <checksSummary.Icon className={`h-4 w-4 ${checksSummary.Icon === Loader2 ? 'animate-spin' : ''}`} />
                    <p className={`rounded-full px-2 py-0.5 text-push-xs font-medium ${checksSummary.className}`}>
                      {checksSummary.label}
                    </p>
                  </div>
                  <p className="mt-2 text-push-sm text-push-fg-secondary">
                    {detail.status.checks.length} check{detail.status.checks.length !== 1 ? 's' : ''}
                  </p>
                  {(detail.status.requestedReviewers.length > 0 || detail.status.requestedTeams.length > 0) && (
                    <p className="mt-1 text-push-xs text-push-fg-dim">
                      Review requested from{' '}
                      {[...detail.status.requestedReviewers, ...detail.status.requestedTeams].join(', ')}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleOpenDiff}
                disabled={!detail.diff}
                className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-push-fg-secondary`}
              >
                <HubControlGlow />
                <FileDiff className="relative z-10 h-3.5 w-3.5" />
                <span className="relative z-10">Open in Diff</span>
              </button>
              {canUseReviewTab && (
                <button
                  onClick={onOpenReviewTab}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-push-fg-secondary`}
                >
                  <HubControlGlow />
                  <GitPullRequest className="relative z-10 h-3.5 w-3.5" />
                  <span className="relative z-10">Review in Push</span>
                </button>
              )}
            </div>

            {activeBranch && detail.headRef !== activeBranch && (
              <p className={`px-3 py-2 text-push-xs text-push-fg-dim ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
                This PR targets <span className="text-push-fg-secondary">{detail.headRef}</span>. Switch to that branch if you want sandbox-backed fixes or branch-scoped review tools.
              </p>
            )}

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setDetailSection('overview')}
                className={`rounded-full border px-2.5 py-1 text-push-xs font-medium transition-colors ${
                  detailSection === 'overview'
                    ? `${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-push-edge-hover text-push-fg`
                    : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                }`}
              >
                Overview
              </button>
              <button
                onClick={() => setDetailSection('changes')}
                className={`rounded-full border px-2.5 py-1 text-push-xs font-medium transition-colors ${
                  detailSection === 'changes'
                    ? `${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-push-edge-hover text-push-fg`
                    : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                }`}
              >
                Changes
              </button>
              <button
                onClick={() => setDetailSection('conversation')}
                className={`rounded-full border px-2.5 py-1 text-push-xs font-medium transition-colors ${
                  detailSection === 'conversation'
                    ? `${HUB_PANEL_SUBTLE_SURFACE_CLASS} border-push-edge-hover text-push-fg`
                    : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                }`}
              >
                Conversation
              </button>
            </div>

            {detailSection === 'overview' ? (
              <div className="space-y-3">
                <section className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                  <p className="mb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">Description</p>
                  {detail.body ? (
                    <p className="whitespace-pre-wrap text-push-base leading-relaxed text-push-fg-secondary">
                      {detail.body}
                    </p>
                  ) : (
                    <p className="text-xs text-push-fg-dim">No description provided.</p>
                  )}
                </section>

                {detail.commits.length > 0 && (
                  <section className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                    <p className="mb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">Recent commits</p>
                    <div className="space-y-2">
                      {detail.commits.slice(0, 6).map((commit) => (
                        <div key={commit.sha} className="flex items-start gap-2">
                          <GitCommit className="mt-0.5 h-3.5 w-3.5 shrink-0 text-push-fg-dim" />
                          <div className="min-w-0">
                            <p className="truncate text-push-sm text-push-fg-secondary">{commit.message || commit.sha}</p>
                            <p className="text-push-2xs text-push-fg-dim">
                              <span className="font-mono">{commit.sha}</span> · {commit.author}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                  <p className="mb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">Files</p>
                  <div className="space-y-1.5">
                    {detail.files.map((file) => (
                      <div key={file.filename} className="flex items-center justify-between gap-2 border-b border-push-edge/70 px-1 py-2 last:border-b-0">
                        <p className="min-w-0 truncate text-push-sm text-push-fg-secondary">{file.filename}</p>
                        <span className="shrink-0 text-push-xs font-mono">
                          <span className="text-push-status-success">+{file.additions}</span>{' '}
                          <span className="text-push-status-error">-{file.deletions}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            ) : detailSection === 'changes' ? (
              <div className={`overflow-hidden ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
                {detail.files.map((file) => {
                  const expanded = expandedFiles.has(file.filename);
                  return (
                    <div key={file.filename} className="border-b border-push-edge last:border-b-0">
                      <button
                        onClick={() => toggleFile(file.filename)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-push-surface-hover"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-push-fg-dim" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-push-fg-dim" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-push-sm text-push-fg-secondary">{file.filename}</p>
                          <p className="text-push-2xs text-push-fg-dim">{file.status}</p>
                        </div>
                        <span className="shrink-0 text-push-xs font-mono">
                          <span className="text-push-status-success">+{file.additions}</span>{' '}
                          <span className="text-push-status-error">-{file.deletions}</span>
                        </span>
                      </button>

                      {expanded && (
                        <div className="border-t border-push-edge bg-black/10 px-1 py-1">
                          {file.patch ? (
                            file.patch.split('\n').map((line, index) => (
                              <DiffLine key={`${file.filename}:${index}`} line={line} index={index} />
                            ))
                          ) : (
                            <p className="px-3 py-2 text-push-xs text-push-fg-dim">
                              Patch preview unavailable for this file.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3">
                {detail.reviews.length > 0 && (
                  <section className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                    <p className="mb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">Reviews</p>
                    <div className="space-y-2">
                      {detail.reviews.map((review) => (
                        <div key={review.id} className="border-b border-push-edge/70 px-1 py-2.5 last:border-b-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-push-sm font-medium text-push-fg-secondary">{review.author}</span>
                            <span className={`${HUB_TAG_CLASS} text-push-2xs font-medium ${reviewStateBadge(review.state)}`}>
                              {review.state.replace('_', ' ')}
                            </span>
                            <span className="text-push-2xs text-push-fg-dim">
                              {review.submittedAt ? timeAgo(review.submittedAt) : 'now'}
                            </span>
                          </div>
                          {review.body && (
                            <p className="mt-1.5 whitespace-pre-wrap text-push-sm leading-relaxed text-push-fg-secondary">
                              {review.body}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {detail.issueComments.length > 0 && (
                  <section className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                    <p className="mb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">Comments</p>
                    <div className="space-y-2">
                      {detail.issueComments.map((comment) => (
                        <div key={comment.id} className="border-b border-push-edge/70 px-1 py-2.5 last:border-b-0">
                          <div className="flex items-center gap-2">
                            <span className="text-push-sm font-medium text-push-fg-secondary">{comment.author}</span>
                            <span className="text-push-2xs text-push-fg-dim">{timeAgo(comment.createdAt)}</span>
                          </div>
                          <p className="mt-1.5 whitespace-pre-wrap text-push-sm leading-relaxed text-push-fg-secondary">
                            {comment.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {detail.reviewThreads.length > 0 && (
                  <section className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} p-3`}>
                    <p className="mb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">Review threads</p>
                    <div className="space-y-2">
                      {detail.reviewThreads.map((thread) => (
                        <div key={thread.id} className="border-b border-push-edge/70 px-1 py-2.5 last:border-b-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`${HUB_TAG_CLASS} gap-1 text-push-2xs`}>
                              <GitBranch className="h-3 w-3" />
                              {thread.file}
                              {typeof thread.line === 'number' ? ` · L${thread.line}` : ''}
                            </span>
                            <span className="text-push-2xs text-push-fg-dim">
                              {thread.comments.length} comment{thread.comments.length !== 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="mt-2 space-y-2">
                            {thread.comments.map((comment) => (
                              <div key={comment.id} className="border-l border-push-edge pl-3">
                                <div className="flex items-center gap-2">
                                  <span className="text-push-sm font-medium text-push-fg-secondary">{comment.author}</span>
                                  <span className="text-push-2xs text-push-fg-dim">{timeAgo(comment.createdAt)}</span>
                                  {typeof comment.line === 'number' && (
                                    <span className={HUB_TAG_CLASS}>
                                      L{comment.line}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 whitespace-pre-wrap text-push-sm leading-relaxed text-push-fg-secondary">
                                  {comment.body}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {detail.reviews.length === 0 && detail.issueComments.length === 0 && detail.reviewThreads.length === 0 && (
                  <div className={`border border-dashed border-push-edge px-3 py-4 text-center text-xs text-push-fg-dim ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
                    No review conversation yet.
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
