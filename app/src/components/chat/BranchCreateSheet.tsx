import { useState, useCallback } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
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
import type { ActiveRepo } from '@/types';

interface BranchCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeRepo: ActiveRepo;
  setCurrentBranch: (branch: string) => void;
}

function BranchCreateSheet({ open, onOpenChange, activeRepo, setCurrentBranch }: BranchCreateSheetProps) {
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
  }, [isValid, creating, activeRepo.full_name, sanitized, fromBranch, afterCreate, setCurrentBranch, onOpenChange]);

  const handleCancel = useCallback(() => {
    setBranchName('');
    setError(null);
    setSuccess(null);
    onOpenChange(false);
  }, [onOpenChange]);

  // Reset state when sheet opens
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) {
      setBranchName('');
      setError(null);
      setSuccess(null);
      setAfterCreate('switch');
    }
    onOpenChange(next);
  }, [onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-[#0d0d0d] border-t border-white/[0.06] rounded-t-2xl px-5 pb-8 pt-0 max-h-[80dvh]"
      >
        <SheetHeader className="pt-5 pb-1">
          <SheetTitle className="text-sm font-semibold text-push-fg flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-push-fg-dim" />
            Create branch from {fromBranch}
          </SheetTitle>
          <SheetDescription className="text-xs text-[#71717a]">
            A new branch will be created on GitHub from the current ref.
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
              className="bg-[#141414] border-white/[0.08] text-push-fg placeholder:text-[#3f3f46] h-11 text-sm"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {/* Show sanitized preview if it differs from raw input */}
            {branchName && sanitized !== branchName.toLowerCase().trim() && sanitized.length > 0 && (
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
              <label className="flex items-center gap-2.5 cursor-pointer">
                <RadioGroupItem value="switch" className="border-[#3f3f46]" />
                <span className="text-sm text-push-fg">Switch to branch</span>
              </label>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <RadioGroupItem value="stay" className="border-[#3f3f46]" />
                <span className="text-sm text-push-fg">Stay on {fromBranch}</span>
              </label>
            </RadioGroup>
          </div>

          {/* Error display */}
          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}

          {/* Success display */}
          {success && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
              <p className="text-xs text-emerald-400">{success}</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-3 pt-1">
            <Button
              onClick={handleCreate}
              disabled={!isValid || creating}
              className="flex-1 h-11 bg-[#e4e4e7] text-[#0d0d0d] hover:bg-[#d4d4d8] font-medium text-sm disabled:opacity-40"
            >
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create'
              )}
            </Button>
            <Button
              onClick={handleCancel}
              disabled={creating}
              variant="outline"
              className="flex-1 h-11 border-white/[0.08] bg-transparent text-push-fg-secondary hover:bg-[#141414] hover:text-push-fg text-sm"
            >
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { BranchCreateSheet };
export type { BranchCreateSheetProps };
