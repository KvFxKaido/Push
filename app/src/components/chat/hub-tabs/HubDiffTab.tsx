import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, Loader2, RefreshCw } from 'lucide-react';
import { DiffLine } from '@/components/cards/DiffPreviewCard';
import { parseDiffStats, parseDiffIntoFiles, type FileDiff } from '@/lib/diff-utils';
import { useWarmAction } from '@/hooks/useWarmAction';
import { nativeFsScopeFrom, resolveNativeFs, type NativeFsDiffResult } from '@/lib/native-fs';
import { sanitizeNativeDiff } from '@/lib/native-diff';
import { getSandboxDiff, type DiffResult } from '@/lib/sandbox-client';
import { HUB_MATERIAL_PILL_BUTTON_CLASS, HUB_TAG_CLASS } from '@/components/chat/hub-styles';
import type { DiffPreviewCardData } from '@/types';

const WORKSPACE_START_FAILED = 'Workspace could not start. Try again in a moment.';
const DIFF_READ_FAILED = "Couldn't read workspace changes.";

interface DiffJumpTarget {
  path: string;
  line?: number;
  requestKey: number;
}

interface HubDiffTabProps {
  /**
   * Warms the workspace and resolves its id. The tab takes no readiness props:
   * accept-warm-run (Wave 3) means it never branches on whether the runtime is
   * up, so `sandboxId` / `sandboxStatus` were removed rather than left as
   * unread surface a future caller might mistake for a gate.
   */
  ensureSandbox: () => Promise<string | null>;
  repoFullName?: string;
  currentBranch?: string;
  /** Externally-managed diff data (so the hub shell can trigger refreshes after commit). */
  diffData: DiffPreviewCardData | null;
  diffLoading: boolean;
  diffError: string | null;
  diffLabel: string;
  diffMode: 'working-tree' | 'review-github' | 'review-sandbox';
  jumpTarget: DiffJumpTarget | null;
  onClearReviewDiff?: () => void;
  onDiffUpdate: (data: DiffPreviewCardData | null, error: string | null) => void;
  onDiffLoadingChange: (loading: boolean) => void;
}

interface DiffRenderLine {
  key: string;
  text: string;
  newLine?: number;
}

interface ParsedFileDiff extends FileDiff {
  renderLines: DiffRenderLine[];
  lineKeyByNewLine: Map<number, string>;
}

function normalizeNativeDiff(result: NativeFsDiffResult): DiffResult {
  const sanitized = sanitizeNativeDiff(result);
  return {
    diff: sanitized.diff,
    truncated: sanitized.truncated,
    ...(sanitized.git_status !== undefined ? { git_status: sanitized.git_status } : {}),
    ...(sanitized.error !== undefined ? { error: sanitized.error } : {}),
  };
}

