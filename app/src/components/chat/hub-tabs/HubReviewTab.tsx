import { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Info, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runReviewer } from '@/lib/reviewer-agent';
import { getActiveProvider } from '@/lib/orchestrator';
import { getModelForRole } from '@/lib/providers';
import type { AIProviderType } from '@/types';
import type { ReviewResult, ReviewComment } from '@/types';

const PROVIDERS: { type: AIProviderType; label: string }[] = [
  { type: 'ollama', label: 'Ollama' },
  { type: 'openrouter', label: 'OpenRouter' },
  { type: 'zen', label: 'Zen' },
  { type: 'nvidia', label: 'Nvidia' },
];

interface HubReviewTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
}

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

export function HubReviewTab({ sandboxId, sandboxStatus, ensureSandbox }: HubReviewTabProps) {
  const defaultProvider = (() => {
    const active = getActiveProvider();
    return active === 'demo' ? 'openrouter' : active;
  })() as AIProviderType;

  const [selectedProvider, setSelectedProvider] = useState<AIProviderType>(defaultProvider);
  const [modelInput, setModelInput] = useState(() => {
    const roleModel = getModelForRole(defaultProvider, 'reviewer');
    return roleModel?.id ?? '';
  });
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const handleProviderChange = useCallback((p: AIProviderType) => {
    setSelectedProvider(p);
    const roleModel = getModelForRole(p, 'reviewer');
    setModelInput(roleModel?.id ?? '');
  }, []);

  const toggleFile = useCallback((file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) { next.delete(file); } else { next.add(file); }
      return next;
    });
  }, []);

  const handleRunReview = useCallback(async () => {
    if (running) return;

    setRunning(true);
    setError(null);
    setResult(null);
    setStatus(null);
    setExpandedFiles(new Set());

    try {
      let id = sandboxId;
      if (!id) {
        setStatus('Starting sandbox…');
        id = await ensureSandbox();
      }
      if (!id) {
        setError('Sandbox is not available. Start it first.');
        return;
      }

      setStatus('Fetching diff…');
      const diffResult = await getSandboxDiff(id);
      if (!diffResult.diff?.trim()) {
        setError('No changes to review. Make some edits first.');
        return;
      }

      const reviewResult = await runReviewer(
        diffResult.diff,
        { provider: selectedProvider, model: modelInput.trim() || undefined },
        (phase) => setStatus(phase),
      );

      setResult(reviewResult);
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
  }, [running, sandboxId, ensureSandbox, selectedProvider, modelInput]);

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Controls */}
      <div className="flex-shrink-0 border-b border-push-edge px-3 py-3 space-y-2.5">
        {/* Provider pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {PROVIDERS.map(({ type, label }) => (
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
            value={modelInput}
            onChange={(e) => setModelInput(e.target.value)}
            placeholder="Model ID (uses role default if blank)"
            className="min-w-0 flex-1 rounded-lg border border-push-edge bg-[#080d14] px-2.5 py-1.5 text-[11px] text-push-fg-secondary placeholder:text-push-fg-dim focus:border-push-accent/40 focus:outline-none"
          />
          <button
            onClick={() => void handleRunReview()}
            disabled={running || (!sandboxReady && sandboxStatus !== 'idle')}
            className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-push-accent/30 bg-push-accent/10 px-3 py-1.5 text-[11px] font-medium text-push-accent transition-colors hover:bg-push-accent/15 active:scale-95 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {running ? 'Reviewing…' : 'Run review'}
          </button>
        </div>

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
            <p className="text-xs text-push-fg-dim">Run a review to see feedback on your current changes.</p>
          </div>
        )}

        {result && (
          <div className="px-3 py-3 space-y-3">
            {/* Summary */}
            <div className="rounded-xl border border-push-edge bg-push-grad-card px-3.5 py-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="text-xs font-medium text-push-fg">Review complete</span>
                </div>
                <span className="text-[10px] text-push-fg-dim">
                  {result.filesReviewed} file{result.filesReviewed !== 1 ? 's' : ''} · {result.model}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-push-fg-secondary">{result.summary}</p>
            </div>

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
                                <div className="mb-0.5">{severityLabel(c.severity)}</div>
                                <p className="text-[11px] leading-relaxed text-push-fg-secondary">{c.comment}</p>
                              </div>
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
