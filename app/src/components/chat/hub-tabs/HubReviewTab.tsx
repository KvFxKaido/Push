import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runReviewer } from '@/lib/reviewer-agent';
import { runDeepReviewer } from '@/lib/deep-reviewer-agent';
import { PrReviewHistorySection } from './PrReviewHistorySection';
import { PrBrowser } from './PrBrowser';
import {
  executePostPRReview,
  fetchGitHubReviewDiff,
  fetchLatestCommitDiff,
} from '@/lib/github-tools';
import { resolveReviewGuidance } from '@/lib/review-guidance';
import { parseDiffStats } from '@/lib/diff-utils';
import { type ActiveProvider } from '@/lib/orchestrator';
import {
  OLLAMA_DEFAULT_MODEL,
  OPENROUTER_DEFAULT_MODEL,
  ZAI_DEFAULT_MODEL,
  KIMI_DEFAULT_MODEL,
  HUGGINGFACE_DEFAULT_MODEL,
  CLOUDFLARE_DEFAULT_MODEL,
  ZEN_DEFAULT_MODEL,
  NVIDIA_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_MODEL,
  OPENAI_DEFAULT_MODEL,
  XAI_DEFAULT_MODEL,
  GOOGLE_DEFAULT_MODEL,
  FIREWORKS_DEFAULT_MODEL,
  SAKANA_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
  getModelForRole,
  type PreferredProvider,
} from '@/lib/providers';
import { ModelPicker } from '@/components/ui/model-picker';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import { getSetting, SETTINGS_KEYS, setSetting } from '@/lib/settings-store';
import {
  GLASS_FILL_HOVER_FAINT,
  GLASS_FILL_SOFT,
  HUB_GLASS_HAIRLINE,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_TAG_CLASS,
} from '@/components/chat/hub-styles';
import type { DiffPreviewCardData, ReviewResult, ReviewComment, ReviewDepth } from '@/types';
import { DiffSeamIcon, SendLiftIcon } from '@/components/icons/push-custom-icons';
import { PushMarkdownRenderer } from '@/components/chat/PushMarkdownRenderer';

interface HubReviewTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
  availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  activeProvider: ActiveProvider;
  providerModelOptions?: Partial<Record<PreferredProvider, string[]>>;
  /** owner/name — undefined in Sandbox Mode or when no repo is selected */
  repoFullName?: string;
  /** active branch name — used to find an open PR */
  activeBranch?: string;
  /** default branch name — used for GitHub branch-vs-default review */
  defaultBranch?: string;
  /** project instructions loaded for this repo, if available */
  projectInstructions?: string | null;
  /** Whether Protect Main is enabled for the current repo context */
  protectMain?: boolean;
  /** Whether the signed-in identity may browse this repo's pull requests */
  canBrowsePullRequests?: boolean;
  onOpenDiff: (payload: {
    diffData: DiffPreviewCardData;
    label: string;
    mode: 'review-github' | 'review-sandbox';
    // Optional: the PR browser opens a whole-PR diff with no line target, while
    // a review finding jumps to a specific path/line.
    target?: { path: string; line?: number };
  }) => void;
  onFixFinding?: (prompt: string) => void;
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

type SavedReviewPayload = {
  version: 1;
  savedAt: number;
  reviewSource: ReviewSourceMode;
  result: ReviewResult;
  reviewContext: ReviewContext | null;
  reviewDiffData: DiffPreviewCardData | null;
  diffStorageTruncated: boolean;
};

// Segmented toggle pills (review source / depth / provider) — secondary
// controls that read as borderless fills instead of another ring of bordered
// chips competing with the active tool tab and the Run button. Selected lifts on
// the soft fill; the rest are quiet ghost text with a faint hover; disabled
// (e.g. while a review is running) dims. Composes the named glass fill scale, so
// the tints can't drift onto an undocumented opacity. Kept local to its sole
// consumer — hub-styles.tsx can't export a function (react-refresh rule), and
// per repo convention a helper is promoted only once a second surface needs it.
const glassSegmentPillClass = (active: boolean): string =>
  `rounded-full px-2.5 py-1 text-push-xs font-medium transition-colors disabled:opacity-50 ${
    active
      ? `${GLASS_FILL_SOFT} text-push-fg`
      : `text-push-fg-dim ${GLASS_FILL_HOVER_FAINT} hover:text-push-fg-secondary`
  }`;

// Pre-unification localStorage keys for the in-app advisory reviewer picks. Now
// read-only fallbacks: the provider + per-provider model picks live in the
// unified settings doc (reviewer.advisory.*). Saved-review payloads
// (push:review:saved:*) stay device-local — they're cached review results, not
// preferences.
const REVIEW_PROVIDER_KEY = 'push:review:selected-provider';
const SAVED_REVIEW_STORAGE_PREFIX = 'push:review:saved:';
const MAX_SAVED_REVIEW_DIFF_CHARS = 120_000;
const REVIEW_MODEL_KEYS: Record<PreferredProvider, string> = {
  ollama: 'push:review:model:ollama',
  openrouter: 'push:review:model:openrouter',
  zai: 'push:review:model:zai',
  kimi: 'push:review:model:kimi',
  huggingface: 'push:review:model:huggingface',
  cloudflare: 'push:review:model:cloudflare',
  zen: 'push:review:model:zen',
  nvidia: 'push:review:model:nvidia',
  anthropic: 'push:review:model:anthropic',
  openai: 'push:review:model:openai',
  xai: 'push:review:model:xai',
  google: 'push:review:model:google',
  fireworks: 'push:review:model:fireworks',
  sakana: 'push:review:model:sakana',
  deepseek: 'push:review:model:deepseek',
};

