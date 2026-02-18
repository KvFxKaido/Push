import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  RefreshCw,
  Sparkles,
  StickyNote,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { runAuditor } from '@/lib/auditor-agent';
import { execInSandbox, getSandboxDiff } from '@/lib/sandbox-client';
import { parseDiffStats } from '@/lib/diff-utils';
import { getActiveProvider, getProviderStreamFn } from '@/lib/orchestrator';
import { getModelForRole } from '@/lib/providers';
import { streamWithTimeout } from '@/lib/utils';
import { HubScratchpadTab, HubConsoleTab, HubFilesTab, HubDiffTab } from './hub-tabs';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { AgentStatusEvent, ChatMessage, DiffPreviewCardData } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HubTab = 'scratchpad' | 'console' | 'files' | 'diff';

type CommitPhase = 'idle' | 'fetching-diff' | 'auditing' | 'committing' | 'pushing' | 'success' | 'error';

export interface HubBranchProps {
  currentBranch: string | undefined;
  defaultBranch: string | undefined;
  availableBranches: Array<{ name: string; isDefault: boolean }>;
  branchesLoading: boolean;
  onSwitchBranch: (branch: string) => void;
  onRefreshBranches: () => void;
  onShowBranchCreate: () => void;
  onShowMergeFlow: () => void;
  onDeleteBranch: (branch: string) => Promise<boolean>;
}

interface WorkspaceHubSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: ChatMessage[];
  agentEvents: AgentStatusEvent[];
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
  repoName?: string;
  protectMainEnabled: boolean;
  // Scratchpad
  scratchpadContent: string;
  scratchpadMemories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onScratchpadContentChange: (content: string) => void;
  onScratchpadClear: () => void;
  onScratchpadSaveMemory: (name: string) => void;
  onScratchpadLoadMemory: (id: string | null) => void;
  onScratchpadDeleteMemory: (id: string) => void;
  // Branch management
  branchProps: HubBranchProps;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: Array<{ key: HubTab; label: string; icon: typeof Files }> = [
  { key: 'scratchpad', label: 'Pad', icon: StickyNote },
  { key: 'console', label: 'Console', icon: TerminalSquare },
  { key: 'files', label: 'Files', icon: Files },
  { key: 'diff', label: 'Diff', icon: FileDiff },
];

const PHASE_LABELS: Record<CommitPhase, string> = {
  idle: '',
  'fetching-diff': 'Checking changes...',
  auditing: 'Auditing...',
  committing: 'Committing...',
  pushing: 'Pushing...',
  success: 'Done!',
  error: 'Failed',
};

const COMMIT_MESSAGE_SUGGEST_TIMEOUT_MS = 30_000;

const COMMIT_MESSAGE_SUGGEST_SYSTEM_PROMPT = `You generate git commit messages.

Return ONLY one line, nothing else, in this strict format:
<type>: <subject>

Rules:
- Allowed types: feat, fix, refactor, docs, test, chore, ci, build, style, perf, revert
- Do not include a scope
- Use imperative mood
- No trailing period
- Keep total line length <= 72 characters
- No quotes, no markdown, no bullets`;

function truncateCommitSubject(subject: string, type: string): string {
  const maxTotalLength = 72;
  const prefix = `${type}: `;
  const maxSubjectLength = Math.max(1, maxTotalLength - prefix.length);
  return subject.length <= maxSubjectLength
    ? subject
    : subject.slice(0, maxSubjectLength).trimEnd();
}

