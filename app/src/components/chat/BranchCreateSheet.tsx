import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { BranchWaveIcon } from '@/components/icons/push-custom-icons';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { executeCreateBranch } from '@/lib/github-tools';
import { sanitizeBranchName } from '@/lib/branch-names';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import type { ActiveRepo } from '@/types';

interface BranchCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeRepo: ActiveRepo;
  setCurrentBranch: (branch: string) => void;
}

const BRANCH_ACTION_BUTTON_CLASS = `${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 flex-1 text-sm text-push-fg-secondary`;

const BRANCH_OPTION_CLASS = `${HUB_PANEL_SUBTLE_SURFACE_CLASS} flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-all duration-200`;

const BRANCH_SUCCESS_PANEL_CLASS =
  'rounded-[18px] border border-emerald-500/20 bg-[linear-gradient(180deg,rgba(17,61,42,0.18)_0%,rgba(8,28,20,0.34)_100%)] px-3.5 py-3';

const BRANCH_DANGER_PANEL_CLASS =
  'rounded-[18px] border border-red-500/20 bg-[linear-gradient(180deg,rgba(70,23,23,0.18)_0%,rgba(31,11,11,0.34)_100%)] px-3.5 py-3';

function BranchCreateSheet({
  open,
  onOpenChange,
  activeRepo,
  setCurrentBranch,
}: BranchCreateSheetProps) {
  const [branchName, setBranchName] = useState('');
  const [afterCreate, setAfterCreate] = useState<'switch' | 'stay'>('switch');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fromBranch = activeRepo.current_branch || activeRepo.default_branch;
  const sanitized = sanitizeBranchName(branchName);
  const isValid = sanitized.length >= 1 && !sanitized.includes('..') && sanitized !== fromBranch;

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBranchName(e.target.value);
    setError(null);
    setSuccess(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!isValid || creating) return;

    setCreating(true);
    setError(null);
    setSuccess(null);

    try {
      await executeCreateBranch(activeRepo.full_name, sanitized, fromBranch);

      if (afterCreate === 'switch') {
        setCurrentBranch(sanitized);
        // Reset and close
        setBranchName('');
        setError(null);
        setSuccess(null);
        onOpenChange(false);
      } else {
        // Stay on current branch -- show brief success, then close after a beat
        setSuccess(`Branch "${sanitized}" created.`);
        setBranchName('');
        setTimeout(() => {
          setSuccess(null);
          onOpenChange(false);
        }, 1500);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create branch';
      // Clean up tool-result prefix noise for UI display
      const cleaned = message
        .replace(/^\[Tool Error\]\s*/i, '')
        .replace(/^\[Tool Result.*?\]\s*/i, '');
      setError(cleaned);
    } finally {
      setCreating(false);
    }
  }, [
    isValid,
    creating,
    activeRepo.full_name,
    sanitized,
    fromBranch,
    afterCreate,
    setCurrentBranch,
    onOpenChange,
  ]);

  const handleCancel = useCallback(() => {
    setBranchName('');
    setError(null);
    setSuccess(null);
    onOpenChange(false);
  }, [onOpenChange]);

  // Reset state when sheet opens
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setBranchName('');
        setError(null);
        setSuccess(null);
        setAfterCreate('switch');
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
            Create branch
          </SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            From {fromBranch}. The new branch will be created on GitHub from the current ref.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Branch name input */}
          <div className="space-y-2">
            <Label htmlFor="branch-name" className="text-xs text-push-fg-secondary">
              Branch name
            </Label>
            <Input
              id="branch-name"
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
            {/* Show sanitized preview if it differs from raw input */}
            {branchName &&
              sanitized !== branchName.toLowerCase().trim() &&
              sanitized.length > 0 && (
                <p className="text-push-xs text-push-fg-dim">
                  Will create: <span className="text-push-fg-muted font-mono">{sanitized}</span>
                </p>
              )}
            {branchName && sanitized.length === 0 && (
              <p className="text-push-xs text-red-400">
                Branch name contains only invalid characters.
              </p>
            )}
          </div>

          {/* After-create behavior */}
          <div className="space-y-2.5">
            <Label className="text-xs text-push-fg-secondary">After creation</Label>
            <RadioGroup
              value={afterCreate}
              onValueChange={(v) => setAfterCreate(v as 'switch' | 'stay')}
              className="gap-3"
            >
              <label
                className={`${BRANCH_OPTION_CLASS} ${
                  afterCreate === 'switch'
                    ? 'border-push-edge-hover bg-push-grad-input shadow-[0_10px_24px_rgba(0,0,0,0.22)]'
                    : 'hover:border-push-edge-hover/80'
                }`}
              >
                <RadioGroupItem value="switch" className="mt-0.5 border-[#3f3f46] text-push-sky" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-push-fg">Switch to branch</span>
                  <span className="mt-0.5 block text-push-xs text-push-fg-dim">
                    Open the new branch right away.
                  </span>
                </span>
              </label>
              <label
                className={`${BRANCH_OPTION_CLASS} ${
                  afterCreate === 'stay'
                    ? 'border-push-edge-hover bg-push-grad-input shadow-[0_10px_24px_rgba(0,0,0,0.22)]'
                    : 'hover:border-push-edge-hover/80'
                }`}
              >
                <RadioGroupItem value="stay" className="mt-0.5 border-[#3f3f46] text-push-sky" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-push-fg">Stay on {fromBranch}</span>
                  <span className="mt-0.5 block text-push-xs text-push-fg-dim">
                    Keep the current branch active after creation.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          {/* Error display */}
          {error && (
            <div className={BRANCH_DANGER_PANEL_CLASS}>
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Success display */}
          {success && (
            <div className={BRANCH_SUCCESS_PANEL_CLASS}>
              <p className="text-xs text-emerald-400">{success}</p>
            </div>
          )}

          {/* Action buttons */}
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
                <span className="relative z-10">Create</span>
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

export { BranchCreateSheet };
export type { BranchCreateSheetProps };