const REVIEW_DEFAULT_MODELS: Record<PreferredProvider, string> = {
  ollama: OLLAMA_DEFAULT_MODEL,
  openrouter: OPENROUTER_DEFAULT_MODEL,
  zai: ZAI_DEFAULT_MODEL,
  kimi: KIMI_DEFAULT_MODEL,
  huggingface: HUGGINGFACE_DEFAULT_MODEL,
  cloudflare: CLOUDFLARE_DEFAULT_MODEL,
  zen: ZEN_DEFAULT_MODEL,
  nvidia: NVIDIA_DEFAULT_MODEL,
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL,
  xai: XAI_DEFAULT_MODEL,
  google: GOOGLE_DEFAULT_MODEL,
  fireworks: FIREWORKS_DEFAULT_MODEL,
  sakana: SAKANA_DEFAULT_MODEL,
  deepseek: DEEPSEEK_DEFAULT_MODEL,
};

function readReviewProvider(): PreferredProvider | null {
  const stored = getSetting<unknown>(SETTINGS_KEYS.reviewerAdvisoryProvider);
  if (typeof stored === 'string' && isPreferredProvider(stored)) return stored;
  // Legacy localStorage fallback.
  const legacy = safeStorageGet(REVIEW_PROVIDER_KEY);
  if (typeof legacy === 'string' && isPreferredProvider(legacy)) return legacy;
  return null;
}

function isPreferredProvider(value: string): value is PreferredProvider {
  return (
    value === 'ollama' ||
    value === 'openrouter' ||
    value === 'zai' ||
    value === 'kimi' ||
    value === 'huggingface' ||
    value === 'cloudflare' ||
    value === 'zen' ||
    value === 'nvidia' ||
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'xai' ||
    value === 'google' ||
    value === 'fireworks' ||
    value === 'deepseek' ||
    value === 'sakana'
  );
}

function readReviewModels(): Record<PreferredProvider, string> {
  const stored = getSetting<unknown>(SETTINGS_KEYS.reviewerAdvisoryModelByProvider);
  const map =
    stored && typeof stored === 'object'
      ? (stored as Partial<Record<PreferredProvider, unknown>>)
      : undefined;
  // Precedence per provider: settings doc → legacy localStorage key → default.
  const pick = (provider: PreferredProvider): string => {
    const fromDoc = map?.[provider];
    if (typeof fromDoc === 'string' && fromDoc.trim()) return fromDoc;
    return safeStorageGet(REVIEW_MODEL_KEYS[provider]) || REVIEW_DEFAULT_MODELS[provider];
  };
  return {
    ollama: pick('ollama'),
    openrouter: pick('openrouter'),
    zai: pick('zai'),
    kimi: pick('kimi'),
    huggingface: pick('huggingface'),
    cloudflare: pick('cloudflare'),
    zen: pick('zen'),
    nvidia: pick('nvidia'),
    fireworks: pick('fireworks'),
    sakana: pick('sakana'),
    deepseek: pick('deepseek'),
    anthropic: pick('anthropic'),
    openai: pick('openai'),
    xai: pick('xai'),
    google: pick('google'),
  };
}

function buildSavedReviewStorageKey(
  reviewSource: ReviewSourceMode,
  repoFullName?: string,
  activeBranch?: string,
): string {
  const repoPart = encodeURIComponent(repoFullName || 'sandbox');
  const branchPart = encodeURIComponent(activeBranch || 'none');
  return `${SAVED_REVIEW_STORAGE_PREFIX}${repoPart}:${branchPart}:${reviewSource}`;
}

function parseSavedReviewPayload(raw: string | null): SavedReviewPayload | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<SavedReviewPayload> | null;
    if (!parsed || parsed.version !== 1) return null;
    if (!parsed.result || typeof parsed.savedAt !== 'number') return null;
    return {
      version: 1,
      savedAt: parsed.savedAt,
      reviewSource:
        parsed.reviewSource === 'github' ||
        parsed.reviewSource === 'commit' ||
        parsed.reviewSource === 'sandbox'
          ? parsed.reviewSource
          : 'sandbox',
      result: parsed.result,
      reviewContext: parsed.reviewContext ?? null,
      reviewDiffData: parsed.reviewDiffData ?? null,
      diffStorageTruncated: Boolean(parsed.diffStorageTruncated),
    };
  } catch {
    return null;
  }
}

function trimDiffForStorage(diffData: DiffPreviewCardData | null): {
  reviewDiffData: DiffPreviewCardData | null;
  diffStorageTruncated: boolean;
} {
  if (!diffData) {
    return { reviewDiffData: null, diffStorageTruncated: false };
  }
  if (diffData.diff.length <= MAX_SAVED_REVIEW_DIFF_CHARS) {
    return { reviewDiffData: diffData, diffStorageTruncated: false };
  }
  return {
    reviewDiffData: {
      ...diffData,
      diff: diffData.diff.slice(0, MAX_SAVED_REVIEW_DIFF_CHARS),
    },
    diffStorageTruncated: true,
  };
}

function severityIcon(severity: ReviewComment['severity']) {
  switch (severity) {
    case 'critical':
      return <AlertTriangle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />;
    case 'warning':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0 mt-0.5" />;
    case 'suggestion':
      return <Sparkles className="h-3.5 w-3.5 text-sky-400 flex-shrink-0 mt-0.5" />;
    case 'note':
      return <Info className="h-3.5 w-3.5 text-push-fg-dim flex-shrink-0 mt-0.5" />;
  }
}

