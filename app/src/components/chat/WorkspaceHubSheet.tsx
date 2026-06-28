import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react';
import {
  Check,
  ChevronDown,
  Download,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { categorizeSandboxError } from '@/lib/sandbox-error-utils';
import type { RepoAppearance } from '@/lib/repo-appearance';
import { toast } from 'sonner';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { runAuditor } from '@/lib/auditor-agent';
import { getIsAuditorGateEnabled } from '@/hooks/useAuditorGate';
import { fetchAuditorFileContexts, type AuditorFileContext } from '@/lib/auditor-file-context';
import {
  createModelCommitBranchNameProposer,
  ensureCommitTargetBranch,
} from '@/lib/ensure-commit-target-branch';
import { createSandboxPushGit, gitHubAuthCommandPrefix } from '@/lib/git-backend';
import type {
  ForkBranchInWorkspaceResult,
  SwitchBranchInWorkspaceResult,
} from '@/lib/fork-branch-in-workspace';
import {
  execInSandbox,
  getSandboxDiff,
  readFromSandbox,
  writeToSandbox,
} from '@/lib/sandbox-client';
import { notifyWorkspaceMutation } from '@/lib/sandbox-mutation-signal';
import {
  deriveBranchNameFromCommitMessage,
  getBranchSuggestionPrefix,
  normalizeSuggestedBranchName,
  sanitizeBranchName,
} from '@/lib/branch-names';
import { parseDiffStats } from '@/lib/diff-utils';
import { shellEscape } from '@/lib/sandbox-tool-utils';
import { getActiveProvider, getProviderPushStream } from '@/lib/orchestrator';
import { getModelForRole, type PreferredProvider } from '@/lib/providers';
import { iteratePushStreamText } from '@push/lib/stream-utils';
import {
  GLASS_ACTIVE_CLASS,
  GLASS_FILL_FAINT,
  GLASS_FILL_HOVER_SOFT,
  HUB_GLASS_HAIRLINE,
  HUB_GLASS_PANEL_CLASS,
  HUB_GLASS_STRIP_CLASS,
  HUB_MATERIAL_BUTTON_CLASS,
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_TAG_CLASS,
} from '@/components/chat/hub-styles';
import { BranchSwitchConfirm } from '@/components/chat/BranchSwitchConfirm';
import { BranchListItem } from './BranchListItem';
import { countGitStatusEntries, type BranchSwitchProbe } from '@/lib/branch-switch-probe';
import {
  BranchWaveIcon,
  CommitPulseIcon,
  ConsoleTraceIcon,
  DiffSeamIcon,
  FilesStackIcon,
  MergeShieldIcon,
  NotebookPadIcon,
  PushOrbitIcon,
  ReviewLensIcon,
  SandboxCubeIcon,
  SettingsCellsIcon,
} from '@/components/icons/push-custom-icons';
import { MultiStepLoader, type MultiStepLoaderStep } from '@/components/ui/multi-step-loader';
import { PublishToGitHubSheet } from '@/components/repo/PublishToGitHubSheet';
import { HubNotesTab, HubConsoleTab, HubFilesTab, HubDiffTab } from './hub-tabs';
const HubReviewTab = lazy(() =>
  import('./hub-tabs/HubReviewTab').then((m) => ({ default: m.HubReviewTab })),
);
const HubSettingsTab = lazy(() =>
  import('./hub-tabs/HubSettingsTab').then((m) => ({ default: m.HubSettingsTab })),
);
import type {
  SettingsAIProps,
  SettingsAuthProps,
  SettingsDataProps,
  SettingsProfileProps,
  SettingsWorkspaceProps,
} from '@/components/SettingsSheet';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { TodoItem } from '@/lib/todo-tools';
import { formatSnapshotAge } from '@/hooks/useSnapshotManager';
import { CheckpointHistory } from './CheckpointHistory';
import type { PinnedArtifact } from '@/hooks/usePinnedArtifacts';
import type {
  AIProviderType,
  AgentStatusEvent,
  ChatMessage,
  DiffPreviewCardData,
  RunEvent,
  WorkspaceCapabilities,
  WorkspaceMode,
  WorkspaceScratchActions,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HubTab = 'notes' | 'console' | 'files' | 'diff' | 'review' | 'settings';

type CommitPhase =
  | 'idle'
  | 'fetching-diff'
  | 'branching'
  | 'auditing'
  | 'committing'
  | 'pushing'
  | 'success'
  | 'error';
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
  onWarmSwitchBranch?: (branch: string) => Promise<SwitchBranchInWorkspaceResult>;
  onRefreshBranches: () => void;
  onShowBranchCreate: () => void;
  onShowBranchFork: () => void;
  onShowMergeFlow: () => void;
  onDeleteBranch: (branch: string) => Promise<boolean>;
}

interface WorkspaceHubSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  externalTabRequest?: { tab: HubTab; requestKey: number } | null;
  messages: ChatMessage[];
  agentEvents: AgentStatusEvent[];
  runEvents: RunEvent[];
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  sandboxError: string | null;
  ensureSandbox: () => Promise<string | null>;
  onStartSandbox: () => void;
  onRetrySandbox: () => void;
  onNewSandbox: () => void;
  /** Manually snapshot the sandbox and terminate it. See Modal Sandbox Snapshots Design §C. */
  onHibernateSandbox?: () => Promise<boolean>;
  /** Drop the stored snapshot (and any dead binding) so the next start is a clean clone. */
  onForgetSandboxSnapshot?: () => void;
  /** Latest persisted snapshot for (repo, branch); null when no hibernate state exists. */
  snapshotInfo?: { snapshotId: string; createdAt: number } | null;
  reviewProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  reviewActiveProvider: ReturnType<typeof getActiveProvider>;
  reviewModelOptions?: Partial<Record<PreferredProvider, string[]>>;
  lockedProvider?: AIProviderType | null;
  lockedModel?: string | null;
  workspaceMode: WorkspaceMode;
  capabilities: WorkspaceCapabilities;
  scratchActions?: WorkspaceScratchActions | null;
  onPublishToGitHub?: (args: {
    repoName: string;
    description?: string;
    isPrivate: boolean;
  }) => Promise<void>;
  repoName?: string;
  /** owner/name format — passed to Review tab for PR detection */
  repoFullName?: string;
  projectInstructions?: string | null;
  protectMainEnabled: boolean;
  showToolActivity: boolean;
  /**
   * Settings prop bundles. Required for repo / scratch / chat workspaces
   * that surface the Settings tab. Daemon-backed sessions (local-pc /
   * relay) don't have these wired today and the Settings tab is dropped
   * for them — see the `tabs` useMemo below.
   */
  settingsAuth?: SettingsAuthProps;
  settingsProfile?: SettingsProfileProps;
  settingsAI?: SettingsAIProps;
  settingsWorkspace?: SettingsWorkspaceProps;
  settingsData?: SettingsDataProps;
  // Scratchpad
  scratchpadContent: string;
  scratchpadMemories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onScratchpadContentChange: (content: string) => void;
  onScratchpadClear: () => void;
  onScratchpadSaveMemory: (name: string) => void;
  onScratchpadLoadMemory: (id: string | null) => void;
  onScratchpadDeleteMemory: (id: string) => void;
  /** Active repo appearance + accent so the full-screen note editor matches the
   *  repo theme. Optional — the Notes tab defaults to the canonical sky/gradient. */
  appearance?: RepoAppearance;
  accentHex?: string;
  // Todo list — model's working plan, read-only display
  todos: readonly TodoItem[];
  onTodoClear: () => void;
  // Branch management
  branchProps: HubBranchProps;
  /** Slice 2.1 fork path. When the "Push to a new branch" flow creates a
   *  branch, route through this so the active conversation migrates onto the
   *  new branch instead of getting dropped (per-branch chat filter would
   *  otherwise route the user to a different chat). Optional because the
   *  chat-only surface gates `canCommitAndPush` off and never reaches the
   *  new-branch path. */
  forkBranchFromUI?: (name: string, from?: string) => Promise<ForkBranchInWorkspaceResult>;
  onFixReviewFinding: (prompt: string) => void;
  // Pinned artifacts (Kept)
  pinnedArtifacts: PinnedArtifact[];
  onUnpinArtifact: (id: string) => void;
  onUpdateArtifactLabel: (id: string, label: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS_WITH_CONSOLE: Array<{
  key: HubTab;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { key: 'notes', label: 'Notes', icon: NotebookPadIcon },
  { key: 'console', label: 'Console', icon: ConsoleTraceIcon },
  { key: 'files', label: 'Files', icon: FilesStackIcon },
  { key: 'diff', label: 'Diff', icon: DiffSeamIcon },
  { key: 'review', label: 'Review', icon: ReviewLensIcon },
  { key: 'settings', label: 'Settings', icon: SettingsCellsIcon },
];

const TABS_WITHOUT_CONSOLE = TABS_WITH_CONSOLE.filter((tab) => tab.key !== 'console');
const CHAT_MODE_TABS = new Set<HubTab>(['notes', 'settings']);
// Daemon-backed workspaces (local-pc / relay) get the same trimmed surface
// as chat mode for now: just Notes. Settings is included only if the daemon
// screen plumbed the prop bundles (today none of them do — the gate stays
// the same as the chat-mode check, just keyed off the bundles' presence).
const DAEMON_MODE_TABS = new Set<HubTab>(['notes', 'settings']);

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

// Canonical ordered steps for the commit/push multi-step loader. `branching`
// and `auditing` are conditional (new-branch / auto-branch flows and the
// Auditor gate) — when skipped, the phase jumps past them and they render as
// done, the universal progress-bar convention. Keep this list and
// COMMIT_PHASE_STEP_INDEX in sync with the updateCommitPhase calls in handleCommit.
// These phase names are this surface's own (`fetching-diff`/`branching`/…); the
// daemon commit flow in `useCommitPush.ts` uses a different set (`reviewing`/
// `recovering`/…) by design — the two surfaces don't share a phase vocabulary.
const DEFAULT_COMMIT_STEP = 0;
const COMMIT_STEPS: readonly MultiStepLoaderStep[] = [
  { key: 'fetching-diff', label: 'Checking changes', doneLabel: 'Changes checked', icon: Search },
  { key: 'branching', label: 'Creating branch', doneLabel: 'Branch ready', icon: GitBranch },
  { key: 'auditing', label: 'Auditing', doneLabel: 'Audited', icon: ShieldCheck },
  { key: 'committing', label: 'Committing', doneLabel: 'Committed', icon: CommitPulseIcon },
  { key: 'pushing', label: 'Pushing', doneLabel: 'Pushed', icon: Upload },
];

const COMMIT_PHASE_STEP_INDEX: Partial<Record<CommitPhase, number>> = {
  'fetching-diff': 0,
  branching: 1,
  auditing: 2,
  committing: 3,
  pushing: 4,
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

  const firstLine =
    text
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
  externalTabRequest,
  messages,
  agentEvents,
  runEvents,
  sandboxId,
  sandboxStatus,
  sandboxError,
  ensureSandbox,
  onStartSandbox,
  onRetrySandbox,
  onNewSandbox,
  onHibernateSandbox,
  onForgetSandboxSnapshot,
  snapshotInfo,
  reviewProviders,
  reviewActiveProvider,
  reviewModelOptions,
  lockedProvider,
  lockedModel,
  workspaceMode,
  capabilities,
  scratchActions,
  onPublishToGitHub,
  repoName,
  repoFullName,
  projectInstructions,
  protectMainEnabled,
  showToolActivity,
  settingsAuth,
  settingsProfile,
  settingsAI,
  settingsWorkspace,
  settingsData,
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onScratchpadContentChange,
  onScratchpadClear,
  onScratchpadSaveMemory,
  onScratchpadLoadMemory,
  onScratchpadDeleteMemory,
  appearance,
  accentHex,
  todos,
  onTodoClear,
  branchProps,
  forkBranchFromUI,
  onFixReviewFinding,
  pinnedArtifacts,
  onUnpinArtifact,
  onUpdateArtifactLabel,
}: WorkspaceHubSheetProps) {
  const [activeTab, setActiveTab] = useState<HubTab>('files');
  // Mount-once-then-keep for the Review tab: avoids running its hooks when hidden.
  const [reviewTabMounted, setReviewTabMounted] = useState(false);
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
  const [publishSheetOpen, setPublishSheetOpen] = useState(false);
  const [commitTargetMode, setCommitTargetMode] = useState<CommitTargetMode>('current');
  const [newBranchName, setNewBranchName] = useState('');
  const [commitTargetError, setCommitTargetError] = useState<string | null>(null);
  const [suggestingBranchName, setSuggestingBranchName] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const branchSuggestionAttemptedRef = useRef(false);
  // The terminal 'error' phase doesn't carry which step failed, so we record the
  // last running step's index as phases advance and read it back to attribute
  // the error in the multi-step loader. Tracked in the event handler (via
  // updateCommitPhase) rather than an effect to avoid cascading renders; idle
  // resets it. Running phases set it, terminal phases (success/error) leave it
  // pointing at the last running step.
  const [lastCommitStep, setLastCommitStep] = useState(DEFAULT_COMMIT_STEP);
  const updateCommitPhase = useCallback((phase: CommitPhase) => {
    setCommitPhase(phase);
    if (phase === 'idle') {
      setLastCommitStep(DEFAULT_COMMIT_STEP);
      return;
    }
    const idx = COMMIT_PHASE_STEP_INDEX[phase];
    if (idx !== undefined) setLastCommitStep(idx);
  }, []);

  // Branch dropdown
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [switchConfirmBranch, setSwitchConfirmBranch] = useState<string | null>(null);
  const [switchProbe, setSwitchProbe] = useState<BranchSwitchProbe | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchingBranch, setSwitchingBranch] = useState<{
    branch: string;
    mode: 'warm' | 'clean';
  } | null>(null);
  const [hibernating, setHibernating] = useState(false);

  const handleHibernateClick = useCallback(async () => {
    if (!onHibernateSandbox) return;
    setHibernating(true);
    try {
      const ok = await onHibernateSandbox();
      if (ok) toast.success('Sandbox hibernated — workspace snapshot saved');
      else toast.error('Hibernate failed — please try again');
    } finally {
      setHibernating(false);
    }
  }, [onHibernateSandbox]);

  const handleForgetSnapshotClick = useCallback(() => {
    if (!onForgetSandboxSnapshot) return;
    onForgetSandboxSnapshot();
    toast.success('Forgot sandbox snapshot — next start will be a clean clone');
  }, [onForgetSandboxSnapshot]);

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);
  const isDaemonMode = workspaceMode === 'local-pc' || workspaceMode === 'relay';
  // The Settings tab depends on the parent passing the full settings
  // prop bundles. Daemon screens don't plumb these yet, so the tab is
  // omitted there rather than crashing into `HubSettingsTab` with
  // undefined sub-props.
  const hasSettingsBundles = Boolean(
    settingsAuth && settingsProfile && settingsAI && settingsWorkspace && settingsData,
  );
  const tabs = useMemo(() => {
    if (workspaceMode === 'chat') {
      return (showToolActivity ? TABS_WITH_CONSOLE : TABS_WITHOUT_CONSOLE).filter(
        (tab) => CHAT_MODE_TABS.has(tab.key) && (tab.key !== 'settings' || hasSettingsBundles),
      );
    }
    if (isDaemonMode) {
      return (showToolActivity ? TABS_WITH_CONSOLE : TABS_WITHOUT_CONSOLE).filter(
        (tab) => DAEMON_MODE_TABS.has(tab.key) && (tab.key !== 'settings' || hasSettingsBundles),
      );
    }
    const baseTabs = showToolActivity ? TABS_WITH_CONSOLE : TABS_WITHOUT_CONSOLE;
    return baseTabs.filter((tab) => tab.key !== 'settings' || hasSettingsBundles);
  }, [hasSettingsBundles, isDaemonMode, showToolActivity, workspaceMode]);
  const fallbackTab = (
    workspaceMode === 'chat' || isDaemonMode
      ? (tabs.find((tab) => tab.key === 'notes')?.key ?? tabs[0]?.key ?? 'notes')
      : (tabs.find((tab) => tab.key === 'files')?.key ?? tabs[0]?.key ?? 'settings')
  ) as HubTab;
  const activeTabIndex = tabs.findIndex((tab) => tab.key === activeTab);
  const showActionBar =
    activeTab === 'files' ||
    (activeTab === 'diff' && reviewDiffSelection?.mode !== 'review-github');
  const showCommitBar = showActionBar && capabilities.canCommitAndPush;
  const showScratchActionBar =
    showActionBar && workspaceMode === 'scratch' && Boolean(scratchActions);

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

  const handleOpenReviewDiff = useCallback(
    (payload: {
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
    },
    [],
  );

  const handleClearReviewDiff = useCallback(() => {
    setReviewDiffSelection(null);
    setDiffJumpTarget(null);
  }, []);

  useEffect(() => {
    if (!externalTabRequest) return;
    const id = setTimeout(() => {
      if (externalTabRequest.tab === 'console' && !showToolActivity) {
        setActiveTab(fallbackTab);
        return;
      }
      setActiveTab(
        tabs.some((tab) => tab.key === externalTabRequest.tab)
          ? externalTabRequest.tab
          : fallbackTab,
      );
    }, 0);
    return () => clearTimeout(id);
  }, [externalTabRequest, fallbackTab, showToolActivity, tabs]);

  useEffect(() => {
    if (tabs.some((tab) => tab.key === activeTab)) return;
    const id = setTimeout(() => setActiveTab(fallbackTab), 0);
    return () => clearTimeout(id);
  }, [activeTab, fallbackTab, tabs]);

  // Mount the review tab on first open, then keep it mounted to preserve state.
  useEffect(() => {
    if (activeTab !== 'review' || reviewTabMounted) return;
    const id = setTimeout(() => setReviewTabMounted(true), 0);
    return () => clearTimeout(id);
  }, [activeTab, reviewTabMounted]);

  useEffect(() => {
    if (capabilities.canCommitAndPush) return;
    if (!commitTargetSheetOpen) return;
    const id = setTimeout(() => {
      setCommitTargetSheetOpen(false);
      setCommitTargetError(null);
    }, 0);
    return () => clearTimeout(id);
  }, [capabilities.canCommitAndPush, commitTargetSheetOpen]);

  useEffect(() => {
    const id = setTimeout(() => {
      setReviewDiffSelection(null);
      setDiffJumpTarget(null);
    }, 0);
    return () => clearTimeout(id);
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

  const handleExportScratchpadToRepo = useCallback(async () => {
    if (!sandboxId) {
      toast.error('Sandbox is not ready.');
      return;
    }
    try {
      const result = await writeToSandbox(sandboxId, '/workspace/SCRATCHPAD.md', scratchpadContent);
      if (result.ok) {
        toast.success('Saved to /workspace/SCRATCHPAD.md');
      } else {
        toast.error(result.error ?? 'Failed to save scratchpad to repo.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save scratchpad to repo.');
    }
  }, [sandboxId, scratchpadContent]);

  const runCommitAndPush = useCallback(
    async (target: CommitPushTarget) => {
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
        updateCommitPhase('error');
        setCommitError(
          'No AI provider configured. Add an API key in Settings to enable the Auditor.',
        );
        return;
      }

      setCommitError(null);
      try {
        // Fetch the working-tree diff up front: it's invariant across the fork
        // (forkBranchFromUI carries the working tree), and the auto-branch
        // namer needs it. Empty diff → nothing to commit.
        updateCommitPhase('fetching-diff');
        const diffResult = await getSandboxDiff(sandboxId);
        if (!diffResult.diff) {
          updateCommitPhase('error');
          setCommitError('Nothing to commit — no changes detected.');
          return;
        }

        let effectiveBranchName = target.mode === 'new' ? target.branchName : currentBranchName;
        let isNewBranch = target.mode === 'new';

        if (target.mode === 'new' && target.branchName) {
          updateCommitPhase('branching');
          if (!forkBranchFromUI) {
            updateCommitPhase('error');
            setCommitError('New-branch flow is not available in this surface.');
            return;
          }
          // Preflight existence check before the fork migrates the
          // conversation. sandbox_create_branch (via forkBranchFromUI) catches
          // local collisions on its own, but a remote-only collision would
          // let us create the branch locally + migrate the chat, then either
          // silently fast-forward into someone else's branch or reject at
          // push after the user is already committed. Fail fast with a clear
          // message instead. ls-remote network failures fall through (the
          // `>/dev/null 2>&1` wrap turns transport errors into "not present"
          // — same as the prior implementation).
          const escapedBranchName = shellEscape(target.branchName);
          const authPrefix = gitHubAuthCommandPrefix();
          const preflight = await execInSandbox(
            sandboxId,
            `cd /workspace && if git show-ref --verify --quiet refs/heads/${escapedBranchName}; then echo "__PUSH_BRANCH_EXISTS_LOCAL__"; exit 10; fi && if git ${authPrefix}ls-remote --exit-code --heads origin ${escapedBranchName} >/dev/null 2>&1; then echo "__PUSH_BRANCH_EXISTS_REMOTE__"; exit 11; fi`,
          );
          if (preflight.exitCode === 10 || preflight.exitCode === 11) {
            updateCommitPhase('error');
            setCommitError(`Branch "${target.branchName}" already exists.`);
            return;
          }
          // Route through the slice 2 fork path (sandbox_create_branch +
          // applyBranchSwitchPayload with kind: 'forked'). This atomically
          // backfills the active conversation's existing messages with the
          // OLD branch, sets conv.branch to the new branch, and inserts a
          // branch_forked event — so the user stays in the same session and
          // their chat follows onto the new branch instead of the per-branch
          // filter routing them to a different chat.
          const forkResult = await forkBranchFromUI(target.branchName);
          if (!forkResult.ok) {
            updateCommitPhase('error');
            setCommitError(forkResult.errorMessage ?? 'Branch switch failed.');
            return;
          }
        } else if (target.mode === 'current' && isOnMain && forkBranchFromUI) {
          // auto-branch-on-commit: a commit must never land on the default
          // branch. Fork to a model-named (deterministic-fallback) branch via
          // the same typed path, migrating the chat onto it. The seam no-ops
          // when the flag is off or HEAD is already off the default branch, so
          // flag-off behaves exactly as before. (Protect-Main-on already
          // blocks the mode==='current' path above; this covers the
          // Protect-Main-off case where committing to main would otherwise be
          // allowed.)
          updateCommitPhase('branching');
          const auto = await ensureCommitTargetBranch({
            sandboxId,
            currentBranch: branchProps.currentBranch,
            defaultBranch: branchProps.defaultBranch,
            diff: diffResult.diff,
            commitMessage: message,
            proposeName: createModelCommitBranchNameProposer({
              providerOverride: lockedProvider || undefined,
              modelOverride: lockedModel || undefined,
            }),
            fork: (branch) => forkBranchFromUI(branch),
          });
          if (auto.switched) {
            effectiveBranchName = auto.branch;
            isNewBranch = true;
          }
        }

        // Phase: Auditing — opt-out, default on (see useAuditorGate). When the
        // gate is disabled for this repo, skip the review and commit directly.
        if (getIsAuditorGateEnabled(repoFullName)) {
          updateCommitPhase('auditing');
          let fileContexts: AuditorFileContext[] = [];
          try {
            const filePaths = parseDiffStats(diffResult.diff).fileNames;
            fileContexts = await fetchAuditorFileContexts(filePaths, async (path) => {
              const result = await readFromSandbox(sandboxId, `/workspace/${path}`);
              if (result.error) return null;
              return { content: result.content, truncated: result.truncated };
            });
          } catch {
            // Degrade gracefully — proceed with diff-only
          }
          const auditResult = await runAuditor(
            diffResult.diff,
            () => {},
            {
              repoFullName,
              activeBranch: effectiveBranchName,
              defaultBranch: branchProps.defaultBranch,
              source: 'working-tree-commit',
              sourceLabel: isNewBranch
                ? `Working tree commit after branching to ${effectiveBranchName}`
                : `Working tree commit on ${effectiveBranchName}`,
              projectInstructions,
            },
            undefined,
            {
              providerOverride: lockedProvider || undefined,
              modelOverride: lockedModel || undefined,
            },
            fileContexts,
          );
          if (auditResult.verdict === 'unsafe') {
            updateCommitPhase('error');
            setCommitError(`Commit blocked by Auditor: ${auditResult.card.summary}`);
            return;
          }
        }

        // Phase: Committing + Pushing through the gated PushGit so the
        // deterministic pre-push secret scan covers this surface — previously
        // the hub committed and pushed via raw `git push`, bypassing the scan
        // every other commit surface runs (auto-branch → auto-push →
        // secret-scan only holds if every push is gated). The commit is local
        // (doctrinally fine); the push is the boundary the scan defends.
        updateCommitPhase('committing');
        const pushGit = createSandboxPushGit(sandboxId, { secretScan: true });
        const commit = await pushGit.commit({ message });
        if (!commit.ok) {
          notifyWorkspaceMutation(sandboxId);
          const detail =
            commit.result?.stderr || commit.result?.stdout || commit.reason || 'Unknown git error';
          updateCommitPhase('error');
          setCommitError(`Commit failed: ${detail}`);
          return;
        }

        updateCommitPhase('pushing');
        const pushResult = await pushGit.push(
          isNewBranch
            ? { setUpstream: true, ref: `HEAD:refs/heads/${effectiveBranchName}` }
            : undefined,
        );
        if (!pushResult.ok) {
          // A secret-scan block is a policy refusal, not a transport failure —
          // surface the reason verbatim.
          const detail = pushResult.stderr || pushResult.stdout || 'Unknown git error';
          updateCommitPhase('error');
          setCommitError(pushResult.blocked ? detail : `Push failed: ${detail}`);
          return;
        }

        // Success
        updateCommitPhase('success');
        toast.success(`Committed & pushed to ${effectiveBranchName}.`);
        if (isNewBranch) {
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
        updateCommitPhase('error');
        setCommitError(err instanceof Error ? err.message : 'Commit failed');
      }
    },
    [
      sandboxId,
      commitMessage,
      blockedByProtectMain,
      branchProps,
      currentBranchName,
      isOnMain,
      lockedModel,
      lockedProvider,
      forkBranchFromUI,
      projectInstructions,
      repoFullName,
      updateCommitPhase,
    ],
  );

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
      const stream = getProviderPushStream(activeProvider);
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

      const { error: streamError, text: accumulated } = await iteratePushStreamText(
        stream,
        {
          provider: activeProvider,
          model: modelId ?? '',
          messages: llmMessages,
          systemPromptOverride: COMMIT_MESSAGE_SUGGEST_SYSTEM_PROMPT,
          hasSandbox: false,
        },
        COMMIT_MESSAGE_SUGGEST_TIMEOUT_MS,
        `Commit message suggestion timed out after ${COMMIT_MESSAGE_SUGGEST_TIMEOUT_MS / 1000}s.`,
      );
      if (streamError) {
        throw streamError;
      }

      const suggested = normalizeSuggestedCommitMessage(accumulated);
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
      const stream = getProviderPushStream(activeProvider);
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
      ]
        .filter(Boolean)
        .join('\n');

      const llmMessages: ChatMessage[] = [
        {
          id: 'branch-name-suggest',
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
      ];

      const { error: streamError, text: accumulated } = await iteratePushStreamText(
        stream,
        {
          provider: activeProvider,
          model: modelId ?? '',
          messages: llmMessages,
          systemPromptOverride: BRANCH_NAME_SUGGEST_SYSTEM_PROMPT,
          hasSandbox: false,
        },
        BRANCH_NAME_SUGGEST_TIMEOUT_MS,
        `Branch name suggestion timed out after ${BRANCH_NAME_SUGGEST_TIMEOUT_MS / 1000}s.`,
      );
      if (streamError) {
        throw streamError;
      }

      const suggested = normalizeSuggestedBranchName(accumulated, branchSuggestionPrefix);
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
  const handleBranchSwitch = useCallback(
    (branch: string) => {
      if (branch === branchProps.currentBranch) return;
      setSwitchConfirmBranch(branch);
      setSwitchError(null);
      if (!sandboxReady || !sandboxId) {
        setSwitchProbe({
          branch,
          loading: false,
          dirty: false,
          changedFiles: 0,
          unknown: false,
          noSandbox: true,
        });
        return;
      }

      setSwitchProbe({
        branch,
        loading: true,
        dirty: true,
        changedFiles: 0,
        unknown: true,
        noSandbox: false,
      });
      void (async () => {
        try {
          const diffResult = await getSandboxDiff(sandboxId);
          const status = diffResult.git_status;
          const unknown = typeof status !== 'string';
          const changedFiles = countGitStatusEntries(status);
          setSwitchProbe((current) => {
            if (!current || current.branch !== branch) return current;
            return {
              branch,
              loading: false,
              dirty: unknown || changedFiles > 0,
              changedFiles,
              unknown,
              noSandbox: false,
            };
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unable to inspect sandbox changes.';
          setSwitchProbe((current) => {
            if (!current || current.branch !== branch) return current;
            return {
              branch,
              loading: false,
              dirty: true,
              changedFiles: 0,
              unknown: true,
              noSandbox: false,
              errorMessage: message,
            };
          });
        }
      })();
    },
    [branchProps.currentBranch, sandboxId, sandboxReady],
  );

  const closeBranchSwitchDialog = useCallback(() => {
    setSwitchConfirmBranch(null);
    setSwitchProbe(null);
    setSwitchError(null);
    setSwitchingBranch(null);
  }, []);

  const cleanSwitchBranch = useCallback(() => {
    if (!switchConfirmBranch) return;
    setSwitchingBranch({ branch: switchConfirmBranch, mode: 'clean' });
    branchProps.onSwitchBranch(switchConfirmBranch);
    setBranchDropdownOpen(false);
    closeBranchSwitchDialog();
  }, [branchProps, closeBranchSwitchDialog, switchConfirmBranch]);

  const confirmBranchSwitch = useCallback(async () => {
    if (!switchConfirmBranch) return;
    if (!sandboxReady || !sandboxId || !branchProps.onWarmSwitchBranch) {
      cleanSwitchBranch();
      return;
    }

    setSwitchingBranch({ branch: switchConfirmBranch, mode: 'warm' });
    setSwitchError(null);
    try {
      const result = await branchProps.onWarmSwitchBranch(switchConfirmBranch);
      if (!result.ok) {
        setSwitchError(result.errorMessage || 'Failed to switch branches.');
        return;
      }
      setBranchDropdownOpen(false);
      closeBranchSwitchDialog();
    } finally {
      setSwitchingBranch((current) =>
        current?.branch === switchConfirmBranch && current.mode === 'warm' ? null : current,
      );
    }
  }, [
    branchProps,
    cleanSwitchBranch,
    closeBranchSwitchDialog,
    sandboxId,
    sandboxReady,
    switchConfirmBranch,
  ]);

  const handleDeleteBranch = useCallback(
    async (branchName: string) => {
      setDeletingBranch(branchName);
      try {
        await branchProps.onDeleteBranch(branchName);
      } finally {
        setDeletingBranch((prev) => (prev === branchName ? null : prev));
      }
    },
    [branchProps],
  );

  // ---- Effects ----
  useEffect(() => {
    if (!open) {
      const id = setTimeout(() => {
        updateCommitPhase('idle');
        setCommitError(null);
        setCommitTargetSheetOpen(false);
        setCommitTargetError(null);
        setBranchDropdownOpen(false);
        setSwitchConfirmBranch(null);
        branchSuggestionAttemptedRef.current = false;
      }, 0);
      return () => clearTimeout(id);
    }
  }, [open, updateCommitPhase]);

  useEffect(() => {
    const id = setTimeout(() => {
      updateCommitPhase('idle');
      setCommitError(null);
    }, 0);
    return () => clearTimeout(id);
  }, [activeTab, updateCommitPhase]);

  useEffect(() => {
    const id = setTimeout(() => {
      setCommitTargetSheetOpen(false);
      setCommitTargetError(null);
      setCommitTargetMode(blockedByProtectMain ? 'new' : 'current');
      setNewBranchName('');
      branchSuggestionAttemptedRef.current = false;
    }, 0);
    return () => clearTimeout(id);
  }, [repoFullName, branchProps.currentBranch, blockedByProtectMain]);

  useEffect(() => {
    if (!showToolActivity && activeTab === 'console') {
      const id = setTimeout(() => setActiveTab('files'), 0);
      return () => clearTimeout(id);
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
        overlayClassName="bg-transparent"
        className={`w-[94vw] rounded-l-2xl border-l ${HUB_GLASS_PANEL_CLASS} p-0 text-push-fg shadow-push-glass sm:max-w-none [&>[data-slot=sheet-close]]:hidden`}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>
            {workspaceMode === 'chat'
              ? 'Chat Panel'
              : isDaemonMode
                ? 'Daemon Hub'
                : 'Workspace Hub'}
          </SheetTitle>
          <SheetDescription>
            {workspaceMode === 'chat'
              ? 'Notes and settings for chat mode.'
              : isDaemonMode
                ? 'Notes and pinned artifacts for the paired daemon session.'
                : 'Files, notes, review tools, and settings for the current workspace.'}
          </SheetDescription>
        </SheetHeader>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 rounded-tl-2xl bg-gradient-to-b from-white/[0.03] to-transparent" />
        <div className="relative flex h-dvh flex-col overflow-hidden rounded-l-2xl">
          {/* Sky ambient wash behind the header — same atmosphere the chat and
              the chats drawer use, fading out before the tab content so it never
              competes with the dense settings cards below. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-20 z-0 h-48 bg-[radial-gradient(58%_100%_at_50%_0%,rgb(var(--push-accent-rgb)_/_0.17),transparent_72%)] blur-2xl"
          />
          {/* ---- Header ---- */}
          <header className={`border-b ${HUB_GLASS_HAIRLINE} px-3 py-3`}>
            <div className="flex items-center justify-between gap-2">
              {/* Repo + Branch dropdown */}
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-semibold text-push-fg">
                  {workspaceMode === 'chat' ? 'Chat' : isDaemonMode ? 'Hub' : 'Workspace'}
                </p>
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-push-xs text-push-fg-dim">
                    {repoName || (isDaemonMode ? 'Daemon' : 'Workspace')}
                  </span>
                  {workspaceMode === 'scratch' && <span className={HUB_TAG_CLASS}>ephemeral</span>}
                  {capabilities.canManageBranches && branchProps.currentBranch && (
                    <div className="relative">
                      <button
                        onClick={() => {
                          setBranchDropdownOpen((v) => !v);
                          if (!branchDropdownOpen && branchProps.availableBranches.length === 0) {
                            branchProps.onRefreshBranches();
                          }
                        }}
                        className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-7 gap-1 px-2.5 text-push-2xs`}
                      >
                        <BranchWaveIcon className="h-3 w-3" />
                        <span className="max-w-[92px] truncate">{branchProps.currentBranch}</span>
                        <ChevronDown
                          className={`h-3 w-3 transition-transform ${branchDropdownOpen ? 'rotate-180' : ''}`}
                        />
                      </button>

                      {/* Branch dropdown */}
                      {branchDropdownOpen && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => {
                              setBranchDropdownOpen(false);
                              setSwitchConfirmBranch(null);
                            }}
                          />
                          <div
                            className={`menu-pop-in origin-top-left absolute left-0 top-full z-50 mt-2 w-[248px] overflow-hidden ${HUB_PANEL_SURFACE_CLASS}`}
                          >
                            {/* Branch actions */}
                            {isOnMain ? (
                              <button
                                onClick={() => {
                                  setBranchDropdownOpen(false);
                                  branchProps.onShowBranchCreate();
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-push-fg-secondary transition-colors hover:bg-white/[0.04]"
                              >
                                <BranchWaveIcon className="h-3.5 w-3.5" />
                                Create branch
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  setBranchDropdownOpen(false);
                                  branchProps.onShowMergeFlow();
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-emerald-300 transition-colors hover:bg-white/[0.04]"
                              >
                                <MergeShieldIcon className="h-3.5 w-3.5" />
                                Merge into {branchProps.defaultBranch}
                              </button>
                            )}
                            {/* Fork (slice 2): always available regardless of
                                current branch — different semantics from
                                "Create branch" (which is GitHub-side). This
                                forks the current workspace state into a new
                                branch and brings the active conversation
                                along via the slice 2 migration handler. */}
                            <button
                              onClick={() => {
                                setBranchDropdownOpen(false);
                                branchProps.onShowBranchFork();
                              }}
                              className="flex w-full items-center gap-2 border-t border-push-edge/80 px-3 py-2.5 text-xs text-push-sky transition-colors hover:bg-white/[0.04]"
                            >
                              <BranchWaveIcon className="h-3.5 w-3.5" />
                              New Branch from Here
                            </button>
                            <div className="border-t border-push-edge/80" />

                            {/* Refresh */}
                            <button
                              onClick={() => branchProps.onRefreshBranches()}
                              disabled={branchProps.branchesLoading}
                              className="flex w-full items-center gap-2 px-3 py-2 text-push-xs text-push-fg-dim transition-colors hover:bg-white/[0.04] hover:text-push-fg-secondary disabled:opacity-50"
                            >
                              <RefreshCw
                                className={`h-3 w-3 ${branchProps.branchesLoading ? 'animate-spin' : ''}`}
                              />
                              Refresh branches
                            </button>
                            <div className="border-t border-push-edge/80" />

                            {/* Branch list */}
                            <div className="max-h-[260px] overflow-y-auto py-1">
                              {branchProps.branchesLoading &&
                                branchProps.availableBranches.length === 0 && (
                                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-push-fg-dim">
                                    <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                                  </div>
                                )}
                              {branchProps.availableBranches.map((branch) => {
                                const isActive = branch.name === branchProps.currentBranch;
                                return (
                                  <BranchListItem
                                    key={branch.name}
                                    name={branch.name}
                                    isDefault={branch.isDefault}
                                    isActive={isActive}
                                    canDelete={!isActive && !branch.isDefault}
                                    isDeleting={deletingBranch === branch.name}
                                    anyDeleting={deletingBranch !== null}
                                    onSwitch={() => handleBranchSwitch(branch.name)}
                                    onDelete={() => void handleDeleteBranch(branch.name)}
                                  />
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
                  className="flex items-center justify-center p-1 text-push-fg-dim transition-colors hover:text-push-fg-secondary"
                  aria-label="Close workspace hub"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </header>

          {/* Sandbox status strip */}
          {sandboxStatus !== 'ready' && (
            <div
              className={`flex items-center justify-between gap-2 ${HUB_GLASS_STRIP_CLASS} px-3 py-2`}
            >
              <div className="min-w-0 flex items-center gap-2">
                {sandboxStatus === 'creating' || sandboxStatus === 'reconnecting' ? (
                  <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-push-fg-dim" />
                ) : sandboxStatus === 'error' ? (
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-400" />
                ) : (
                  <SandboxCubeIcon className="h-3 w-3 flex-shrink-0 text-push-fg-dim" />
                )}
                <span className="min-w-0 truncate text-push-xs">
                  {sandboxStatus === 'reconnecting' && (
                    <span className="text-push-fg-dim">Reconnecting…</span>
                  )}
                  {sandboxStatus === 'creating' && (
                    <span className="text-push-fg-dim">Starting sandbox…</span>
                  )}
                  {sandboxStatus === 'idle' && (
                    <span className="text-push-fg-dim">
                      {snapshotInfo
                        ? `Sandbox hibernated · snapshot ${formatSnapshotAge(snapshotInfo.createdAt)}`
                        : 'Sandbox not running'}
                    </span>
                  )}
                  {sandboxStatus === 'error' && (
                    <span className="text-red-400">
                      {sandboxError ? categorizeSandboxError(sandboxError).title : 'Sandbox error'}
                    </span>
                  )}
                </span>
              </div>
              {(sandboxStatus === 'idle' || sandboxStatus === 'error') && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {sandboxStatus === 'idle' && snapshotInfo && onForgetSandboxSnapshot && (
                    <button
                      onClick={handleForgetSnapshotClick}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-7 gap-1 px-2.5 text-push-fg-dim`}
                      title="Drop the saved snapshot so the next start is a clean clone"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>Forget</span>
                    </button>
                  )}
                  {sandboxStatus === 'error' && sandboxId && (
                    <button
                      onClick={onRetrySandbox}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-7 gap-1 px-2.5 text-amber-300`}
                    >
                      <RefreshCw className="h-3 w-3" />
                      <span>Retry</span>
                    </button>
                  )}
                  <button
                    onClick={sandboxStatus === 'error' ? onNewSandbox : onStartSandbox}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-7 gap-1 px-2.5 text-push-link`}
                  >
                    {sandboxStatus === 'error' ? (
                      <>
                        <Plus className="h-3 w-3" />
                        <span>New</span>
                      </>
                    ) : (
                      <span>{snapshotInfo ? 'Restore' : 'Start'}</span>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Sandbox lifecycle strip (ready) — hibernate to preserve working tree. */}
          {sandboxStatus === 'ready' && sandboxId && onHibernateSandbox && (
            <div
              className={`flex items-center justify-between gap-2 ${HUB_GLASS_STRIP_CLASS} px-3 py-2`}
            >
              <div className="min-w-0 flex items-center gap-2">
                <SandboxCubeIcon className="h-3 w-3 flex-shrink-0 text-push-fg-dim" />
                <span className="min-w-0 truncate text-push-xs text-push-fg-dim">
                  Sandbox live — hibernate to preserve the working tree across sessions
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={handleHibernateClick}
                  disabled={hibernating}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-7 gap-1 px-2.5 text-push-fg-dim disabled:opacity-50`}
                  title="Snapshot the workspace and terminate the container"
                >
                  {hibernating ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  <span>{hibernating ? 'Hibernating…' : 'Hibernate'}</span>
                </button>
              </div>
            </div>
          )}

          {/* On-device checkpoint history — self-gating (native shell + flag),
              renders nothing on web. Sits in the workspace-state zone next to
              hibernate/snapshot. */}
          <CheckpointHistory
            sandboxId={sandboxId}
            repoFullName={repoFullName ?? null}
            branch={branchProps.currentBranch}
            open={open}
          />

          {/* Branch switch confirmation overlay */}
          {switchConfirmBranch && (
            <div className={`border-b ${HUB_GLASS_HAIRLINE} px-3 py-2.5`}>
              <BranchSwitchConfirm
                branch={switchConfirmBranch}
                probe={switchProbe}
                error={switchError}
                switchingMode={switchingBranch?.mode ?? null}
                onConfirm={() => void confirmBranchSwitch()}
                onCancel={closeBranchSwitchDialog}
                onCleanSwitch={cleanSwitchBranch}
              />
            </div>
          )}

          {/* Tab bar — a quiet tool grid. The tabs carry their own (faint) fill
              instead of sitting in a bordered tray, so the only outline in the
              cluster is the active tab's accent ring. Inactive tabs keep a
              transparent border purely to hold their size when one goes active. */}
          <div className={`border-b ${HUB_GLASS_HAIRLINE} px-2 py-2`}>
            <div
              className={`grid gap-1 ${tabs.length >= 7 || tabs.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}
            >
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const active = tab.key === activeTab;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`relative flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border px-1.5 text-push-xs transition-all ${
                      active
                        ? `${GLASS_ACTIVE_CLASS} text-push-fg`
                        : `border-transparent ${GLASS_FILL_FAINT} text-push-fg-dim ${GLASS_FILL_HOVER_SOFT} hover:text-push-fg-secondary`
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 ${active ? 'text-push-accent' : ''}`} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Repo commit bar (shown on Files/Diff tabs when commit/push is meaningful) */}
          {showCommitBar && (
            <div className={`border-b ${HUB_GLASS_HAIRLINE} px-3 py-2`}>
              <div className="flex items-center gap-1.5">
                <input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Commit message"
                  disabled={
                    commitPhase !== 'idle' && commitPhase !== 'success' && commitPhase !== 'error'
                  }
                  className={`${HUB_MATERIAL_INPUT_CLASS} min-w-0 flex-1`}
                />
                <button
                  onClick={() => void suggestCommitMessage()}
                  disabled={
                    suggestingCommitMessage ||
                    (commitPhase !== 'idle' &&
                      commitPhase !== 'success' &&
                      commitPhase !== 'error') ||
                    !sandboxReady
                  }
                  title="Suggest commit message from current diff"
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
                >
                  {suggestingCommitMessage ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  <span>AI</span>
                </button>
                <button
                  onClick={() => {
                    if (commitPhase === 'success' || commitPhase === 'error') {
                      updateCommitPhase('idle');
                      setCommitError(null);
                      return;
                    }
                    openCommitTargetSheet();
                  }}
                  disabled={
                    (commitPhase !== 'idle' &&
                      commitPhase !== 'success' &&
                      commitPhase !== 'error') ||
                    !sandboxReady
                  }
                  className={`relative flex h-8 items-center gap-1.5 rounded-full border px-3 text-push-xs transition-all disabled:opacity-50 ${
                    commitPhase === 'success'
                      ? 'border-emerald-500/35 [background-image:var(--push-surface-success-strong)] text-emerald-300 shadow-[0_12px_30px_rgba(0,0,0,0.32),0_2px_8px_rgba(0,0,0,0.18)]'
                      : commitPhase === 'error'
                        ? 'border-red-500/35 [background-image:var(--push-surface-error-strong)] text-red-300 shadow-[0_12px_30px_rgba(0,0,0,0.32),0_2px_8px_rgba(0,0,0,0.18)]'
                        : `${HUB_MATERIAL_BUTTON_CLASS} text-push-fg-dim`
                  }`}
                >
                  {commitPhase !== 'idle' &&
                  commitPhase !== 'success' &&
                  commitPhase !== 'error' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : commitPhase === 'success' ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <CommitPulseIcon className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {commitPhase === 'idle'
                      ? 'Commit & Push…'
                      : commitPhase === 'success' || commitPhase === 'error'
                        ? 'Reset'
                        : PHASE_LABELS[commitPhase]}
                  </span>
                </button>
              </div>
              {blockedByProtectMain && (
                <p className="mt-1 text-push-2xs text-amber-300">
                  Protect Main is enabled for {branchProps.defaultBranch}.
                </p>
              )}
              {commitPhase !== 'idle' && (
                <div
                  className={`mt-2 rounded-[14px] border ${HUB_GLASS_HAIRLINE} ${GLASS_FILL_FAINT} px-3 py-2.5`}
                >
                  <MultiStepLoader
                    steps={COMMIT_STEPS}
                    currentStep={
                      commitPhase === 'success'
                        ? COMMIT_STEPS.length
                        : commitPhase === 'error'
                          ? lastCommitStep
                          : (COMMIT_PHASE_STEP_INDEX[commitPhase] ?? DEFAULT_COMMIT_STEP)
                    }
                    state={
                      commitPhase === 'success'
                        ? 'success'
                        : commitPhase === 'error'
                          ? 'error'
                          : 'running'
                    }
                    errorMessage={commitError}
                  />
                </div>
              )}
            </div>
          )}

          {/* Sandbox actions replace the repo commit bar in sandbox (no-repo) mode. */}
          {showScratchActionBar && scratchActions && (
            <div className={`border-b ${HUB_GLASS_HAIRLINE} px-3 py-2`}>
              <div className="space-y-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-push-fg-dim">
                    Sandbox Actions
                  </p>
                  <p
                    className={`mt-1 truncate text-push-xs ${scratchActions.tone === 'stale' ? 'text-amber-300' : 'text-push-fg-dim'}`}
                  >
                    {scratchActions.statusText}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={scratchActions.onSaveSnapshot}
                    disabled={!scratchActions.canSaveSnapshot || scratchActions.snapshotRestoring}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 disabled:opacity-50`}
                    title="Save sandbox snapshot"
                  >
                    {scratchActions.snapshotSaving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    <span>Save</span>
                  </button>
                  <button
                    onClick={scratchActions.onRestoreSnapshot}
                    disabled={!scratchActions.canRestoreSnapshot || scratchActions.snapshotSaving}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 disabled:opacity-50`}
                    title="Restore latest sandbox snapshot"
                  >
                    {scratchActions.snapshotRestoring ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    <span>Restore</span>
                  </button>
                  <button
                    onClick={scratchActions.onDownloadWorkspace}
                    disabled={!scratchActions.canDownloadWorkspace}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 disabled:opacity-50`}
                    title="Download sandbox workspace"
                  >
                    {scratchActions.downloadingWorkspace ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    <span>Download</span>
                  </button>
                  {onPublishToGitHub && (
                    <button
                      onClick={() => setPublishSheetOpen(true)}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 text-push-fg-secondary`}
                      title="Create a GitHub repository from this workspace"
                    >
                      <PushOrbitIcon className="h-3.5 w-3.5 text-push-fg-dim" />
                      <span>Publish</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Tab content */}
          <div
            className="min-h-0 flex-1 overflow-hidden"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            {activeTab === 'notes' && (
              <HubNotesTab
                scratchpadContent={scratchpadContent}
                scratchpadMemories={scratchpadMemories}
                activeMemoryId={activeMemoryId}
                onContentChange={onScratchpadContentChange}
                onClear={onScratchpadClear}
                onSaveMemory={onScratchpadSaveMemory}
                onLoadMemory={onScratchpadLoadMemory}
                onDeleteMemory={onScratchpadDeleteMemory}
                onExportToRepo={handleExportScratchpadToRepo}
                sandboxId={sandboxId}
                artifacts={pinnedArtifacts}
                onUnpin={onUnpinArtifact}
                onUpdateLabel={onUpdateArtifactLabel}
                todos={todos}
                onTodoClear={onTodoClear}
                appearance={appearance}
                accentHex={accentHex}
              />
            )}

            {showToolActivity && activeTab === 'console' && (
              <HubConsoleTab messages={messages} agentEvents={agentEvents} runEvents={runEvents} />
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

            {reviewTabMounted && (
              <div
                className={
                  activeTab === 'review'
                    ? 'flex h-full min-h-0 flex-col'
                    : 'hidden h-full min-h-0 flex-col'
                }
              >
                <Suspense fallback={null}>
                  <HubReviewTab
                    sandboxId={sandboxId}
                    sandboxStatus={sandboxStatus}
                    ensureSandbox={ensureSandbox}
                    availableProviders={reviewProviders}
                    activeProvider={reviewActiveProvider}
                    providerModelOptions={reviewModelOptions}
                    repoFullName={repoFullName}
                    activeBranch={branchProps.currentBranch}
                    defaultBranch={branchProps.defaultBranch}
                    projectInstructions={projectInstructions}
                    protectMain={protectMainEnabled}
                    canBrowsePullRequests={capabilities.canBrowsePullRequests}
                    onOpenDiff={handleOpenReviewDiff}
                    onFixFinding={onFixReviewFinding}
                  />
                </Suspense>
              </div>
            )}

            {activeTab === 'settings' &&
              settingsAuth &&
              settingsProfile &&
              settingsAI &&
              settingsWorkspace &&
              settingsData && (
                <div className="flex h-full min-h-0 flex-col">
                  <Suspense fallback={null}>
                    <HubSettingsTab
                      key={`settings-${open ? 'open' : 'closed'}`}
                      auth={settingsAuth}
                      profile={settingsProfile}
                      ai={settingsAI}
                      workspace={settingsWorkspace}
                      data={settingsData}
                      onCloseHub={() => onOpenChange(false)}
                    />
                  </Suspense>
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
              className={`border-t ${HUB_GLASS_PANEL_CLASS} px-0 pb-6 pt-0 text-push-fg`}
            >
              <SheetHeader className={`border-b ${HUB_GLASS_HAIRLINE} px-4 py-4`}>
                <SheetTitle className="text-push-lg font-display font-semibold text-push-fg">
                  Push target
                </SheetTitle>
                <SheetDescription className="text-xs text-push-fg-dim">
                  Push to the current branch or fork this working tree into a new branch first.
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 px-4 pt-4">
                <div
                  className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3 py-3 ${commitTargetMode === 'current' ? 'border-push-edge-hover' : ''}`}
                >
                  <button
                    onClick={() => {
                      if (blockedByProtectMain) return;
                      setCommitTargetMode('current');
                      setCommitTargetError(null);
                    }}
                    disabled={blockedByProtectMain}
                    className={`w-full text-left ${blockedByProtectMain ? 'opacity-50' : ''}`}
                    aria-label="Push to current branch"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-push-fg">Current branch</p>
                          <span className={HUB_TAG_CLASS}>{currentBranchName}</span>
                        </div>
                        <p className="mt-1 text-xs text-push-fg-dim">
                          Commit and push directly to the active branch.
                        </p>
                      </div>
                      <span className={HUB_TAG_CLASS}>
                        {commitTargetMode === 'current' ? 'selected' : 'available'}
                      </span>
                    </div>
                  </button>
                  {blockedByProtectMain && (
                    <p className="mt-2 text-push-xs text-amber-300">
                      Protect Main blocks direct pushes to {branchProps.defaultBranch}.
                    </p>
                  )}
                </div>

                <div
                  className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3 py-3 ${commitTargetMode === 'new' ? 'border-push-edge-hover' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
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
                      className="min-w-0 flex-1 text-left"
                      aria-label="Push to a new branch"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-push-fg">New branch</p>
                        <span className={HUB_TAG_CLASS}>from {currentBranchName}</span>
                      </div>
                      <p className="mt-1 text-xs text-push-fg-dim">
                        Create a new branch from the current working tree, then commit and push
                        there.
                      </p>
                    </button>
                    <span className={HUB_TAG_CLASS}>
                      {commitTargetMode === 'new' ? 'selected' : 'available'}
                    </span>
                  </div>

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
                      className={`${HUB_MATERIAL_INPUT_CLASS} h-10 min-w-0 flex-1 px-3 text-sm`}
                    />
                    <button
                      onClick={() => {
                        setCommitTargetMode('new');
                        branchSuggestionAttemptedRef.current = true;
                        void suggestBranchName();
                      }}
                      disabled={suggestingBranchName}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-10 px-3`}
                    >
                      {suggestingBranchName ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      <span>AI</span>
                    </button>
                  </div>

                  {newBranchName &&
                    sanitizedNewBranchName !== newBranchName.toLowerCase().trim() && (
                      <p className="mt-2 text-push-xs text-push-fg-dim">
                        Will create:{' '}
                        <span className="font-mono text-push-fg-secondary">
                          {sanitizedNewBranchName || `${branchSuggestionPrefix}/update-workspace`}
                        </span>
                      </p>
                    )}
                </div>

                <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3 py-2.5`}>
                  <p className="text-push-xs text-push-fg-dim">Commit message</p>
                  <p className="mt-1 truncate text-sm text-push-fg-secondary">
                    {commitMessage.trim() || 'Enter a commit message in the bar above first.'}
                  </p>
                </div>

                {commitTargetError && (
                  <div className="rounded-[18px] border border-red-500/20 bg-red-500/5 px-3 py-2.5">
                    <p className="text-xs text-red-300">{commitTargetError}</p>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCommitTargetConfirm}
                    disabled={suggestingBranchName}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-10 flex-1 justify-center px-4 text-sm text-push-fg-secondary`}
                  >
                    <span>Commit &amp; Push</span>
                  </button>
                  <button
                    onClick={() => setCommitTargetSheetOpen(false)}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-10 px-4 text-sm`}
                  >
                    <span>Cancel</span>
                  </button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
          {onPublishToGitHub && (
            <PublishToGitHubSheet
              open={publishSheetOpen}
              onOpenChange={setPublishSheetOpen}
              onSubmit={onPublishToGitHub}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
