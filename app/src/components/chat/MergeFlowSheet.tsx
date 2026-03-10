import { useState, useCallback, useEffect, useRef } from 'react';
import {
  GitMerge,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
  Trash2,
  ArrowRight,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  executeFindExistingPR,
  executeCreatePR,
  executeCheckPRMergeable,
  executeMergePR,
  executeDeleteBranch,
  githubFetch,
  getGitHubHeaders,
} from '@/lib/github-tools';
import { getSandboxDiff } from '@/lib/sandbox-client';
import { runAuditor } from '@/lib/auditor-agent';
import type { ActiveRepo, AuditVerdictCardData } from '@/types';

// ── Types ────────────────────────────────────────────────────────────

type MergeStep = 'check-tree' | 'create-pr' | 'audit' | 'merge' | 'done';

interface PRInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  isExisting: boolean;
}

interface MergeStatus {
  mergeable: boolean | null;
  mergeableState: string;
  ciOverall: string;
  ciChecks: { name: string; status: string; conclusion: string | null }[];
  hasConflicts: boolean;
  prState: string;
}

export interface MergeFlowSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeRepo: ActiveRepo;
  sandboxId: string | null;
  setCurrentBranch: (branch: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert branch name to a reasonable PR title. */
function branchToTitle(branch: string): string {
  return branch
    .replace(/^(feature|fix|hotfix|chore|refactor|docs|test)\//i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse a PR number out of the text-based ToolExecutionResult. */
function parsePRNumber(text: string): number | null {
  const match = text.match(/PR #(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Parse the title from find_existing_pr result. */
function parsePRTitle(text: string): string {
  const match = text.match(/Title: (.+)/);
  return match ? match[1].trim() : '';
}

/** Parse the URL from a tool result. */
function parsePRUrl(text: string): string {
  const match = text.match(/URL: (.+)/);
  return match ? match[1].trim() : '';
}

/** Clean up error messages for UI display. */
function cleanError(message: string): string {
  return message
    .replace(/^\[Tool Error\]\s*/i, '')
    .replace(/^\[Tool Result.*?\]\s*/i, '');
}

// ── Step indicator ───────────────────────────────────────────────────

const STEPS: { key: MergeStep; label: string }[] = [
  { key: 'check-tree', label: 'Check' },
  { key: 'create-pr', label: 'PR' },
  { key: 'audit', label: 'Audit' },
  { key: 'merge', label: 'Merge' },
  { key: 'done', label: 'Done' },
];

function StepIndicator({ current }: { current: MergeStep }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-1 mb-4">
      {STEPS.map((step, i) => {
        const isActive = i === currentIdx;
        const isDone = i < currentIdx;
        return (
          <div key={step.key} className="flex items-center gap-1">
            {i > 0 && (
              <div
                className={`h-px w-4 ${isDone ? 'bg-emerald-500/50' : 'bg-white/[0.06]'}`}
              />
            )}
            <div
              className={`
                flex items-center justify-center rounded-full text-push-2xs font-medium
                h-6 px-2.5 transition-colors
                ${isActive ? 'bg-white/10 text-push-fg' : ''}
                ${isDone ? 'bg-emerald-500/10 text-emerald-400' : ''}
                ${!isActive && !isDone ? 'bg-transparent text-[#3f3f46]' : ''}
              `}
            >
              {isDone ? <CheckCircle2 className="h-3 w-3" /> : step.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

function MergeFlowSheet({
  open,
  onOpenChange,
  activeRepo,
  sandboxId,
  setCurrentBranch,
}: MergeFlowSheetProps) {
  const currentBranch = activeRepo.current_branch || activeRepo.default_branch;
  const defaultBranch = activeRepo.default_branch;
  const repo = activeRepo.full_name;

  // Can't merge default branch into itself
  const isOnDefault = currentBranch === defaultBranch;

  // ── State ──────────────────────────────────────────────────────────

  const [step, setStep] = useState<MergeStep>('check-tree');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);

  // Step 2 — PR
  const [prInfo, setPrInfo] = useState<PRInfo | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prFormMode, setPrFormMode] = useState<'create' | 'existing' | null>(null);

  // Step 3 — Audit
  const [auditVerdict, setAuditVerdict] = useState<'safe' | 'unsafe' | null>(null);
  const [auditCard, setAuditCard] = useState<AuditVerdictCardData | null>(null);

  // Step 4 — Merge status
  const [mergeStatus, setMergeStatus] = useState<MergeStatus | null>(null);

  // Step 5 — Post-merge
  const [deletingBranch, setDeletingBranch] = useState(false);

  // Abort guard for async operations
  const abortRef = useRef(false);

  // ── Reset on open ──────────────────────────────────────────────────

  const reset = useCallback(() => {
    setStep('check-tree');
    setLoading(false);
    setError(null);
    setStatusText(null);
    setPrInfo(null);
    setPrTitle('');
    setPrBody('');
    setPrFormMode(null);
    setAuditVerdict(null);
    setAuditCard(null);
    setMergeStatus(null);
    setDeletingBranch(false);
    abortRef.current = false;
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) reset();
      else abortRef.current = true;
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const close = useCallback(() => {
    abortRef.current = true;
    onOpenChange(false);
  }, [onOpenChange]);

  // ── Step 1: Check working tree ─────────────────────────────────────

  useEffect(() => {
    if (!open || step !== 'check-tree') return;
    if (isOnDefault) return; // will show error state, no auto-proceed

    let cancelled = false;
    abortRef.current = false;

    async function checkTree() {
      setLoading(true);
      setError(null);
      setStatusText('Checking working tree...');

      try {
        if (sandboxId) {
          const diffResult = await getSandboxDiff(sandboxId);
          if (cancelled || abortRef.current) return;

          if (diffResult.diff && diffResult.diff.trim().length > 0) {
            // Dirty working tree
            setLoading(false);
            setStatusText(null);
            setError('uncommitted');
            return;
          }
        }
        // Clean or no sandbox — proceed to step 2
        if (!cancelled && !abortRef.current) {
          setStep('create-pr');
        }
      } catch (err) {
        if (cancelled || abortRef.current) return;
        const msg = err instanceof Error ? err.message : 'Failed to check working tree';
        setError(cleanError(msg));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setStatusText(null);
        }
      }
    }

    checkTree();
    return () => { cancelled = true; };
  }, [open, step, sandboxId, isOnDefault]);

  // ── Step 2: Find/create PR ─────────────────────────────────────────

  useEffect(() => {
    if (!open || step !== 'create-pr' || prFormMode !== null) return;

    let cancelled = false;

    async function findPR() {
      setLoading(true);
      setError(null);
      setStatusText('Looking for existing PR...');

      try {
        const result = await executeFindExistingPR(repo, currentBranch, defaultBranch);
        if (cancelled || abortRef.current) return;

        const prNumber = parsePRNumber(result.text);
        if (prNumber) {
          // Existing PR found
          const title = parsePRTitle(result.text);
          const url = parsePRUrl(result.text);
          setPrInfo({
            number: prNumber,
            title,
            body: '',
            url,
            isExisting: true,
          });
          setPrTitle(title);
          setPrFormMode('existing');
        } else {
          // No existing PR — show create form
          setPrTitle(branchToTitle(currentBranch));
          setPrBody('');
          setPrFormMode('create');
        }
      } catch (err) {
        if (cancelled || abortRef.current) return;
        const msg = err instanceof Error ? err.message : 'Failed to search for PRs';
        setError(cleanError(msg));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setStatusText(null);
        }
      }
    }

    findPR();
    return () => { cancelled = true; };
  }, [open, step, prFormMode, repo, currentBranch, defaultBranch]);

  // ── Create PR handler ──────────────────────────────────────────────

  const handleCreatePR = useCallback(async () => {
    if (loading) return;

    setLoading(true);
    setError(null);
    setStatusText('Creating PR...');

    try {
      const result = await executeCreatePR(repo, prTitle.trim(), prBody.trim(), currentBranch, defaultBranch);
      if (abortRef.current) return;

      const prNumber = parsePRNumber(result.text);
      const url = parsePRUrl(result.text);

      if (!prNumber) {
        setError('PR was created but could not parse the PR number from the response.');
        return;
      }

      setPrInfo({
        number: prNumber,
        title: prTitle.trim(),
        body: prBody.trim(),
        url: url || `https://github.com/${repo}/pull/${prNumber}`,
        isExisting: false,
      });
      setStep('audit');
    } catch (err) {
      if (abortRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to create PR';
      setError(cleanError(msg));
    } finally {
      setLoading(false);
      setStatusText(null);
    }
  }, [loading, repo, prTitle, prBody, currentBranch, defaultBranch]);

  // ── Proceed with existing PR ───────────────────────────────────────

  const handleProceedWithExisting = useCallback(() => {
    if (!prInfo) return;
    setStep('audit');
  }, [prInfo]);

  // ── Step 3: Auditor review ─────────────────────────────────────────

  useEffect(() => {
    if (!open || step !== 'audit' || !prInfo) return;
    const pr = prInfo; // capture for closure narrowing

    let cancelled = false;

    async function runAudit() {
      setLoading(true);
      setError(null);
      setAuditVerdict(null);
      setAuditCard(null);
      setStatusText('Fetching PR diff...');

      try {
        // Fetch the PR diff via GitHub API
        const headers = getGitHubHeaders();
        headers['Accept'] = 'application/vnd.github.v3.diff';
        const diffRes = await githubFetch(
          `https://api.github.com/repos/${repo}/pulls/${pr.number}`,
          { headers },
        );
        if (cancelled || abortRef.current) return;

        if (!diffRes.ok) {
          throw new Error(`Failed to fetch PR diff (HTTP ${diffRes.status})`);
        }

        const diff = await diffRes.text();
        if (cancelled || abortRef.current) return;

        if (!diff || diff.trim().length === 0) {
          // Empty diff — skip audit, go straight to merge
          setAuditVerdict('safe');
          setAuditCard({
            verdict: 'safe',
            summary: 'No changes to review — empty diff.',
            risks: [],
            filesReviewed: 0,
          });
          setStep('merge');
          return;
        }

        // Run the Auditor
        setStatusText('Auditor reviewing...');
        const result = await runAuditor(diff, (phase) => {
          if (!cancelled && !abortRef.current) setStatusText(phase);
        });
        if (cancelled || abortRef.current) return;

        setAuditVerdict(result.verdict);
        setAuditCard(result.card);

        if (result.verdict === 'safe') {
          // Auto-proceed to merge step
          setStep('merge');
        }
      } catch (err) {
        if (cancelled || abortRef.current) return;
        const msg = err instanceof Error ? err.message : 'Auditor failed';
        setError(cleanError(msg));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setStatusText(null);
        }
      }
    }

    runAudit();
    return () => { cancelled = true; };
  }, [open, step, prInfo, repo]);

  // ── Step 4: Check mergeability ─────────────────────────────────────

  useEffect(() => {
    if (!open || step !== 'merge' || !prInfo || mergeStatus !== null) return;
    const pr = prInfo; // capture for closure narrowing

    let cancelled = false;

    async function checkMergeable() {
      setLoading(true);
      setError(null);
      setStatusText('Checking merge eligibility...');

      try {
        const result = await executeCheckPRMergeable(repo, pr.number);
        if (cancelled || abortRef.current) return;

        const text = result.text;

        // Parse mergeability from the structured text result
        const mergeableMatch = text.match(/Mergeable: (yes|no|computing)/);
        const mergeableStateMatch = text.match(/Mergeable state: (\S+)/);
        const ciMatch = text.match(/CI status: (\S+)/);
        const stateMatch = text.match(/State: (\S+)/);
        const eligible = text.includes('eligible for merge');

        const mergeable = mergeableMatch?.[1] === 'yes' ? true
          : mergeableMatch?.[1] === 'no' ? false
          : null;

        setMergeStatus({
          mergeable,
          mergeableState: mergeableStateMatch?.[1] || 'unknown',
          ciOverall: ciMatch?.[1] || 'UNKNOWN',
          ciChecks: [], // We don't re-parse individual checks here
          hasConflicts: mergeable === false,
          prState: stateMatch?.[1] || 'unknown',
        });

        if (!eligible && mergeable === null) {
          // GitHub is still computing — set a hint
          setStatusText('GitHub is computing merge status. You may need to check again.');
        }
      } catch (err) {
        if (cancelled || abortRef.current) return;
        const msg = err instanceof Error ? err.message : 'Failed to check PR status';
        setError(cleanError(msg));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (!cancelled) setStatusText(null);
        }
      }
    }

    checkMergeable();
    return () => { cancelled = true; };
  }, [open, step, prInfo, repo, mergeStatus]);

  // ── Merge handler ──────────────────────────────────────────────────

  const handleMerge = useCallback(async () => {
    if (loading || !prInfo) return;

    setLoading(true);
    setError(null);
    setStatusText('Merging...');

    try {
      await executeMergePR(repo, prInfo.number, 'merge');
      if (abortRef.current) return;

      setStep('done');
    } catch (err) {
      if (abortRef.current) return;
      const msg = err instanceof Error ? err.message : 'Merge failed';
      setError(cleanError(msg));
    } finally {
      setLoading(false);
      setStatusText(null);
    }
  }, [loading, prInfo, repo]);

  // ── Re-check merge status ──────────────────────────────────────────

  const handleRecheck = useCallback(() => {
    setMergeStatus(null);
    setError(null);
  }, []);

  // ── Retry auditor ──────────────────────────────────────────────────

  const handleRetryAudit = useCallback(() => {
    setAuditVerdict(null);
    setAuditCard(null);
    setError(null);
    // Re-entering the 'audit' step triggers the useEffect again
    setStep('check-tree'); // reset to re-run
    setTimeout(() => setStep('audit'), 0);
  }, []);

  // ── Post-merge: switch to main ─────────────────────────────────────

  const handleSwitchToMain = useCallback(() => {
    setCurrentBranch(defaultBranch);
    close();
  }, [setCurrentBranch, defaultBranch, close]);

  // ── Post-merge: switch to main + delete branch ─────────────────────

  const handleSwitchAndDelete = useCallback(async () => {
    if (deletingBranch) return;

    setDeletingBranch(true);
    setError(null);

    try {
      await executeDeleteBranch(repo, currentBranch);
    } catch (err) {
      // Non-fatal: branch might already be deleted via PR settings
      console.warn('Branch delete failed (may already be deleted):', err);
    }

    setCurrentBranch(defaultBranch);
    setDeletingBranch(false);
    close();
  }, [deletingBranch, repo, currentBranch, defaultBranch, setCurrentBranch, close]);

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-[#0d0d0d] border-t border-white/[0.06] rounded-t-2xl px-5 pb-8 pt-0 max-h-[85dvh] overflow-y-auto"
      >
        <SheetHeader className="pt-5 pb-1">
          <SheetTitle className="text-sm font-semibold text-push-fg flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-push-fg-dim" />
            Merge {currentBranch}
          </SheetTitle>
          <SheetDescription className="text-xs text-[#71717a]">
            {currentBranch} into {defaultBranch}
          </SheetDescription>
        </SheetHeader>

        {/* Edge case: on default branch */}
        {isOnDefault ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2.5">
              <p className="text-xs text-yellow-400">
                You are on the default branch ({defaultBranch}). Switch to a feature branch to merge.
              </p>
            </div>
            <Button
              onClick={close}
              variant="outline"
              className="w-full h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
            >
              Close
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            <StepIndicator current={step} />

            {/* ── Step 1: Check working tree ─────────────────────── */}
            {step === 'check-tree' && (
              <div className="space-y-4">
                {loading && (
                  <div className="flex items-center gap-2.5 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-push-fg-dim" />
                    <span className="text-sm text-push-fg-secondary">{statusText || 'Checking...'}</span>
                  </div>
                )}

                {error === 'uncommitted' && (
                  <>
                    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-yellow-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="text-xs font-medium text-yellow-400">Uncommitted changes</p>
                          <p className="text-xs text-yellow-400/70 mt-0.5">
                            You have uncommitted changes in the sandbox. Commit and push before merging.
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Button
                        onClick={close}
                        className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
                      >
                        Commit & push first
                      </Button>
                      <Button
                        onClick={close}
                        variant="outline"
                        className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                )}

                {error && error !== 'uncommitted' && (
                  <ErrorDisplay message={error} onRetry={() => { setError(null); setStep('check-tree'); }} onCancel={close} />
                )}
              </div>
            )}

            {/* ── Step 2: Create or reuse PR ─────────────────────── */}
            {step === 'create-pr' && (
              <div className="space-y-4">
                {loading && (
                  <div className="flex items-center gap-2.5 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-push-fg-dim" />
                    <span className="text-sm text-push-fg-secondary">{statusText || 'Looking for PRs...'}</span>
                  </div>
                )}

                {!loading && prFormMode === 'existing' && prInfo && (
                  <>
                    <div className="rounded-lg border border-white/[0.06] bg-[#141414] px-3 py-3 space-y-1.5">
                      <p className="text-xs text-push-fg-dim">Existing PR found</p>
                      <p className="text-sm text-push-fg font-medium">
                        #{prInfo.number} — {prInfo.title}
                      </p>
                      {prInfo.url && (
                        <a
                          href={prInfo.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                        >
                          View on GitHub <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <Button
                        onClick={handleProceedWithExisting}
                        className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
                      >
                        <ArrowRight className="h-4 w-4" />
                        Continue with this PR
                      </Button>
                      <Button
                        onClick={close}
                        variant="outline"
                        className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                )}

                {!loading && prFormMode === 'create' && (
                  <>
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label htmlFor="pr-title" className="text-xs text-push-fg-secondary">
                          PR title
                        </Label>
                        <Input
                          id="pr-title"
                          placeholder="What does this PR do?"
                          value={prTitle}
                          onChange={(e) => { setPrTitle(e.target.value); setError(null); }}
                          autoFocus
                          className="bg-[#141414] border-white/[0.08] text-push-fg placeholder:text-[#3f3f46] h-11 text-sm"
                          autoComplete="off"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pr-body" className="text-xs text-push-fg-secondary">
                          Description <span className="text-[#3f3f46]">(optional)</span>
                        </Label>
                        <Textarea
                          id="pr-body"
                          placeholder="Additional details..."
                          value={prBody}
                          onChange={(e) => setPrBody(e.target.value)}
                          rows={3}
                          className="bg-[#141414] border-white/[0.08] text-push-fg placeholder:text-[#3f3f46] text-sm min-h-[72px] resize-none"
                        />
                      </div>
                      <p className="text-push-xs text-[#3f3f46]">
                        {currentBranch} <ArrowRight className="h-3 w-3 inline" /> {defaultBranch}
                      </p>
                    </div>
                    <div className="flex gap-3 pt-1">
                      <Button
                        onClick={handleCreatePR}
                        disabled={!prTitle.trim() || loading}
                        className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm disabled:opacity-40"
                      >
                        {loading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Creating...
                          </>
                        ) : (
                          'Create PR'
                        )}
                      </Button>
                      <Button
                        onClick={close}
                        disabled={loading}
                        variant="outline"
                        className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                )}

                {error && (
                  <ErrorDisplay message={error} onRetry={() => { setError(null); setPrFormMode(null); }} onCancel={close} />
                )}
              </div>
            )}

            {/* ── Step 3: Auditor review ─────────────────────────── */}
            {step === 'audit' && (
              <div className="space-y-4">
                {loading && (
                  <div className="flex items-center gap-2.5 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-push-fg-dim" />
                    <span className="text-sm text-push-fg-secondary">{statusText || 'Auditing...'}</span>
                  </div>
                )}

                {!loading && auditVerdict === 'unsafe' && auditCard && (
                  <>
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-red-400 shrink-0" />
                        <p className="text-xs font-medium text-red-400">Blocked by Auditor</p>
                      </div>
                      <p className="text-xs text-red-400/80">{auditCard.summary}</p>
                      {auditCard.risks.length > 0 && (
                        <div className="space-y-1 pt-1">
                          {auditCard.risks.map((risk, i) => (
                            <div key={i} className="flex items-start gap-1.5">
                              <span
                                className={`text-push-2xs font-medium uppercase mt-0.5 ${
                                  risk.level === 'high' ? 'text-red-400' :
                                  risk.level === 'medium' ? 'text-yellow-400' :
                                  'text-push-fg-dim'
                                }`}
                              >
                                {risk.level}
                              </span>
                              <span className="text-xs text-push-fg-secondary">{risk.description}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <Button
                        onClick={handleRetryAudit}
                        className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
                      >
                        Fix and retry
                      </Button>
                      <Button
                        onClick={close}
                        variant="outline"
                        className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                      >
                        Cancel
                      </Button>
                    </div>
                  </>
                )}

                {!loading && auditVerdict === 'safe' && auditCard && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                      <p className="text-xs font-medium text-emerald-400">Auditor: SAFE</p>
                    </div>
                    <p className="text-xs text-emerald-400/70 mt-1">{auditCard.summary}</p>
                  </div>
                )}

                {error && (
                  <ErrorDisplay message={error} onRetry={handleRetryAudit} onCancel={close} />
                )}
              </div>
            )}

            {/* ── Step 4: Merge ──────────────────────────────────── */}
            {step === 'merge' && (
              <div className="space-y-4">
                {/* Audit summary (brief, since we passed) */}
                {auditCard && auditVerdict === 'safe' && (
                  <div className="flex items-center gap-2 text-xs text-emerald-400/60">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>Audit passed — {auditCard.filesReviewed} files reviewed</span>
                  </div>
                )}

                {loading && !mergeStatus && (
                  <div className="flex items-center gap-2.5 py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-push-fg-dim" />
                    <span className="text-sm text-push-fg-secondary">{statusText || 'Checking...'}</span>
                  </div>
                )}

                {mergeStatus && (
                  <>
                    {/* Mergeable */}
                    {mergeStatus.mergeable === true && mergeStatus.ciOverall !== 'FAILURE' && (
                      <>
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-3">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                            <div>
                              <p className="text-xs font-medium text-emerald-400">Ready to merge</p>
                              <p className="text-xs text-emerald-400/60 mt-0.5">
                                {currentBranch} into {defaultBranch}
                              </p>
                            </div>
                          </div>
                          {mergeStatus.ciOverall === 'PENDING' && (
                            <p className="text-push-xs text-yellow-400/70 mt-2 flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              CI checks still running (merge is allowed)
                            </p>
                          )}
                          {mergeStatus.ciOverall === 'NO-CHECKS' && (
                            <p className="text-push-xs text-push-fg-dim mt-2">No CI checks configured</p>
                          )}
                        </div>
                        <div className="flex gap-3">
                          <Button
                            onClick={handleMerge}
                            disabled={loading}
                            className="flex-1 h-11 bg-emerald-600 text-white hover:bg-emerald-500 font-medium text-sm disabled:opacity-40"
                          >
                            {loading ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Merging...
                              </>
                            ) : (
                              <>
                                <GitMerge className="h-4 w-4" />
                                Merge
                              </>
                            )}
                          </Button>
                          <Button
                            onClick={close}
                            disabled={loading}
                            variant="outline"
                            className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    )}

                    {/* Conflicts */}
                    {mergeStatus.hasConflicts && (
                      <>
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3">
                          <div className="flex items-center gap-2">
                            <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                            <div>
                              <p className="text-xs font-medium text-red-400">Merge conflicts</p>
                              <p className="text-xs text-red-400/70 mt-0.5">
                                This branch has conflicts with {defaultBranch} that must be resolved.
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <a
                            href={`https://github.com/${repo}/pull/${prInfo?.number}/conflicts`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1"
                          >
                            <Button className="w-full h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm">
                              <ExternalLink className="h-4 w-4" />
                              Resolve on GitHub
                            </Button>
                          </a>
                          <Button
                            onClick={close}
                            variant="outline"
                            className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    )}

                    {/* CI failing */}
                    {mergeStatus.ciOverall === 'FAILURE' && !mergeStatus.hasConflicts && (
                      <>
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3">
                          <div className="flex items-center gap-2">
                            <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                            <div>
                              <p className="text-xs font-medium text-red-400">CI checks failing</p>
                              <p className="text-xs text-red-400/70 mt-0.5">
                                One or more CI checks have failed. Fix them before merging.
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <Button
                            onClick={handleRecheck}
                            className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
                          >
                            Check again
                          </Button>
                          <Button
                            onClick={close}
                            variant="outline"
                            className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    )}

                    {/* Mergeable is null — GitHub still computing */}
                    {mergeStatus.mergeable === null && !mergeStatus.hasConflicts && (
                      <>
                        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-3">
                          <div className="flex items-center gap-2">
                            <Loader2 className="h-4 w-4 text-yellow-400 animate-spin shrink-0" />
                            <div>
                              <p className="text-xs font-medium text-yellow-400">Computing merge status</p>
                              <p className="text-xs text-yellow-400/70 mt-0.5">
                                GitHub is still determining if this branch can be merged. Try again in a moment.
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          <Button
                            onClick={handleRecheck}
                            className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
                          >
                            Check again
                          </Button>
                          <Button
                            onClick={close}
                            variant="outline"
                            className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                          >
                            Cancel
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                )}

                {error && (
                  <ErrorDisplay message={error} onRetry={handleRecheck} onCancel={close} />
                )}
              </div>
            )}

            {/* ── Step 5: Post-merge ─────────────────────────────── */}
            {step === 'done' && (
              <div className="space-y-4">
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-4">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-emerald-400">Merged</p>
                      <p className="text-xs text-emerald-400/60 mt-0.5">
                        {currentBranch} has been merged into {defaultBranch}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2.5">
                  <Button
                    onClick={handleSwitchToMain}
                    className="w-full h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
                  >
                    Switch to {defaultBranch}
                  </Button>
                  <Button
                    onClick={handleSwitchAndDelete}
                    disabled={deletingBranch}
                    variant="outline"
                    className="w-full h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
                  >
                    {deletingBranch ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Deleting branch...
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4" />
                        Switch to {defaultBranch} + delete {currentBranch}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Reusable error display ──────────────────────────────────────────

function ErrorDisplay({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
        <p className="text-xs text-red-400">{message}</p>
      </div>
      <div className="flex gap-3">
        <Button
          onClick={onRetry}
          className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm"
        >
          Retry
        </Button>
        <Button
          onClick={onCancel}
          variant="outline"
          className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
        >
          Cancel
        </Button>
      </div>
    </>
  );
}

export { MergeFlowSheet };