function normalizeSuggestedCommitMessage(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:text)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) || '';

  let candidate = firstLine
    .replace(/^[-*]\s*/, '')
    .replace(/^(commit message|message)\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const allowedTypes = new Set([
    'feat',
    'fix',
    'refactor',
    'docs',
    'test',
    'chore',
    'ci',
    'build',
    'style',
    'perf',
    'revert',
  ]);

  const conventionalMatch = candidate.match(/^([a-z]+)(?:\([^)]+\))?:\s+(.+)$/i);
  if (conventionalMatch) {
    const type = conventionalMatch[1].toLowerCase();
    const subject = conventionalMatch[2].trim().replace(/\.$/, '');
    if (allowedTypes.has(type) && subject) {
      return `${type}: ${truncateCommitSubject(subject, type)}`;
    }
  }

  if (!candidate) {
    return 'chore: update workspace changes';
  }

  candidate = candidate.replace(/\.$/, '');
  return `chore: ${truncateCommitSubject(candidate, 'chore')}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceHubSheet({
  open,
  onOpenChange,
  messages,
  agentEvents,
  sandboxId,
  sandboxStatus,
  ensureSandbox,
  repoName,
  protectMainEnabled,
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onScratchpadContentChange,
  onScratchpadClear,
  onScratchpadSaveMemory,
  onScratchpadLoadMemory,
  onScratchpadDeleteMemory,
  branchProps,
}: WorkspaceHubSheetProps) {
  const [activeTab, setActiveTab] = useState<HubTab>('files');
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  // Diff state (shared between diff tab and commit flow)
  const [diffData, setDiffData] = useState<DiffPreviewCardData | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Commit flow state (replaces old hand-rolled commit/push)
  const [commitPhase, setCommitPhase] = useState<CommitPhase>('idle');
  const [commitMessage, setCommitMessage] = useState('');
  const [suggestingCommitMessage, setSuggestingCommitMessage] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Branch dropdown
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [switchConfirmBranch, setSwitchConfirmBranch] = useState<string | null>(null);

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);
  const activeTabIndex = TABS.findIndex((tab) => tab.key === activeTab);
  const showCommitBar = activeTab === 'files' || activeTab === 'diff';

  const blockedByProtectMain = Boolean(
    protectMainEnabled &&
      branchProps.currentBranch &&
      branchProps.defaultBranch &&
      branchProps.currentBranch === branchProps.defaultBranch,
  );

  const isOnMain = branchProps.currentBranch === branchProps.defaultBranch;

  // ---- Diff callbacks for HubDiffTab ----
  const handleDiffUpdate = useCallback((data: DiffPreviewCardData | null, error: string | null) => {
    setDiffData(data);
    setDiffError(error);
  }, []);

  const handleDiffLoadingChange = useCallback((loading: boolean) => {
    setDiffLoading(loading);
  }, []);

  // ---- Commit & Push flow ----
  const runCommitAndPush = useCallback(async () => {
    if (!sandboxId) {
      toast.error('Sandbox is not ready.');
      return;
    }

    const message = commitMessage.replace(/[\r\n]+/g, ' ').trim();
    if (!message) {
      toast.error('Commit message is required.');
      return;
    }

    if (blockedByProtectMain) {
      toast.error(`Protected branch: commits to "${branchProps.defaultBranch}" are blocked.`);
      return;
    }

    if (getActiveProvider() === 'demo') {
      setCommitPhase('error');
      setCommitError('No AI provider configured. Add an API key in Settings to enable the Auditor.');
      return;
    }

    const safeMessage = message.replace(/'/g, `'"'"'`);

    // Phase: Fetching diff
    setCommitPhase('fetching-diff');
    setCommitError(null);
    try {
      const diffResult = await getSandboxDiff(sandboxId);
      if (!diffResult.diff) {
        setCommitPhase('error');
        setCommitError('Nothing to commit — no changes detected.');
        return;
      }

      // Phase: Auditing
      setCommitPhase('auditing');
      const auditResult = await runAuditor(diffResult.diff, () => {});
      if (auditResult.verdict === 'unsafe') {
        setCommitPhase('error');
        setCommitError(`Commit blocked by Auditor: ${auditResult.card.summary}`);
        return;
      }

      // Phase: Committing
      setCommitPhase('committing');
      const commitResult = await execInSandbox(
        sandboxId,
        `cd /workspace && git add -A && if git diff --cached --quiet; then echo "__PUSH_NO_CHANGES__"; else git commit -m '${safeMessage}'; fi`,
      );

      if (commitResult.exitCode !== 0) {
        const detail = commitResult.stderr || commitResult.stdout || 'Unknown git error';
        setCommitPhase('error');
        setCommitError(`Commit failed: ${detail}`);
        return;
      }

      if ((commitResult.stdout || '').includes('__PUSH_NO_CHANGES__')) {
        setCommitPhase('error');
        setCommitError('Nothing to commit — no staged changes.');
        return;
      }

      // Phase: Pushing
      setCommitPhase('pushing');
      const pushResult = await execInSandbox(sandboxId, 'cd /workspace && git push origin HEAD');
      if (pushResult.exitCode !== 0) {
        const detail = pushResult.stderr || pushResult.stdout || 'Unknown git error';
        setCommitPhase('error');
        setCommitError(`Push failed: ${detail}`);
        return;
      }

      // Success
      setCommitPhase('success');
      toast.success('Committed & pushed.');

      // Refresh diff data
      try {
        const freshDiff = await getSandboxDiff(sandboxId);
        if (freshDiff.diff) {
          const stats = parseDiffStats(freshDiff.diff);
          setDiffData({
            diff: freshDiff.diff,
            filesChanged: stats.filesChanged,
            additions: stats.additions,
            deletions: stats.deletions,
            truncated: freshDiff.truncated,
          });
        } else {
          setDiffData(null);
        }
      } catch {
        // Best effort
      }
    } catch (err) {
      setCommitPhase('error');
      setCommitError(err instanceof Error ? err.message : 'Commit failed');
    }
  }, [sandboxId, commitMessage, blockedByProtectMain, branchProps.defaultBranch]);

  const suggestCommitMessage = useCallback(async () => {
    if (!sandboxId) {
      toast.error('Sandbox is not ready.');
      return;
    }

    const activeProvider = getActiveProvider();
    if (activeProvider === 'demo') {
      toast.error('No AI provider configured. Add an API key in Settings.');
      return;
    }

    setSuggestingCommitMessage(true);
    try {
      const diffResult = await getSandboxDiff(sandboxId);
      if (!diffResult.diff) {
        toast.error('No local changes to summarize.');
        return;
      }

      const stats = parseDiffStats(diffResult.diff);
      const diffSnippet = diffResult.diff.slice(0, 20_000);
      const { streamFn } = getProviderStreamFn(activeProvider);
      const modelId = getModelForRole(activeProvider, 'orchestrator')?.id;

      const prompt = [
        `Generate a commit message for this diff.`,
        `Changed files: ${stats.filesChanged}, additions: ${stats.additions}, deletions: ${stats.deletions}.`,
        `Return exactly one commit-message line.`,
        '',
        '```diff',
        diffSnippet,
        '```',
      ].join('\n');

      const llmMessages: ChatMessage[] = [
        {
          id: 'commit-message-suggest',
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
      ];

      const { promise, getAccumulated } = streamWithTimeout(
        COMMIT_MESSAGE_SUGGEST_TIMEOUT_MS,
        `Commit message suggestion timed out after ${COMMIT_MESSAGE_SUGGEST_TIMEOUT_MS / 1000}s.`,
        (onToken, onDone, onError) => {
          streamFn(
            llmMessages,
            onToken,
            onDone,
            onError,
            undefined,
            undefined,
            false,
            modelId,
            COMMIT_MESSAGE_SUGGEST_SYSTEM_PROMPT,
          );
        },
      );

      const streamError = await promise;
      if (streamError) {
        throw streamError;
      }

      const suggested = normalizeSuggestedCommitMessage(getAccumulated());
      setCommitMessage(suggested);
      toast.success('Commit message suggested.');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Suggestion failed';
      toast.error(detail);
    } finally {
      setSuggestingCommitMessage(false);
    }
  }, [sandboxId]);

  // ---- Branch switching with confirmation ----
  const handleBranchSwitch = useCallback((branch: string) => {
    if (branch === branchProps.currentBranch) return;
    setSwitchConfirmBranch(branch);
  }, [branchProps.currentBranch]);

  const confirmBranchSwitch = useCallback(() => {
    if (!switchConfirmBranch) return;
    branchProps.onSwitchBranch(switchConfirmBranch);
    setSwitchConfirmBranch(null);
    setBranchDropdownOpen(false);
  }, [switchConfirmBranch, branchProps]);

  const handleDeleteBranch = useCallback(async (branchName: string) => {
    setDeletingBranch(branchName);
    try {
      await branchProps.onDeleteBranch(branchName);
      setPendingDeleteBranch(null);
    } finally {
      setDeletingBranch((prev) => (prev === branchName ? null : prev));
    }
  }, [branchProps]);

  // ---- Effects ----
  useEffect(() => {
    if (!open) {
      setCommitPhase('idle');
      setCommitError(null);
      setBranchDropdownOpen(false);
      setPendingDeleteBranch(null);
      setSwitchConfirmBranch(null);
    }
  }, [open]);

  useEffect(() => {
    setCommitPhase('idle');
    setCommitError(null);
  }, [activeTab]);

  // Auto-load diff when opening diff tab
  useEffect(() => {
    if (open && activeTab === 'diff' && sandboxReady && !diffLoading && !diffData && !diffError) {
      // Diff tab will handle its own initial load via its ensureSandbox
    }
  }, [open, activeTab, sandboxReady, diffLoading, diffData, diffError]);

  // ---- Swipe navigation ----
  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || event.changedTouches.length !== 1) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) return;

    if (deltaX < 0 && activeTabIndex < TABS.length - 1) {
      setActiveTab(TABS[activeTabIndex + 1].key);
      return;
    }
    if (deltaX > 0 && activeTabIndex > 0) {
      setActiveTab(TABS[activeTabIndex - 1].key);
    }
  };

  // ---- Render ----
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[94vw] rounded-l-2xl border-l border-[#151b26] bg-push-grad-panel p-0 text-push-fg shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] sm:max-w-none [&>[data-slot=sheet-close]]:hidden"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 rounded-tl-2xl bg-gradient-to-b from-white/[0.03] to-transparent" />
        <div className="relative flex h-dvh flex-col overflow-hidden rounded-l-2xl">
          {/* ---- Header ---- */}
          <header className="border-b border-push-edge px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              {/* Repo + Branch dropdown */}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-push-fg">
                  Workspace
                </p>
                <div className="flex items-center gap-1">
                  <span className="truncate text-[11px] text-push-fg-dim">
                    {repoName || 'Sandbox'}
                  </span>
                  {branchProps.currentBranch && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setBranchDropdownOpen((v) => !v);
                          if (!branchDropdownOpen && branchProps.availableBranches.length === 0) {
                            branchProps.onRefreshBranches();
                          }
                        }}
                        className="flex items-center gap-0.5 rounded-md px-1 py-0.5 text-[11px] text-push-fg-dim transition-colors hover:bg-[#0d1119] hover:text-push-fg-secondary"
                      >
                        <GitBranch className="h-2.5 w-2.5" />
                        <span className="max-w-[90px] truncate">{branchProps.currentBranch}</span>
                        <ChevronDown className={`h-2.5 w-2.5 transition-transform ${branchDropdownOpen ? 'rotate-180' : ''}`} />
                      </button>

                      {/* Branch dropdown */}
                      {branchDropdownOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => { setBranchDropdownOpen(false); setPendingDeleteBranch(null); setSwitchConfirmBranch(null); }} />
                          <div className="absolute left-0 top-full z-50 mt-1 w-[220px] rounded-xl border border-push-edge bg-push-grad-card shadow-[0_18px_40px_rgba(0,0,0,0.62)]">
                            {/* Branch actions */}
                            {isOnMain ? (
                              <button
                                onClick={() => { setBranchDropdownOpen(false); branchProps.onShowBranchCreate(); }}
                                className="flex w-full items-center gap-2 rounded-t-xl px-3 py-2.5 text-xs text-push-fg-secondary hover:bg-[#0d1119]"
                              >
                                <GitBranch className="h-3.5 w-3.5" />
                                Create branch
                              </button>
                            ) : (
                              <button
                                onClick={() => { setBranchDropdownOpen(false); branchProps.onShowMergeFlow(); }}
                                className="flex w-full items-center gap-2 rounded-t-xl px-3 py-2.5 text-xs text-emerald-300 hover:bg-[#0d1119]"
                              >
                                <GitMerge className="h-3.5 w-3.5" />
                                Merge into {branchProps.defaultBranch}
                              </button>
                            )}
                            <div className="border-t border-push-edge" />

                            {/* Refresh */}
                            <button
                              onClick={() => branchProps.onRefreshBranches()}
                              disabled={branchProps.branchesLoading}
                              className="flex w-full items-center gap-2 px-3 py-2 text-[11px] text-push-fg-dim hover:bg-[#0d1119] hover:text-push-fg-secondary disabled:opacity-50"
                            >
                              <RefreshCw className={`h-3 w-3 ${branchProps.branchesLoading ? 'animate-spin' : ''}`} />
                              Refresh branches
                            </button>
                            <div className="border-t border-push-edge" />

                            {/* Branch list */}
                            <div className="max-h-[240px] overflow-y-auto py-1">
                              {branchProps.branchesLoading && branchProps.availableBranches.length === 0 && (
                                <div className="flex items-center gap-2 px-3 py-2 text-xs text-push-fg-dim">
                                  <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                                </div>
                              )}
                              {branchProps.availableBranches.map((branch) => {
                                const isActive = branch.name === branchProps.currentBranch;
                                const canDelete = !isActive && !branch.isDefault;
                                const isDeletePending = pendingDeleteBranch === branch.name;
                                const isDeletingThis = deletingBranch === branch.name;
                                return (
                                  <div key={branch.name}>
                                    <button
                                      onClick={() => {
                                        if (!isActive) handleBranchSwitch(branch.name);
                                      }}
                                      className={`flex w-full items-center gap-2 px-3 py-2 text-left ${isActive ? 'bg-[#101621]' : 'hover:bg-[#0d1119]'}`}
                                    >
                                      <span className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'text-push-fg' : 'text-push-fg-secondary'}`}>
                                        {branch.name}
                                      </span>
                                      {branch.isDefault && (
                                        <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-[10px] text-[#58a6ff]">default</span>
                                      )}
                                      {isActive && <Check className="h-3.5 w-3.5 text-push-link" />}
                                    </button>
                                    {canDelete && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (isDeletingThis || deletingBranch) return;
                                          if (!isDeletePending) { setPendingDeleteBranch(branch.name); return; }
                                          void handleDeleteBranch(branch.name);
                                        }}
                                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-[11px] ${
                                          isDeletePending
                                            ? 'bg-red-950/30 text-red-300 hover:bg-red-950/40'
                                            : 'text-push-fg-dim hover:bg-[#0d1119] hover:text-red-300'
                                        }`}
                                      >
                                        {isDeletingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                        {isDeletingThis ? 'Deleting...' : isDeletePending ? 'Confirm delete' : 'Delete'}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Right actions */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onOpenChange(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-push-edge bg-[#080b10]/95 text-push-fg-dim transition-colors hover:border-push-edge-hover hover:text-push-fg-secondary"
                  aria-label="Close workspace hub"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

          </header>

          {/* Branch switch confirmation overlay */}
          {switchConfirmBranch && (
            <div className="border-b border-push-edge bg-[#0d1526] px-3 py-2.5">
              <p className="text-xs text-push-fg-secondary">
                Switch to <span className="font-medium text-push-fg">{switchConfirmBranch}</span>? This will restart your sandbox.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={confirmBranchSwitch}
                  className="rounded-lg border border-push-edge bg-[#080b10]/95 px-3 py-1.5 text-xs text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:text-push-fg"
                >
                  Switch
                </button>
                <button
                  onClick={() => setSwitchConfirmBranch(null)}
                  className="rounded-lg px-3 py-1.5 text-xs text-push-fg-dim transition-colors hover:text-push-fg-secondary"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Tab bar */}
          <div className="border-b border-push-edge px-2 py-2">
            <div className="grid grid-cols-4 gap-1">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = tab.key === activeTab;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex min-h-[42px] items-center justify-center gap-1 rounded-lg px-1 text-[11px] transition-colors ${
                      active
                        ? 'border border-push-edge-hover bg-[#0d1119] text-push-fg'
                        : 'border border-transparent text-push-fg-dim hover:bg-[#080b10]/80 hover:text-push-fg-secondary'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Commit bar (shown on Files/Diff tabs, below tab bar) */}
          {showCommitBar && (
            <div className="border-b border-push-edge px-3 py-2">
              <div className="flex items-center gap-1.5">
                <input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Commit message"
                  disabled={commitPhase !== 'idle' && commitPhase !== 'success' && commitPhase !== 'error'}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-push-edge bg-push-surface px-2.5 text-xs text-push-fg-secondary outline-none transition-colors placeholder:text-push-fg-dim focus:border-push-sky/50 disabled:opacity-50"
                />
                <button
                  onClick={() => void suggestCommitMessage()}
                  disabled={
                    suggestingCommitMessage ||
                    (commitPhase !== 'idle' && commitPhase !== 'success' && commitPhase !== 'error') ||
                    !sandboxReady
                  }
                  title="Suggest commit message from current diff"
                  className="flex h-8 items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2 text-[11px] text-push-fg-dim transition-colors hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-50"
                >
                  {suggestingCommitMessage ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  AI
                </button>
                <button
                  onClick={() => {
                    if (commitPhase === 'success' || commitPhase === 'error') {
                      setCommitPhase('idle');
                      setCommitError(null);
                      return;
                    }
                    void runCommitAndPush();
                  }}
                  disabled={
                    (commitPhase !== 'idle' && commitPhase !== 'success' && commitPhase !== 'error') ||
                    !sandboxReady
                  }
                  className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] transition-colors disabled:opacity-50 ${
                    commitPhase === 'success'
                      ? 'border-emerald-500/50 bg-emerald-950/35 text-emerald-300'
                      : commitPhase === 'error'
                      ? 'border-red-500/40 bg-red-950/20 text-red-300'
                      : 'border-push-edge bg-[#080b10]/95 text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary'
                  }`}
                >
                  {commitPhase !== 'idle' && commitPhase !== 'success' && commitPhase !== 'error' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : commitPhase === 'success' ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <GitCommitHorizontal className="h-3.5 w-3.5" />
                  )}
                  {commitPhase === 'idle'
                    ? 'Commit & Push'
                    : commitPhase === 'success' || commitPhase === 'error'
                    ? 'Reset'
                    : PHASE_LABELS[commitPhase]}
                </button>
              </div>
              {blockedByProtectMain && (
                <p className="mt-1 text-[10px] text-amber-300">
                  Protect Main is enabled for {branchProps.defaultBranch}.
                </p>
              )}
              {commitPhase === 'error' && commitError && (
                <p className="mt-1 text-[10px] text-red-300">{commitError}</p>
              )}
            </div>
          )}

          {/* Tab content */}
          <div
            className="min-h-0 flex-1 overflow-hidden"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {activeTab === 'scratchpad' && (
              <HubScratchpadTab
                scratchpadContent={scratchpadContent}
                scratchpadMemories={scratchpadMemories}
                activeMemoryId={activeMemoryId}
                onContentChange={onScratchpadContentChange}
                onClear={onScratchpadClear}
                onSaveMemory={onScratchpadSaveMemory}
                onLoadMemory={onScratchpadLoadMemory}
                onDeleteMemory={onScratchpadDeleteMemory}
              />
            )}

            {activeTab === 'console' && (
              <HubConsoleTab messages={messages} agentEvents={agentEvents} />
            )}

            {activeTab === 'files' && (
              <div className="flex h-full min-h-0 flex-col">
                <HubFilesTab
                  sandboxId={sandboxId}
                  sandboxStatus={sandboxStatus}
                  ensureSandbox={ensureSandbox}
                />
              </div>
            )}

            {activeTab === 'diff' && (
              <div className="flex h-full min-h-0 flex-col">
                <HubDiffTab
                  sandboxId={sandboxId}
                  sandboxStatus={sandboxStatus}
                  ensureSandbox={ensureSandbox}
                  diffData={diffData}
                  diffLoading={diffLoading}
                  diffError={diffError}
                  onDiffUpdate={handleDiffUpdate}
                  onDiffLoadingChange={handleDiffLoadingChange}
                />
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
