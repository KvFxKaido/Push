/**
 * CommitPushSheet — bottom sheet for the file browser commit + push flow.
 *
 * Phase-driven UI:
 * - fetching-diff: Spinner
 * - reviewing: DiffPreviewCard + commit message input + green button
 * - auditing/committing/pushing: Spinner with phase label
 * - success: Green checkmark + "Done" button
 * - error: Red error + AuditVerdictCard (if blocked) + "Try Again" button
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { DiffPreviewCard } from '@/components/cards/DiffPreviewCard';
import { AuditVerdictCard } from '@/components/cards/AuditVerdictCard';
import { useCommitPush } from '@/hooks/useCommitPush';
import type { DiffPreviewCardData } from '@/types';

interface CommitPushSheetProps {
  sandboxId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  'fetching-diff': 'Getting diff…',
  'auditing': 'Auditor reviewing…',
  'committing': 'Committing…',
  'pushing': 'Pushing to remote…',
};

/**
 * Generate a suggested commit message from diff stats.
 * Uses conventional commit format with type inference from file patterns.
 */
function generateCommitMessage(diff: DiffPreviewCardData): string {
  const { filesChanged, additions, deletions } = diff;
  
  // Infer type from file patterns in diff
  let type = 'update';
  const diffLower = diff.diff.toLowerCase();
  
  if (diffLower.includes('fix') || diffLower.includes('bug') || diffLower.includes('hotfix')) {
    type = 'fix';
  } else if (diffLower.includes('feat') || diffLower.includes('add') || diffLower.includes('new')) {
    type = 'feat';
  } else if (diffLower.includes('refactor') || diffLower.includes('clean') || diffLower.includes('extract')) {
    type = 'refactor';
  } else if (diffLower.includes('test') || diffLower.includes('spec')) {
    type = 'test';
  } else if (diffLower.includes('docs') || diffLower.includes('readme') || diffLower.includes('.md')) {
    type = 'docs';
  } else if (diffLower.includes('style') || diffLower.includes('css') || diffLower.includes('format')) {
    type = 'style';
  }

  // Extract scope from file path
  const fileMatch = diff.diff.match(/diff --git a\/(.+?) b\//);
  let scope = '';
  if (fileMatch) {
    const file = fileMatch[1];
    if (file.includes('src/')) {
      const parts = file.split('src/');
      if (parts[1]) {
        scope = parts[1].split('/')[0];
      }
    } else if (file.includes('components/')) {
      scope = 'ui';
    } else if (file.includes('hooks/')) {
      scope = 'hooks';
    } else if (file.includes('lib/')) {
      scope = 'lib';
    }
  }

  // Build message
  let message = `${type}${scope ? `(${scope})` : ''}: `;
  
  if (filesChanged === 1) {
    const fileName = fileMatch ? fileMatch[1].split('/').pop() : 'file';
    message += `update ${fileName}`;
  } else {
    message += `update ${filesChanged} files`;
  }

  // Add stats context
  if (additions > 0 && deletions === 0) {
    message += ` (+${additions})`;
  } else if (deletions > 0 && additions === 0) {
    message += ` (-${deletions})`;
  } else if (additions > 0 && deletions > 0) {
    message += ` (+${additions}/-${deletions})`;
  }

  return message;
}

/**
 * Hook to track virtual keyboard height using Visual Viewport API
 */
function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const updateKeyboardHeight = () => {
      const vh = window.visualViewport?.height || window.innerHeight;
      const windowHeight = window.innerHeight;
      const height = Math.max(0, windowHeight - vh);
      setKeyboardHeight(height);
    };

    // Initial check
    updateKeyboardHeight();

    // Listen for viewport changes (keyboard open/close)
    const viewport = window.visualViewport;
    if (viewport) {
      viewport.addEventListener('resize', updateKeyboardHeight);
      viewport.addEventListener('scroll', updateKeyboardHeight);
    }
    window.addEventListener('resize', updateKeyboardHeight);

    return () => {
      if (viewport) {
        viewport.removeEventListener('resize', updateKeyboardHeight);
        viewport.removeEventListener('scroll', updateKeyboardHeight);
      }
      window.removeEventListener('resize', updateKeyboardHeight);
    };
  }, []);

  return keyboardHeight;
}