function severityLabel(severity: ReviewComment['severity']) {
  switch (severity) {
    case 'critical':
      return (
        <span className="text-push-2xs font-medium uppercase tracking-wide text-red-400">
          Critical
        </span>
      );
    case 'warning':
      return (
        <span className="text-push-2xs font-medium uppercase tracking-wide text-amber-400">
          Warning
        </span>
      );
    case 'suggestion':
      return (
        <span className="text-push-2xs font-medium uppercase tracking-wide text-sky-400">
          Suggestion
        </span>
      );
    case 'note':
      return (
        <span className="text-push-2xs font-medium uppercase tracking-wide text-push-fg-dim">
          Note
        </span>
      );
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

function buildAutoExpandFiles(comments: ReviewComment[]): Set<string> {
  const autoExpand = new Set<string>();
  for (const comment of comments) {
    if (comment.severity === 'critical' || comment.severity === 'warning') {
      autoExpand.add(comment.file);
    }
  }
  return autoExpand;
}

function severityOrder(s: ReviewComment['severity']): number {
  return { critical: 0, warning: 1, suggestion: 2, note: 3 }[s];
}

function buildFixPrompt(params: {
  comment: ReviewComment;
  reviewContext: ReviewContext | null;
  activeBranch?: string;
  defaultBranch?: string;
}): string {
  const { comment, reviewContext, activeBranch, defaultBranch } = params;

  const reviewContextLine = (() => {
    switch (reviewContext?.kind) {
      case 'sandbox':
        return 'This finding came from a Working tree review of the current workspace changes. Reuse the current sandbox if it is still available.';
      case 'github-pr':
        return `This finding came from the pushed PR diff (${reviewContext.label}). Start from the current branch workspace, but verify against the current sandbox because local code may have diverged from the reviewed snapshot.`;
      case 'github-branch':
        return `This finding came from the pushed branch diff for ${activeBranch ?? 'the active branch'} against ${defaultBranch ?? 'the default branch'}. Verify the current workspace before editing.`;
      case 'github-commit':
        return `This finding came from the latest pushed commit ${reviewContext.shortSha}${activeBranch ? ` on ${activeBranch}` : ''}. The current workspace may differ from that reviewed commit, so verify before editing.`;
      default:
        return 'This finding came from a review run in Push. Inspect the current workspace before deciding on edits.';
    }
  })();

  return [
    'Please investigate and fix the following review finding in the current workspace.',
    '',
    `Target file: ${comment.file}`,
    ...(typeof comment.line === 'number' ? [`Target line: ${comment.line}`] : []),
    `Severity: ${comment.severity}`,
    `Finding: ${comment.comment}`,
    '',
    `Review context: ${reviewContextLine}`,
    '',
    'Instructions:',
    '- Start from the current workspace state, not just the reviewed snapshot.',
    '- Inspect the referenced file and any nearby call sites before editing.',
    '- If the finding is still valid, make the smallest reasonable fix.',
    '- If the current code already differs enough that the finding is stale or invalid, explain that briefly instead of forcing a change.',
    '- After the fix, summarize what changed and mention any follow-up checks worth running.',
  ].join('\n');
}

export function HubReviewTab({
  sandboxId,
  sandboxStatus,
  ensureSandbox,
  availableProviders,
  activeProvider,
  providerModelOptions,
  repoFullName,
  activeBranch,
  defaultBranch,
  projectInstructions,
  protectMain,
  canBrowsePullRequests,
  onOpenDiff,
  onFixFinding,
}: HubReviewTabProps) {
  const providerOptions = useMemo(
    () => availableProviders.map(([type, label]) => ({ type, label })),
    [availableProviders],
  );
  // Branch diff requires a feature branch — on the default branch there's nothing
  // to compare against and fetchGitHubReviewDiff explicitly rejects it.
  // Open PRs with the default branch as head are essentially impossible in practice.
  const hasGitHubSource = Boolean(
    repoFullName && activeBranch && defaultBranch && activeBranch !== defaultBranch,
  );
  const hasCommitSource = Boolean(repoFullName && activeBranch);
  const [selectedProvider, setSelectedProvider] = useState<PreferredProvider | null>(() =>
    readReviewProvider(),
  );
  const [reviewSource, setReviewSource] = useState<ReviewSourceMode>(
    hasGitHubSource ? 'github' : hasCommitSource ? 'commit' : 'sandbox',
  );
  // Top-level Review-tab view: run the advisory review vs. browse this repo's
  // pull requests (inspection only). Independent of the review source so PR
  // browsing stays reachable on the default branch too (where there's no
  // branch-diff source).
  const [reviewView, setReviewView] = useState<'review' | 'pulls'>('review');
  const [selectedModels, setSelectedModels] =
    useState<Record<PreferredProvider, string>>(readReviewModels);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [reviewContext, setReviewContext] = useState<ReviewContext | null>(null);
  const [reviewDiffData, setReviewDiffData] = useState<DiffPreviewCardData | null>(null);
  const [savedReview, setSavedReview] = useState<SavedReviewPayload | null>(null);
  const [savedReviewNotice, setSavedReviewNotice] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [loadedSavedReviewMeta, setLoadedSavedReviewMeta] = useState<{
    savedAt: number;
    diffStorageTruncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewDepth, setReviewDepth] = useState<ReviewDepth>('quick');
  const [running, setRunning] = useState(false);
  const [runningReviewDepth, setRunningReviewDepth] = useState<ReviewDepth | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [postState, setPostState] = useState<'idle' | 'posting' | 'posted' | 'error'>('idle');
  const [postError, setPostError] = useState<string | null>(null);
  const reviewStorageKey = useMemo(
    () => buildSavedReviewStorageKey(reviewSource, repoFullName, activeBranch),
    [activeBranch, repoFullName, reviewSource],
  );

  useEffect(() => {
    const id = setTimeout(() => {
      const nextSelected =
        selectedProvider && providerOptions.some((provider) => provider.type === selectedProvider)
          ? selectedProvider
          : activeProvider !== 'demo' &&
              providerOptions.some((provider) => provider.type === activeProvider)
            ? activeProvider
            : (providerOptions[0]?.type ?? null);

      if (nextSelected !== selectedProvider) {
        setSelectedProvider(nextSelected);
      }

      if (providerOptions.length === 0) {
        setResult(null);
        setReviewDiffData(null);
        setError(null);
      }
    }, 0);
    return () => clearTimeout(id);
  }, [activeProvider, providerOptions, selectedProvider]);

  useEffect(() => {
    const id = setTimeout(() => {
      setSavedReview(parseSavedReviewPayload(safeStorageGet(reviewStorageKey)));
      setSavedReviewNotice(null);
    }, 0);
    return () => clearTimeout(id);
  }, [reviewStorageKey]);

  useEffect(() => {
    setSetting(SETTINGS_KEYS.reviewerAdvisoryProvider, selectedProvider ?? null);
  }, [selectedProvider]);

  useEffect(() => {
    const needsReset =
      (reviewSource === 'github' && !hasGitHubSource) ||
      (reviewSource === 'commit' && !hasCommitSource);
    if (needsReset) {
      const id = setTimeout(() => {
        setReviewSource('sandbox');
        setResult(null);
        setReviewContext(null);
        setReviewDiffData(null);
        setError(null);
        setSavedReviewNotice(null);
        setLoadedSavedReviewMeta(null);
        setPostState('idle');
        setPostError(null);
      }, 0);
      return () => clearTimeout(id);
    }
  }, [hasCommitSource, hasGitHubSource, reviewSource]);

  const handleProviderChange = useCallback((p: PreferredProvider) => {
    setSelectedProvider(p);
  }, []);

  const handleModelChange = useCallback(
    (nextModel: string) => {
      if (!selectedProvider) return;
      const value = nextModel.trim() || REVIEW_DEFAULT_MODELS[selectedProvider];
      const next = { ...selectedModels, [selectedProvider]: value };
      setSelectedModels(next);
      setSetting(SETTINGS_KEYS.reviewerAdvisoryModelByProvider, next);
    },
    [selectedModels, selectedProvider],
  );

  const handleSourceChange = useCallback((source: ReviewSourceMode) => {
    setReviewSource(source);
    setResult(null);
    setReviewContext(null);
    setReviewDiffData(null);
    setError(null);
    setStatus(null);
    setSavedReviewNotice(null);
    setLoadedSavedReviewMeta(null);
    setExpandedFiles(new Set());
    setPostState('idle');
    setPostError(null);
  }, []);

  const toggleFile = useCallback((file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) {
        next.delete(file);
      } else {
        next.add(file);
      }
      return next;
    });
  }, []);

  const handlePostToPR = useCallback(async () => {
    if (!result || !repoFullName || reviewContext?.kind !== 'github-pr') return;
    setPostState('posting');
    setPostError(null);
    try {
      await executePostPRReview(
        repoFullName,
        reviewContext.pr.number,
        reviewContext.pr.commitSha,
        result,
        undefined,
        // Reviewed diff — on a 422 it salvages the valid inline anchors rather
        // than folding every comment into the body.
        reviewDiffData?.diff,
      );
      setPostState('posted');
    } catch (err) {
      setPostState('error');
      setPostError(err instanceof Error ? err.message : 'Failed to post review.');
    }
  }, [result, repoFullName, reviewContext, reviewDiffData]);

  const handleOpenCommentInDiff = useCallback(
    (file: string, line?: number) => {
      if (!reviewDiffData || !reviewContext) return;
      onOpenDiff({
        diffData: reviewDiffData,
        label:
          reviewContext.kind === 'sandbox' ? 'Working tree review snapshot' : reviewContext.label,
        mode: reviewContext.kind === 'sandbox' ? 'review-sandbox' : 'review-github',
        target: { path: file, ...(line !== undefined ? { line } : {}) },
      });
    },
    [onOpenDiff, reviewContext, reviewDiffData],
  );

  const selectedDefaultModel = selectedProvider ? REVIEW_DEFAULT_MODELS[selectedProvider] : '';
  const selectedReviewModelInput = selectedProvider ? (selectedModels[selectedProvider] ?? '') : '';
  const selectedReviewModel = selectedProvider
    ? selectedReviewModelInput.trim() || selectedDefaultModel
    : '';

  const modelOptionsForProvider = useMemo(() => {
    if (!selectedProvider || !providerModelOptions) return [];
    const options = providerModelOptions[selectedProvider] ?? [];
    const active =
      selectedModels[selectedProvider]?.trim() || REVIEW_DEFAULT_MODELS[selectedProvider];
    if (!active || options.includes(active)) return options;
    return [active, ...options];
  }, [selectedProvider, providerModelOptions, selectedModels]);
  const isCurrentReviewSaved = Boolean(
    result && savedReview && savedReview.result.reviewedAt === result.reviewedAt,
  );

  const applySavedReview = useCallback(
    (payload: SavedReviewPayload) => {
      setResult(payload.result);
      setReviewContext(payload.reviewContext);
      setReviewDiffData(payload.reviewDiffData);
      setExpandedFiles(buildAutoExpandFiles(payload.result.comments));
      setError(null);
      setStatus(null);
      setPostState('idle');
      setPostError(null);
      setLoadedSavedReviewMeta({
        savedAt: payload.savedAt,
        diffStorageTruncated: payload.diffStorageTruncated,
      });

      if (isPreferredProvider(payload.result.provider)) {
        setSelectedModels((prev) => ({
          ...prev,
          [payload.result.provider]: payload.result.model,
        }));
        if (providerOptions.some((provider) => provider.type === payload.result.provider)) {
          setSelectedProvider(payload.result.provider);
        }
      }
    },
    [providerOptions],
  );

  const handleSaveReview = useCallback(() => {
    if (!result) {
      setSavedReviewNotice({ tone: 'error', text: 'Run a review before saving it locally.' });
      return;
    }

    const trimmed = trimDiffForStorage(reviewDiffData);
    const payload: SavedReviewPayload = {
      version: 1,
      savedAt: Date.now(),
      reviewSource,
      result,
      reviewContext,
      reviewDiffData: trimmed.reviewDiffData,
      diffStorageTruncated: trimmed.diffStorageTruncated,
    };

    if (!safeStorageSet(reviewStorageKey, JSON.stringify(payload))) {
      const fallbackPayload: SavedReviewPayload = {
        ...payload,
        reviewDiffData: null,
        diffStorageTruncated: true,
      };
      if (!safeStorageSet(reviewStorageKey, JSON.stringify(fallbackPayload))) {
        setSavedReviewNotice({ tone: 'error', text: 'Failed to save review locally.' });
        return;
      }
      setSavedReview(fallbackPayload);
      setSavedReviewNotice({
        tone: 'info',
        text: 'Review saved locally without a diff snapshot due to storage limits.',
      });
      return;
    }

    setSavedReview(payload);
    setSavedReviewNotice({
      tone: trimmed.diffStorageTruncated ? 'info' : 'success',
      text: trimmed.diffStorageTruncated
        ? 'Review saved locally. The diff snapshot was trimmed for storage.'
        : 'Review saved locally.',
    });
  }, [result, reviewContext, reviewDiffData, reviewSource, reviewStorageKey]);

  const handleLoadSavedReview = useCallback(() => {
    if (!savedReview) return;
    applySavedReview(savedReview);
    setSavedReviewNotice({
      tone: 'info',
      text: savedReview.diffStorageTruncated
        ? 'Loaded saved review. The stored diff snapshot was trimmed for local storage.'
        : 'Loaded saved review.',
    });
  }, [applySavedReview, savedReview]);

  const handleClearSavedReview = useCallback(() => {
    safeStorageRemove(reviewStorageKey);
    setSavedReview(null);
    setSavedReviewNotice({ tone: 'success', text: 'Cleared saved review for this scope.' });
    setLoadedSavedReviewMeta(null);
  }, [reviewStorageKey]);

  const handleRunReview = useCallback(async () => {
    if (running || !selectedProvider) return;

    const requestedReviewDepth = reviewDepth;
    setRunning(true);
    setRunningReviewDepth(requestedReviewDepth);
    setError(null);
    setResult(null);
    setReviewContext(null);
    setReviewDiffData(null);
    setStatus(null);
    setSavedReviewNotice(null);
    setLoadedSavedReviewMeta(null);
    setExpandedFiles(new Set());
    setPostState('idle');
    setPostError(null);

    try {
      let diff = '';
      let nextContext: ReviewContext | null = null;
      let ensuredSandboxId: string | null = sandboxId;

      if (reviewSource === 'github') {
        if (!repoFullName || !activeBranch || !defaultBranch) {
          setError('GitHub review is not available for this workspace.');
          return;
        }
        setStatus('Resolving branch / PR diff…');
        const githubDiff = await fetchGitHubReviewDiff(repoFullName, activeBranch, defaultBranch);
        diff = githubDiff.diff;
        nextContext =
          githubDiff.source === 'pr' && githubDiff.pr
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
        // `id` may have just been ensured this run, while the `sandboxId` prop
        // is still null until state propagates. Track the resolved id so the
        // working-tree review reads REVIEW.md (and symbols) from the live
        // sandbox instead of falling back to GitHub on first run.
        ensuredSandboxId = id;
      }

      if (!diff?.trim()) {
        setError(
          reviewSource === 'github'
            ? 'No GitHub changes to review. Push your branch or open a PR first.'
            : 'No working tree changes to review. Make some edits first.',
        );
        return;
      }

      const reviewSourceForPrompt =
        nextContext.kind === 'github-pr'
          ? 'pr-diff'
          : nextContext.kind === 'github-branch'
            ? 'branch-diff'
            : nextContext.kind === 'github-commit'
              ? 'last-commit'
              : 'working-tree';
      const reviewerSandboxId =
        nextContext.kind === 'sandbox'
          ? ensuredSandboxId || undefined
          : sandboxStatus === 'ready'
            ? sandboxId || undefined
            : undefined;

      // Repo-specific review guidance from REVIEW.md, when present. Null leaves
      // the reviewer on its built-in guidance.
      //
      // Honor the branch under review: prefer the sandbox working copy (live,
      // possibly-uncommitted edits on the active branch), then fall back to the
      // active branch's pushed REVIEW.md on GitHub. Skip the status flash when
      // there's nothing to look up.
      if (repoFullName || reviewerSandboxId) setStatus('Loading REVIEW.md…');
      const reviewGuidance = await resolveReviewGuidance({
        repoFullName,
        ref: activeBranch || defaultBranch,
        sandboxId: reviewerSandboxId,
      });

      let reviewResult: ReviewResult;

      if (requestedReviewDepth === 'deep') {
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const deepModelId =
          selectedReviewModel?.trim() ||
          getModelForRole(selectedProvider, 'reviewer')?.id ||
          selectedProvider;
        reviewResult = await runDeepReviewer(
          diff,
          {
            provider: selectedProvider,
            modelId: deepModelId,
            sandboxId: reviewerSandboxId,
            context: {
              repoFullName,
              activeBranch,
              defaultBranch,
              source: reviewSourceForPrompt,
              sourceLabel: nextContext.label,
              projectInstructions,
              reviewGuidance,
            },
            allowedRepo: repoFullName || '',
            branchContext:
              activeBranch && defaultBranch
                ? {
                    activeBranch,
                    defaultBranch,
                    protectMain: protectMain ?? false,
                  }
                : undefined,
            projectInstructions: projectInstructions ?? undefined,
          },
          {
            onStatus: (phase, detail) => setStatus(detail ? `${phase} — ${detail}` : phase),
            signal: abortController.signal,
          },
        );
        abortControllerRef.current = null;
      } else {
        const resolvedModelId =
          selectedReviewModel?.trim() ||
          getModelForRole(selectedProvider, 'reviewer')?.id ||
          selectedProvider;
        reviewResult = await runReviewer(
          diff,
          {
            provider: selectedProvider,
            modelId: resolvedModelId,
            sandboxId: reviewerSandboxId,
            context: {
              repoFullName,
              activeBranch,
              defaultBranch,
              source: reviewSourceForPrompt,
              sourceLabel: nextContext.label,
              projectInstructions,
              reviewGuidance,
            },
          },
          (phase) => setStatus(phase),
        );
      }
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
      setExpandedFiles(buildAutoExpandFiles(reviewResult.comments));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setSavedReviewNotice({ tone: 'info', text: 'Deep review cancelled.' });
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : 'Review failed.');
    } finally {
      abortControllerRef.current = null;
      setRunningReviewDepth(null);
      setRunning(false);
      setStatus(null);
    }
  }, [
    activeBranch,
    defaultBranch,
    ensureSandbox,
    protectMain,
    repoFullName,
    reviewDepth,
    reviewSource,
    running,
    sandboxId,
    sandboxStatus,
    selectedProvider,
    selectedReviewModel,
    projectInstructions,
  ]);

  const handleCancelDeepReview = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);
  const activeReviewDepth = runningReviewDepth ?? reviewDepth;
  const canRunReview =
    !running &&
    Boolean(selectedProvider) &&
    (reviewSource === 'github'
      ? hasGitHubSource
      : reviewSource === 'commit'
        ? hasCommitSource
        : sandboxReady || sandboxStatus === 'idle');
  const showSandboxPostingHint = reviewContext?.kind === 'sandbox' && hasGitHubSource;

  // Browsing PRs is an inspection sub-view of the github source. Needs a repo and
  // the GitHub-app capability; advisory review stays bound to the active branch.
  const canBrowsePrs = Boolean(canBrowsePullRequests && repoFullName);
  const showPullsView = reviewView === 'pulls' && canBrowsePrs;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Controls */}
      <div className={`flex-shrink-0 border-b ${HUB_GLASS_HAIRLINE} px-3 py-3 space-y-2.5`}>
        {/* Top-level view: run the advisory review vs. browse pull requests
            (inspection). Reachable whenever PR browsing is allowed — independent
            of the review source, so it works on the default branch too, and needs
            no AI provider. */}
        {canBrowsePrs && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setReviewView('review')}
              className={glassSegmentPillClass(reviewView === 'review')}
            >
              Review
            </button>
            <button
              onClick={() => setReviewView('pulls')}
              className={glassSegmentPillClass(reviewView === 'pulls')}
            >
              Pull requests
            </button>
          </div>
        )}

        {/* Source selector — only in the review view (browsing needs no source) */}
        {!showPullsView && (hasGitHubSource || hasCommitSource || reviewSource === 'sandbox') && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              {hasGitHubSource && (
                <button
                  onClick={() => handleSourceChange('github')}
                  className={glassSegmentPillClass(reviewSource === 'github')}
                >
                  Branch diff
                </button>
              )}
              {hasCommitSource && (
                <button
                  onClick={() => handleSourceChange('commit')}
                  className={glassSegmentPillClass(reviewSource === 'commit')}
                >
                  Last commit
                </button>
              )}
              <button
                onClick={() => handleSourceChange('sandbox')}
                className={glassSegmentPillClass(reviewSource === 'sandbox')}
              >
                Working tree
              </button>
            </div>
            <p className="text-push-2xs text-push-fg-dim">
              {reviewSource === 'github'
                ? 'Reviews the pushed PR or branch diff against the default branch.'
                : reviewSource === 'commit'
                  ? 'Reviews the diff of the most recent commit — no sandbox needed.'
                  : 'Reviews uncommitted working tree edits in the current workspace.'}
            </p>
          </div>
        )}

        {!showPullsView &&
          (providerOptions.length === 0 ? (
            <p className="text-push-xs text-push-fg-dim">
              No AI provider configured. Add an API key in Settings to use the Reviewer.
            </p>
          ) : (
            <>
              {/* Review depth — Quick vs Deep */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setReviewDepth('quick')}
                  disabled={running}
                  className={glassSegmentPillClass(reviewDepth === 'quick')}
                >
                  Quick
                </button>
                <button
                  onClick={() => setReviewDepth('deep')}
                  disabled={running}
                  className={glassSegmentPillClass(reviewDepth === 'deep')}
                >
                  Deep
                </button>
                <span className="text-push-2xs text-push-fg-dim">
                  {reviewDepth === 'deep'
                    ? 'Investigates the codebase before reviewing.'
                    : 'Single-pass review of the diff.'}
                </span>
              </div>

              {/* Provider pills — only configured providers */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {providerOptions.map(({ type, label }) => (
                  <button
                    key={type}
                    onClick={() => handleProviderChange(type)}
                    className={glassSegmentPillClass(selectedProvider === type)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Model selector */}
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <ModelPicker
                    key={selectedProvider ?? 'none'}
                    provider={selectedProvider ?? 'ollama'}
                    value={selectedReviewModel}
                    customInputValue={selectedReviewModelInput}
                    options={modelOptionsForProvider}
                    onChange={handleModelChange}
                    disabled={running || !selectedProvider}
                    allowCustom
                    customPlaceholder={
                      selectedDefaultModel ? `Default: ${selectedDefaultModel}` : 'Review model'
                    }
                    ariaLabel="Select review model"
                  />
                </div>
                <button
                  onClick={() => void handleRunReview()}
                  disabled={!canRunReview}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-push-fg-secondary`}
                >
                  {running ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  <span>
                    {running
                      ? activeReviewDepth === 'deep'
                        ? 'Investigating…'
                        : 'Reviewing…'
                      : reviewDepth === 'deep'
                        ? 'Run deep review'
                        : 'Run review'}
                  </span>
                </button>
                {running && runningReviewDepth === 'deep' && (
                  <button
                    onClick={handleCancelDeepReview}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 text-push-fg-dim`}
                    title="Cancel deep review"
                  >
                    <X className="h-3 w-3" />
                    <span>Cancel</span>
                  </button>
                )}
              </div>
            </>
          ))}

        {/* Status line — review-run specific; hidden while browsing PRs */}
        {!showPullsView && (
          <>
            {running && status && <p className="text-push-xs text-push-fg-dim">{status}</p>}
            {error && <p className="text-push-xs text-red-400">{error}</p>}
            {savedReviewNotice && (
              <p
                className={`text-push-xs ${
                  savedReviewNotice.tone === 'error'
                    ? 'text-red-400'
                    : savedReviewNotice.tone === 'success'
                      ? 'text-emerald-400'
                      : 'text-push-fg-dim'
                }`}
              >
                {savedReviewNotice.text}
              </p>
            )}
          </>
        )}
      </div>

      {/* Body: browse pull requests (inspection) or the review results pane */}
      {showPullsView ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <PrBrowser
            repoFullName={repoFullName}
            activeBranch={activeBranch}
            onOpenDiff={onOpenDiff}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Autonomous (webhook-triggered) PR reviews: the global on/off toggle
            plus this PR's review history. Renders whenever a repo is connected
            (empty state when there's no PR/reviews); hidden only with no repo. */}
          <div className="px-3 pt-3 empty:hidden">
            <PrReviewHistorySection repoFullName={repoFullName} activeBranch={activeBranch} />
          </div>
          {!result && !running && !error && savedReview && (
            <div className="px-3 py-3">
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3.5 py-3`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-push-fg">Saved review available</p>
                    <p className="text-push-xs text-push-fg-dim">
                      {savedReview.reviewContext?.label || 'Saved review'} ·{' '}
                      {new Date(savedReview.savedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={handleLoadSavedReview}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3`}
                    >
                      <span>Load saved</span>
                    </button>
                    <button
                      onClick={handleClearSavedReview}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3`}
                    >
                      <span>Clear</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!result && !running && !error && !savedReview && (
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
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3.5 py-3`}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-xs font-medium text-push-fg">
                      Review complete{reviewContext ? ` · ${reviewContext.label}` : ''}
                    </span>
                  </div>
                  <span className="text-push-2xs text-push-fg-dim">
                    {result.truncated
                      ? `${result.filesReviewed} of ${result.totalFiles} files`
                      : `${result.filesReviewed} file${result.filesReviewed !== 1 ? 's' : ''}`}{' '}
                    · {result.model}
                  </span>
                </div>
                {result.truncated && (
                  <div className="flex items-center gap-1.5 mb-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5">
                    <AlertTriangle className="h-3 w-3 text-amber-400 flex-shrink-0" />
                    <p className="text-push-2xs text-amber-400">
                      Diff too large — review covers {result.filesReviewed} of {result.totalFiles}{' '}
                      files. Later files were not seen.
                    </p>
                  </div>
                )}
                {/* Rendering is sanitized in PushMarkdownRenderer; images are disallowed. */}
                <div className="push-markdown text-push-xs leading-relaxed text-push-fg-secondary">
                  <PushMarkdownRenderer
                    text={result.summary}
                    isStreaming={false}
                    enableCodeHighlight={false}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={handleSaveReview}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3`}
                  >
                    <span>
                      {isCurrentReviewSaved
                        ? 'Saved locally'
                        : savedReview
                          ? 'Replace saved review'
                          : 'Save locally'}
                    </span>
                  </button>
                  {savedReview && !isCurrentReviewSaved && (
                    <button
                      onClick={handleLoadSavedReview}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3`}
                    >
                      <span>Load saved</span>
                    </button>
                  )}
                  {savedReview && (
                    <button
                      onClick={handleClearSavedReview}
                      className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3`}
                    >
                      <span>Clear saved</span>
                    </button>
                  )}
                  {savedReview && (
                    <span className="text-push-2xs text-push-fg-dim">
                      Saved {new Date(savedReview.savedAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {loadedSavedReviewMeta?.diffStorageTruncated && (
                  <div className={`mt-2 px-2.5 py-2 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
                    <p className="text-push-2xs text-push-fg-dim">
                      Loaded from local save. The stored diff snapshot was trimmed, so Diff jump
                      targets may be incomplete.
                    </p>
                  </div>
                )}
              </div>

              {/* Post to PR */}
              {reviewContext?.kind === 'github-pr' && postState !== 'posted' && (
                <div
                  className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-push-xs text-push-fg-secondary truncate">
                      PR{' '}
                      <a
                        href={reviewContext.pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-push-accent hover:underline inline-flex items-center gap-0.5"
                      >
                        #{reviewContext.pr.number} <ExternalLink className="h-2.5 w-2.5" />
                      </a>{' '}
                      open
                    </span>
                    {postState === 'error' && postError && (
                      <span className="text-push-2xs text-red-400 truncate">{postError}</span>
                    )}
                  </div>
                  <button
                    onClick={() => void handlePostToPR()}
                    disabled={postState === 'posting'}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 text-push-fg-secondary`}
                  >
                    {postState === 'posting' ? (
                      <>
                        <Loader2 className="h-3 w-3 animate-spin" />
                        <span>Posting…</span>
                      </>
                    ) : (
                      <>
                        <SendLiftIcon className="h-3 w-3" />
                        <span>Post to PR</span>
                      </>
                    )}
                  </button>
                </div>
              )}
              {postState === 'posted' && reviewContext?.kind === 'github-pr' && (
                <div className="flex items-center gap-2 rounded-[18px] border border-emerald-500/20 bg-emerald-500/5 px-3.5 py-2.5">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
                  <span className="text-push-xs text-emerald-400">
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
                <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3.5 py-2.5`}>
                  <p className="text-push-xs text-push-fg-dim">
                    Working tree reviews stay in Push. Switch to{' '}
                    <span className="text-push-fg-secondary">GitHub diff</span> to review the pushed
                    branch or post findings back to a PR.
                  </p>
                </div>
              )}
              {reviewContext?.kind === 'github-branch' && (
                <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3.5 py-2.5`}>
                  <p className="text-push-xs text-push-fg-dim">
                    No open PR for this branch. This review covers the pushed branch diff against{' '}
                    <span className="text-push-fg-secondary">{defaultBranch}</span>.
                  </p>
                </div>
              )}
              {reviewContext?.kind === 'github-commit' && (
                <div
                  className={`flex items-center gap-2 px-3.5 py-2.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
                >
                  <span className="text-push-xs text-push-fg-dim">Commit</span>
                  <a
                    href={reviewContext.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 font-mono text-push-xs text-push-accent hover:underline"
                  >
                    {reviewContext.shortSha} <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                </div>
              )}

              {/* No comments */}
              {result.comments.length === 0 && (
                <p className="text-center text-xs text-push-fg-dim py-4">
                  No specific comments — looks clean.
                </p>
              )}

              {/* Comments grouped by file */}
              {result.comments.length > 0 && (
                <div className="space-y-2">
                  {Array.from(groupByFile(result.comments)).map(([file, comments]) => {
                    const sorted = [...comments].sort(
                      (a, b) => severityOrder(a.severity) - severityOrder(b.severity),
                    );
                    const expanded = expandedFiles.has(file);
                    const hasCritical = comments.some((c) => c.severity === 'critical');
                    const hasWarning = comments.some((c) => c.severity === 'warning');
                    const headerColor = hasCritical
                      ? 'text-red-300'
                      : hasWarning
                        ? 'text-amber-300'
                        : 'text-push-fg-secondary';

                    return (
                      <div
                        key={file}
                        className={`overflow-hidden ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
                      >
                        <button
                          onClick={() => toggleFile(file)}
                          className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 hover:bg-push-surface-hover transition-colors"
                        >
                          <span
                            className={`min-w-0 flex-1 truncate text-left text-push-xs font-medium ${headerColor}`}
                          >
                            {file}
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-push-2xs text-push-fg-dim">
                              {comments.length}
                            </span>
                            {expanded ? (
                              <ChevronDown className="h-3 w-3 text-push-fg-dim" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-push-fg-dim" />
                            )}
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
                                        disabled={!reviewDiffData}
                                        className={`${HUB_TAG_CLASS} border-push-edge-hover font-mono`}
                                        title={`Open ${c.file} at line ${c.line} in Diff`}
                                      >
                                        L{c.line}
                                      </button>
                                    ) : null}
                                  </div>
                                  <p className="text-push-xs leading-relaxed text-push-fg-secondary">
                                    {c.comment}
                                  </p>
                                </div>
                                <button
                                  onClick={() => handleOpenCommentInDiff(c.file, c.line)}
                                  disabled={!reviewDiffData}
                                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} mt-0.5 h-7 gap-1 px-2.5 text-push-2xs`}
                                  title={`Open ${c.file}${typeof c.line === 'number' ? ` line ${c.line}` : ''} in Diff`}
                                >
                                  <DiffSeamIcon className="h-3 w-3" />
                                  <span>Diff</span>
                                </button>
                                {onFixFinding && (
                                  <button
                                    onClick={() =>
                                      onFixFinding(
                                        buildFixPrompt({
                                          comment: c,
                                          reviewContext,
                                          activeBranch,
                                          defaultBranch,
                                        }),
                                      )
                                    }
                                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} mt-0.5 h-7 gap-1 px-2.5 text-push-2xs text-push-fg-secondary`}
                                    title={`Send ${c.file}${typeof c.line === 'number' ? ` line ${c.line}` : ''} to chat as a fix request`}
                                  >
                                    <Sparkles className="h-3 w-3" />
                                    <span>Fix</span>
                                  </button>
                                )}
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
      )}
    </div>
  );
}
