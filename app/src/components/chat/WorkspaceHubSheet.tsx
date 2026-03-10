import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Eye,
  FileDiff,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  StickyNote,
  Terminal,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import { categorizeSandboxError } from '@/lib/sandbox-error-utils';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { runAuditor } from '@/lib/auditor-agent';
import { execInSandbox, getSandboxDiff } from '@/lib/sandbox-client';
import { deriveBranchNameFromCommitMessage, getBranchSuggestionPrefix, normalizeSuggestedBranchName, sanitizeBranchName } from '@/lib/branch-names';
import { parseDiffStats } from '@/lib/diff-utils';
import { getActiveProvider, getProviderStreamFn } from '@/lib/orchestrator';
import { getModelForRole, type PreferredProvider } from '@/lib/providers';
import { streamWithTimeout } from '@/lib/utils';
import { HubScratchpadTab, HubConsoleTab, HubFilesTab, HubDiffTab, HubPRsTab, HubReviewTab } from './hub-tabs';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { AgentStatusEvent, ChatMessage, DiffPreviewCardData } from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HubTab = 'scratchpad' | 'console' | 'files' | 'diff' | 'prs' | 'review';

type CommitPhase = 'idle' | 'fetching-diff' | 'branching' | 'auditing' | 'committing' | 'pushing' | 'success' | 'error';
type CommitTargetMode = 'current' | 'new';
type DiffViewMode = 'working-tree' | 'review-github' | 'review-sandbox';

interface DiffJumpTarget {
  path: string;
  line?: number;
  requestKey: number;
}

interface ReviewDiffSelection {
  data: DiffPreviewCardData;
  label: string;
  mode: Exclude<DiffViewMode, 'working-tree'>;
}

