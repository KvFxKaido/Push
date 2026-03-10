import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, ExternalLink, FileDiff, Info, Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runReviewer } from '@/lib/reviewer-agent';
import { executePostPRReview, fetchGitHubReviewDiff, fetchLatestCommitDiff } from '@/lib/github-tools';
import { parseDiffStats } from '@/lib/diff-utils';
import type { ActiveProvider } from '@/lib/orchestrator';
import type { PreferredProvider } from '@/lib/providers';
import type { DiffPreviewCardData, ReviewResult, ReviewComment } from '@/types';

interface HubReviewTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
  availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  activeProvider: ActiveProvider;
  providerModels: Record<PreferredProvider, string>;
  /** owner/name — undefined in Sandbox Mode or when no repo is selected */
  repoFullName?: string;
  /** active branch name — used to find an open PR */
  activeBranch?: string;
  /** default branch name — used for GitHub branch-vs-default review */
  defaultBranch?: string;
  onOpenDiff: (payload: {
    diffData: DiffPreviewCardData;
    label: string;
    mode: 'review-github' | 'review-sandbox';
    target: { path: string; line?: number };
  }) => void;
}

type ReviewSourceMode = 'github' | 'commit' | 'sandbox';

type ReviewContext =
  | {
      kind: 'github-pr';
      label: string;
      pr: { number: number; title: string; commitSha: string; url: string };
    }
  | {
      kind: 'github-branch';
      label: string;
    }
  | {
      kind: 'github-commit';
      label: string;
      shortSha: string;
      url: string;
    }
  | {
      kind: 'sandbox';
      label: string;
    };

function severityIcon(severity: ReviewComment['severity']) {
  switch (severity) {
    case 'critical': return <AlertTriangle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />;
    case 'warning':  return <AlertTriangle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />;
    case 'suggestion': return <Sparkles className="h-3.5 w-3.5 text-sky-400 flex-shrink-0 mt-0.5" />;
    case 'note':     return <Info className="h-3.5 w-3.5 text-[#5f6b80] flex-shrink-0 mt-0.5" />;
  }
}

function severityLabel(severity: ReviewComment['severity']) {
  switch (severity) {
    case 'critical':   return <span className="text-[10px] font-medium uppercase tracking-wide text-red-400">Critical</span>;
    case 'warning':    return <span className="text-[10px] font-medium uppercase tracking-wide text-amber-400">Warning</span>;
    case 'suggestion': return <span className="text-[10px] font-medium uppercase tracking-wide text-sky-400">Suggestion</span>;
    case 'note':       return <span className="text-[10px] font-medium uppercase tracking-wide text-[#5f6b80]">Note</span>;
  }
}

function groupByFile(comments: ReviewComment[]): Map<string, ReviewComment[]> {
  const map = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const group = map.get(c.file) ?? [];
    group.push(c);
    map.set(c.file, group);
  }
  return map;
}

function severityOrder(s: ReviewComment['severity']): number {
  return { critical: 0, warning: 1, suggestion: 2, note: 3 }[s];
}

