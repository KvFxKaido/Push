import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BranchWaveIcon } from '@/components/icons/push-custom-icons';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sanitizeBranchName } from '@/lib/branch-names';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { ForkBranchInWorkspaceResult } from '@/lib/fork-branch-in-workspace';

interface BranchForkSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Branch the fork will spawn from. Displayed in the header so the user
   *  knows what state they're forking. Not passed to `forkBranch` — the
   *  sandbox tool defaults to its current HEAD, which is the actual "here"
   *  state and may differ from this UI-tracked label if HEAD has drifted. */
  fromBranch: string;
  /** Bound to `useChat.forkBranchFromUI`. Calls the sandbox_create_branch
   *  tool path; the chat hook handles conversation migration internally. */
  forkBranch: (name: string, from?: string) => Promise<ForkBranchInWorkspaceResult>;
}

const BRANCH_ACTION_BUTTON_CLASS = `${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 flex-1 text-sm text-push-fg-secondary`;

const BRANCH_DANGER_PANEL_CLASS =
  'rounded-[18px] border border-red-500/20 bg-[linear-gradient(180deg,rgba(70,23,23,0.18)_0%,rgba(31,11,11,0.34)_100%)] px-3.5 py-3';

function BranchForkSheet({ open, onOpenChange, fromBranch, forkBranch }: BranchForkSheetProps) {
  const [branchName, setBranchName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sanitized = sanitizeBranchName(branchName);
  // Reject inputs that only become valid after `sanitizeBranchName` strips a
  // leading invalid char ("-evil" → "evil"). Silent leading-char stripping is
  // surprising — surface it as a validation error so the user sees what they
  // typed reflected in the result.
  const leadingInvalid = /^[-/]/.test(branchName.trim());
  const isValid =
    sanitized.length >= 1 &&
    !sanitized.includes('..') &&
    sanitized !== fromBranch &&
    !leadingInvalid;

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBranchName(e.target.value);
    setError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!isValid || creating) return;
    setCreating(true);
    setError(null);
    try {
      // Don't pass `fromBranch`; let the sandbox tool default to its current
      // HEAD. If sandbox HEAD has drifted from the UI-tracked branch label
      // (e.g. via plain `git checkout` through `sandbox_exec`), this keeps
      // "fork from here" anchored to the actual current state.
      const result = await forkBranch(sanitized);
      if (!result.ok) {
        setError(result.errorMessage ?? 'Failed to create branch');
        return;
      }
      // Success: useChat.forkBranchFromUI already triggered conversation
      // migration via applyBranchSwitchPayload. Just close the sheet.
      setBranchName('');
      onOpenChange(false);
    } finally {
      setCreating(false);
    }
  }, [isValid, creating, sanitized, forkBranch, onOpenChange]);

  const handleCancel = useCallback(() => {
    setBranchName('');
    setError(null);
    onOpenChange(false);
  }, [onOpenChange]);

  // Reset state when the sheet opens.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setBranchName('');
        setError(null);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-push-edge bg-push-grad-panel px-5 pb-8 pt-0"
      >
        <SheetHeader className="pt-5 pb-1">
          <SheetTitle className="text-sm font-semibold text-push-fg flex items-center gap-2">
            <BranchWaveIcon className="h-4 w-4 text-push-fg-dim" />
            New Branch from Here
          </SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            Forks <span className="font-mono text-push-fg-muted">{fromBranch}</span> into a new
            branch. This conversation stays attached and follows you onto the new branch.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="fork-branch-name" className="text-xs text-push-fg-secondary">
              Branch name
            </Label>
            <Input
              id="fork-branch-name"
              placeholder="feature/auth-refactor"
              value={branchName}
              onChange={handleNameChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValid && !creating) handleCreate();
              }}
              autoFocus
              disabled={creating}
              className={`${HUB_MATERIAL_INPUT_CLASS} h-11 rounded-[18px] text-sm`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {branchName && leadingInvalid && (
              <p className="text-push-xs text-red-400">
                Branch name cannot start with &quot;-&quot; or &quot;/&quot;.
              </p>
            )}
            {branchName &&
              !leadingInvalid &&
              sanitized !== branchName.toLowerCase().trim() &&
              sanitized.length > 0 && (
                <p className="text-push-xs text-push-fg-dim">
                  Will create: <span className="text-push-fg-muted font-mono">{sanitized}</span>
                </p>
              )}
            {branchName && !leadingInvalid && sanitized.length === 0 && (
              <p className="text-push-xs text-red-400">
                Branch name contains only invalid characters.
              </p>
            )}
          </div>

          {error && (
            <div className={BRANCH_DANGER_PANEL_CLASS}>
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <Button
              onClick={handleCreate}
              disabled={!isValid || creating}
              className={BRANCH_ACTION_BUTTON_CLASS}
            >
              <HubControlGlow />
              {creating ? (
                <>
                  <Loader2 className="relative z-10 h-4 w-4 animate-spin" />
                  <span className="relative z-10">Creating...</span>
                </>
              ) : (
                <span className="relative z-10">Create Branch</span>
              )}
            </Button>
            <Button
              onClick={handleCancel}
              disabled={creating}
              variant="outline"
              className={BRANCH_ACTION_BUTTON_CLASS}
            >
              <HubControlGlow />
              <span className="relative z-10">Cancel</span>
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { BranchForkSheet };
export type { BranchForkSheetProps };
