import { Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import { BranchWaveIcon, DiffSeamIcon, FilesStackIcon } from '@/components/icons/push-custom-icons';
import type { NewChatWorkspaceState } from '@/types';

interface NewChatWorkspaceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: NewChatWorkspaceState | null;
  checking: boolean;
  resetting: boolean;
  onContinueCurrentWorkspace: () => void;
  onStartFresh: () => void;
  onReviewChanges: () => void;
}

function formatSummary(workspace: NewChatWorkspaceState): string {
  if (workspace.mode === 'scratch') {
    return `${workspace.changedFiles} file${workspace.changedFiles === 1 ? '' : 's'} in this workspace`;
  }

  const parts = [`${workspace.changedFiles} changed`];
  if (workspace.stagedFiles > 0) parts.push(`${workspace.stagedFiles} staged`);
  if (workspace.unstagedFiles > 0) parts.push(`${workspace.unstagedFiles} unstaged`);
  if (workspace.untrackedFiles > 0) parts.push(`${workspace.untrackedFiles} untracked`);
  return parts.join(' · ');
}

export function NewChatWorkspaceSheet({
  open,
  onOpenChange,
  workspace,
  checking,
  resetting,
  onContinueCurrentWorkspace,
  onStartFresh,
  onReviewChanges,
}: NewChatWorkspaceSheetProps) {
  const reviewLabel = workspace?.mode === 'scratch' ? 'Review files' : 'Review changes';
  const ReviewIcon = workspace?.mode === 'scratch' ? FilesStackIcon : DiffSeamIcon;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[82dvh] overflow-y-auto rounded-t-2xl border-t border-push-edge bg-push-grad-panel px-5 pb-8 pt-0 text-push-fg"
      >
        <SheetHeader className="pb-1 pt-5">
          <SheetTitle className="flex items-center gap-2 text-sm font-semibold text-push-fg">
            <Sparkles className="h-4 w-4 text-push-fg-dim" />
            Start new chat?
          </SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            {workspace?.mode === 'scratch'
              ? 'This workspace still has files in it. New chat can continue from here or start fresh.'
              : 'This workspace has uncommitted changes. New chat can keep the current workspace or reset to branch HEAD.'}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 pt-3">
          {checking || !workspace ? (
            <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} flex items-center gap-3 px-4 py-4 text-sm text-push-fg-secondary`}>
              <Loader2 className="h-4 w-4 animate-spin text-push-fg-dim" />
              <span>Checking workspace changes…</span>
            </div>
          ) : (
            <>
              <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} space-y-3 px-4 py-4`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-push-fg">
                      {workspace.mode === 'scratch' ? 'Workspace' : 'Current workspace'}
                    </p>
                    <p className="mt-1 text-xs text-push-fg-dim">{formatSummary(workspace)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 rounded-full border border-push-edge bg-push-surface/80 px-2.5 py-1 text-push-2xs text-push-fg-secondary">
                    <BranchWaveIcon className="h-3 w-3 text-push-fg-dim" />
                    <span>{workspace.branch}</span>
                  </div>
                </div>

                {workspace.preview.length > 0 && (
                  <div className="space-y-1">
                    {workspace.preview.map((entry) => (
                      <div
                        key={entry}
                        className="truncate rounded-lg border border-push-edge bg-black/20 px-2.5 py-2 font-mono text-push-2xs text-push-fg-secondary"
                      >
                        {entry}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-[18px] border border-amber-500/20 bg-[linear-gradient(180deg,rgba(62,45,16,0.16)_0%,rgba(22,17,7,0.3)_100%)] px-3.5 py-3">
                <p className="text-xs text-amber-200/90">
                  {workspace.mode === 'scratch'
                    ? 'Starting fresh clears the current workspace. Review or continue if you still need these files.'
                    : 'Starting fresh resets the branch workspace and discards these uncommitted changes across chats on this branch.'}
                </p>
              </div>

              <button
                type="button"
                onClick={onReviewChanges}
                className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-10 w-full gap-2 px-3 text-push-fg-secondary`}
              >
                <HubControlGlow />
                <ReviewIcon className="relative z-10 h-4 w-4" />
                <span className="relative z-10 text-sm">{reviewLabel}</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onContinueCurrentWorkspace}
                  disabled={resetting}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 flex-[1.2] gap-2 px-3 text-push-fg disabled:opacity-60`}
                >
                  <HubControlGlow />
                  <span className="relative z-10 text-sm">Continue workspace</span>
                </button>
                <button
                  type="button"
                  onClick={onStartFresh}
                  disabled={resetting}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-11 flex-1 gap-2 px-3 text-amber-100 disabled:opacity-60`}
                >
                  <HubControlGlow />
                  {resetting ? (
                    <Loader2 className="relative z-10 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="relative z-10 h-4 w-4" />
                  )}
                  <span className="relative z-10 text-sm">Start fresh</span>
                </button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