export function CommitPushSheet({
  sandboxId,
  open,
  onOpenChange,
  onSuccess,
}: CommitPushSheetProps) {
  const {
    phase,
    diff,
    auditVerdict,
    error,
    commitMessage,
    setCommitMessage,
    fetchDiff,
    commitAndPush,
    reset,
  } = useCommitPush(sandboxId);

  const keyboardHeight = useKeyboardHeight();

  // Generate suggested commit message when diff is loaded
  const suggestedMessage = useMemo(() => {
    if (!diff || phase !== 'reviewing') return '';
    return generateCommitMessage(diff);
  }, [diff, phase]);

  // Auto-fill commit message when first entering review phase
  const [hasAutoFilled, setHasAutoFilled] = useState(false);
  
  useEffect(() => {
    if (phase === 'reviewing' && suggestedMessage && !hasAutoFilled && !commitMessage) {
      setCommitMessage(suggestedMessage);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasAutoFilled(true);
    }
  }, [phase, suggestedMessage, hasAutoFilled, commitMessage, setCommitMessage]);

  // Reset when sheet closes
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      reset();
      setHasAutoFilled(false);
    }
    onOpenChange(nextOpen);
  }, [reset, onOpenChange]);

  // Fetch diff when sheet opens
  useEffect(() => {
    if (open && phase === 'idle') {
      fetchDiff();
    }
  }, [open, phase, fetchDiff]);

  const handleDone = () => {
    onSuccess?.();
    handleOpenChange(false);
  };

  const handleRetry = () => {
    reset();
    setHasAutoFilled(false);
    fetchDiff();
  };

  const handleUseSuggestion = () => {
    if (suggestedMessage) {
      setCommitMessage(suggestedMessage);
    }
  };

  const isSpinnerPhase = phase === 'fetching-diff' || phase === 'auditing' || phase === 'committing' || phase === 'pushing';

  // Dynamic padding to account for keyboard
  const bottomPadding = Math.max(keyboardHeight, 0);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-[#0d0d0d] border-[#1a1a1a] rounded-t-2xl max-h-[85dvh] overflow-y-auto safe-area-bottom"
        style={{ paddingBottom: bottomPadding > 0 ? bottomPadding : undefined }}
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="text-[#fafafa] text-sm font-medium">
            Commit &amp; Push
          </SheetTitle>
          <SheetDescription className="sr-only">
            Review changes, enter a commit message, and push to remote.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-4">
          {/* Spinner phases */}
          {isSpinnerPhase && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <Loader2 className="h-5 w-5 animate-spin text-[#0070f3]" />
              <span className="text-sm text-[#a1a1aa]">
                {PHASE_LABELS[phase] || 'Working…'}
              </span>
            </div>
          )}

          {/* Reviewing: diff + commit message + button */}
          {phase === 'reviewing' && diff && (
            <>
              <DiffPreviewCard data={diff} />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="commit-message"
                    className="text-xs text-[#a1a1aa] font-medium"
                  >
                    Commit message
                  </label>
                  {suggestedMessage && suggestedMessage !== commitMessage && (
                    <button
                      onClick={handleUseSuggestion}
                      className="flex items-center gap-1 text-xs text-[#0070f3] hover:text-[#0060d3] transition-colors"
                      title="Use AI-suggested message"
                    >
                      <Sparkles className="h-3 w-3" />
                      Suggest
                    </button>
                  )}
                </div>
                <input
                  id="commit-message"
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Describe your changes…"
                  className="w-full rounded-lg border border-[#1a1a1a] bg-[#000] px-3 py-2.5 text-sm text-[#fafafa] placeholder:text-[#3f3f46] focus:outline-none focus:ring-1 focus:ring-[#0070f3]"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && commitMessage.trim()) {
                      commitAndPush();
                    }
                  }}
                />
              </div>

              <button
                onClick={commitAndPush}
                disabled={!commitMessage.trim()}
                className="w-full rounded-lg bg-[#22c55e] py-2.5 text-sm font-medium text-white transition-all hover:bg-[#16a34a] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none"
              >
                Commit &amp; Push
              </button>
            </>
          )}

          {/* Success */}
          {phase === 'success' && (
            <div className="flex flex-col items-center gap-4 py-6">
              {auditVerdict && <AuditVerdictCard data={auditVerdict} />}
              <CheckCircle2 className="h-8 w-8 text-[#22c55e]" />
              <span className="text-sm text-[#e4e4e7] font-medium">Committed and pushed!</span>
              <button
                onClick={handleDone}
                className="w-full rounded-lg bg-[#22c55e] py-2.5 text-sm font-medium text-white transition-all hover:bg-[#16a34a] active:scale-[0.98]"
              >
                Done
              </button>
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="flex flex-col gap-4 py-4">
              {auditVerdict && <AuditVerdictCard data={auditVerdict} />}

              <div className="flex items-start gap-2.5 rounded-lg bg-[#ef4444]/5 border border-[#ef4444]/20 px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-[#ef4444] shrink-0 mt-0.5" />
                <p className="text-sm text-[#ef4444]/90 leading-relaxed">{error}</p>
              </div>

              <button
                onClick={handleRetry}
                className="w-full rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] py-2.5 text-sm font-medium text-[#a1a1aa] transition-all hover:bg-[#161618] hover:text-[#fafafa] active:scale-[0.98]"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
