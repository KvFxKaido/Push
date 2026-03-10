import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, CornerDownRight, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { DiffLine } from '@/components/cards/DiffPreviewCard';
import { parseDiffStats, parseDiffIntoFiles, type FileDiff } from '@/lib/diff-utils';
import { getSandboxDiff } from '@/lib/sandbox-client';
import type { DiffPreviewCardData } from '@/types';

interface DiffJumpTarget {
  path: string;
  line?: number;
  requestKey: number;
}

interface HubDiffTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
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

export function HubDiffTab({
  sandboxId,
  sandboxStatus,
  ensureSandbox,
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
  const [startingSandbox, setStartingSandbox] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [highlightedFile, setHighlightedFile] = useState<string | null>(null);
  const [highlightedLineKey, setHighlightedLineKey] = useState<string | null>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lineRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);
  const showingReviewDiff = diffMode !== 'working-tree';

  const ensureHubSandbox = useCallback(async (): Promise<string | null> => {
    if (sandboxId) return sandboxId;
    setStartingSandbox(true);
    try {
      const id = await ensureSandbox();
      if (!id) toast.error('Sandbox is not ready yet.');
      return id;
    } finally {
      setStartingSandbox(false);
    }
  }, [sandboxId, ensureSandbox]);

  const refreshDiff = useCallback(async () => {
    const id = await ensureHubSandbox();
    if (!id) return;
    onDiffLoadingChange(true);
    try {
      const result = await getSandboxDiff(id);
      if (!result.diff) {
        onDiffUpdate(null, null);
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
    } catch (err) {
      onDiffUpdate(null, err instanceof Error ? err.message : 'Failed to load diff');
    } finally {
      onDiffLoadingChange(false);
    }
  }, [ensureHubSandbox, onDiffUpdate, onDiffLoadingChange]);

  const fileDiffs: FileDiff[] = useMemo(
    () => (diffData?.diff ? parseDiffIntoFiles(diffData.diff) : []),
    [diffData?.diff],
  );

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
    if (!jumpTarget) {
      setHighlightedFile(null);
      setHighlightedLineKey(null);
      return;
    }

    const file = parsedFileDiffs.find((fd) => fd.path === jumpTarget.path);
    if (!file) return;

    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      next.delete(jumpTarget.path);
      return next;
    });

    let rafB: number | null = null;
    const rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        const lineKey = jumpTarget.line !== undefined ? file.lineKeyByNewLine.get(jumpTarget.line) ?? null : null;
        const targetEl = lineKey ? lineRefs.current.get(lineKey) : null;
        const fallbackEl = sectionRefs.current.get(jumpTarget.path) ?? null;
        (targetEl ?? fallbackEl)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedFile(jumpTarget.path);
        setHighlightedLineKey(lineKey);
      });
    });

    return () => {
      cancelAnimationFrame(rafA);
      if (rafB !== null) cancelAnimationFrame(rafB);
    };
  }, [jumpTarget?.requestKey, jumpTarget?.path, jumpTarget?.line, parsedFileDiffs]);

  if (!diffData && !sandboxReady) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-push-fg-secondary">Start a sandbox to view diff.</p>
        <button
          onClick={() => {
            void ensureHubSandbox().then((id) => {
              if (id) void refreshDiff();
            });
          }}
          disabled={startingSandbox || sandboxStatus === 'creating'}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#1b2230] bg-push-grad-input px-3 text-xs text-push-fg-secondary shadow-[0_10px_24px_rgba(0,0,0,0.42),0_2px_8px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 disabled:opacity-50"
        >
          {(startingSandbox || sandboxStatus === 'creating') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {startingSandbox || sandboxStatus === 'creating' ? 'Starting sandbox...' : 'Start sandbox'}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-push-edge px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-xs text-push-fg-dim">{diffLabel}</p>
          {showingReviewDiff && (
            <p className="text-[10px] text-push-fg-dim">Reviewed diff snapshot</p>
          )}
        </div>
        {showingReviewDiff ? (
          <button
            onClick={onClearReviewDiff}
            disabled={!onClearReviewDiff}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2 text-[11px] text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-50"
          >
            <CornerDownRight className="h-3.5 w-3.5" />
            Live diff
          </button>
        ) : (
          <button
            onClick={() => void refreshDiff()}
            disabled={diffLoading}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2 text-[11px] text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-50"
          >
            {diffLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
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
                className="flex shrink-0 items-center gap-1 rounded-full border border-push-edge bg-[#080b10]/80 px-2 py-1 text-[10px] text-push-fg-dim transition-colors hover:border-push-edge-hover hover:text-push-fg-secondary"
                title={fd.path}
              >
                <span className="max-w-[100px] truncate">{filename}</span>
                {(fd.additions > 0 || fd.deletions > 0) && (
                  <span className="flex items-center gap-0.5">
                    {fd.additions > 0 && <span className="font-mono text-[#22c55e]">+{fd.additions}</span>}
                    {fd.deletions > 0 && <span className="font-mono text-[#ef4444]">-{fd.deletions}</span>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {diffLoading && !diffData ? (
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
                      isHighlightedFile ? 'bg-push-accent/10' : 'bg-[#0a0e16]/95'
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
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-mono">
                      {fd.additions > 0 && <span className="text-[#22c55e]">+{fd.additions}</span>}
                      {fd.deletions > 0 && <span className="text-[#ef4444]">-{fd.deletions}</span>}
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
                          className={highlightedLineKey === line.key ? 'rounded-md ring-1 ring-push-accent/50 bg-push-accent/5' : ''}
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
              <div className="px-3 py-1.5 text-[11px] italic text-push-fg-dim border-t border-push-edge">
                Diff truncated
              </div>
            )}
          </div>
        ) : diffData ? (
          <p className="p-3 text-xs text-push-fg-dim">No working tree changes.</p>
        ) : (
          <p className="p-3 text-xs text-push-fg-dim">No working tree changes.</p>
        )}
      </div>
    </>
  );
}