export function HubReviewTab({
  sandboxId,
  sandboxStatus,
  ensureSandbox,
  availableProviders,
  activeProvider,
  providerModels,
  repoFullName,
  activeBranch,
  defaultBranch,
  onOpenDiff,
}: HubReviewTabProps) {
  const providerOptions = useMemo(
    () => availableProviders.map(([type, label]) => ({ type, label })),
    [availableProviders],
  );
  // Branch diff requires a feature branch — on the default branch there's nothing
  // to compare against and fetchGitHubReviewDiff explicitly rejects it.
  // Open PRs with the default branch as head are essentially impossible in practice.
  const hasGitHubSource = Boolean(repoFullName && activeBranch && defaultBranch && activeBranch !== defaultBranch);
  const hasCommitSource = Boolean(repoFullName && activeBranch);
  const [selectedProvider, setSelectedProvider] = useState<PreferredProvider | null>(null);
  const [reviewSource, setReviewSource] = useState<ReviewSourceMode>(hasGitHubSource ? 'github' : hasCommitSource ? 'commit' : 'sandbox');
  const [modelOverride, setModelOverride] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [reviewContext, setReviewContext] = useState<ReviewContext | null>(null);
  const [reviewDiffData, setReviewDiffData] = useState<DiffPreviewCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [postState, setPostState] = useState<'idle' | 'posting' | 'posted' | 'error'>('idle');
  const [postError, setPostError] = useState<string | null>(null);

  useEffect(() => {
    const nextSelected =
      selectedProvider && providerOptions.some((provider) => provider.type === selectedProvider)
        ? selectedProvider
        : activeProvider !== 'demo' && providerOptions.some((provider) => provider.type === activeProvider)
          ? activeProvider
          : providerOptions[0]?.type ?? null;

    if (nextSelected !== selectedProvider) {
      setSelectedProvider(nextSelected);
      setModelOverride('');
    }

    if (providerOptions.length === 0) {
      setResult(null);
      setReviewDiffData(null);
      setError(null);
    }
  }, [activeProvider, providerOptions, selectedProvider]);

  useEffect(() => {
    const needsReset =
      (reviewSource === 'github' && !hasGitHubSource) ||
      (reviewSource === 'commit' && !hasCommitSource);
    if (needsReset) {
      setReviewSource('sandbox');
      setResult(null);
      setReviewContext(null);
      setReviewDiffData(null);
      setError(null);
      setPostState('idle');
      setPostError(null);
    }
  }, [hasCommitSource, hasGitHubSource, reviewSource]);

  const handleProviderChange = useCallback((p: PreferredProvider) => {
    setSelectedProvider(p);
    setModelOverride('');
  }, []);

  const handleSourceChange = useCallback((source: ReviewSourceMode) => {
    setReviewSource(source);
    setResult(null);
    setReviewContext(null);
    setReviewDiffData(null);
    setError(null);
    setStatus(null);
    setExpandedFiles(new Set());
    setPostState('idle');
    setPostError(null);
  }, []);

  const toggleFile = useCallback((file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) { next.delete(file); } else { next.add(file); }
      return next;
    });
  }, []);

  const handlePostToPR = useCallback(async () => {
    if (!result || !repoFullName || reviewContext?.kind !== 'github-pr') return;
    setPostState('posting');
    setPostError(null);
    try {
      await executePostPRReview(repoFullName, reviewContext.pr.number, reviewContext.pr.commitSha, result);
      setPostState('posted');
    } catch (err) {
      setPostState('error');
      setPostError(err instanceof Error ? err.message : 'Failed to post review.');
    }
  }, [result, repoFullName, reviewContext]);

  const handleOpenCommentInDiff = useCallback((file: string, line?: number) => {
    if (!reviewDiffData || !reviewContext) return;
    onOpenDiff({
      diffData: reviewDiffData,
      label: reviewContext.kind === 'sandbox' ? 'Working tree review snapshot' : reviewContext.label,
      mode: reviewContext.kind === 'sandbox' ? 'review-sandbox' : 'review-github',
      target: { path: file, ...(line !== undefined ? { line } : {}) },
    });
  }, [onOpenDiff, reviewContext, reviewDiffData]);

  const handleRunReview = useCallback(async () => {
    if (running || !selectedProvider) return;

    setRunning(true);
    setError(null);
    setResult(null);
    setReviewContext(null);
    setReviewDiffData(null);
    setStatus(null);
    setExpandedFiles(new Set());
    setPostState('idle');
    setPostError(null);

    try {
      let diff = '';
      let nextContext: ReviewContext | null = null;

      if (reviewSource === 'github') {
        if (!repoFullName || !activeBranch || !defaultBranch) {
          setError('GitHub review is not available for this workspace.');
          return;
        }
        setStatus('Resolving branch / PR diff…');
        const githubDiff = await fetchGitHubReviewDiff(repoFullName, activeBranch, defaultBranch);
        diff = githubDiff.diff;
        nextContext = githubDiff.source === 'pr' && githubDiff.pr
          ? { kind: 'github-pr', label: githubDiff.label, pr: githubDiff.pr }
          : { kind: 'github-branch', label: githubDiff.label };
      } else if (reviewSource === 'commit') {
        if (!repoFullName || !activeBranch) {
          setError('Commit review is not available for this workspace.');
          return;
        }
        setStatus('Fetching latest commit diff…');
        const commitDiff = await fetchLatestCommitDiff(repoFullName, activeBranch);
        diff = commitDiff.diff;
        nextContext = {
          kind: 'github-commit',
          label: `${commitDiff.shortSha} ${commitDiff.message}`,
          shortSha: commitDiff.shortSha,
          url: commitDiff.url,
        };
      } else {
        let id = sandboxId;
        if (!id) {
          setStatus('Starting sandbox…');
          id = await ensureSandbox();
        }
        if (!id) {
          setError('Sandbox is not available. Start it first.');
          return;
        }

        setStatus('Fetching working tree diff…');
        const diffResult = await getSandboxDiff(id);
        diff = diffResult.diff;
        nextContext = { kind: 'sandbox', label: 'Working tree' };
      }

      if (!diff?.trim()) {
        setError(
          reviewSource === 'github'
            ? 'No GitHub changes to review. Push your branch or open a PR first.'
            : 'No working tree changes to review. Make some edits first.',
        );
        return;
      }

      const reviewResult = await runReviewer(
        diff,
        { provider: selectedProvider, model: modelOverride.trim() || undefined },
        (phase) => setStatus(phase),
      );
      const stats = parseDiffStats(diff);

      setResult(reviewResult);
      setReviewContext(nextContext);
      setReviewDiffData({
        diff,
        filesChanged: stats.filesChanged,
        additions: stats.additions,
        deletions: stats.deletions,
        truncated: false,
      });
      // Expand critical and warning files by default
      const autoExpand = new Set<string>();
      for (const c of reviewResult.comments) {
        if (c.severity === 'critical' || c.severity === 'warning') {
          autoExpand.add(c.file);
        }
      }
      setExpandedFiles(autoExpand);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      setRunning(false);
      setStatus(null);
    }
  }, [
    activeBranch,
    defaultBranch,
    ensureSandbox,
    modelOverride,
    repoFullName,
    reviewSource,
    running,
    sandboxId,
    selectedProvider,
  ]);

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);
  const selectedDefaultModel = selectedProvider ? providerModels[selectedProvider] : '';
  const canRunReview =
    !running &&
    Boolean(selectedProvider) &&
    (
      reviewSource === 'github' ? hasGitHubSource :
      reviewSource === 'commit' ? hasCommitSource :
      (sandboxReady || sandboxStatus === 'idle')
    );
  const showSandboxPostingHint = reviewContext?.kind === 'sandbox' && hasGitHubSource;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Controls */}
      <div className="flex-shrink-0 border-b border-push-edge px-3 py-3 space-y-2.5">
        {providerOptions.length === 0 ? (
          <p className="text-[11px] text-push-fg-dim">
            No AI provider configured. Add an API key in Settings to use the Reviewer.
          </p>
        ) : (
          <>
            {(hasGitHubSource || hasCommitSource || reviewSource === 'sandbox') && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {hasGitHubSource && (
                    <button
                      onClick={() => handleSourceChange('github')}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        reviewSource === 'github'
                          ? 'border-push-accent/40 bg-push-accent/10 text-push-accent'
                          : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                      }`}
                    >
                      Branch diff
                    </button>
                  )}
                  {hasCommitSource && (
                    <button
                      onClick={() => handleSourceChange('commit')}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        reviewSource === 'commit'
                          ? 'border-push-accent/40 bg-push-accent/10 text-push-accent'
                          : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                      }`}
                    >
                      Last commit
                    </button>
                  )}
                  <button
                    onClick={() => handleSourceChange('sandbox')}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      reviewSource === 'sandbox'
                        ? 'border-push-accent/40 bg-push-accent/10 text-push-accent'
                        : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                    }`}
                  >
                    Working tree
                  </button>
                </div>
                <p className="text-[10px] text-push-fg-dim">
                  {reviewSource === 'github'
                    ? 'Reviews the pushed PR or branch diff against the default branch.'
                    : reviewSource === 'commit'
                    ? 'Reviews the diff of the most recent commit — no sandbox needed.'
                    : 'Reviews uncommitted sandbox edits in the current working tree.'}
                </p>
              </div>
            )}

            {/* Provider pills — only configured providers */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {providerOptions.map(({ type, label }) => (
                <button
                  key={type}
                  onClick={() => handleProviderChange(type)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    selectedProvider === type
                      ? 'border-push-accent/40 bg-push-accent/10 text-push-accent'
                      : 'border-push-edge text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Model input */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={modelOverride}
                onChange={(e) => setModelOverride(e.target.value)}
                placeholder={selectedDefaultModel ? `Default: ${selectedDefaultModel}` : 'Model ID override'}
                className="min-w-0 flex-1 rounded-lg border border-push-edge bg-[#080d14] px-2.5 py-1.5 text-[11px] text-push-fg-secondary placeholder:text-push-fg-dim focus:border-push-accent/40 focus:outline-none"
              />
              <button
                onClick={() => void handleRunReview()}
                disabled={!canRunReview}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-push-accent/30 bg-push-accent/10 px-3 py-1.5 text-[11px] font-medium text-push-accent transition-colors hover:bg-push-accent/15 active:scale-95 disabled:opacity-50"
              >
                {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {running ? 'Reviewing…' : 'Run review'}
              </button>
            </div>
            {selectedDefaultModel && (
              <p className="text-[10px] text-push-fg-dim">
                Using provider default: <span className="text-push-fg-secondary">{selectedDefaultModel}</span>
                {modelOverride.trim() ? ' (override active)' : ''}
              </p>
            )}
          </>
        )}

        {/* Status line */}
        {running && status && (
          <p className="text-[11px] text-push-fg-dim">{status}</p>
        )}
        {error && (
          <p className="text-[11px] text-red-400">{error}</p>
        )}
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!result && !running && !error && (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-push-fg-dim">
              {reviewSource === 'github'
                ? 'Run a review to inspect the active branch or open PR from GitHub.'
                : reviewSource === 'commit'
                ? 'Run a review to inspect the most recent commit on this branch.'
                : 'Run a review to see feedback on your current working tree changes.'}
            </p>
          </div>
        )}

        {result && (
          <div className="px-3 py-3 space-y-3">
            {/* Summary */}
            <div className="rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-xs font-medium text-push-fg">
                    Review complete{reviewContext ? ` · ${reviewContext.label}` : ''}
                  </span>
                </div>
                <span className="text-[10px] text-push-fg-dim">
                  {result.truncated
                    ? `${result.filesReviewed} of ${result.totalFiles} files`
                    : `${result.filesReviewed} file${result.filesReviewed !== 1 ? 's' : ''}`
                  } · {result.model}
                </span>
              </div>
              {result.truncated && (
                <div className="flex items-center gap-1.5 mb-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5">
                  <AlertTriangle className="h-3 w-3 text-amber-400 flex-shrink-0" />
                  <p className="text-[10px] text-amber-400">
                    Diff too large — review covers {result.filesReviewed} of {result.totalFiles} files. Later files were not seen.
                  </p>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-push-fg-secondary">{result.summary}</p>
            </div>

            {/* Post to PR */}
            {reviewContext?.kind === 'github-pr' && postState !== 'posted' && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-[11px] text-push-fg-secondary truncate">
                    PR <a
                      href={reviewContext.pr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-push-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      #{reviewContext.pr.number} <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                    {' '}open
                  </span>
                  {postState === 'error' && postError && (
                    <span className="text-[10px] text-red-400 truncate">{postError}</span>
                  )}
                </div>
                <button
                  onClick={() => void handlePostToPR()}
                  disabled={postState === 'posting'}
                  className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-push-accent/30 bg-push-accent/10 px-2.5 py-1.5 text-[11px] font-medium text-push-accent transition-colors hover:bg-push-accent/15 active:scale-95 disabled:opacity-50"
                >
                  {postState === 'posting'
                    ? <><Loader2 className="h-3 w-3 animate-spin" /> Posting…</>
                    : <><Send className="h-3 w-3" /> Post to PR</>
                  }
                </button>
              </div>
            )}
            {postState === 'posted' && reviewContext?.kind === 'github-pr' && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3.5 py-2.5">
                <CheckCircle className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
                <span className="text-[11px] text-emerald-400">
                  Review posted to{' '}
                  <a
                    href={reviewContext.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline inline-flex items-center gap-0.5"
                  >
                    PR #{reviewContext.pr.number} <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                </span>
              </div>
            )}
            {showSandboxPostingHint && (
              <div className="rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-2.5">
                <p className="text-[11px] text-push-fg-dim">
                  Working tree reviews stay in Push. Switch to <span className="text-push-fg-secondary">GitHub diff</span> to review the pushed branch or post findings back to a PR.
                </p>
              </div>
            )}
            {reviewContext?.kind === 'github-branch' && (
              <div className="rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-2.5">
                <p className="text-[11px] text-push-fg-dim">
                  No open PR for this branch. This review covers the pushed branch diff against <span className="text-push-fg-secondary">{defaultBranch}</span>.
                </p>
              </div>
            )}
            {reviewContext?.kind === 'github-commit' && (
              <div className="flex items-center gap-2 rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-2.5">
                <span className="text-[11px] text-push-fg-dim">Commit</span>
                <a
                  href={reviewContext.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 font-mono text-[11px] text-push-accent hover:underline"
                >
                  {reviewContext.shortSha} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
            )}

            {/* No comments */}
            {result.comments.length === 0 && (
              <p className="text-center text-xs text-push-fg-dim py-4">No specific comments — looks clean.</p>
            )}

            {/* Comments grouped by file */}
            {result.comments.length > 0 && (
              <div className="space-y-2">
                {Array.from(groupByFile(result.comments)).map(([file, comments]) => {
                  const sorted = [...comments].sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
                  const expanded = expandedFiles.has(file);
                  const hasCritical = comments.some((c) => c.severity === 'critical');
                  const hasWarning = comments.some((c) => c.severity === 'warning');
                  const headerColor = hasCritical ? 'text-red-300' : hasWarning ? 'text-amber-300' : 'text-push-fg-secondary';

                  return (
                    <div key={file} className="rounded-xl border border-push-edge bg-push-grad-card overflow-hidden">
                      <button
                        onClick={() => toggleFile(file)}
                        className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 hover:bg-[#0d1119] transition-colors"
                      >
                        <span className={`min-w-0 flex-1 truncate text-left text-[11px] font-medium ${headerColor}`}>
                          {file}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[10px] text-push-fg-dim">{comments.length}</span>
                          {expanded
                            ? <ChevronDown className="h-3 w-3 text-push-fg-dim" />
                            : <ChevronRight className="h-3 w-3 text-push-fg-dim" />}
                        </div>
                      </button>

                      {expanded && (
                        <div className="border-t border-push-edge divide-y divide-push-edge">
                          {sorted.map((c, i) => (
                            <div key={i} className="flex items-start gap-2.5 px-3.5 py-2.5">
                              {severityIcon(c.severity)}
                              <div className="min-w-0 flex-1">
                                <div className="mb-0.5 flex items-center gap-2">
                                  {severityLabel(c.severity)}
                                  {typeof c.line === 'number' ? (
                                    <button
                                      onClick={() => handleOpenCommentInDiff(c.file, c.line)}
                                      className="rounded-full border border-push-accent/30 px-1.5 py-0.5 text-[10px] font-mono text-push-accent transition-colors hover:bg-push-accent/10"
                                      title={`Open ${c.file} at line ${c.line} in Diff`}
                                    >
                                      L{c.line}
                                    </button>
                                  ) : null}
                                </div>
                                <p className="text-[11px] leading-relaxed text-push-fg-secondary">{c.comment}</p>
                              </div>
                              <button
                                onClick={() => handleOpenCommentInDiff(c.file, c.line)}
                                className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-push-edge px-2 py-1 text-[10px] text-push-fg-dim transition-colors hover:border-push-edge-hover hover:text-push-fg-secondary"
                                title={`Open ${c.file}${typeof c.line === 'number' ? ` line ${c.line}` : ''} in Diff`}
                              >
                                <FileDiff className="h-3 w-3" />
                                Diff
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
