import { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { DiffLine } from '@/components/cards/DiffPreviewCard';
import { parseDiffStats, parseDiffIntoFiles, type FileDiff } from '@/lib/diff-utils';
import { getSandboxDiff } from '@/lib/sandbox-client';
import type { DiffPreviewCardData } from '@/types';

interface HubDiffTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
  /** Externally-managed diff data (so the hub shell can trigger refreshes after commit). */
  diffData: DiffPreviewCardData | null;
  diffLoading: boolean;
  diffError: string | null;
  onDiffUpdate: (data: DiffPreviewCardData | null, error: string | null) => void;
  onDiffLoadingChange: (loading: boolean) => void;
}

export function HubDiffTab({
  sandboxId,
  sandboxStatus,
  ensureSandbox,
  diffData,
  diffLoading,
  diffError,
  onDiffUpdate,
  onDiffLoadingChange,
}: HubDiffTabProps) {
  const [startingSandbox, setStartingSandbox] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);

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

  if (!sandboxReady) {
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
        <p className="text-xs text-push-fg-dim">Working tree diff</p>
        <button
          onClick={() => void refreshDiff()}
          disabled={diffLoading}
          className="inline-flex h-8 items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2 text-[11px] text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-50"
        >
          {diffLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </button>
      </div>

      {/* File index pills */}
      {fileDiffs.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-push-edge px-3 py-2 scrollbar-none">
          {fileDiffs.map((fd) => {
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
        ) : fileDiffs.length > 0 ? (
          <div>
            {fileDiffs.map((fd) => {
              const isCollapsed = collapsedFiles.has(fd.path);
              const lines = fd.hunks.split('\n');
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
                    className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-push-edge bg-[#0a0e16]/95 px-3 py-2 text-left backdrop-blur-sm"
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
                      {lines.map((line, i) => (
                        <DiffLine key={i} line={line} index={i} />
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
