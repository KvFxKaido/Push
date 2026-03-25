import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { RepoLauncherPanel, type LauncherSandboxSession } from './RepoLauncherPanel';
import type { RepoAppearance } from '@/lib/repo-appearance';
import type { ActiveRepo, ConversationIndex, RepoWithActivity } from '@/types';

interface RepoLauncherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repos: RepoWithActivity[];
  loading: boolean;
  error?: string | null;
  conversations: ConversationIndex;
  activeRepo: ActiveRepo | null;
  resolveRepoAppearance: (repoFullName?: string | null) => RepoAppearance;
  setRepoAppearance: (repoFullName: string, appearance: RepoAppearance) => void;
  clearRepoAppearance: (repoFullName: string) => void;
  onSelectRepo: (repo: RepoWithActivity, branch?: string) => void;
  onResumeConversation: (chatId: string) => void;
  sandboxSession?: LauncherSandboxSession | null;
  onResumeSandbox?: () => void;
  onStartWorkspace?: () => void;
}

export function RepoLauncherSheet({
  open,
  onOpenChange,
  repos,
  loading,
  error,
  conversations,
  activeRepo,
  resolveRepoAppearance,
  setRepoAppearance,
  clearRepoAppearance,
  onSelectRepo,
  onResumeConversation,
  sandboxSession,
  onResumeSandbox,
  onStartWorkspace,
}: RepoLauncherSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[92dvh] border-t border-push-edge bg-push-grad-panel px-0 pb-0 pt-0 text-push-fg"
      >
        <SheetHeader className="border-b border-push-edge/70 bg-[linear-gradient(180deg,rgba(10,13,20,0.84)_0%,rgba(6,8,13,0.92)_100%)] px-4 py-4 text-left backdrop-blur-xl">
          <SheetTitle className="text-sm font-semibold text-push-fg">Launcher</SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            Resume repo work, reopen your sandbox, or switch context without leaving chat.
          </SheetDescription>
        </SheetHeader>

        <div className="h-[calc(92dvh-72px)] overflow-y-auto overscroll-contain px-4 pb-6 pt-4">
          <RepoLauncherPanel
            repos={repos}
            loading={loading}
            error={error}
            conversations={conversations}
            activeRepo={activeRepo}
            resolveRepoAppearance={resolveRepoAppearance}
            setRepoAppearance={setRepoAppearance}
            clearRepoAppearance={clearRepoAppearance}
            onSelectRepo={(repo, branch) => {
              onSelectRepo(repo, branch);
              onOpenChange(false);
            }}
            onResumeConversation={(chatId) => {
              onResumeConversation(chatId);
              onOpenChange(false);
            }}
            sandboxSession={sandboxSession}
            onResumeSandbox={sandboxSession
              ? () => {
                  onResumeSandbox?.();
                  onOpenChange(false);
                }
              : undefined}
            onStartWorkspace={onStartWorkspace
              ? () => {
                  onStartWorkspace();
                  onOpenChange(false);
                }
              : undefined}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