interface CommitPushTarget {
  mode: CommitTargetMode;
  branchName?: string;
}

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
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  sandboxError: string | null;
  ensureSandbox: () => Promise<string | null>;
  onStartSandbox: () => void;
  onRetrySandbox: () => void;
  onNewSandbox: () => void;
  reviewProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  reviewActiveProvider: ReturnType<typeof getActiveProvider>;
  reviewProviderModels: Record<PreferredProvider, string>;
  repoName?: string;
  /** owner/name format — passed to Review tab for PR detection */
  repoFullName?: string;
  protectMainEnabled: boolean;
  showToolActivity: boolean;
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
  onSandboxBranchSwitch: (branch: string) => void;
  onFixReviewFinding: (prompt: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS_WITH_CONSOLE: Array<{ key: HubTab; label: string; icon: typeof Files }> = [
  { key: 'scratchpad', label: 'Pad', icon: StickyNote },
  { key: 'console', label: 'Console', icon: TerminalSquare },
  { key: 'files', label: 'Files', icon: Files },
  { key: 'diff', label: 'Diff', icon: FileDiff },
  { key: 'prs', label: 'PRs', icon: GitPullRequest },
  { key: 'review', label: 'Review', icon: Eye },
];

const TABS_WITHOUT_CONSOLE = TABS_WITH_CONSOLE.filter((tab) => tab.key !== 'console');

const PHASE_LABELS: Record<CommitPhase, string> = {
  idle: '',
  'fetching-diff': 'Checking changes...',
  branching: 'Creating branch...',
  auditing: 'Auditing...',
  committing: 'Committing...',
  pushing: 'Pushing...',
  success: 'Done!',
  error: 'Failed',
};

const COMMIT_MESSAGE_SUGGEST_TIMEOUT_MS = 30_000;
const BRANCH_NAME_SUGGEST_TIMEOUT_MS = 30_000;

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

const BRANCH_NAME_SUGGEST_SYSTEM_PROMPT = `You generate git branch names.

Return ONLY one branch name, nothing else.

Rules:
- lowercase only
- kebab-case words
- one slash-separated prefix followed by a descriptive topic
- no spaces, quotes, markdown, bullets, or explanations
- keep it concise but specific`;

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}

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
  sandboxError,
  ensureSandbox,
  onStartSandbox,
  onRetrySandbox,
  onNewSandbox,
  reviewProviders,
  reviewActiveProvider,
  reviewProviderModels,
  repoName,
  repoFullName,
  protectMainEnabled,
  showToolActivity,
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onScratchpadContentChange,
  onScratchpadClear,
  onScratchpadSaveMemory,
  onScratchpadLoadMemory,
  onScratchpadDeleteMemory,
  branchProps,
  onSandboxBranchSwitch,
  onFixReviewFinding,
}: WorkspaceHubSheetProps) {
  const [activeTab, setActiveTab] = useState<HubTab>('files');
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  // Diff state (shared between diff tab and commit flow)
  const [diffData, setDiffData] = useState<DiffPreviewCardData | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [reviewDiffSelection, setReviewDiffSelection] = useState<ReviewDiffSelection | null>(null);
  const [diffJumpTarget, setDiffJumpTarget] = useState<DiffJumpTarget | null>(null);

  // Commit flow state (replaces old hand-rolled commit/push)
  const [commitPhase, setCommitPhase] = useState<CommitPhase>('idle');
  const [commitMessage, setCommitMessage] = useState('');
  const [suggestingCommitMessage, setSuggestingCommitMessage] = useState(false);
  const [commitTargetSheetOpen, setCommitTargetSheetOpen] = useState(false);
  const [commitTargetMode, setCommitTargetMode] = useState<CommitTargetMode>('current');
  const [newBranchName, setNewBranchName] = useState('');
  const [commitTargetError, setCommitTargetError] = useState<string | null>(null);
  const [suggestingBranchName, setSuggestingBranchName] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const branchSuggestionAttemptedRef = useRef(false);

  // Branch dropdown
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<string | null>(null);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [switchConfirmBranch, setSwitchConfirmBranch] = useState<string | null>(null);

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);
  const tabs = showToolActivity ? TABS_WITH_CONSOLE : TABS_WITHOUT_CONSOLE;
  const activeTabIndex = tabs.findIndex((tab) => tab.key === activeTab);
  const showCommitBar =
    activeTab === 'files' ||
    (activeTab === 'diff' && reviewDiffSelection?.mode !== 'review-github');

  const blockedByProtectMain = Boolean(
    protectMainEnabled &&
      branchProps.currentBranch &&
      branchProps.defaultBranch &&
      branchProps.currentBranch === branchProps.defaultBranch,
  );

  const isOnMain = branchProps.currentBranch === branchProps.defaultBranch;
  const currentBranchName = branchProps.currentBranch || branchProps.defaultBranch || 'main';
  const branchSuggestionPrefix = useMemo(() => getBranchSuggestionPrefix(repoName), [repoName]);
  const fallbackBranchName = useMemo(
    () => deriveBranchNameFromCommitMessage(commitMessage, branchSuggestionPrefix),
    [commitMessage, branchSuggestionPrefix],
  );
  const sanitizedNewBranchName = sanitizeBranchName(newBranchName);

  // ---- Diff callbacks for HubDiffTab ----
  const handleDiffUpdate = useCallback((data: DiffPreviewCardData | null, error: string | null) => {
    setDiffData(data);
    setDiffError(error);
  }, []);

  const handleDiffLoadingChange = useCallback((loading: boolean) => {
    setDiffLoading(loading);
  }, []);

  const handleOpenReviewDiff = useCallback((payload: {
    diffData: DiffPreviewCardData;
    label: string;
    mode: Exclude<DiffViewMode, 'working-tree'>;
    target?: { path: string; line?: number };
  }) => {
    setReviewDiffSelection({
      data: payload.diffData,
      label: payload.label,
      mode: payload.mode,
    });
    setDiffJumpTarget(
      payload.target
        ? {
            path: payload.target.path,
            ...(payload.target.line !== undefined ? { line: payload.target.line } : {}),
            requestKey: Date.now(),
          }
        : null,
    );
    setActiveTab('diff');
  }, []);

  const handleClearReviewDiff = useCallback(() => {
    setReviewDiffSelection(null);
    setDiffJumpTarget(null);
  }, []);

  useEffect(() => {
    setReviewDiffSelection(null);
    setDiffJumpTarget(null);
  }, [repoFullName, branchProps.currentBranch]);

  // ---- Commit & Push flow ----
  const openCommitTargetSheet = useCallback(() => {
    if (!sandboxReady) {
      toast.error('Sandbox is not ready.');
      return;
    }
    setCommitTargetMode(blockedByProtectMain ? 'new' : 'current');
    setCommitTargetError(null);
    setNewBranchName((prev) => prev || fallbackBranchName);
    branchSuggestionAttemptedRef.current = false;
    setCommitTargetSheetOpen(true);
  }, [sandboxReady, blockedByProtectMain, fallbackBranchName]);

  const runCommitAndPush = useCallback(async (target: CommitPushTarget) => {
    if (!sandboxId) {
      toast.error('Sandbox is not ready.');
      return;
    }

    const message = commitMessage.replace(/[\r\n]+/g, ' ').trim();
    if (!message) {
      toast.error('Commit message is required.');
      return;
    }

    if (target.mode === 'current' && blockedByProtectMain) {
      toast.error(`Protected branch: commits to "${branchProps.defaultBranch}" are blocked.`);
      return;
    }

    if (getActiveProvider() === 'demo') {
      setCommitPhase('error');
      setCommitError('No AI provider configured. Add an API key in Settings to enable the Auditor.');
      return;
    }

    const safeMessage = escapeSingleQuotes(message);
    const targetBranchName = target.mode === 'new' ? target.branchName : currentBranchName;

    setCommitError(null);
    try {
      if (target.mode === 'new' && target.branchName) {
        setCommitPhase('branching');
        const switchResult = await execInSandbox(
          sandboxId,
          `cd /workspace && if git show-ref --verify --quiet refs/heads/${target.branchName}; then echo "__PUSH_BRANCH_EXISTS_LOCAL__"; exit 10; fi && if git ls-remote --exit-code --heads origin ${target.branchName} >/dev/null 2>&1; then echo "__PUSH_BRANCH_EXISTS_REMOTE__"; exit 11; fi && git switch -c ${target.branchName}`,
          undefined,
          { markWorkspaceMutated: true },
        );

        if (switchResult.exitCode !== 0) {
          const output = `${switchResult.stdout}\n${switchResult.stderr}`;
          if (output.includes('__PUSH_BRANCH_EXISTS_LOCAL__') || output.includes('__PUSH_BRANCH_EXISTS_REMOTE__')) {
            setCommitPhase('error');
            setCommitError(`Branch "${target.branchName}" already exists.`);
            return;
          }

          const detail = switchResult.stderr || switchResult.stdout || 'Unknown git error';
          setCommitPhase('error');
          setCommitError(`Branch switch failed: ${detail}`);
          return;
        }

        onSandboxBranchSwitch(target.branchName);
      }

      // Phase: Fetching diff
      setCommitPhase('fetching-diff');
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
        undefined,
        { markWorkspaceMutated: true },
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
      const pushCommand = target.mode === 'new' && target.branchName
        ? `cd /workspace && git push -u origin HEAD:refs/heads/${target.branchName}`
        : 'cd /workspace && git push origin HEAD';
      const pushResult = await execInSandbox(
        sandboxId,
        pushCommand,
        undefined,
        { markWorkspaceMutated: true },
      );
      if (pushResult.exitCode !== 0) {
        const detail = pushResult.stderr || pushResult.stdout || 'Unknown git error';
        setCommitPhase('error');
        setCommitError(`Push failed: ${detail}`);
        return;
      }

      // Success
      setCommitPhase('success');
      toast.success(`Committed & pushed to ${targetBranchName}.`);
      if (target.mode === 'new') {
        branchProps.onRefreshBranches();
      }

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
  }, [
    sandboxId,
    commitMessage,
    blockedByProtectMain,
    branchProps,
    currentBranchName,
    onSandboxBranchSwitch,
  ]);

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

  const suggestBranchName = useCallback(async () => {
    setSuggestingBranchName(true);
    setCommitTargetError(null);
    try {
      if (!sandboxId) {
        throw new Error('Sandbox is not ready.');
      }

      const diffResult = await getSandboxDiff(sandboxId);
      if (!diffResult.diff) {
        setNewBranchName(fallbackBranchName);
        return;
      }

      const activeProvider = getActiveProvider();
      if (activeProvider === 'demo') {
        setNewBranchName(fallbackBranchName);
        return;
      }

      const stats = parseDiffStats(diffResult.diff);
      const diffSnippet = diffResult.diff.slice(0, 20_000);
      const { streamFn } = getProviderStreamFn(activeProvider);
      const modelId = getModelForRole(activeProvider, 'orchestrator')?.id;
      const prompt = [
        `Generate a git branch name for this change.`,
        `Required prefix: ${branchSuggestionPrefix}/`,
        `Current branch: ${currentBranchName}`,
        commitMessage ? `Commit message: ${commitMessage}` : null,
        `Changed files: ${stats.filesChanged}, additions: ${stats.additions}, deletions: ${stats.deletions}.`,
        `Return exactly one branch name.`,
        '',
        '```diff',
        diffSnippet,
        '```',
      ].filter(Boolean).join('\n');

      const llmMessages: ChatMessage[] = [
        {
          id: 'branch-name-suggest',
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
      ];

      const { promise, getAccumulated } = streamWithTimeout(
        BRANCH_NAME_SUGGEST_TIMEOUT_MS,
        `Branch name suggestion timed out after ${BRANCH_NAME_SUGGEST_TIMEOUT_MS / 1000}s.`,
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
            BRANCH_NAME_SUGGEST_SYSTEM_PROMPT,
          );
        },
      );

      const streamError = await promise;
      if (streamError) {
        throw streamError;
      }

      const suggested = normalizeSuggestedBranchName(getAccumulated(), branchSuggestionPrefix);
      setNewBranchName(suggested || fallbackBranchName);
    } catch {
      setNewBranchName(fallbackBranchName);
    } finally {
      setSuggestingBranchName(false);
    }
  }, [sandboxId, branchSuggestionPrefix, commitMessage, currentBranchName, fallbackBranchName]);

  const handleCommitTargetConfirm = useCallback(() => {
    const message = commitMessage.replace(/[\r\n]+/g, ' ').trim();
    if (!message) {
      setCommitTargetError('Enter a commit message first.');
      return;
    }

    if (commitTargetMode === 'current') {
      if (blockedByProtectMain) {
        setCommitTargetError(`Direct pushes to "${branchProps.defaultBranch}" are blocked.`);
        return;
      }
      setCommitTargetError(null);
      setCommitTargetSheetOpen(false);
      void runCommitAndPush({ mode: 'current' });
      return;
    }

    if (!sanitizedNewBranchName) {
      setCommitTargetError('Enter a branch name.');
      return;
    }
    if (sanitizedNewBranchName === currentBranchName) {
      setCommitTargetError(`Branch "${sanitizedNewBranchName}" is already active.`);
      return;
    }

    setCommitTargetError(null);
    setCommitTargetSheetOpen(false);
    void runCommitAndPush({ mode: 'new', branchName: sanitizedNewBranchName });
  }, [
    commitMessage,
    commitTargetMode,
    blockedByProtectMain,
    branchProps.defaultBranch,
    sanitizedNewBranchName,
    currentBranchName,
    runCommitAndPush,
  ]);

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
      setCommitTargetSheetOpen(false);
      setCommitTargetError(null);
      setBranchDropdownOpen(false);
      setPendingDeleteBranch(null);
      setSwitchConfirmBranch(null);
      branchSuggestionAttemptedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    setCommitPhase('idle');
    setCommitError(null);
  }, [activeTab]);

  useEffect(() => {
    setCommitTargetSheetOpen(false);
    setCommitTargetError(null);
    setCommitTargetMode(blockedByProtectMain ? 'new' : 'current');
    setNewBranchName('');
    branchSuggestionAttemptedRef.current = false;
  }, [repoFullName, branchProps.currentBranch, blockedByProtectMain]);

  useEffect(() => {
    if (!showToolActivity && activeTab === 'console') {
      setActiveTab('files');
    }
  }, [showToolActivity, activeTab]);

  useEffect(() => {
    if (!commitTargetSheetOpen || commitTargetMode !== 'new') return;
    if (branchSuggestionAttemptedRef.current) return;
    branchSuggestionAttemptedRef.current = true;
    void suggestBranchName();
  }, [commitTargetSheetOpen, commitTargetMode, suggestBranchName]);

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

    if (activeTabIndex === -1) return;

    if (deltaX < 0 && activeTabIndex < tabs.length - 1) {
      setActiveTab(tabs[activeTabIndex + 1].key);
      return;
    }
    if (deltaX > 0 && activeTabIndex > 0) {
      setActiveTab(tabs[activeTabIndex - 1].key);
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
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#1b2230] bg-push-grad-input text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.4),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all hover:border-push-edge-hover hover:text-push-fg-secondary hover:brightness-110"
                  aria-label="Close workspace hub"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

          </header>

          {/* Sandbox status strip */}
          {sandboxStatus !== 'ready' && (
            <div className="border-b border-push-edge px-3 py-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {(sandboxStatus === 'creating' || sandboxStatus === 'reconnecting') ? (
                  <Loader2 className="h-3 w-3 animate-spin text-push-fg-dim flex-shrink-0" />
                ) : sandboxStatus === 'error' ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400 flex-shrink-0" />
                ) : (
                  <Terminal className="h-3 w-3 text-[#5f6b80] flex-shrink-0" />
                )}
                <span className="text-[11px] truncate min-w-0">
                  {sandboxStatus === 'reconnecting' && <span className="text-push-fg-dim">Reconnecting…</span>}
                  {sandboxStatus === 'creating' && <span className="text-push-fg-dim">Starting sandbox…</span>}
                  {sandboxStatus === 'idle' && <span className="text-push-fg-dim">Sandbox not running</span>}
                  {sandboxStatus === 'error' && (
                    <span className="text-red-400">
                      {sandboxError ? categorizeSandboxError(sandboxError).title : 'Sandbox error'}
                    </span>
                  )}
                </span>
              </div>
              {(sandboxStatus === 'idle' || sandboxStatus === 'error') && (
                <div className="flex items-center gap-1.5 shrink-0">
                  {sandboxStatus === 'error' && sandboxId && (
                    <button
                      onClick={onRetrySandbox}
                      className="flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/15 active:scale-95"
                    >
                      <RefreshCw className="h-2.5 w-2.5" />
                      Retry
                    </button>
                  )}
                  <button
                    onClick={sandboxStatus === 'error' ? onNewSandbox : onStartSandbox}
                    className="flex items-center gap-1 rounded-md border border-[#243148] bg-[#0b1220] px-2 py-1 text-[11px] font-medium text-[#8ad4ff] transition-colors hover:bg-[#0d1526] active:scale-95"
                  >
                    {sandboxStatus === 'error' ? <><Plus className="h-2.5 w-2.5" />New</> : 'Start'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Branch switch confirmation overlay */}
          {switchConfirmBranch && (
            <div className="border-b border-push-edge bg-[#0d1526] px-3 py-2.5">
              <p className="text-xs text-push-fg-secondary">
                Switch to <span className="font-medium text-push-fg">{switchConfirmBranch}</span>? This will restart your sandbox.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={confirmBranchSwitch}
                  className="rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-1.5 text-xs text-push-fg-secondary shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all hover:border-push-edge-hover hover:text-push-fg hover:brightness-110"
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
            <div className={`grid gap-1 ${tabs.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const active = tab.key === activeTab;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex min-h-[42px] items-center justify-center gap-1 rounded-lg px-1 text-[11px] transition-all ${
                      active
                        ? 'border border-[#31425a] bg-push-grad-input text-push-fg shadow-[0_8px_20px_rgba(0,0,0,0.4),0_2px_6px_rgba(0,0,0,0.22)] backdrop-blur-xl'
                        : 'border border-transparent text-push-fg-dim hover:border-[#1f2a3a] hover:bg-[#0c1018] hover:text-push-fg-secondary'
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
                  className="h-8 min-w-0 flex-1 rounded-lg border border-[#1b2230] bg-push-grad-input px-2.5 text-xs text-push-fg-secondary shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all placeholder:text-push-fg-dim focus:border-push-sky/50 disabled:opacity-50"
                />
                <button
                  onClick={() => void suggestCommitMessage()}
                  disabled={
                    suggestingCommitMessage ||
                    (commitPhase !== 'idle' && commitPhase !== 'success' && commitPhase !== 'error') ||
                    !sandboxReady
                  }
                  title="Suggest commit message from current diff"
                  className="flex h-8 items-center gap-1 rounded-lg border border-[#1b2230] bg-push-grad-input px-2 text-[11px] text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all hover:border-push-edge-hover hover:text-push-fg-secondary hover:brightness-110 disabled:opacity-50"
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
                    openCommitTargetSheet();
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
                      : 'border-[#1b2230] bg-push-grad-input text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl hover:border-push-edge-hover hover:text-push-fg-secondary hover:brightness-110'
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
                    ? 'Commit & Push…'
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

            {showToolActivity && activeTab === 'console' && (
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
                  diffData={reviewDiffSelection?.data ?? diffData}
                  diffLoading={reviewDiffSelection ? false : diffLoading}
                  diffError={reviewDiffSelection ? null : diffError}
                  diffLabel={reviewDiffSelection?.label ?? 'Working tree diff'}
                  diffMode={reviewDiffSelection?.mode ?? 'working-tree'}
                  jumpTarget={diffJumpTarget}
                  onClearReviewDiff={reviewDiffSelection ? handleClearReviewDiff : undefined}
                  onDiffUpdate={handleDiffUpdate}
                  onDiffLoadingChange={handleDiffLoadingChange}
                />
              </div>
            )}

            {activeTab === 'prs' && (
              <div className="flex h-full min-h-0 flex-col">
                <HubPRsTab
                  repoFullName={repoFullName}
                  activeBranch={branchProps.currentBranch}
                  onOpenDiff={handleOpenReviewDiff}
                  onOpenReviewTab={() => setActiveTab('review')}
                />
              </div>
            )}

            {activeTab === 'review' && (
              <div className="flex h-full min-h-0 flex-col">
                <HubReviewTab
                  sandboxId={sandboxId}
                  sandboxStatus={sandboxStatus}
                  ensureSandbox={ensureSandbox}
                  availableProviders={reviewProviders}
                  activeProvider={reviewActiveProvider}
                  providerModels={reviewProviderModels}
                  repoFullName={repoFullName}
                  activeBranch={branchProps.currentBranch}
                  defaultBranch={branchProps.defaultBranch}
                  onOpenDiff={handleOpenReviewDiff}
                  onFixFinding={onFixReviewFinding}
                />
              </div>
            )}
          </div>

          <Sheet
            open={commitTargetSheetOpen}
            onOpenChange={(nextOpen) => {
              setCommitTargetSheetOpen(nextOpen);
              if (!nextOpen) {
                setCommitTargetError(null);
                branchSuggestionAttemptedRef.current = false;
              }
            }}
          >
            <SheetContent
              side="bottom"
              className="border-t border-[#151b26] bg-[#0d0d0d] px-0 pb-6 pt-0 text-push-fg"
            >
              <SheetHeader className="border-b border-push-edge px-4 py-4">
                <SheetTitle className="text-sm font-semibold text-push-fg">Push target</SheetTitle>
                <SheetDescription className="text-xs text-push-fg-dim">
                  Push to the current branch or fork this working tree into a new branch first.
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4 pt-4">
                <div className="rounded-xl border border-push-edge bg-[#0b1018]/90 p-3">
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => {
                        if (blockedByProtectMain) return;
                        setCommitTargetMode('current');
                        setCommitTargetError(null);
                      }}
                      disabled={blockedByProtectMain}
                      className={`mt-0.5 h-4 w-4 rounded-full border ${
                        commitTargetMode === 'current'
                          ? 'border-push-link bg-push-link'
                          : 'border-[#31425a] bg-transparent'
                      } ${blockedByProtectMain ? 'opacity-40' : ''}`}
                      aria-label="Push to current branch"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-push-fg">Current branch</p>
                        <span className="rounded-full bg-[#0d2847] px-1.5 py-0.5 text-[10px] text-[#58a6ff]">
                          {currentBranchName}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-push-fg-dim">
                        Commit and push directly to the active branch.
                      </p>
                      {blockedByProtectMain && (
                        <p className="mt-2 text-[11px] text-amber-300">
                          Protect Main blocks direct pushes to {branchProps.defaultBranch}.
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-push-edge bg-[#0b1018]/90 p-3">
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => {
                        setCommitTargetMode('new');
                        setCommitTargetError(null);
                        setNewBranchName((prev) => prev || fallbackBranchName);
                        if (!branchSuggestionAttemptedRef.current) {
                          branchSuggestionAttemptedRef.current = true;
                          void suggestBranchName();
                        }
                      }}
                      className={`mt-0.5 h-4 w-4 rounded-full border ${
                        commitTargetMode === 'new'
                          ? 'border-push-link bg-push-link'
                          : 'border-[#31425a] bg-transparent'
                      }`}
                      aria-label="Push to a new branch"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-push-fg">New branch</p>
                        <span className="rounded-full bg-[#131a27] px-1.5 py-0.5 text-[10px] text-push-fg-dim">
                          from {currentBranchName}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-push-fg-dim">
                        Create a new branch from the current working tree, then commit and push there.
                      </p>

                      <div className="mt-3 flex items-center gap-2">
                        <input
                          value={newBranchName}
                          onChange={(event) => {
                            setNewBranchName(event.target.value);
                            setCommitTargetMode('new');
                            setCommitTargetError(null);
                          }}
                          placeholder={`${branchSuggestionPrefix}/update-workspace`}
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          className="h-10 min-w-0 flex-1 rounded-lg border border-[#1b2230] bg-push-grad-input px-3 text-sm text-push-fg-secondary shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl outline-none transition-all placeholder:text-push-fg-dim focus:border-push-sky/50"
                        />
                        <button
                          onClick={() => {
                            setCommitTargetMode('new');
                            branchSuggestionAttemptedRef.current = true;
                            void suggestBranchName();
                          }}
                          disabled={suggestingBranchName}
                          className="flex h-10 items-center gap-1 rounded-lg border border-[#1b2230] bg-push-grad-input px-3 text-xs text-push-fg-dim shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all hover:border-push-edge-hover hover:text-push-fg-secondary hover:brightness-110 disabled:opacity-50"
                        >
                          {suggestingBranchName ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Sparkles className="h-3.5 w-3.5" />
                          )}
                          AI
                        </button>
                      </div>

                      {newBranchName && sanitizedNewBranchName !== newBranchName.toLowerCase().trim() && (
                        <p className="mt-2 text-[11px] text-push-fg-dim">
                          Will create: <span className="font-mono text-push-fg-secondary">{sanitizedNewBranchName || `${branchSuggestionPrefix}/update-workspace`}</span>
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-[#1b2230] bg-push-grad-input px-3 py-2">
                  <p className="text-[11px] text-push-fg-dim">
                    Commit message
                  </p>
                  <p className="mt-1 truncate text-sm text-push-fg-secondary">
                    {commitMessage.trim() || 'Enter a commit message in the bar above first.'}
                  </p>
                </div>

                {commitTargetError && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
                    <p className="text-xs text-red-300">{commitTargetError}</p>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCommitTargetConfirm}
                    disabled={suggestingBranchName}
                    className="flex-1 rounded-lg border border-[#1b2230] bg-push-grad-input px-3 py-2.5 text-sm text-push-fg-secondary shadow-[0_8px_18px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all hover:border-push-edge-hover hover:text-push-fg hover:brightness-110 disabled:opacity-50"
                  >
                    Commit &amp; Push
                  </button>
                  <button
                    onClick={() => setCommitTargetSheetOpen(false)}
                    className="rounded-lg px-3 py-2.5 text-sm text-push-fg-dim transition-colors hover:text-push-fg-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </SheetContent>
    </Sheet>
  );
}