export function HubDiffTab({
  ensureSandbox,
  repoFullName,
  currentBranch,
  diffData,
  diffLoading,
  diffError,
  diffLabel,
  diffMode,
  jumpTarget,
  onClearReviewDiff,
  onDiffUpdate,
  onDiffLoadingChange,
}: HubDiffTabProps) {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [highlightedFile, setHighlightedFile] = useState<string | null>(null);
  const [highlightedLineKey, setHighlightedLineKey] = useState<string | null>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const diffLoadInFlightRef = useRef(false);
  const { warming: diffWarming, run: runWarmedDiff } = useWarmAction(ensureSandbox);
  const nativeFsScope = useMemo(
    () => nativeFsScopeFrom(repoFullName, currentBranch),
    [repoFullName, currentBranch],
  );
  const showingReviewDiff = diffMode !== 'working-tree';
  const jumpTargetPath = jumpTarget?.path ?? null;
  const jumpTargetLine = jumpTarget?.line;
  const jumpTargetRequestKey = jumpTarget?.requestKey ?? null;

  /**
   * The diff base. Branch is *mutable session state* that changes in place on a
   * warm switch, and the parent's `diffData` is unscoped, so without this the
   * previous branch's diff stays on screen (the load effect sees non-null data
   * and exits) and a read still in flight across the switch publishes the old
   * branch's diff into the new one.
   */
  const diffScopeKey = `${repoFullName ?? ''}::${currentBranch ?? ''}`;
  const diffScopeRef = useRef(diffScopeKey);

  useEffect(() => {
    if (diffScopeRef.current === diffScopeKey) return;
    diffScopeRef.current = diffScopeKey;
    // Any in-flight read now belongs to the previous base. Release BOTH the
    // reservation and the loading flag here: the stale read will decline to
    // touch them on completion (it no longer owns them), so if this effect
    // left `diffLoading` set, the load effect would never fire again and the
    // tab would spin forever on the new branch.
    diffLoadInFlightRef.current = false;
    onDiffLoadingChange(false);
    onDiffUpdate(null, null);
  }, [diffScopeKey, onDiffLoadingChange, onDiffUpdate]);

  const refreshDiff = useCallback(async () => {
    if (diffLoadInFlightRef.current || diffLoading) return;
    diffLoadInFlightRef.current = true;
    onDiffLoadingChange(true);
    const nativeFs = resolveNativeFs(nativeFsScope);
    let readStarted = nativeFs !== null;
    const readScope = diffScopeKey;
    /** Drop a completion whose base is no longer the active one. */
    const stale = () => diffScopeRef.current !== readScope;

    const applyDiff = (result: DiffResult) => {
      if (result.error) throw new Error(result.error);
      if (stale()) {
        console.log(
          JSON.stringify({ level: 'info', event: 'hub_diff_discarded_stale', scope: readScope }),
        );
        return;
      }
      const stats = parseDiffStats(result.diff);
      onDiffUpdate(
        {
          diff: result.diff,
          filesChanged: stats.filesChanged,
          additions: stats.additions,
          deletions: stats.deletions,
          truncated: result.truncated,
        },
        null,
      );
    };

    // The user-facing copy is deliberately generic (upstream detail never
    // reaches the UI), so the cause only survives in these logs. Three paired
    // branches, one per way a load can end without a diff.
    const surface = nativeFs ? 'native' : 'sandbox';
    try {
      if (nativeFs) {
        applyDiff(normalizeNativeDiff(await nativeFs.diff()));
      } else {
        await runWarmedDiff(
          async (workspaceId) => {
            readStarted = true;
            applyDiff(await getSandboxDiff(workspaceId));
          },
          () => {
            console.log(
              JSON.stringify({ level: 'warn', event: 'hub_diff_warm_unavailable', surface }),
            );
            if (!stale()) onDiffUpdate(null, WORKSPACE_START_FAILED);
          },
        );
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: readStarted ? 'hub_diff_read_failed' : 'hub_diff_warm_failed',
          surface,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      if (!stale()) onDiffUpdate(null, readStarted ? DIFF_READ_FAILED : WORKSPACE_START_FAILED);
    } finally {
      // A scope change already released the reservation for the new base; don't
      // clear it a second time and stomp a load that started after the switch.
      if (!stale()) {
        diffLoadInFlightRef.current = false;
        onDiffLoadingChange(false);
      }
    }
  }, [diffLoading, diffScopeKey, nativeFsScope, onDiffLoadingChange, onDiffUpdate, runWarmedDiff]);

  useEffect(() => {
    if (showingReviewDiff || diffData || diffError || diffLoading) return;
    void refreshDiff();
  }, [diffData, diffError, diffLoading, refreshDiff, showingReviewDiff]);

  const diffText = diffData?.diff ?? '';
  const fileDiffs: FileDiff[] = useMemo(
    () => (diffText ? parseDiffIntoFiles(diffText) : []),
    [diffText],
  );
  /** Diff text the file parser found nothing in — sanitizer notes, typically. */
  const unparsedDiffText = fileDiffs.length === 0 ? diffText.trim() : '';

  const parsedFileDiffs: ParsedFileDiff[] = useMemo(() => {
    return fileDiffs.map((fd) => {
      const renderLines: DiffRenderLine[] = [];
      const lineKeyByNewLine = new Map<number, string>();
      let newLine = 0;

      for (const [index, text] of fd.hunks.split('\n').entries()) {
        const key = `${fd.path}:${index}`;
        let resolvedNewLine: number | undefined;

        if (text.startsWith('@@')) {
          const match = text.match(/\+(\d+)/);
          if (match) newLine = parseInt(match[1], 10) - 1;
        } else if (
          text.startsWith('+++') ||
          text.startsWith('---') ||
          text.startsWith('diff ') ||
          text.startsWith('index ')
        ) {
          // Header lines are not part of the new-file line map.
        } else if (text.startsWith('+')) {
          newLine++;
          resolvedNewLine = newLine;
        } else if (text.startsWith('-') || text.startsWith('\\')) {
          // Removed lines and "\ No newline..." do not advance the new-file line map.
        } else {
          newLine++;
          resolvedNewLine = newLine;
        }

        if (resolvedNewLine !== undefined && !lineKeyByNewLine.has(resolvedNewLine)) {
          lineKeyByNewLine.set(resolvedNewLine, key);
        }

        renderLines.push({
          key,
          text,
          ...(resolvedNewLine !== undefined ? { newLine: resolvedNewLine } : {}),
        });
      }

      return { ...fd, renderLines, lineKeyByNewLine };
    });
  }, [fileDiffs]);

  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const scrollToFile = (path: string) => {
    const el = sectionRefs.current.get(path);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Ensure it's expanded
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  useEffect(() => {
    if (!jumpTargetPath) {
      const id = requestAnimationFrame(() => {
        setHighlightedFile(null);
        setHighlightedLineKey(null);
      });
      return () => cancelAnimationFrame(id);
    }

    const file = parsedFileDiffs.find((fd) => fd.path === jumpTargetPath);
    if (!file) return;

    let rafB: number | null = null;
    const rafA = requestAnimationFrame(() => {
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.delete(jumpTargetPath);
        return next;
      });
      rafB = requestAnimationFrame(() => {
        const lineKey =
          jumpTargetLine !== undefined ? (file.lineKeyByNewLine.get(jumpTargetLine) ?? null) : null;
        const targetEl = lineKey ? lineRefs.current.get(lineKey) : null;
        const fallbackEl = sectionRefs.current.get(jumpTargetPath) ?? null;
        (targetEl ?? fallbackEl)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedFile(jumpTargetPath);
        setHighlightedLineKey(lineKey);
      });
    });

    return () => {
      cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [jumpTargetPath, jumpTargetLine, jumpTargetRequestKey, parsedFileDiffs]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-push-edge px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-push-fg-dim">{diffLabel}</p>
          {showingReviewDiff && (
            <p className="text-push-2xs text-push-fg-dim">Reviewed diff snapshot</p>
          )}
        </div>
        {showingReviewDiff ? (
          <button
            onClick={onClearReviewDiff}
            disabled={!onClearReviewDiff}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
          >
            <CornerDownRight className="h-3.5 w-3.5" />
            <span>Live diff</span>
          </button>
        ) : (
          <button
            onClick={() => void refreshDiff()}
            disabled={diffLoading || diffWarming}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
          >
            {diffLoading || diffWarming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>Refresh</span>
          </button>
        )}
      </div>

      {/* File index pills */}
      {parsedFileDiffs.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-push-edge px-3 py-2 scrollbar-none">
          {parsedFileDiffs.map((fd) => {
            const filename = fd.path.split('/').pop() || fd.path;
            return (
              <button
                key={fd.path}
                onClick={() => scrollToFile(fd.path)}
                className={`${HUB_TAG_CLASS} gap-1 transition-colors hover:border-push-edge-hover hover:text-push-fg-secondary`}
                title={fd.path}
              >
                <span className="max-w-[100px] truncate">{filename}</span>
                {(fd.additions > 0 || fd.deletions > 0) && (
                  <span className="flex items-center gap-0.5">
                    {fd.additions > 0 && (
                      <span className="font-mono text-push-status-success">+{fd.additions}</span>
                    )}
                    {fd.deletions > 0 && (
                      <span className="font-mono text-push-status-error">-{fd.deletions}</span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!diffData && (diffLoading || diffWarming || (!showingReviewDiff && !diffError)) ? (
          <div className="flex items-center gap-2 p-3 text-xs text-push-fg-dim">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading diff...
          </div>
        ) : diffError ? (
          <p className="p-3 text-xs text-red-300">{diffError}</p>
        ) : parsedFileDiffs.length > 0 ? (
          <div>
            {parsedFileDiffs.map((fd) => {
              const isCollapsed = collapsedFiles.has(fd.path);
              const isHighlightedFile = highlightedFile === fd.path;
              return (
                <div
                  key={fd.path}
                  ref={(el) => {
                    if (el) sectionRefs.current.set(fd.path, el);
                    else sectionRefs.current.delete(fd.path);
                  }}
                >
                  {/* Sticky file header */}
                  <button
                    onClick={() => toggleFile(fd.path)}
                    className={`sticky top-0 z-10 flex w-full items-center gap-2 border-b border-push-edge px-3 py-2 text-left backdrop-blur-sm ${
                      isHighlightedFile ? 'bg-push-accent/10' : 'bg-push-surface-raised/95'
                    }`}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3 w-3 shrink-0 text-push-fg-dim" />
                    ) : (
                      <ChevronDown className="h-3 w-3 shrink-0 text-push-fg-dim" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-push-fg-secondary">
                      {fd.path}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-push-xs font-mono">
                      {fd.additions > 0 && (
                        <span className="text-push-status-success">+{fd.additions}</span>
                      )}
                      {fd.deletions > 0 && (
                        <span className="text-push-status-error">-{fd.deletions}</span>
                      )}
                    </span>
                  </button>
                  {/* Diff lines */}
                  {!isCollapsed && (
                    <div className="py-0.5">
                      {fd.renderLines.map((line, i) => (
                        <div
                          key={line.key}
                          ref={(el) => {
                            if (el) lineRefs.current.set(line.key, el);
                            else lineRefs.current.delete(line.key);
                          }}
                          className={
                            highlightedLineKey === line.key
                              ? 'rounded-md ring-1 ring-push-accent/50 bg-push-accent/5'
                              : ''
                          }
                        >
                          <DiffLine line={line.text} index={i} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {diffData?.truncated && (
              <div className="px-3 py-1.5 text-push-xs italic text-push-fg-dim border-t border-push-edge">
                Diff truncated
              </div>
            )}
          </div>
        ) : unparsedDiffText ? (
          // Diff text that parses to zero file blocks is still evidence of
          // change — the sanitizer replaces sensitive blocks with a bare note
          // (`[1 sensitive file diff hidden]`), and reporting that as a clean
          // tree is the same false claim this tab was fixed to stop making.
          <p className="whitespace-pre-wrap p-3 font-mono text-push-xs text-push-fg-dim">
            {unparsedDiffText}
          </p>
        ) : (
          <p className="p-3 text-xs text-push-fg-dim">No working tree changes.</p>
        )}
      </div>
    </>
  );
}
